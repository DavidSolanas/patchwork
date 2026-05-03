import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { Octokit } from '@octokit/rest';
import { ensureFork, ForkConflictError } from '../forkRepo.js';

const TOKEN = 'ghp_test_token';
const makeTestOctokit = () => new Octokit({ auth: TOKEN });

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

function mockMe(login: string) {
  nock('https://api.github.com').get('/user').reply(200, { login });
}

describe('ensureFork', () => {
  it('is a no-op when the user owns upstream', async () => {
    mockMe('alice');
    const result = await ensureFork(makeTestOctokit(), { owner: 'alice', name: 'repo' });
    expect(result).toEqual({ owner: 'alice', name: 'repo', created: false });
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('returns the existing fork when one is already present', async () => {
    mockMe('alice');
    nock('https://api.github.com')
      .get('/repos/alice/repo')
      .reply(200, { parent: { full_name: 'upstream/repo' } });

    const result = await ensureFork(makeTestOctokit(), { owner: 'upstream', name: 'repo' });
    expect(result).toEqual({ owner: 'alice', name: 'repo', created: false });
  });

  it('throws ForkConflictError when alice/repo exists but is not a fork of upstream/repo', async () => {
    mockMe('alice');
    nock('https://api.github.com')
      .get('/repos/alice/repo')
      .reply(200, { parent: { full_name: 'somebody-else/repo' } });

    await expect(
      ensureFork(makeTestOctokit(), { owner: 'upstream', name: 'repo' }),
    ).rejects.toBeInstanceOf(ForkConflictError);
  });

  it('creates a fork on 404 and polls until it appears', async () => {
    mockMe('alice');
    nock('https://api.github.com').get('/repos/alice/repo').reply(404, {});
    nock('https://api.github.com').post('/repos/upstream/repo/forks').reply(202, {});
    // First poll: still missing.
    nock('https://api.github.com').get('/repos/alice/repo').reply(404, {});
    // Second poll: ready.
    nock('https://api.github.com')
      .get('/repos/alice/repo')
      .reply(200, { parent: { full_name: 'upstream/repo' } });

    const result = await ensureFork(
      makeTestOctokit(),
      { owner: 'upstream', name: 'repo' },
      { pollIntervalMs: 1, pollTimeoutMs: 1_000 },
    );
    expect(result).toEqual({ owner: 'alice', name: 'repo', created: true });
  });

  it('times out when the fork never appears', async () => {
    mockMe('alice');
    nock('https://api.github.com').get('/repos/alice/repo').reply(404, {});
    nock('https://api.github.com').post('/repos/upstream/repo/forks').reply(202, {});
    nock('https://api.github.com').get('/repos/alice/repo').times(20).reply(404, {});

    await expect(
      ensureFork(
        makeTestOctokit(),
        { owner: 'upstream', name: 'repo' },
        { pollIntervalMs: 1, pollTimeoutMs: 30 },
      ),
    ).rejects.toThrow(/Timed out/);
  });
});
