import { createDedupCache } from '../github/deduplication.js';
import { createPR } from '../github/createPR.js';
import { makeOctokit, type Octokit } from '../github/octokit.js';
import { ConsoleReporter } from '../reporter/console.js';
import { TerminalReviewSurface } from '../review/humanGate.js';
import { DeferredQueue, keyOf } from '../review/queue.js';
import {
  PatchworkError,
  type ReviewSurface,
} from '../types.js';
import { preflight } from './preflight.js';

export interface ReviewCommandOptions {
  /** Unused for now — review reads from the deferred queue, not the YAML. */
  config?: string;
}

export interface ReviewCommandDeps {
  octokit: Octokit;
  reporter: ConsoleReporter;
  surface: ReviewSurface;
  queue: DeferredQueue;
}

/**
 * `patchwork review` — re-present every entry in `.patchwork/deferred.json`
 * through the review surface and act on each decision identically to a
 * full run.
 */
export async function reviewCommand(
  opts: ReviewCommandOptions = {},
  deps?: ReviewCommandDeps,
): Promise<void> {
  void opts;
  preflight({ needsTty: true, needsCursor: false, needsAnthropic: false });
  const resolved = deps ?? buildDefaultDeps();
  await executeReview(resolved);
}

function buildDefaultDeps(): ReviewCommandDeps {
  const octokit = makeOctokit(process.env.GITHUB_TOKEN ?? '');
  const reporter = new ConsoleReporter();
  const surface = new TerminalReviewSurface();
  const queue = new DeferredQueue();
  return { octokit, reporter, surface, queue };
}

export async function executeReview(deps: ReviewCommandDeps): Promise<void> {
  const { octokit, reporter, surface, queue } = deps;
  const dedupCache = createDedupCache();
  const entries = await queue.list();

  if (entries.length === 0) {
    process.stdout.write('No deferred reviews. Run `patchwork run` first.\n');
    return;
  }

  for (const entry of entries) {
    const { payload } = entry;
    const decision = await surface.present(payload);
    reporter.reviewDecision(payload.issue, decision);

    switch (decision.action) {
      case 'approve': {
        const pr = await createPR({
          octokit,
          result: payload.result,
          upstream: payload.issue.repo,
          dedupCache,
        });
        reporter.prCreated(payload.issue, pr.url);
        await queue.remove(keyOf(entry));
        break;
      }
      case 'reject':
        await queue.remove(keyOf(entry));
        break;
      case 'skip':
        // Leave it on the queue.
        break;
      case 'open_external':
        // Surface re-prompts internally.
        break;
      default: {
        const _: never = decision;
        void _;
      }
    }
  }
}

// Surface as throwable so consumers can react to a corrupted-queue case.
export { PatchworkError };
