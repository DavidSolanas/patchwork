import type { Octokit } from './octokit.js';
import { findExistingPR, type DedupCache } from './deduplication.js';
import { ensureFork } from './forkRepo.js';
import { renderPRBody, renderPRTitle } from './prTemplate.js';
import { PatchworkError, type SuccessfulAgentRunResult } from '../types.js';

export interface CreatePRInput {
  octokit: Octokit;
  result: SuccessfulAgentRunResult;
  upstream: { owner: string; name: string };
  /** Shared per-run dedup cache. Threads through invariant #7's three checkpoints. */
  dedupCache?: DedupCache;
  /** Optional logger — defaults to `console.warn` for the dedup-collision path. */
  warn?: (msg: string) => void;
}

export interface CreatePRResult {
  url: string;
  number: number;
}

/**
 * Create the GitHub pull request for an approved agent run.
 *
 * **This is the single allowed caller of `octokit.pulls.create`.** Invariant
 * #1 is enforced by ESLint `no-restricted-imports` plus a CI grep audit; do
 * not add a second caller.
 *
 * Flow (PLAN.md §758):
 *  1. Final dedup re-check (invariant #7, third checkpoint). If a PR now
 *     references the issue, return its url/number — never duplicate.
 *  2. Idempotent `ensureFork` (no-op when the user owns upstream).
 *  3. Read `upstream.default_branch` for the PR base.
 *  4. `pulls.create` with the cross-fork `owner:branch` head prefix.
 *  5. Return `{ url, number }`.
 *
 * The PR body always includes the standardised AI disclosure block
 * (invariant #4) — this function delegates to `renderPRBody`, which has no
 * suppression flag.
 */
export async function createPR(input: CreatePRInput): Promise<CreatePRResult> {
  const { octokit, result, upstream } = input;
  const warn = input.warn ?? ((msg: string) => console.warn(msg));

  // 1. Final dedup re-check.
  const existing = await findExistingPR(octokit, result.issue, input.dedupCache);
  if (existing.exists && existing.url) {
    warn(
      `An open PR already references ${result.issue.repo.owner}/${result.issue.repo.name}#${result.issue.number}: ${existing.url} — skipping create.`,
    );
    return { url: existing.url, number: parsePRNumber(existing.url) };
  }

  // 2. Idempotent fork re-check. (No network round-trip for the user-owns-upstream case.)
  await ensureFork(octokit, upstream);

  // 3. Default branch is the PR base.
  const repo = await octokit.repos.get({ owner: upstream.owner, repo: upstream.name });
  const baseBranch = repo.data.default_branch;

  // 4. Create the PR.
  const head = `${result.boundRepo.owner}:${result.outcome.branch}`;
  const created = await octokit.pulls.create({
    owner: upstream.owner,
    repo: upstream.name,
    title: renderPRTitle(result.issue),
    body: renderPRBody({
      issue: result.issue,
      model: result.model,
      agentSummary: result.outcome.agentSummary,
      testingNotes: result.testingNotes,
    }),
    head,
    base: baseBranch,
    draft: false,
  });

  return { url: created.data.html_url, number: created.data.number };
}

/**
 * Extract the PR number from a GitHub pull-request URL like
 * `https://github.com/owner/name/pull/123`. The dedup search returns the
 * URL but not the number, so we parse it back out for the caller.
 */
function parsePRNumber(url: string): number {
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  if (!m) {
    throw new PatchworkError(
      `Could not parse PR number from URL: ${url}`,
      'Expected a GitHub PR URL of the form https://github.com/<owner>/<name>/pull/<N>.',
    );
  }
  return Number.parseInt(m[1]!, 10);
}
