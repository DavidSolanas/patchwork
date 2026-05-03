import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { fetchIssues } from '../fetchIssues.js';
import { makeOctokit } from '../octokit.js';

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  labels: ({ name: string } | string)[];
  comments: number;
  assignees: { login: string }[];
  html_url: string;
  created_at: string;
  pull_request?: { url: string };
  state?: string;
}

function buildIssue(overrides: Partial<RawIssue> & { number: number }): RawIssue {
  return {
    title: `Issue #${overrides.number}`,
    body: `Body for #${overrides.number}`,
    labels: [],
    comments: 0,
    assignees: [],
    html_url: `https://github.com/o/r/issues/${overrides.number}`,
    created_at: '2026-05-01T00:00:00Z',
    state: 'open',
    ...overrides,
  };
}

const TOKEN = 'ghp_test_token';

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe('fetchIssues', () => {
  it('drops PRs, assigned issues, drop-listed labels, over-commented issues, and empty bodies', async () => {
    const issues: RawIssue[] = [
      buildIssue({ number: 1 }), // ✓ keeper
      buildIssue({ number: 2, pull_request: { url: 'x' } }), // ✗ PR
      buildIssue({ number: 3, assignees: [{ login: 'alice' }] }), // ✗ assigned
      buildIssue({ number: 4, labels: [{ name: 'wontfix' }] }), // ✗ drop label
      buildIssue({ number: 5, labels: [{ name: 'NEEDS-DESIGN' }] }), // ✗ case-insensitive
      buildIssue({ number: 6, comments: 35 }), // ✗ over threshold
      buildIssue({ number: 7, body: '' }), // ✗ empty body
      buildIssue({ number: 8, body: '   \n  ' }), // ✗ whitespace-only body
      buildIssue({ number: 9, body: null }), // ✗ null body
      buildIssue({ number: 10 }), // ✓ keeper
    ];

    nock('https://api.github.com')
      .get('/repos/o/r/issues')
      .query(true)
      .reply(200, issues);

    const octokit = makeOctokit(TOKEN);
    const result = await fetchIssues({
      octokit,
      owner: 'o',
      name: 'r',
      labels: [],
      maxIssues: 50,
      skipIfCommentsGt: 30,
    });

    expect(result.map(i => i.number)).toEqual([1, 10]);
    expect(result[0].repo).toEqual({ owner: 'o', name: 'r' });
  });

  it('respects maxIssues short-circuit and stops paginating early', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => buildIssue({ number: i + 1 }));

    // Only the first page should be requested; if pagination continues, nock will fail with no match.
    nock('https://api.github.com')
      .get('/repos/o/r/issues')
      .query(q => q.page === undefined || q.page === '1')
      .reply(200, page1, {
        link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"',
      });

    const octokit = makeOctokit(TOKEN);
    const result = await fetchIssues({
      octokit,
      owner: 'o',
      name: 'r',
      labels: [],
      maxIssues: 5,
      skipIfCommentsGt: 30,
    });

    expect(result).toHaveLength(5);
    expect(result.map(i => i.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it('passes user-provided labels to the GitHub query', async () => {
    nock('https://api.github.com')
      .get('/repos/o/r/issues')
      .query(q => q.labels === 'good first issue,help wanted')
      .reply(200, []);

    const octokit = makeOctokit(TOKEN);
    const result = await fetchIssues({
      octokit,
      owner: 'o',
      name: 'r',
      labels: ['good first issue', 'help wanted'],
      maxIssues: 5,
      skipIfCommentsGt: 30,
    });

    expect(result).toEqual([]);
  });

  it('handles string labels (some endpoints return them inline)', async () => {
    nock('https://api.github.com')
      .get('/repos/o/r/issues')
      .query(true)
      .reply(200, [buildIssue({ number: 1, labels: ['bug', 'good first issue'] })]);

    const octokit = makeOctokit(TOKEN);
    const [issue] = await fetchIssues({
      octokit,
      owner: 'o',
      name: 'r',
      labels: [],
      maxIssues: 5,
      skipIfCommentsGt: 30,
    });

    expect(issue.labels).toEqual(['bug', 'good first issue']);
  });
});
