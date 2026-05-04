import { describe, expect, it } from 'vitest';
import { RunState } from '../runState.js';
import type { AgentRunResult, IssueRef } from '../../types.js';

const issue: IssueRef = {
  repo: { owner: 'octo', name: 'demo' },
  number: 42,
  title: 'fix it',
  body: '',
  labels: [],
  commentsCount: 0,
  assignees: [],
  htmlUrl: 'https://github.com/octo/demo/issues/42',
  createdAt: '2026-05-04T00:00:00Z',
};

const baseResult = (
  override: Partial<AgentRunResult> & Pick<AgentRunResult, 'outcome'>,
): AgentRunResult => ({
  issue,
  model: 'composer-2',
  tokens: { input: 0, output: 0, cacheRead: 0 },
  costUsd: 0.1,
  startedAt: '2026-05-04T00:00:00Z',
  endedAt: '2026-05-04T00:01:00Z',
  cursorRunId: 'run_123',
  boundRepo: { owner: 'octo', name: 'demo' },
  testingNotes: '',
  ...override,
});

describe('RunState', () => {
  it('starts with zero counters and a startedAt', () => {
    const s = new RunState(2).snapshot();
    expect(s.totalCostUsd).toBe(0);
    expect(s.issuesAttempted).toBe(0);
    expect(s.costLimitHit).toBe(false);
    expect(s.startedAt).toMatch(/T/);
    expect(s.endedAt).toBeUndefined();
  });

  it('addCost accumulates totalCostUsd without touching counters', () => {
    const rs = new RunState(2);
    rs.addCost({ model: 'claude-haiku-4-5-20251001', tokens: { input: 0, output: 0, cacheRead: 0 }, usd: 0.05 });
    rs.addCost({ model: 'claude-haiku-4-5-20251001', tokens: { input: 0, output: 0, cacheRead: 0 }, usd: 0.07 });
    const s = rs.snapshot();
    expect(s.totalCostUsd).toBeCloseTo(0.12, 8);
    expect(s.issuesAttempted).toBe(0);
  });

  it('recordResult adds cost, increments attempted, and routes outcome counters', () => {
    const rs = new RunState(2);
    rs.recordResult(
      baseResult({
        costUsd: 0.5,
        outcome: { kind: 'success', branch: 'fix/x', diff: '', commitSha: 'abc', agentSummary: 'did it' },
      }),
    );
    rs.recordResult(baseResult({ costUsd: 0.1, outcome: { kind: 'skip', reason: 'unclear' } }));
    rs.recordResult(baseResult({ costUsd: 0.1, outcome: { kind: 'no_diff' } }));
    rs.recordResult(baseResult({ costUsd: 0.1, outcome: { kind: 'error', message: 'boom' } }));
    const s = rs.snapshot();
    expect(s.issuesAttempted).toBe(4);
    expect(s.skipped).toBe(2); // skip + no_diff
    expect(s.errors).toBe(1);
    expect(s.totalCostUsd).toBeCloseTo(0.8, 8);
    expect(s.perIssue).toHaveLength(4);
  });

  it('shouldAbortBeforeNextRun returns false below limit, true at/over, and sets costLimitHit', () => {
    const rs = new RunState(1);
    rs.addCost({ model: 'm', tokens: { input: 0, output: 0, cacheRead: 0 }, usd: 0.5 });
    expect(rs.shouldAbortBeforeNextRun()).toBe(false);
    expect(rs.snapshot().costLimitHit).toBe(false);
    rs.addCost({ model: 'm', tokens: { input: 0, output: 0, cacheRead: 0 }, usd: 0.6 });
    expect(rs.shouldAbortBeforeNextRun()).toBe(true);
    expect(rs.snapshot().costLimitHit).toBe(true);
  });

  it('snapshot perIssue is a copy — pushing to it does not mutate state', () => {
    const rs = new RunState(2);
    rs.recordResult(baseResult({ outcome: { kind: 'no_diff' } }));
    const s = rs.snapshot();
    s.perIssue.push(baseResult({ outcome: { kind: 'no_diff' } }));
    expect(rs.snapshot().perIssue).toHaveLength(1);
  });

  it('finish sets endedAt once', () => {
    const rs = new RunState(2);
    rs.finish();
    const first = rs.snapshot().endedAt;
    expect(first).toBeDefined();
    rs.finish();
    expect(rs.snapshot().endedAt).toBe(first);
  });

  it('PR / rejection / skip notes increment their counters', () => {
    const rs = new RunState(2);
    rs.notePRCreated();
    rs.notePRCreated();
    rs.noteReviewRejected();
    rs.noteReviewSkipped();
    rs.noteConsidered();
    rs.noteScored();
    const s = rs.snapshot();
    expect(s.prsCreated).toBe(2);
    expect(s.rejected).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.issuesConsidered).toBe(1);
    expect(s.issuesScored).toBe(1);
  });
});
