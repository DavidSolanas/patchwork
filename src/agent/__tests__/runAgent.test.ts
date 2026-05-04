import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { Octokit } from '@octokit/rest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgent } from '../runAgent.js';
import type { CursorClient, CursorEvent, RunSnapshot, StartRunInput } from '../cursorClient.js';
import type { IssueRef } from '../../types.js';

const TOKEN = 'ghp_test_token';
const makeTestOctokit = () => new Octokit({ auth: TOKEN });

function makeIssue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    repo: { owner: 'upstream', name: 'repo' },
    number: 42,
    title: 'crash on empty input',
    body: 'When foo runs with no args, it crashes.',
    labels: ['bug'],
    commentsCount: 1,
    assignees: [],
    htmlUrl: 'https://github.com/upstream/repo/issues/42',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

interface MockCursorOptions {
  events?: CursorEvent[];
  /** Snapshot returned by every getRun call. Pass a function to compute it dynamically. */
  snapshot: RunSnapshot | (() => RunSnapshot);
  /** If set, throws on the n-th event (0-indexed) to simulate a network drop. */
  throwOnEvent?: number;
}

function mockCursor(opts: MockCursorOptions): CursorClient & {
  startCalls: StartRunInput[];
  getCalls: number;
  cancelCalls: number;
  resumeCalls: number;
} {
  const startCalls: StartRunInput[] = [];
  let getCalls = 0;
  let cancelCalls = 0;
  let resumeCalls = 0;
  const events = opts.events ?? [];

  async function* makeEvents(skip = 0, throwAt?: number): AsyncGenerator<CursorEvent, void> {
    for (let i = skip; i < events.length; i++) {
      if (throwAt !== undefined && i === throwAt) {
        throw new Error('network drop');
      }
      yield events[i]!;
    }
  }

  return {
    startCalls,
    get getCalls() {
      return getCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    get resumeCalls() {
      return resumeCalls;
    },
    startRun: async (input: StartRunInput) => {
      startCalls.push(input);
      return {
        runId: 'run-1',
        events: makeEvents(0, opts.throwOnEvent),
      };
    },
    getRun: async () => {
      getCalls += 1;
      return typeof opts.snapshot === 'function' ? opts.snapshot() : opts.snapshot;
    },
    resumeEvents: (_runId, fromCursor) => {
      resumeCalls += 1;
      const skip = fromCursor ? Number(fromCursor) : 0;
      return makeEvents(skip);
    },
    cancelRun: async () => {
      cancelCalls += 1;
    },
  };
}

function mockNoExistingPR(times = 1) {
  return nock('https://api.github.com')
    .get('/search/issues')
    .times(times)
    .query(true)
    .reply(200, { total_count: 0, incomplete_results: false, items: [] });
}

function mockUserOwnsUpstream() {
  nock('https://api.github.com').get('/user').reply(200, { login: 'upstream' });
}

function mockNoTestFiles() {
  for (const p of ['package.json', 'pytest.ini', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile']) {
    nock('https://api.github.com').get(`/repos/upstream/repo/contents/${p}`).reply(404, {});
  }
}

function mockDefaultBranch(owner = 'upstream', name = 'repo', branch = 'main') {
  nock('https://api.github.com')
    .get(`/repos/${owner}/${name}`)
    .reply(200, { default_branch: branch });
}

let tmpStateDir: string;

beforeAll(() => nock.disableNetConnect());
beforeEach(async () => {
  tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patchwork-state-'));
});
afterEach(async () => {
  nock.cleanAll();
  await fs.rm(tmpStateDir, { recursive: true, force: true });
});
afterAll(() => nock.enableNetConnect());

const target = { model: 'composer-2', max_tokens_per_issue: 100_000 };
const noSleep = (ms: number) => {
  void ms;
  return Promise.resolve();
};
const statePath = () => path.join(tmpStateDir, 'state.json');

describe('runAgent', () => {
  it('skips immediately when a PR already exists (pre-agent dedup, invariant #7)', async () => {
    nock('https://api.github.com')
      .get('/search/issues')
      .query(true)
      .reply(200, {
        total_count: 1,
        items: [{ html_url: 'https://github.com/upstream/repo/pull/9' }],
      });

    const cursor = mockCursor({ snapshot: { status: 'completed', output: '' } });
    const result = await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 1,
      pollTimeoutMs: 1_000,
      statePath: statePath(),
      sleep: noSleep,
    });

    expect(result.outcome.kind).toBe('skip');
    if (result.outcome.kind === 'skip') {
      expect(result.outcome.reason).toContain('PR already exists');
    }
    expect(cursor.startCalls).toHaveLength(0);
  });

  it('reports a SKIP outcome when the agent emits SKIP: <reason>', async () => {
    mockNoExistingPR();
    mockUserOwnsUpstream();
    mockDefaultBranch();
    mockNoTestFiles();

    const cursor = mockCursor({
      events: [{ type: 'delta', cursor: '1', tokens: { input: 10, output: 5, cacheRead: 0 } }],
      snapshot: { status: 'completed', output: 'preamble\nSKIP: ambiguous request' },
    });
    const result = await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
      statePath: statePath(),
      sleep: noSleep,
    });

    expect(result.outcome.kind).toBe('skip');
    if (result.outcome.kind === 'skip') {
      expect(result.outcome.reason).toBe('ambiguous request');
    }
    expect(result.tokens).toEqual({ input: 10, output: 5, cacheRead: 0 });
    // Type-locked literal flows through.
    expect(cursor.startCalls[0]?.autoCreatePR).toBe(false);
  });

  it('reports no_diff when the agent finishes without producing a diff', async () => {
    mockNoExistingPR();
    mockUserOwnsUpstream();
    mockDefaultBranch();
    mockNoTestFiles();

    const cursor = mockCursor({
      snapshot: { status: 'completed', output: 'I looked but did not change anything.' },
    });
    const result = await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 1,
      pollTimeoutMs: 1_000,
      statePath: statePath(),
      sleep: noSleep,
    });

    expect(result.outcome.kind).toBe('no_diff');
  });

  it('builds a success outcome when the agent completes with a diff', async () => {
    mockNoExistingPR();
    mockUserOwnsUpstream();
    mockDefaultBranch();
    mockNoTestFiles();
    // commitSha is now fetched post-hoc via repos.getBranch (the SDK does not
    // expose the run's HEAD SHA). The other success-path tests rely on the
    // best-effort fallback to '' in fetchHeadSha and don't need this stub.
    nock('https://api.github.com')
      .get('/repos/upstream/repo/branches/patchwork%2Fissue-42-crash-on-empty-input')
      .reply(200, { commit: { sha: 'abc123' } });

    const cursor = mockCursor({
      snapshot: {
        status: 'completed',
        output: 'preamble\n\nFixed it by handling the empty case.',
        diff: 'diff --git a/x b/x\n+ok\n',
        branch: 'patchwork/issue-42-crash-on-empty-input',
      },
    });
    const result = await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
      statePath: statePath(),
      sleep: noSleep,
    });

    expect(result.outcome.kind).toBe('success');
    if (result.outcome.kind === 'success') {
      expect(result.outcome.branch).toBe('patchwork/issue-42-crash-on-empty-input');
      expect(result.outcome.diff).toContain('diff --git');
      expect(result.outcome.commitSha).toBe('abc123');
      expect(result.outcome.agentSummary).toContain('Fixed it');
    }
    expect(result.boundRepo).toEqual({ owner: 'upstream', name: 'repo' });
  });

  it('cancels the run and returns an error outcome on poll timeout', async () => {
    mockNoExistingPR();
    mockUserOwnsUpstream();
    mockDefaultBranch();
    mockNoTestFiles();

    const cursor = mockCursor({
      snapshot: { status: 'running', output: '' },
    });
    const result = await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 1,
      pollTimeoutMs: 5,
      statePath: statePath(),
      sleep: noSleep,
    });

    expect(result.outcome.kind).toBe('error');
    if (result.outcome.kind === 'error') {
      expect(result.outcome.message).toBe('agent run timed out');
    }
    expect(cursor.cancelCalls).toBe(1);
  });

  it('resumes the event stream from lastCursor on iterator throw', async () => {
    mockNoExistingPR();
    mockUserOwnsUpstream();
    mockDefaultBranch();
    mockNoTestFiles();

    // Stay 'running' until the event task has thrown + resumed. The mock's
    // resumeEvents bumps `cursor.resumeCalls`; we gate the transition to
    // 'completed' on that. A real (small) sleep is used so the event task
    // gets fs-I/O time between polls.
    const cursor: ReturnType<typeof mockCursor> = mockCursor({
      events: [
        { type: 'delta', cursor: '1', tokens: { input: 1, output: 1, cacheRead: 0 } },
        { type: 'delta', cursor: '2', tokens: { input: 2, output: 2, cacheRead: 0 } },
        { type: 'delta', cursor: '3', tokens: { input: 3, output: 3, cacheRead: 0 } },
      ],
      throwOnEvent: 2,
      snapshot: () =>
        cursor.resumeCalls > 0
          ? { status: 'completed', output: 'done', diff: 'diff --git a/x b/x\n+ok' }
          : { status: 'running', output: '' },
    });
    const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const result = await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 5,
      pollTimeoutMs: 5_000,
      statePath: statePath(),
      sleep: realSleep,
    });

    expect(result.outcome.kind).toBe('success');
    expect(cursor.resumeCalls).toBeGreaterThanOrEqual(1);
    // First two events accumulated before the throw, third event after resume.
    expect(result.tokens.input).toBe(1 + 2 + 3);
  });

  it('checkpoints state on startup and clears it on terminal outcome', async () => {
    mockNoExistingPR();
    mockUserOwnsUpstream();
    mockDefaultBranch();
    mockNoTestFiles();

    const cursor = mockCursor({
      snapshot: { status: 'completed', output: 'done', diff: 'diff' },
    });
    const sp = statePath();
    await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
      statePath: sp,
      sleep: noSleep,
    });

    const raw = await fs.readFile(sp, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.inFlight).toEqual({});
  });

  it('returns an error outcome when the run finishes in failed status', async () => {
    mockNoExistingPR();
    mockUserOwnsUpstream();
    mockDefaultBranch();
    mockNoTestFiles();

    const cursor = mockCursor({
      snapshot: { status: 'failed', output: '', error: 'compile error' },
    });
    const result = await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 1,
      pollTimeoutMs: 1_000,
      statePath: statePath(),
      sleep: noSleep,
    });

    expect(result.outcome.kind).toBe('error');
    if (result.outcome.kind === 'error') {
      expect(result.outcome.message).toBe('compile error');
    }
  });

  it('forks the repo when the user does not own upstream', async () => {
    mockNoExistingPR();
    nock('https://api.github.com').get('/user').reply(200, { login: 'alice' });
    nock('https://api.github.com')
      .get('/repos/alice/repo')
      .reply(200, { parent: { full_name: 'upstream/repo' } });
    mockDefaultBranch('alice', 'repo');
    mockNoTestFiles();

    const cursor = mockCursor({
      snapshot: { status: 'completed', output: 'done', diff: 'diff' },
    });
    const result = await runAgent(makeIssue(), target, {
      cursor,
      octokit: makeTestOctokit(),
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
      statePath: statePath(),
      sleep: noSleep,
    });

    expect(result.boundRepo).toEqual({ owner: 'alice', name: 'repo' });
    expect(cursor.startCalls[0]?.repoUrl).toBe('https://github.com/alice/repo');
  });
});
