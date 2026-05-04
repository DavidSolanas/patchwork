import { promises as fs } from 'node:fs';
import { STATE_FILE } from '../config/defaults.js';
import { dedupKey, findExistingPR, type DedupCache } from '../github/deduplication.js';
import { ensureFork } from '../github/forkRepo.js';
import type { Octokit } from '../github/octokit.js';
import { priceFor } from '../reporter/costs.js';
import type { AgentRunResult, IssueRef, TokenUsage } from '../types.js';
import { atomicWriteFile } from '../util/atomicWrite.js';
import { buildPrompt } from './buildPrompt.js';
import type { CursorClient, CursorEvent, RunSnapshot } from './cursorClient.js';
import { detectTestCommands } from './detectTests.js';
import { parseResult } from './parseResult.js';

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 30 * 60_000;
const BRANCH_SLUG_MAX = 40;

export interface RunAgentTarget {
  model: string;
  max_tokens_per_issue: number;
}

export interface RunAgentDeps {
  cursor: CursorClient;
  octokit: Octokit;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  statePath?: string;
  /** Shared per-run dedup cache. Threads through invariant #7's three checkpoints. */
  dedupCache?: DedupCache;
  /** Hook to override `setTimeout` in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Dispatch a Cursor cloud agent against a single issue and produce an
 * `AgentRunResult` describing the outcome.
 *
 * Contracts (PLAN.md §615–651):
 *   - Pre-agent dedup re-check (invariant #7, second of three checkpoints).
 *   - Bind to the correct repo (upstream if user owns it, otherwise a fork
 *     materialised by `ensureFork`). Cloud agents are permanently bound.
 *   - Persist `{runId, lastCursor, issueKey}` to `.patchwork/state.json`
 *     immediately after `startRun` so a restarted CLI can recover.
 *   - Two cooperative loops: an event consumer (source of truth for tokens)
 *     and a status poller (source of truth for terminal status).
 *   - Failure mode is SKIP / no_diff / error — never silently retry
 *     (invariant #5).
 */
export async function runAgent(
  issue: IssueRef,
  target: RunAgentTarget,
  deps: RunAgentDeps,
): Promise<AgentRunResult> {
  const startedAt = new Date().toISOString();
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const statePath = deps.statePath ?? STATE_FILE;
  const sleep = deps.sleep ?? defaultSleep;

  const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0 };

  // 1. Pre-agent dedup re-check (invariant #7).
  const existing = await findExistingPR(deps.octokit, issue, deps.dedupCache);
  if (existing.exists) {
    return finish(issue, target.model, {
      kind: 'skip',
      reason: `PR already exists: ${existing.url ?? 'unknown'}`,
    }, tokens, startedAt, '', issue.repo, '');
  }

  // 2. Bind to repo (upstream or fork).
  const fork = await ensureFork(deps.octokit, issue.repo);
  const boundRepo = { owner: fork.owner, name: fork.name };
  const repoUrl = `https://github.com/${boundRepo.owner}/${boundRepo.name}`;

  // 3. Branch name.
  const branch = `patchwork/issue-${issue.number}-${slugify(issue.title)}`;

  // 4. Test detection (best-effort against upstream — that's where the
  // canonical tooling lives).
  const testHints = await detectTestCommands({
    octokit: deps.octokit,
    owner: issue.repo.owner,
    name: issue.repo.name,
  });
  const testingNotes =
    testHints.length > 0
      ? `Test commands detected: ${testHints.join(', ')}`
      : 'No test commands detected.';

  // 5. Prompt.
  const prompt = buildPrompt(issue, { repoUrl, testHints });

  // 6. Dispatch.
  const start = await deps.cursor.startRun({
    repoUrl,
    branch,
    prompt,
    model: target.model,
    autoCreatePR: false,
  });
  const runId = start.runId;

  // 7. Checkpoint immediately after startRun. State writes are serialised
  // through `stateWrites` because both the event consumer and the post-terminal
  // clearState run concurrently and would otherwise race on the .tmp + rename
  // dance.
  let lastCursor: string | null = null;
  let stateWrites: Promise<void> = Promise.resolve();
  const enqueueWrite = (op: () => Promise<void>): Promise<void> => {
    stateWrites = stateWrites.then(op, op);
    return stateWrites;
  };
  await enqueueWrite(() =>
    checkpointState(statePath, issue, runId, lastCursor, target.model, boundRepo),
  );

  // 8. Two cooperative loops.
  let eventStream: AsyncIterable<CursorEvent> = start.events;
  let stop = false;

  const eventTask = (async () => {
    while (!stop) {
      try {
        for await (const ev of eventStream) {
          tokens.input += ev.tokens.input;
          tokens.output += ev.tokens.output;
          tokens.cacheRead += ev.tokens.cacheRead;
          lastCursor = ev.cursor;
          await enqueueWrite(() =>
            checkpointState(statePath, issue, runId, lastCursor, target.model, boundRepo),
          );
          if (stop) return;
        }
        return; // natural end
      } catch {
        // Network drop — Cursor cloud agents are durable. Resume from the last
        // cursor we observed. Don't retry past `stop` — that means the poller
        // already saw a terminal status.
        if (stop) return;
        eventStream = deps.cursor.resumeEvents(runId, lastCursor ?? undefined);
      }
    }
  })();

  let terminal: RunSnapshot | null = null;
  let timedOut = false;
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() <= deadline) {
    await sleep(pollIntervalMs);
    const snap = await deps.cursor.getRun(runId);
    if (snap.status === 'completed' || snap.status === 'failed') {
      terminal = snap;
      break;
    }
  }
  if (!terminal) timedOut = true;
  stop = true;

  // Drain the event task fully so any in-flight checkpoint completes before
  // we clearState. Cursor's `run.stream()` iterator ends naturally once the
  // run reaches a terminal status, so this resolves promptly in production;
  // mock iterators in tests resolve immediately.
  await eventTask.catch(() => {});

  // 9–11. Terminal handling.
  if (timedOut) {
    await safeCancel(deps.cursor, runId);
    await enqueueWrite(() => clearState(statePath, issue));
    return finish(
      issue,
      target.model,
      { kind: 'error', message: 'agent run timed out' },
      tokens,
      startedAt,
      runId,
      boundRepo,
      testingNotes,
    );
  }

  // terminal is non-null past this point
  const snap = terminal!;

  if (snap.status === 'failed') {
    await enqueueWrite(() => clearState(statePath, issue));
    return finish(
      issue,
      target.model,
      { kind: 'error', message: snap.error ?? 'agent run failed' },
      tokens,
      startedAt,
      runId,
      boundRepo,
      testingNotes,
    );
  }

  const parsed = parseResult({ output: snap.output, diff: snap.diff });
  await clearState(statePath, issue);

  if (parsed.kind === 'skip') {
    return finish(
      issue,
      target.model,
      { kind: 'skip', reason: parsed.reason },
      tokens,
      startedAt,
      runId,
      boundRepo,
      testingNotes,
    );
  }
  if (parsed.kind === 'no_diff') {
    return finish(
      issue,
      target.model,
      { kind: 'no_diff' },
      tokens,
      startedAt,
      runId,
      boundRepo,
      testingNotes,
    );
  }
  const successBranch = snap.branch ?? branch;
  // The Cursor SDK does not expose the run's HEAD SHA — fetch it post-hoc from
  // the bound repo. Best-effort: a failure here (network, fresh push not yet
  // visible, branch missing) returns '' rather than aborting the success path.
  const commitSha = await fetchHeadSha(deps.octokit, boundRepo, successBranch);
  return finish(
    issue,
    target.model,
    {
      kind: 'success',
      branch: successBranch,
      diff: snap.diff ?? '',
      commitSha,
      agentSummary: parsed.agentSummary,
    },
    tokens,
    startedAt,
    runId,
    boundRepo,
    testingNotes,
  );
}

async function fetchHeadSha(
  octokit: Octokit,
  boundRepo: { owner: string; name: string },
  branch: string,
): Promise<string> {
  try {
    const res = await octokit.repos.getBranch({
      owner: boundRepo.owner,
      repo: boundRepo.name,
      branch,
    });
    return res.data.commit.sha ?? '';
  } catch {
    return '';
  }
}

function finish(
  issue: IssueRef,
  model: string,
  outcome: AgentRunResult['outcome'],
  tokens: TokenUsage,
  startedAt: string,
  cursorRunId: string,
  boundRepo: { owner: string; name: string },
  testingNotes: string,
): AgentRunResult {
  return {
    issue,
    outcome,
    model,
    tokens,
    costUsd: priceFor(model, tokens),
    startedAt,
    endedAt: new Date().toISOString(),
    cursorRunId,
    boundRepo,
    testingNotes,
  };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BRANCH_SLUG_MAX);
}

async function safeCancel(cursor: CursorClient, runId: string): Promise<void> {
  try {
    await cursor.cancelRun(runId);
  } catch {
    // Best-effort — the orchestrator's progress should not depend on cancel
    // succeeding. The run is durable; orphan runs are billed regardless.
  }
}

interface StateRecord {
  runId: string;
  lastCursor: string | null;
  startedAt: string;
  model: string;
  boundRepo: { owner: string; name: string };
}

interface StateFile {
  inFlight: Record<string, StateRecord>;
}

async function checkpointState(
  statePath: string,
  issue: IssueRef,
  runId: string,
  lastCursor: string | null,
  model: string,
  boundRepo: { owner: string; name: string },
): Promise<void> {
  const key = dedupKey(issue);
  const existing = await readState(statePath);
  const startedAt = existing.inFlight[key]?.startedAt ?? new Date().toISOString();
  existing.inFlight[key] = { runId, lastCursor, startedAt, model, boundRepo };
  await writeStateAtomic(statePath, existing);
}

async function clearState(statePath: string, issue: IssueRef): Promise<void> {
  const key = dedupKey(issue);
  const existing = await readState(statePath);
  if (key in existing.inFlight) {
    delete existing.inFlight[key];
    await writeStateAtomic(statePath, existing);
  }
}

async function readState(statePath: string): Promise<StateFile> {
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed && typeof parsed === 'object' && parsed.inFlight) return parsed;
    return { inFlight: {} };
  } catch {
    return { inFlight: {} };
  }
}

async function writeStateAtomic(statePath: string, state: StateFile): Promise<void> {
  await atomicWriteFile(statePath, JSON.stringify(state, null, 2));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
