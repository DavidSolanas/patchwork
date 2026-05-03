import type { Octokit } from './octokit.js';
import { PatchworkError } from '../types.js';

const FORK_POLL_INTERVAL_MS = 2_000;
const FORK_POLL_TIMEOUT_MS = 60_000;

export class ForkConflictError extends PatchworkError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'ForkConflictError';
  }
}

export interface EnsureForkResult {
  owner: string;
  name: string;
  /** True only when this call created a fresh fork. */
  created: boolean;
}

export interface EnsureForkOptions {
  /** Override polling cadence — used by tests. */
  pollIntervalMs?: number;
  /** Override polling cap — used by tests. */
  pollTimeoutMs?: number;
}

/**
 * Resolve the repo the Cursor cloud agent should be bound to.
 *
 * If the authenticated user owns `upstream`, no fork is needed and the
 * function is a no-op. Otherwise it detects an existing fork or creates a
 * new one via `repos.createFork` and polls `repos.get` until the fork is
 * ready (bounded — Cursor cannot bind a non-existent repo).
 *
 * Throws `ForkConflictError` when the user owns an unrelated repo of the
 * same name (e.g. `me/utils` exists but its parent is not
 * `upstream-owner/utils`). The caller surfaces this with a hint to rename
 * the conflicting repo.
 */
export async function ensureFork(
  octokit: Octokit,
  upstream: { owner: string; name: string },
  options: EnsureForkOptions = {},
): Promise<EnsureForkResult> {
  const pollIntervalMs = options.pollIntervalMs ?? FORK_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? FORK_POLL_TIMEOUT_MS;

  const me = await octokit.users.getAuthenticated();
  const myLogin = me.data.login;

  if (myLogin === upstream.owner) {
    return { owner: upstream.owner, name: upstream.name, created: false };
  }

  const existing = await tryGetRepo(octokit, myLogin, upstream.name);
  if (existing) {
    const expectedParent = `${upstream.owner}/${upstream.name}`;
    const actualParent = existing.parent?.full_name;
    if (actualParent === expectedParent) {
      return { owner: myLogin, name: upstream.name, created: false };
    }
    throw new ForkConflictError(
      `${myLogin}/${upstream.name} already exists but is not a fork of ${expectedParent}.`,
      `Rename or delete ${myLogin}/${upstream.name} on GitHub before retrying, or use a token whose user does not own a conflicting repo.`,
    );
  }

  await octokit.repos.createFork({ owner: upstream.owner, repo: upstream.name });
  await pollUntilForkReady(octokit, myLogin, upstream, pollIntervalMs, pollTimeoutMs);
  return { owner: myLogin, name: upstream.name, created: true };
}

interface RepoLite {
  parent?: { full_name: string } | null;
}

async function tryGetRepo(
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<RepoLite | null> {
  try {
    const response = await octokit.repos.get({ owner, repo: name });
    return response.data as RepoLite;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

async function pollUntilForkReady(
  octokit: Octokit,
  myLogin: string,
  upstream: { owner: string; name: string },
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() <= deadline) {
    const repo = await tryGetRepo(octokit, myLogin, upstream.name);
    if (repo && repo.parent?.full_name === `${upstream.owner}/${upstream.name}`) {
      return;
    }
    await sleep(pollIntervalMs);
  }

  throw new PatchworkError(
    `Timed out waiting for ${myLogin}/${upstream.name} fork to become ready after ${Math.round(pollTimeoutMs / 1000)}s.`,
    'GitHub fork creation usually completes in a few seconds. Retry the run, or create the fork manually first.',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
