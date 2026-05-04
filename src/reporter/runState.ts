import type {
  AgentRunResult,
  CostEstimate,
  RunStats,
} from '../types.js';

/**
 * Mutable, in-memory aggregator of a patchwork run.
 *
 * Contracts (PLAN.md §842–854):
 *   - `shouldAbortBeforeNextRun()` is the **only** cost-limit gate. It is
 *     consulted between issues, never mid-run — Cursor cloud agents are
 *     durable, so killing one mid-flight wastes the spend (invariant #9).
 *   - All mutator methods are intended to be safe under future parallel
 *     orchestration. v0.1 is sequential, so JS single-threaded ordering
 *     provides natural serialisation for the synchronous mutators here.
 *     v0.2 parallel mode can replace the bodies with a Promise-chain queue
 *     without changing the surface.
 */
export class RunState {
  readonly #costLimitUsd: number;
  readonly #stats: RunStats;

  constructor(costLimitUsd: number) {
    this.#costLimitUsd = costLimitUsd;
    this.#stats = {
      startedAt: new Date().toISOString(),
      issuesConsidered: 0,
      issuesScored: 0,
      issuesAttempted: 0,
      prsCreated: 0,
      rejected: 0,
      skipped: 0,
      errors: 0,
      totalCostUsd: 0,
      perIssue: [],
      costLimitHit: false,
    };
  }

  /** Standalone cost (e.g. Haiku triage on a non-attempted issue). */
  addCost(c: CostEstimate): void {
    this.#stats.totalCostUsd += c.usd;
  }

  /**
   * Record the terminal outcome of an agent dispatch. Increments
   * `issuesAttempted` unconditionally and the outcome-specific counter for
   * non-success outcomes. PR creation and review rejection are signalled
   * separately via `notePRCreated` / `noteReviewRejected` /
   * `noteReviewSkipped` because they happen *after* the agent run.
   */
  recordResult(r: AgentRunResult): void {
    this.#stats.perIssue.push(r);
    this.#stats.totalCostUsd += r.costUsd;
    this.#stats.issuesAttempted += 1;
    switch (r.outcome.kind) {
      case 'success':
        // Counted on review decision.
        break;
      case 'skip':
      case 'no_diff':
        this.#stats.skipped += 1;
        break;
      case 'error':
        this.#stats.errors += 1;
        break;
    }
  }

  noteConsidered(): void {
    this.#stats.issuesConsidered += 1;
  }

  noteScored(): void {
    this.#stats.issuesScored += 1;
  }

  notePRCreated(): void {
    this.#stats.prsCreated += 1;
  }

  noteReviewRejected(): void {
    this.#stats.rejected += 1;
  }

  noteReviewSkipped(): void {
    this.#stats.skipped += 1;
  }

  finish(): void {
    this.#stats.endedAt ??= new Date().toISOString();
  }

  shouldAbortBeforeNextRun(): boolean {
    if (this.#stats.totalCostUsd >= this.#costLimitUsd) {
      this.#stats.costLimitHit = true;
      return true;
    }
    return false;
  }

  /** Snapshot of current stats. `perIssue` is shallow-copied so external
   * code cannot mutate the internal array. */
  snapshot(): RunStats {
    return {
      ...this.#stats,
      perIssue: [...this.#stats.perIssue],
    };
  }
}
