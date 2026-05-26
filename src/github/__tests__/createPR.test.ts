import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { Octokit } from '@octokit/rest';
import { createPR } from '../createPR.js';
import type { IssueRef, SuccessfulAgentRunResult } from '../../types.js';

const TOKEN = 'ghp_test_token';
const makeTestOctokit = () => new Octokit({ auth: TOKEN });

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

function makeIssue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    repo: { owner: 'upstream', name: 'repo' },
    number: 42,
    title: 'segfault on load',
    body: 'reproduce by running foo',
    labels: [],
    commentsCount: 0,
    assignees: [],
    htmlUrl: 'https://github.com/upstream/repo/issues/42',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

function makeResult(overrides: Partial<SuccessfulAgentRunResult> = {}): SuccessfulAgentRunResult {
  const issue = overrides.issue ?? makeIssue();
  return {
    issue,
    outcome: {
      kind: 'success',
      branch: 'patchwork/issue-42-segfault-on-load',
      diff: 'diff --git a/x b/x\n',
      commitSha: 'abc1234',
      agentSummary: 'Replaced unwrap() with a graceful error path.',
    },
    model: 'composer-2',
    tokens: { input: 1000, output: 500, cacheRead: 0 },
    costUsd: 0.0025,
    startedAt: '2026-05-01T00:00:00Z',
    endedAt: '2026-05-01T00:05:00Z',
    cursorRunId: 'run_123',
    boundRepo: { owner: 'alice', name: 'repo' },
    testingNotes: 'npm test',
    ...overrides,
  };
}

function mockNoExistingPR() {
  nock('https://api.github.com')
    .get('/search/issues')
    .query(true)
    .reply(200, { total_count: 0, incomplete_results: false, items: [] });
}

function mockUserIs(login: string) {
  nock('https://api.github.com').get('/user').reply(200, { login });
}

function mockDefaultBranch(owner: string, name: string, branch: string) {
  nock('https://api.github.com')
    .get(`/repos/${owner}/${name}`)
    .reply(200, { default_branch: branch, name, full_name: `${owner}/${name}` });
}

describe('createPR', () => {
  it('creates a PR with the cross-fork head prefix and the upstream default branch as base', async () => {
    mockNoExistingPR();
    // ensureFork: user is alice, owns alice/repo as a fork of upstream/repo.
    mockUserIs('alice');
    nock('https://api.github.com')
      .get('/repos/alice/repo')
      .reply(200, { parent: { full_name: 'upstream/repo' } });
    // upstream default branch.
    mockDefaultBranch('upstream', 'repo', 'main');

    let captured: any;
    nock('https://api.github.com')
      .post('/repos/upstream/repo/pulls', body => {
        captured = body;
        return true;
      })
      .reply(201, {
        html_url: 'https://github.com/upstream/repo/pull/77',
        number: 77,
      });

    const result = makeResult();
    const out = await createPR({
      octokit: makeTestOctokit(),
      result,
      upstream: { owner: 'upstream', name: 'repo' },
      testedLocally: false,
    });

    expect(out).toEqual({ url: 'https://github.com/upstream/repo/pull/77', number: 77 });
    expect(captured.head).toBe('alice:patchwork/issue-42-segfault-on-load');
    expect(captured.base).toBe('main');
    expect(captured.draft).toBe(false);
    expect(captured.title).toBe('fix: segfault on load (#42)');
  });

  it('always embeds the AI disclosure block in the PR body (invariant #4)', async () => {
    mockNoExistingPR();
    mockUserIs('upstream'); // user owns upstream — ensureFork is a no-op
    mockDefaultBranch('upstream', 'repo', 'main');

    let captured: any;
    nock('https://api.github.com')
      .post('/repos/upstream/repo/pulls', body => {
        captured = body;
        return true;
      })
      .reply(201, { html_url: 'https://github.com/upstream/repo/pull/1', number: 1 });

    await createPR({
      octokit: makeTestOctokit(),
      result: makeResult({ boundRepo: { owner: 'upstream', name: 'repo' } }),
      upstream: { owner: 'upstream', name: 'repo' },
      testedLocally: false,
    });

    expect(captured.body).toContain('AI Disclosure');
    expect(captured.body).toContain('developed with AI assistance using the Cursor SDK');
    expect(captured.body).toContain('(composer-2 model)');
    expect(captured.body).toContain('Fixes #42');
  });

  it('records local testing in the disclosure when testedLocally is true', async () => {
    mockNoExistingPR();
    mockUserIs('upstream');
    mockDefaultBranch('upstream', 'repo', 'main');

    let captured: { body: string };
    nock('https://api.github.com')
      .post('/repos/upstream/repo/pulls', body => {
        captured = body;
        return true;
      })
      .reply(201, { html_url: 'https://github.com/upstream/repo/pull/3', number: 3 });

    await createPR({
      octokit: makeTestOctokit(),
      result: makeResult({ boundRepo: { owner: 'upstream', name: 'repo' } }),
      upstream: { owner: 'upstream', name: 'repo' },
      testedLocally: true,
    });

    expect(captured!.body).toContain('reviewed, tested locally, and approved');
  });

  it('honours non-`main` default branches', async () => {
    mockNoExistingPR();
    mockUserIs('upstream');
    mockDefaultBranch('upstream', 'repo', 'develop');

    let captured: any;
    nock('https://api.github.com')
      .post('/repos/upstream/repo/pulls', body => {
        captured = body;
        return true;
      })
      .reply(201, { html_url: 'https://github.com/upstream/repo/pull/2', number: 2 });

    await createPR({
      octokit: makeTestOctokit(),
      result: makeResult({ boundRepo: { owner: 'upstream', name: 'repo' } }),
      upstream: { owner: 'upstream', name: 'repo' },
      testedLocally: false,
    });
    expect(captured.base).toBe('develop');
  });

  it('returns the existing PR and does NOT call pulls.create when dedup finds one', async () => {
    nock('https://api.github.com')
      .get('/search/issues')
      .query(true)
      .reply(200, {
        total_count: 1,
        incomplete_results: false,
        items: [{ html_url: 'https://github.com/upstream/repo/pull/99' }],
      });

    const warnings: string[] = [];
    const out = await createPR({
      octokit: makeTestOctokit(),
      result: makeResult(),
      upstream: { owner: 'upstream', name: 'repo' },
      testedLocally: false,
      warn: msg => warnings.push(msg),
    });

    expect(out).toEqual({ url: 'https://github.com/upstream/repo/pull/99', number: 99 });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('upstream/repo#42');
    // Nothing else should have been requested — pendingMocks is empty by definition
    // (only one mock was registered) and no extra interceptors are needed.
    expect(nock.pendingMocks()).toEqual([]);
  });
});
