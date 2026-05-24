import type { Octokit } from '@octokit/rest';
import type { IssueRef } from '../types.js';

export interface DedupResult {
  exists: boolean;
  /** URL of the existing PR, if one was found. */
  url?: string;
}

/**
 * Per-run cache for `findExistingPR`. Keyed by `owner/name#N`.
 *
 * The Phase 6 orchestrator constructs one `Map` per `patchwork run` invocation
 * and threads it through all three dedup checkpoints (pre-triage, pre-agent,
 * pre-PR — see invariant #7). Only confirmed PR hits are memoised so negative
 * lookups stay fresh through the final guard. Tests pass a fresh `Map` per call.
 */
export type DedupCache = Map<string, DedupResult>;

export function createDedupCache(): DedupCache {
  return new Map();
}

export function dedupKey(issue: IssueRef): string {
  return `${issue.repo.owner}/${issue.repo.name}#${issue.number}`;
}

/**
 * Detect whether an open PR already references this issue, via GitHub's Search API.
 *
 * Called at three checkpoints in the pipeline (invariant #7):
 *  1. Pre-triage — cheap skip before paying for a Haiku call.
 *  2. Pre-agent — immediately before dispatching the Cursor agent.
 *  3. Pre-PR — final guard inside `createPR.ts` before `pulls.create`.
 *
 * If `cache` is supplied, **positive** hits (`exists: true`) are memoised by
 * `owner/name#N` for the lifetime of the run. Negative results are never
 * cached — a PR may appear between the pre-triage and pre-PR checkpoints
 * (invariant #7; see PLAN.md createPR risk table).
 *
 * Network errors from Search are surfaced (not swallowed) so the orchestrator
 * can decide whether to skip-on-error.
 */
export async function findExistingPR(
  octokit: Octokit,
  issue: IssueRef,
  cache?: DedupCache,
): Promise<DedupResult> {
  const key = dedupKey(issue);

  if (cache) {
    const cached = cache.get(key);
    if (cached?.exists) return cached;
  }

  const q = `repo:${issue.repo.owner}/${issue.repo.name} is:pr is:open #${issue.number} in:body`;

  // Calling `GET /search/issues` directly because the typed
  // `octokit.rest.search.issuesAndPullRequests` wrapper is deprecated.
  const response = await octokit.request('GET /search/issues', {
    q,
    per_page: 1,
  });

  const top = response.data.items[0];
  const result: DedupResult =
    response.data.total_count > 0 && top !== undefined
      ? { exists: true, url: top.html_url }
      : { exists: false };

  if (cache && result.exists) {
    cache.set(key, result);
  }
  return result;
}
