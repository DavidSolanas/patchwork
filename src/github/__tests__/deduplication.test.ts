import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { Octokit } from '@octokit/rest';
import { createDedupCache, dedupKey, findExistingPR } from '../deduplication.js';
import type { IssueRef } from '../../types.js';

const TOKEN = 'ghp_test_token';

// Plain Octokit (no throttling/retry plugins) — the production factory enforces
// a 2-second minimum delay between Search API calls, which is correct behaviour
// but makes the test suite slow. We're testing findExistingPR's logic, not the
// plugins.
const makeTestOctokit = () => new Octokit({ auth: TOKEN });

function makeIssue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    repo: { owner: 'o', name: 'r' },
    number: 7,
    title: 't',
    body: 'b',
    labels: [],
    commentsCount: 0,
    assignees: [],
    htmlUrl: 'https://github.com/o/r/issues/7',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('findExistingPR', () => {
  it('returns exists:false when no matching PR is found', async () => {
    nock('https://api.github.com')
      .get('/search/issues')
      .query(q => typeof q.q === 'string' && q.q.includes('repo:o/r') && q.q.includes('#7'))
      .reply(200, { total_count: 0, incomplete_results: false, items: [] });

    const octokit = makeTestOctokit();
    const result = await findExistingPR(octokit, makeIssue());
    expect(result).toEqual({ exists: false });
  });

  it('returns exists:true with the PR url when a match is found', async () => {
    nock('https://api.github.com')
      .get('/search/issues')
      .query(true)
      .reply(200, {
        total_count: 1,
        incomplete_results: false,
        items: [{ html_url: 'https://github.com/o/r/pull/99', number: 99 }],
      });

    const octokit = makeTestOctokit();
    const result = await findExistingPR(octokit, makeIssue());
    expect(result).toEqual({ exists: true, url: 'https://github.com/o/r/pull/99' });
  });

  it('builds the search query exactly as PLAN specifies', async () => {
    let capturedQuery = '';
    nock('https://api.github.com')
      .get('/search/issues')
      .query(q => {
        capturedQuery = String(q.q);
        return true;
      })
      .reply(200, { total_count: 0, incomplete_results: false, items: [] });

    const octokit = makeTestOctokit();
    await findExistingPR(octokit, makeIssue({ number: 123 }));
    expect(capturedQuery).toBe('repo:o/r is:pr is:open #123 in:body');
  });

  it('re-queries after a negative result so a later PR is detected', async () => {
    nock('https://api.github.com')
      .get('/search/issues')
      .query(true)
      .reply(200, { total_count: 0, incomplete_results: false, items: [] });
    nock('https://api.github.com')
      .get('/search/issues')
      .query(true)
      .reply(200, {
        total_count: 1,
        incomplete_results: false,
        items: [{ html_url: 'https://github.com/o/r/pull/42', number: 42 }],
      });

    const octokit = makeTestOctokit();
    const cache = createDedupCache();
    const issue = makeIssue();

    const first = await findExistingPR(octokit, issue, cache);
    const second = await findExistingPR(octokit, issue, cache);

    expect(first).toEqual({ exists: false });
    expect(second).toEqual({ exists: true, url: 'https://github.com/o/r/pull/42' });
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('memoises positive hits in the supplied cache (one network call across many lookups)', async () => {
    nock('https://api.github.com')
      .get('/search/issues')
      .query(true)
      .reply(200, {
        total_count: 1,
        incomplete_results: false,
        items: [{ html_url: 'https://github.com/o/r/pull/99' }],
      });

    const octokit = makeTestOctokit();
    const cache = createDedupCache();
    const issue = makeIssue();

    const a = await findExistingPR(octokit, issue, cache);
    const b = await findExistingPR(octokit, issue, cache);
    const c = await findExistingPR(octokit, issue, cache);

    expect(a).toEqual({ exists: true, url: 'https://github.com/o/r/pull/99' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // nock.cleanAll in afterEach + a single .reply means a second HTTP call would error.
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('issues separate searches for distinct issues even when sharing a cache', async () => {
    nock('https://api.github.com')
      .get('/search/issues')
      .query(q => String(q.q).includes('#1'))
      .reply(200, { total_count: 0, incomplete_results: false, items: [] });
    nock('https://api.github.com')
      .get('/search/issues')
      .query(q => String(q.q).includes('#2'))
      .reply(200, {
        total_count: 1,
        incomplete_results: false,
        items: [{ html_url: 'https://github.com/o/r/pull/55' }],
      });

    const octokit = makeTestOctokit();
    const cache = createDedupCache();
    const r1 = await findExistingPR(octokit, makeIssue({ number: 1 }), cache);
    const r2 = await findExistingPR(octokit, makeIssue({ number: 2 }), cache);

    expect(r1).toEqual({ exists: false });
    expect(r2).toEqual({ exists: true, url: 'https://github.com/o/r/pull/55' });
  });

  it('dedupKey produces owner/name#N', () => {
    expect(dedupKey(makeIssue({ repo: { owner: 'foo', name: 'bar' }, number: 9 }))).toBe('foo/bar#9');
  });
});
