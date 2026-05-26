import { Agent } from '@cursor/sdk';
import type { SDKAgent } from '@cursor/sdk';
import type { TokenUsage } from '../types.js';

/**
 * Patchwork-internal Cursor SDK boundary.
 *
 * The real SDK surface is large and evolving (see `@cursor/sdk`'s
 * `Agent.create` / `agent.send` / `Run.stream` / `Agent.getRun`).
 * This file is the *only* place those calls happen — every other module
 * depends on the `CursorClient` interface below. PLAN.md's risk register
 * for Phase 3 explicitly relies on this isolation: "All SDK calls live
 * behind `cursorClient.ts`".
 */

export interface StartRunInput {
  repoUrl: string;
  startingRef: string;
  prompt: string;
  model: string;
  /**
   * Invariant #2: type-locked to the literal `false`. Setting this to
   * `true` is a compile error throughout the codebase. Patchwork creates
   * PRs only via `src/github/createPR.ts` after explicit human approval.
   */
  autoCreatePR: false;
  // skillFiles is intentionally absent: the SDK has no such parameter.
  // Cursor cloud agents discover .cursor/skills/ from the bound repo automatically.
  // maxTokens is intentionally absent: the SDK has no token-cap parameter.
  // Budget enforcement is handled by RunState.shouldAbortBeforeNextRun() (invariant #9).
}

export interface RunSnapshot {
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** Agent output with structured blocks removed. */
  output: string;
  /** Patch-stripped agent text; retains `<summary>` for parseResult. */
  parseOutput?: string;
  /** Unified diff extracted from the agent's `<patch>...</patch>` block, if present. */
  diff?: string;
  branch?: string;
  // commitSha is intentionally absent: the SDK does not expose the run's HEAD
  // SHA, so runAgent fetches it post-hoc via `octokit.repos.getBranch`.
  error?: string;
}

export type CursorEvent =
  | { type: 'step'; cursor: string; tokens: TokenUsage }
  | { type: 'delta'; cursor: string; tokens: TokenUsage };

export interface CursorClient {
  startRun(input: StartRunInput): Promise<{ runId: string; events: AsyncIterable<CursorEvent> }>;
  getRun(runId: string): Promise<RunSnapshot>;
  resumeEvents(runId: string, fromCursor?: string): AsyncIterable<CursorEvent>;
  cancelRun(runId: string): Promise<void>;
}

export function makeCursorClient(apiKey: string): CursorClient {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('CURSOR_API_KEY is missing or empty.');
  }

  // Run handles indexed by run id so `getRun` / `cancelRun` / `resumeEvents`
  // can be served without hitting the SDK's static lookup APIs in the hot path.
  const runs = new Map<string, RunHandle>();

  return {
    async startRun(input) {
      const agent = await Agent.create({
        apiKey,
        model: { id: input.model },
        cloud: {
          repos: [{ url: input.repoUrl, startingRef: input.startingRef }],
          autoCreatePR: false,
        },
      });

      const run = await agent.send(input.prompt);
      const handle: RunHandle = { agent, run, output: '', cursor: 0 };
      runs.set(run.id, handle);
      return { runId: run.id, events: streamEvents(handle) };
    },

    async getRun(runId) {
      const handle = runs.get(runId);
      if (!handle) {
        throw new Error(`Unknown runId: ${runId}`);
      }
      return snapshotOf(handle);
    },

    resumeEvents(runId, fromCursor) {
      const handle = runs.get(runId);
      if (!handle) {
        throw new Error(`Unknown runId: ${runId}`);
      }
      // `fromCursor` is reserved for the day the SDK supports replaying a
      // partial event stream. For now we re-attach to the live stream — the
      // durable cloud run continues server-side regardless.
      void fromCursor;
      return streamEvents(handle);
    },

    async cancelRun(runId) {
      const handle = runs.get(runId);
      if (!handle) return;
      await handle.run.cancel();
    },
  };
}

interface RunHandle {
  agent: SDKAgent;
  run: Awaited<ReturnType<SDKAgent['send']>>;
  output: string;
  cursor: number;
}

async function* streamEvents(handle: RunHandle): AsyncGenerator<CursorEvent, void> {
  for await (const message of handle.run.stream()) {
    handle.cursor += 1;
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') handle.output += block.text;
      }
    }
    // The v1.x SDK does not yet surface token usage on stream messages.
    // We emit zero-token events so the runAgent loop's accounting still works
    // and update mechanically when the SDK adds usage fields.
    yield {
      type: 'delta',
      cursor: String(handle.cursor),
      tokens: { input: 0, output: 0, cacheRead: 0 },
    };
  }
}

// Matches the `<patch>...</patch>` block that buildPrompt instructs the agent
// to wrap its unified diff in. Capture group 1 holds the raw diff body.
const PATCH_BLOCK = /<patch>([\s\S]*?)<\/patch>/;
const SUMMARY_BLOCK = /<summary>([\s\S]*?)<\/summary>/;

async function snapshotOf(handle: RunHandle): Promise<RunSnapshot> {
  const status = mapStatus(handle.run.status);
  const branch = handle.run.git?.branches?.[0]?.branch;
  const result = handle.run.result;
  const raw = handle.output || (result ?? '');
  const m = PATCH_BLOCK.exec(raw);
  const diff = m ? m[1]!.trim() : undefined;
  const parseOutput = (diff !== undefined ? raw.replace(PATCH_BLOCK, '') : raw).trim();
  const output = parseOutput.replace(SUMMARY_BLOCK, '').trim();
  return {
    status,
    output,
    parseOutput,
    branch,
    diff,
  };
}

function mapStatus(s: string): RunSnapshot['status'] {
  switch (s) {
    case 'running':
      return 'running';
    case 'finished':
      return 'completed';
    case 'error':
    case 'cancelled':
      return 'failed';
    default:
      return 'queued';
  }
}
