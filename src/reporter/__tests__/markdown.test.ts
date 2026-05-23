import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderSummary, writeSummary } from '../markdown.js';
import type { AgentRunResult, IssueRef, RunStats } from '../../types.js';

const issue: IssueRef = {
  repo: { owner: 'octo', name: 'demo' },
  number: 7,
  title: 'broken | thing',
  body: '',
  labels: [],
  commentsCount: 0,
  assignees: [],
  htmlUrl: 'https://github.com/octo/demo/issues/7',
  createdAt: '2026-05-04T00:00:00Z',
};

const result = (over: Partial<AgentRunResult> & Pick<AgentRunResult, 'outcome'>): AgentRunResult => ({
  issue,
  model: 'composer-2',
  tokens: { input: 100, output: 200, cacheRead: 50 },
  costUsd: 0.42,
  startedAt: '2026-05-04T00:00:00Z',
  endedAt: '2026-05-04T00:02:00Z',
  cursorRunId: 'run_abc',
  boundRepo: { owner: 'octo', name: 'demo' },
  testingNotes: '',
  ...over,
});

const baseStats = (over: Partial<RunStats> = {}): RunStats => ({
  startedAt: '2026-05-04T00:00:00Z',
  endedAt: '2026-05-04T00:10:00Z',
  issuesConsidered: 3,
  issuesScored: 2,
  issuesAttempted: 2,
  prsCreated: 1,
  rejected: 0,
  skipped: 1,
  errors: 0,
  totalCostUsd: 0.83,
  perIssue: [],
  costLimitHit: false,
  ...over,
});

describe('renderSummary', () => {
  it('emits the canonical header and counter list', () => {
    const md = renderSummary(baseStats());
    expect(md).toMatch(/^# Patchwork run summary/);
    expect(md).toContain('- **Started:** 2026-05-04T00:00:00Z');
    expect(md).toContain('- **Ended:**   2026-05-04T00:10:00Z');
    expect(md).toContain('- **Total cost:** $0.83');
    expect(md).toContain('Issues considered: 3');
    expect(md).toContain('PRs created:       1');
  });

  it('escapes pipe characters in issue titles to keep table valid', () => {
    const md = renderSummary(
      baseStats({
        perIssue: [result({ outcome: { kind: 'success', branch: 'fix/x', diff: '', commitSha: 'a', agentSummary: 's' } })],
      }),
    );
    expect(md).toContain('broken \\| thing');
  });

  it('marks cost limit hit when set', () => {
    const md = renderSummary(baseStats({ costLimitHit: true }));
    expect(md).toMatch(/cost limit hit/);
  });

  it('falls back to "(in progress)" when endedAt is missing', () => {
    const md = renderSummary(baseStats({ endedAt: undefined }));
    expect(md).toContain('(in progress)');
  });

  it('renders the empty-issues row when nothing ran', () => {
    const md = renderSummary(baseStats({ perIssue: [] }));
    expect(md).toContain('| _(none)_ |');
  });

  it('shows cost unknown when token telemetry is unavailable', () => {
    const md = renderSummary(
      baseStats({
        totalCostUsd: 0,
        perIssue: [
          result({
            tokens: { input: 0, output: 0, cacheRead: 0 },
            costUsd: 0,
            outcome: { kind: 'success', branch: 'fix/x', diff: '', commitSha: 'a', agentSummary: 's' },
          }),
        ],
      }),
    );
    expect(md).toContain('- **Total cost:** cost unknown');
    expect(md).toMatch(/\| cost unknown \|$/m);
    expect(md).toContain('- Cost: cost unknown');
    expect(md).not.toContain('$0.00');
  });
});

describe('writeSummary', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-summary-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes atomically — final file contains the rendered summary, no .tmp left over', async () => {
    const out = path.join(tmpDir, 'nested', 'SUMMARY.md');
    await writeSummary(baseStats(), out);
    const written = await fs.readFile(out, 'utf8');
    expect(written).toContain('# Patchwork run summary');
    const dirEntries = await fs.readdir(path.dirname(out));
    expect(dirEntries).not.toContain('SUMMARY.md.tmp');
  });
});
