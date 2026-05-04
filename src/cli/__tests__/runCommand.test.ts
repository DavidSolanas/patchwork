import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ConsoleReporter } from '../../reporter/console.js';
import { DeferredQueue } from '../../review/queue.js';
import type { CursorClient } from '../../agent/cursorClient.js';
import type { Octokit } from '../../github/octokit.js';
import type {
  IssueRef,
  ReviewDecision,
  ReviewPayload,
  ReviewSurface,
  TriageScore,
} from '../../types.js';
import { buildReviewPayload, executeRun } from '../runCommand.js';
import type { PatchworkConfig } from '../../config/schema.js';

function makeIssue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    repo: { owner: 'octo', name: 'demo' },
    number: 42,
    title: 'fix it',
    body: 'reproduction',
    labels: ['bug'],
    commentsCount: 1,
    assignees: [],
    htmlUrl: 'https://github.com/octo/demo/issues/42',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<PatchworkConfig['settings']> = {}): PatchworkConfig {
  return {
    targets: [
      {
        repo: 'octo/demo',
        labels: [],
        max_issues: 5,
        max_tokens_per_issue: 150_000,
        skip_if_comments_gt: 30,
        model: 'composer-2-standard',
      },
    ],
    settings: {
      mode: 'sequential',
      dry_run: false,
      min_score: 7,
      cost_limit_usd: 2,
      ...overrides,
    },
  };
}

function makeOctokit(issues: IssueRef[], existingPR = false): Octokit {
  const raw = issues.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    labels: i.labels.map((name) => ({ name })),
    comments: i.commentsCount,
    assignees: [],
    html_url: i.htmlUrl,
    created_at: i.createdAt,
  }));
  return {
    rest: { issues: { listForRepo: () => undefined } },
    paginate: {
      iterator: () => (async function* () { yield { data: raw }; })(),
    },
    request: vi.fn(async () => ({
      data: {
        total_count: existingPR ? 1 : 0,
        items: existingPR ? [{ html_url: 'https://github.com/octo/demo/pull/9' }] : [],
      },
    })),
  } as unknown as Octokit;
}

function makeAnthropicReturning(score: TriageScore): Anthropic {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'submit_triage_score',
            input: {
              breakdown: score.breakdown,
              reason: score.reason,
              recommendation: score.recommendation,
            },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      })),
    },
  } as unknown as Anthropic;
}

function spyCursor(): CursorClient & { startRunCalls: number } {
  const startRun = vi.fn();
  return {
    startRun,
    getRun: vi.fn(),
    resumeEvents: vi.fn(),
    cancelRun: vi.fn(),
    get startRunCalls() {
      return (startRun as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    },
  } as unknown as CursorClient & { startRunCalls: number };
}

function silentReporter(): ConsoleReporter {
  // Direct stream into a no-op writable.
  const sink = {
    write: () => true,
    isTTY: false,
  } as unknown as NodeJS.WriteStream;
  return new ConsoleReporter(sink);
}

function neverSurface(): ReviewSurface {
  return {
    interactive: false,
    present: vi.fn<(p: ReviewPayload) => Promise<ReviewDecision>>(async () => {
      throw new Error('surface should not be invoked');
    }),
  };
}

async function withTmpSummary<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'patchwork-runcmd-'));
  const path = join(dir, 'SUMMARY.md');
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('executeRun (orchestrator)', () => {
  it('--dry-run never invokes cursor.startRun even when score passes threshold', async () => {
    const octo = makeOctokit([makeIssue()]);
    const anthropic = makeAnthropicReturning({
      score: 9,
      breakdown: { clarity: 3, scope: 3, context: 2, viability: 1 },
      reason: 'looks good',
      recommendation: 'fix',
    });
    const cursor = spyCursor();
    const surface = neverSurface();
    const queue = new DeferredQueue('/tmp/patchwork-test-deferred-' + Date.now() + '.json');
    const reporter = silentReporter();

    const config = makeConfig();

    await withTmpSummary(async (summaryPath) => {
      const stats = await executeRun(
        config,
        { octokit: octo, anthropic, cursor, reporter, surface, queue, summaryPath },
        { dryRun: true },
      );
      expect(stats.issuesScored).toBe(1);
      expect(stats.issuesAttempted).toBe(0);
      expect(cursor.startRunCalls).toBe(0);
      expect(surface.present).not.toHaveBeenCalled();
    });
  });

  it('skips below-threshold scores without dispatching', async () => {
    const octo = makeOctokit([makeIssue()]);
    const anthropic = makeAnthropicReturning({
      score: 3,
      breakdown: { clarity: 1, scope: 1, context: 0, viability: 1 },
      reason: 'too vague',
      recommendation: 'skip',
    });
    const cursor = spyCursor();
    const surface = neverSurface();
    const queue = new DeferredQueue('/tmp/patchwork-test-deferred-' + Date.now() + '.json');
    const reporter = silentReporter();

    await withTmpSummary(async (summaryPath) => {
      const stats = await executeRun(
        makeConfig({ min_score: 7 }),
        { octokit: octo, anthropic, cursor, reporter, surface, queue, summaryPath },
        { dryRun: false },
      );
      expect(stats.issuesScored).toBe(1);
      expect(stats.issuesAttempted).toBe(0);
      expect(cursor.startRunCalls).toBe(0);
    });
  });

  it('skips pre-triage when an open PR already references the issue', async () => {
    const octo = makeOctokit([makeIssue()], /* existingPR */ true);
    const anthropic = makeAnthropicReturning({
      score: 9,
      breakdown: { clarity: 3, scope: 3, context: 2, viability: 1 },
      reason: 'never reached',
      recommendation: 'fix',
    });
    const cursor = spyCursor();
    const surface = neverSurface();
    const queue = new DeferredQueue('/tmp/patchwork-test-deferred-' + Date.now() + '.json');
    const reporter = silentReporter();

    await withTmpSummary(async (summaryPath) => {
      const stats = await executeRun(
        makeConfig(),
        { octokit: octo, anthropic, cursor, reporter, surface, queue, summaryPath },
        { dryRun: false },
      );
      expect(stats.issuesScored).toBe(0);
      expect(stats.issuesConsidered).toBe(1);
      expect(cursor.startRunCalls).toBe(0);
    });
  });

  it('writes a SUMMARY.md atomically', async () => {
    const octo = makeOctokit([makeIssue()]);
    const anthropic = makeAnthropicReturning({
      score: 3,
      breakdown: { clarity: 1, scope: 1, context: 0, viability: 1 },
      reason: 'meh',
      recommendation: 'skip',
    });
    const cursor = spyCursor();
    const surface = neverSurface();
    const queue = new DeferredQueue('/tmp/patchwork-test-deferred-' + Date.now() + '.json');
    const reporter = silentReporter();

    await withTmpSummary(async (summaryPath) => {
      await executeRun(
        makeConfig(),
        { octokit: octo, anthropic, cursor, reporter, surface, queue, summaryPath },
        { dryRun: false },
      );
      const body = await readFile(summaryPath, 'utf8');
      expect(body).toContain('# Patchwork run summary');
    });
  });

  it('throws when --repo does not match any target', async () => {
    const octo = makeOctokit([]);
    const anthropic = makeAnthropicReturning({
      score: 0,
      breakdown: { clarity: 0, scope: 0, context: 0, viability: 0 },
      reason: 'unused',
      recommendation: 'skip',
    });
    const cursor = spyCursor();
    const surface = neverSurface();
    const queue = new DeferredQueue('/tmp/patchwork-test-deferred-' + Date.now() + '.json');
    const reporter = silentReporter();

    await withTmpSummary(async (summaryPath) => {
      await expect(
        executeRun(
          makeConfig(),
          { octokit: octo, anthropic, cursor, reporter, surface, queue, summaryPath },
          { dryRun: false, repo: 'no/match' },
        ),
      ).rejects.toThrow(/did not match any target/);
    });
  });
});

describe('buildReviewPayload', () => {
  it('flags large diffs and counts additions/deletions', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      'index 1..2 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,3 @@',
      ' a',
      '+b',
      '+c',
      '-d',
    ].join('\n') + '\n';

    const payload = buildReviewPayload({
      issue: makeIssue(),
      outcome: { kind: 'success', branch: 'b', diff, commitSha: 'sha', agentSummary: 's' },
      model: 'composer-2-standard',
      tokens: { input: 0, output: 0, cacheRead: 0 },
      costUsd: 0.01,
      startedAt: '',
      endedAt: '',
      cursorRunId: '',
      boundRepo: { owner: 'me', name: 'demo' },
      testingNotes: '',
    });
    expect(payload.totalAdditions).toBe(2);
    expect(payload.totalDeletions).toBe(1);
    expect(payload.filesChanged).toHaveLength(1);
    expect(payload.largeDiffWarning).toBe(false);
    expect(payload.estimatedPrCostUsd).toBe(0.01);
  });
});
