import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { ConsoleReporter } from '../console.js';
import type { PatchworkConfig } from '../../config/schema.js';
import type { AgentRunResult, IssueRef, RunStats, TriageScore } from '../../types.js';

class CaptureStream extends Writable {
  chunks: string[] = [];
  isTTY = false;
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

const issue: IssueRef = {
  repo: { owner: 'octo', name: 'demo' },
  number: 1,
  title: 'thing',
  body: '',
  labels: [],
  commentsCount: 0,
  assignees: [],
  htmlUrl: 'https://github.com/octo/demo/issues/1',
  createdAt: '2026-05-04T00:00:00Z',
};

const config: PatchworkConfig = {
  targets: [
    {
      repo: 'octo/demo',
      labels: [],
      max_issues: 5,
      max_tokens_per_issue: 100,
      skip_if_comments_gt: 30,
      model: 'composer-2',
    },
  ],
  settings: { mode: 'sequential', dry_run: false, min_score: 7, cost_limit_usd: 2 },
};

const score: TriageScore = {
  score: 8,
  breakdown: { clarity: 2, scope: 2, context: 2, viability: 2 },
  reason: 'looks fixable',
  recommendation: 'fix',
};

const result = (kind: AgentRunResult['outcome']['kind']): AgentRunResult => ({
  issue,
  model: 'composer-2',
  tokens: { input: 0, output: 0, cacheRead: 0 },
  costUsd: 0.05,
  startedAt: '2026-05-04T00:00:00Z',
  endedAt: '2026-05-04T00:01:00Z',
  cursorRunId: 'run_1',
  boundRepo: { owner: 'octo', name: 'demo' },
  testingNotes: '',
  outcome:
    kind === 'success'
      ? { kind: 'success', branch: 'fix/x', diff: '', commitSha: 'abc', agentSummary: 's' }
      : kind === 'skip'
        ? { kind: 'skip', reason: 'unclear' }
        : kind === 'error'
          ? { kind: 'error', message: 'boom' }
          : { kind: 'no_diff' },
});

const stats: RunStats = {
  startedAt: '2026-05-04T00:00:00Z',
  endedAt: '2026-05-04T00:10:00Z',
  issuesConsidered: 1,
  issuesScored: 1,
  issuesAttempted: 1,
  prsCreated: 1,
  rejected: 0,
  skipped: 0,
  errors: 0,
  totalCostUsd: 0.05,
  perIssue: [],
  costLimitHit: false,
};

describe('ConsoleReporter (non-TTY)', () => {
  it('runs the full lifecycle without throwing and writes lines per event', () => {
    const stream = new CaptureStream() as unknown as NodeJS.WriteStream;
    const r = new ConsoleReporter(stream);
    r.start(config);
    r.issueStarting(issue, 'composer-2');
    r.issueScored(issue, score);
    r.issueAttempting(issue);
    r.agentResult(result('success'));
    r.reviewDecision(issue, { action: 'approve' });
    r.prCreated(issue, 'https://github.com/octo/demo/pull/123');
    r.costLimitHit(stats);
    r.end(stats);
    const out = (stream as unknown as CaptureStream).text();
    expect(out).toContain('patchwork starting');
    expect(out).toContain('octo/demo#1');
    expect(out).toContain('reviewer approved');
    expect(out).toContain('PR opened');
    expect(out).toContain('cost limit hit');
    expect(out).toContain('done');
  });

  it('handles every ReviewDecision action without falling through', () => {
    const stream = new CaptureStream() as unknown as NodeJS.WriteStream;
    const r = new ConsoleReporter(stream);
    r.reviewDecision(issue, { action: 'approve' });
    r.reviewDecision(issue, { action: 'reject', reason: 'wrong fix' });
    r.reviewDecision(issue, { action: 'skip', reason: 'later' });
    r.reviewDecision(issue, { action: 'open_external' });
    const out = (stream as unknown as CaptureStream).text();
    expect(out).toContain('approved');
    expect(out).toContain('rejected: wrong fix');
    expect(out).toContain('deferred: later');
    expect(out).toContain('opened externally');
  });

  it('shows cost unknown when token telemetry is unavailable', () => {
    const stream = new CaptureStream() as unknown as NodeJS.WriteStream;
    const r = new ConsoleReporter(stream);
    r.agentResult({
      ...result('success'),
      tokens: { input: 0, output: 0, cacheRead: 0 },
      costUsd: 0,
    });
    const out = (stream as unknown as CaptureStream).text();
    expect(out).toContain('cost unknown');
    expect(out).not.toContain('$0.00');
  });

  it('notes at end when agent cost telemetry was unavailable', () => {
    const stream = new CaptureStream() as unknown as NodeJS.WriteStream;
    const r = new ConsoleReporter(stream);
    r.end({
      ...stats,
      totalCostUsd: 0,
      perIssue: [
        {
          ...result('success'),
          tokens: { input: 0, output: 0, cacheRead: 0 },
          costUsd: 0,
        },
      ],
    });
    const out = (stream as unknown as CaptureStream).text();
    expect(out).toContain('Agent cost telemetry was unavailable; total USD reflects triage only.');
  });
});
