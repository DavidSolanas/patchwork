import ora, { type Ora } from 'ora';
import type { PatchworkConfig } from '../config/schema.js';
import type {
  AgentRunResult,
  IssueRef,
  ReviewDecision,
  RunStats,
  TriageScore,
} from '../types.js';
import { formatCostUsd, formatTotalCostUsd } from './costs.js';

/**
 * Live progress reporter. One active `ora` spinner at a time; each lifecycle
 * method stops the previous spinner with the appropriate marker.
 *
 * Wiring into the orchestrator happens in Phase 6 — this module is the
 * vocabulary the orchestrator will speak.
 */
export class ConsoleReporter {
  #spinner: Ora | null = null;
  readonly #stream: NodeJS.WriteStream;
  readonly #isTTY: boolean;

  constructor(stream: NodeJS.WriteStream = process.stdout) {
    this.#stream = stream;
    this.#isTTY = Boolean(stream.isTTY);
  }

  start(config: PatchworkConfig): void {
    this.#stopActive('info');
    const repos = config.targets.map((t) => t.repo).join(', ');
    this.#log(`patchwork starting — ${config.targets.length} target(s): ${repos}`);
    this.#log(
      `mode=${config.settings.mode}` +
        (config.settings.dry_run ? ' (dry run)' : '') +
        ` cost_limit=$${config.settings.cost_limit_usd.toFixed(2)}` +
        ` min_score=${config.settings.min_score}`,
    );
  }

  issueStarting(issue: IssueRef, model: string): void {
    this.#stopActive('info');
    this.#spinner = this.#spawn(`${issueLabel(issue)} — triaging (model=${model})`);
  }

  issueScored(issue: IssueRef, score: TriageScore): void {
    this.#stopActive('succeed', `${issueLabel(issue)} scored ${score.score}/10 → ${score.recommendation}`);
  }

  issueAttempting(issue: IssueRef): void {
    this.#stopActive('info');
    this.#spinner = this.#spawn(`${issueLabel(issue)} — agent running`);
  }

  agentResult(r: AgentRunResult): void {
    const tag = `${issueLabel(r.issue)} agent ${r.outcome.kind} (${formatCostUsd(r.costUsd, r.tokens)})`;
    switch (r.outcome.kind) {
      case 'success':
        this.#stopActive('succeed', tag);
        break;
      case 'no_diff':
      case 'skip':
        this.#stopActive('info', tag);
        break;
      case 'error':
        this.#stopActive('fail', tag);
        break;
    }
  }

  reviewDecision(issue: IssueRef, decision: ReviewDecision): void {
    this.#stopActive('info');
    switch (decision.action) {
      case 'approve':
        this.#log(`${issueLabel(issue)} reviewer approved`);
        break;
      case 'reject':
        this.#log(
          `${issueLabel(issue)} reviewer rejected${decision.reason ? `: ${decision.reason}` : ''}`,
        );
        break;
      case 'skip':
        this.#log(
          `${issueLabel(issue)} reviewer deferred${decision.reason ? `: ${decision.reason}` : ''}`,
        );
        break;
      case 'open_external':
        this.#log(`${issueLabel(issue)} opened externally`);
        break;
      default: {
        const _: never = decision;
        void _;
      }
    }
  }

  prCreated(issue: IssueRef, url: string): void {
    this.#stopActive('succeed', `${issueLabel(issue)} PR opened: ${url}`);
  }

  costLimitHit(stats: RunStats): void {
    this.#stopActive('warn', `cost limit hit at ${formatTotalCostUsd(stats)} — stopping before next issue`);
  }

  end(stats: RunStats): void {
    this.#stopActive('info');
    this.#log(
      `done — considered=${stats.issuesConsidered}` +
        ` attempted=${stats.issuesAttempted}` +
        ` prs=${stats.prsCreated}` +
        ` rejected=${stats.rejected}` +
        ` skipped=${stats.skipped}` +
        ` errors=${stats.errors}` +
        ` total=${formatTotalCostUsd(stats)}`,
    );
  }

  #spawn(text: string): Ora | null {
    if (!this.#isTTY) {
      this.#log(text);
      return null;
    }
    return ora({ text, stream: this.#stream }).start();
  }

  #stopActive(marker: 'succeed' | 'fail' | 'info' | 'warn', overrideText?: string): void {
    const sp = this.#spinner;
    this.#spinner = null;
    if (sp) {
      const text = overrideText ?? sp.text;
      switch (marker) {
        case 'succeed':
          sp.succeed(text);
          break;
        case 'fail':
          sp.fail(text);
          break;
        case 'warn':
          sp.warn(text);
          break;
        case 'info':
          sp.info(text);
          break;
      }
      return;
    }
    if (overrideText) this.#log(overrideText);
  }

  #log(line: string): void {
    this.#stream.write(line + '\n');
  }
}

function issueLabel(issue: IssueRef): string {
  return `${issue.repo.owner}/${issue.repo.name}#${issue.number}`;
}
