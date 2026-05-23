import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COST_UNKNOWN_LABEL,
  _resetUnknownModelWarnings,
  formatCostUsd,
  formatTotalCostUsd,
  isCostUnknown,
  priceFor,
} from '../costs.js';
import type { AgentRunResult, RunStats, TokenUsage } from '../../types.js';

const tokens = (input: number, output: number, cacheRead = 0): TokenUsage => ({
  input,
  output,
  cacheRead,
});

describe('priceFor', () => {
  beforeEach(() => {
    _resetUnknownModelWarnings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses dedicated cache-read rate when present', () => {
    const cost = priceFor('composer-2', tokens(1_000_000, 0, 1_000_000));
    // input 0.50 + cache 0.20 = 0.70
    expect(cost).toBeCloseTo(0.7, 8);
  });

  it('sums input + output + cacheRead', () => {
    const cost = priceFor('claude-sonnet-4-6', tokens(1_000_000, 500_000, 200_000));
    // 3.00 + 7.50 + 0.06 = 10.56
    expect(cost).toBeCloseTo(10.56, 8);
  });

  it('warns once for an unknown model and returns 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(priceFor('not-a-model', tokens(1, 1))).toBe(0);
    expect(priceFor('not-a-model', tokens(1, 1))).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('isCostUnknown', () => {
  it('is true when cost and all token fields are zero', () => {
    expect(isCostUnknown(tokens(0, 0, 0), 0)).toBe(true);
  });

  it('is false when cost is non-zero', () => {
    expect(isCostUnknown(tokens(0, 0, 0), 0.01)).toBe(false);
  });

  it('is false when any token field is non-zero', () => {
    expect(isCostUnknown(tokens(1, 0, 0), 0)).toBe(false);
    expect(isCostUnknown(tokens(0, 1, 0), 0)).toBe(false);
    expect(isCostUnknown(tokens(0, 0, 1), 0)).toBe(false);
  });
});

describe('formatCostUsd', () => {
  it('renders cost unknown when telemetry is unavailable', () => {
    expect(formatCostUsd(0, tokens(0, 0, 0))).toBe(COST_UNKNOWN_LABEL);
  });

  it('renders numeric cost when usage exists', () => {
    expect(formatCostUsd(0.42, tokens(100, 200, 50))).toBe('$0.42');
  });
});

describe('formatTotalCostUsd', () => {
  const baseResult = (over: Partial<AgentRunResult> = {}): AgentRunResult => ({
    issue: {
      repo: { owner: 'o', name: 'r' },
      number: 1,
      title: 't',
      body: '',
      labels: [],
      commentsCount: 0,
      assignees: [],
      htmlUrl: 'https://github.com/o/r/issues/1',
      createdAt: '2026-05-04T00:00:00Z',
    },
    model: 'composer-2',
    tokens: { input: 0, output: 0, cacheRead: 0 },
    costUsd: 0,
    startedAt: '2026-05-04T00:00:00Z',
    endedAt: '2026-05-04T00:01:00Z',
    cursorRunId: 'run_1',
    boundRepo: { owner: 'o', name: 'r' },
    testingNotes: '',
    outcome: { kind: 'no_diff' },
    ...over,
  });

  const baseStats = (over: Partial<RunStats> = {}): RunStats => ({
    startedAt: '2026-05-04T00:00:00Z',
    issuesConsidered: 1,
    issuesScored: 1,
    issuesAttempted: 1,
    prsCreated: 0,
    rejected: 0,
    skipped: 0,
    errors: 0,
    totalCostUsd: 0,
    perIssue: [],
    costLimitHit: false,
    ...over,
  });

  it('renders cost unknown when total is zero and an issue has unavailable telemetry', () => {
    const stats = baseStats({ perIssue: [baseResult()] });
    expect(formatTotalCostUsd(stats)).toBe(COST_UNKNOWN_LABEL);
  });

  it('renders numeric total when known costs were recorded', () => {
    const stats = baseStats({ totalCostUsd: 0.05, perIssue: [baseResult({ costUsd: 0.05 })] });
    expect(formatTotalCostUsd(stats)).toBe('$0.05');
  });

  it('renders numeric zero when no issues ran', () => {
    expect(formatTotalCostUsd(baseStats())).toBe('$0.00');
  });
});
