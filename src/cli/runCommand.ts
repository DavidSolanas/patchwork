import Anthropic from '@anthropic-ai/sdk';
import parseDiff from 'parse-diff';
import { DEFAULT_CONFIG_PATH, DEFAULT_TRIAGE_MODEL, SUMMARY_FILE } from '../config/defaults.js';
import { loadConfig, type PatchworkConfig } from '../config/load.js';
import type { TargetConfig } from '../config/schema.js';
import { runAgent } from '../agent/runAgent.js';
import { makeCursorClient, type CursorClient } from '../agent/cursorClient.js';
import { fetchIssues } from '../github/fetchIssues.js';
import { createDedupCache, findExistingPR, type DedupCache } from '../github/deduplication.js';
import { makeOctokit, type Octokit } from '../github/octokit.js';
import { scoreIssue } from '../github/scoreIssue.js';
import { createPR } from '../github/createPR.js';
import { ConsoleReporter } from '../reporter/console.js';
import { priceFor } from '../reporter/costs.js';
import { writeSummary } from '../reporter/markdown.js';
import { RunState } from '../reporter/runState.js';
import { isBinary } from '../review/diffViewer.js';
import { TerminalReviewSurface } from '../review/humanGate.js';
import { DeferredQueue } from '../review/queue.js';
import {
  PatchworkError,
  type IssueRef,
  type ReviewPayload,
  type ReviewSurface,
  type RunStats,
  type SuccessfulAgentRunResult,
} from '../types.js';
import { preflight } from './preflight.js';

export interface RunCommandOptions {
  config?: string;
  dryRun?: boolean;
  /** "owner/name" filter — limits the run to one target. */
  repo?: string;
}

export interface RunCommandDeps {
  octokit: Octokit;
  anthropic: Anthropic;
  cursor: CursorClient;
  reporter: ConsoleReporter;
  surface: ReviewSurface;
  queue: DeferredQueue;
  /** Override the SUMMARY.md path — tests use this. */
  summaryPath?: string;
}

const LARGE_DIFF_FILE_THRESHOLD = 10;
const LARGE_DIFF_LINE_THRESHOLD = 500;

/**
 * `patchwork run` orchestrator.
 *
 * Defaults: constructs deps from env vars and runs the full pipeline. Tests
 * inject `deps` to assert ordering and to ensure `--dry-run` never reaches
 * the Cursor client.
 *
 * Threads one `DedupCache` through invariant #7's three checkpoints (here at
 * pre-triage, then `runAgent` for pre-agent, then `createPR` for pre-PR) so
 * the same issue is searched at most once per run.
 */
export async function runCommand(
  opts: RunCommandOptions = {},
  deps?: RunCommandDeps,
): Promise<RunStats> {
  const dryRun = opts.dryRun ?? false;

  preflight({ needsTty: !dryRun, needsCursor: !dryRun });

  const config = loadConfig(opts.config ?? DEFAULT_CONFIG_PATH);
  // CLI flag wins over the YAML setting.
  const effectiveDryRun = dryRun || config.settings.dry_run;

  const resolved = deps ?? buildDefaultDeps({ dryRun: effectiveDryRun });
  return executeRun(config, resolved, { ...opts, dryRun: effectiveDryRun });
}

function buildDefaultDeps(opts: { dryRun: boolean }): RunCommandDeps {
  const octokit = makeOctokit(process.env.GITHUB_TOKEN ?? '');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
  // In a true dry-run we still need a CursorClient placeholder for the
  // typing, but it must never be called. Use a safe stub that throws if
  // invoked — the orchestrator never reaches it when `effectiveDryRun` is on.
  const cursor: CursorClient = opts.dryRun
    ? unreachableCursor()
    : makeCursorClient(process.env.CURSOR_API_KEY ?? '');
  const reporter = new ConsoleReporter();
  // Construct the surface lazily — instantiating it fails outside a TTY,
  // and `--dry-run` is the supported escape hatch for non-TTY environments.
  const surface: ReviewSurface = opts.dryRun ? noopSurface() : new TerminalReviewSurface();
  const queue = new DeferredQueue();
  return { octokit, anthropic, cursor, reporter, surface, queue };
}

function unreachableCursor(): CursorClient {
  const fail = (): never => {
    throw new PatchworkError(
      'CursorClient was invoked during a --dry-run.',
      'This is a bug — dry-run paths must not dispatch agents.',
    );
  };
  return {
    startRun: fail,
    getRun: fail,
    resumeEvents: fail,
    cancelRun: fail,
  };
}

function noopSurface(): ReviewSurface {
  return {
    interactive: false,
    present: (): never => {
      throw new PatchworkError(
        'Review surface invoked during a --dry-run.',
        'Dry-run never produces a successful agent result, so this should be unreachable.',
      );
    },
  };
}

export async function executeRun(
  config: PatchworkConfig,
  deps: RunCommandDeps,
  opts: { dryRun: boolean; repo?: string },
): Promise<RunStats> {
  const { octokit, anthropic, cursor, reporter, surface, queue } = deps;
  const summaryPath = deps.summaryPath ?? SUMMARY_FILE;
  const state = new RunState(config.settings.cost_limit_usd);
  const dedupCache: DedupCache = createDedupCache();

  reporter.start(config);

  const targets = filterTargets(config.targets, opts.repo);

  outer: for (const target of targets) {
    const [owner, name] = target.repo.split('/') as [string, string];
    let issues: IssueRef[];
    try {
      issues = await fetchIssues({
        octokit,
        owner,
        name,
        labels: target.labels,
        maxIssues: target.max_issues,
        skipIfCommentsGt: target.skip_if_comments_gt,
      });
    } catch (err) {
      throw new PatchworkError(
        `Failed to fetch issues for ${target.repo}: ${(err as Error).message}`,
        'Check your GITHUB_TOKEN scopes and the repo name.',
      );
    }

    for (const issue of issues) {
      state.noteConsidered();

      if (state.shouldAbortBeforeNextRun()) {
        reporter.costLimitHit(state.snapshot());
        break outer;
      }

      // Checkpoint 1 of 3 (invariant #7): pre-triage dedup.
      const existing = await findExistingPR(octokit, issue, dedupCache);
      if (existing.exists) continue;

      reporter.issueStarting(issue, DEFAULT_TRIAGE_MODEL);
      const { score, tokens } = await scoreIssue(issue, { anthropic });
      const triageCost = priceFor(DEFAULT_TRIAGE_MODEL, tokens);
      state.addCost({ model: DEFAULT_TRIAGE_MODEL, tokens, usd: triageCost });
      state.noteScored();
      reporter.issueScored(issue, score);

      if (score.score < config.settings.min_score) continue;
      if (opts.dryRun) continue;

      reporter.issueAttempting(issue);
      const result = await runAgent(issue, target, { cursor, octokit, dedupCache });
      reporter.agentResult(result);
      // The runAgent pre-agent dedup re-check (invariant #7, second checkpoint) returns
      // skip with an empty cursorRunId without ever dispatching. Don't double-count it
      // as an attempt — the orchestrator's pre-triage check already accounted for it.
      if (result.cursorRunId === '' && result.outcome.kind === 'skip') continue;
      state.recordResult(result);

      if (result.outcome.kind !== 'success') continue;

      const successResult = result as SuccessfulAgentRunResult;
      const payload = buildReviewPayload(successResult);
      const decision = await surface.present(payload);
      reporter.reviewDecision(issue, decision);

      switch (decision.action) {
        case 'approve': {
          const pr = await createPR({
            octokit,
            result: successResult,
            upstream: issue.repo,
            dedupCache,
          });
          state.notePRCreated();
          reporter.prCreated(issue, pr.url);
          break;
        }
        case 'reject':
          state.noteReviewRejected();
          break;
        case 'skip':
          await queue.push({ payload, deferredAt: new Date().toISOString() });
          state.noteReviewSkipped();
          break;
        case 'open_external':
          // Surface re-prompts internally; reaching this branch would be a
          // contract violation, but the exhaustive switch makes adding a new
          // ReviewDecision action a build error (invariant #10).
          break;
        default: {
          const _: never = decision;
          void _;
        }
      }
    }
  }

  state.finish();
  const stats = state.snapshot();
  reporter.end(stats);
  await writeSummary(stats, summaryPath);
  return stats;
}

function filterTargets(targets: TargetConfig[], repoFilter: string | undefined): TargetConfig[] {
  if (!repoFilter) return targets;
  const matched = targets.filter((t) => t.repo === repoFilter);
  if (matched.length === 0) {
    throw new PatchworkError(
      `--repo ${repoFilter} did not match any target in the config.`,
      'Check the spelling and that the repo appears under `targets:` in your YAML.',
    );
  }
  return matched;
}

export function buildReviewPayload(result: SuccessfulAgentRunResult): ReviewPayload {
  const files = parseDiff(result.outcome.diff);
  const filesChanged: ReviewPayload['filesChanged'] = files.map((f) => {
    const path = f.to && f.to !== '/dev/null' ? f.to : (f.from ?? '(unknown)');
    const binary = isBinary(f);
    return {
      path,
      additions: f.additions,
      deletions: f.deletions,
      binary,
    };
  });
  const totalAdditions = filesChanged.reduce((acc, f) => acc + f.additions, 0);
  const totalDeletions = filesChanged.reduce((acc, f) => acc + f.deletions, 0);
  const largeDiffWarning =
    filesChanged.length > LARGE_DIFF_FILE_THRESHOLD ||
    totalAdditions + totalDeletions > LARGE_DIFF_LINE_THRESHOLD;
  return {
    issue: result.issue,
    result,
    filesChanged,
    totalAdditions,
    totalDeletions,
    largeDiffWarning,
    estimatedPrCostUsd: result.costUsd,
  };
}

