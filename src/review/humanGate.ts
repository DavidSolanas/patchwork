import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import chalk from 'chalk';
import { PatchworkError, type ReviewDecision, type ReviewPayload, type ReviewSurface } from '../types.js';
import { sanitizeUntrusted } from '../util/sanitize.js';
import { renderDiff } from './diffViewer.js';

export interface TerminalReviewSurfaceIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

export interface TerminalReviewSurfaceOptions {
  /** Override the external opener — used by tests. Defaults to `xdg-open`/`open`/`start`. */
  openExternal?: (url: string) => Promise<void>;
}

const BODY_SUMMARY_CHARS = 300;

/**
 * The terminal implementation of `ReviewSurface`. It is the canonical PR
 * approval gate for v0.1; future surfaces (web, Slack) plug in by implementing
 * the same interface from `src/types.ts`.
 *
 * Constructor throws when stdin is not a TTY — invariant #3's last-line
 * defence. The CLI's `preflight` should already have refused the run.
 */
export class TerminalReviewSurface implements ReviewSurface {
  readonly interactive = true;

  private readonly io: TerminalReviewSurfaceIO;
  private readonly openExternal: (url: string) => Promise<void>;

  constructor(io: TerminalReviewSurfaceIO = process, opts: TerminalReviewSurfaceOptions = {}) {
    // Truthy check, not `=== false`: `process.stdin.isTTY` is `undefined`
    // (not literally `false`) when stdin is piped, so `=== false` would
    // silently accept it and the surface would later hang on `once(stdin, 'data')`.
    if (!io.stdin.isTTY) {
      throw new PatchworkError(
        'TerminalReviewSurface requires an interactive TTY.',
        'Run patchwork in an interactive terminal, or use --dry-run for non-interactive triage.',
      );
    }
    this.io = io;
    this.openExternal = opts.openExternal ?? defaultOpenExternal;
  }

  async present(payload: ReviewPayload): Promise<ReviewDecision> {
    this.printHeader(payload);
    this.printBodySummary(payload);
    this.printFilesTable(payload);
    if (payload.largeDiffWarning) this.printLargeDiffBanner();
    this.io.stdout.write(renderDiff(payload.result.outcome.diff) + '\n');
    this.printCostLine(payload);

    while (true) {
      this.io.stdout.write(
        '\n[A]pprove / [R]eject / [S]kip for later / [O]pen in browser > ',
      );
      const key = await this.readKey();
      const lower = key.toLowerCase();

      if (key === '\x03') {
        // Raw-mode Ctrl+C / Ctrl+D — bubble up so the orchestrator stops cleanly.
        throw new PatchworkError('Review cancelled by user.');
      }
      if (lower === 'a') {
        this.io.stdout.write('approve\n');
        return { action: 'approve' };
      }
      if (lower === 'r') {
        this.io.stdout.write('reject\n');
        const reason = await this.readLine('Reason (optional, enter to skip): ');
        return reason === '' ? { action: 'reject' } : { action: 'reject', reason };
      }
      if (lower === 's') {
        this.io.stdout.write('skip\n');
        return { action: 'skip' };
      }
      if (lower === 'o') {
        this.io.stdout.write('open\n');
        const url = branchUrl(payload);
        try {
          await this.openExternal(url);
          this.io.stdout.write(chalk.dim(`Opened ${url}\n`));
        } catch (err) {
          this.io.stdout.write(
            chalk.yellow(`Could not open browser: ${(err as Error).message}\n`),
          );
          this.io.stdout.write(chalk.dim(`URL: ${url}\n`));
        }
        continue;
      }
      this.io.stdout.write(chalk.yellow('Invalid choice. Press A, R, S, or O.\n'));
    }
  }

  private printHeader(payload: ReviewPayload): void {
    const { issue } = payload;
    this.io.stdout.write('\n');
    this.io.stdout.write(chalk.bold(`#${issue.number}  ${sanitizeUntrusted(issue.title)}\n`));
    this.io.stdout.write(chalk.dim(`${issue.htmlUrl}\n`));
    if (issue.labels.length > 0) {
      const labels = issue.labels.map(sanitizeUntrusted).join(', ');
      this.io.stdout.write(chalk.dim(`labels: ${labels}\n`));
    }
  }

  private printBodySummary(payload: ReviewPayload): void {
    const body = sanitizeUntrusted(payload.issue.body).trim();
    if (body === '') return;
    const summary = body.length > BODY_SUMMARY_CHARS
      ? body.slice(0, BODY_SUMMARY_CHARS) + '…'
      : body;
    this.io.stdout.write('\n' + summary + '\n');
  }

  private printFilesTable(payload: ReviewPayload): void {
    this.io.stdout.write('\n');
    this.io.stdout.write(chalk.bold('Files changed:\n'));
    for (const f of payload.filesChanged) {
      const tag = f.binary ? chalk.dim('[binary]') : `${chalk.green(`+${f.additions}`)} ${chalk.red(`-${f.deletions}`)}`;
      this.io.stdout.write(`  ${f.path}  ${tag}\n`);
    }
    this.io.stdout.write(
      chalk.dim(`Total: +${payload.totalAdditions} -${payload.totalDeletions}\n`),
    );
  }

  private printLargeDiffBanner(): void {
    this.io.stdout.write('\n' + chalk.bgYellow.black(' LARGE DIFF — review carefully ') + '\n');
  }

  private printCostLine(payload: ReviewPayload): void {
    const { result } = payload;
    const t = result.tokens;
    this.io.stdout.write(
      '\n' +
        chalk.dim(
          `Run cost: $${result.costUsd.toFixed(3)} (${result.model}, ${t.input} in / ${t.output} out / ${t.cacheRead} cache)\n`,
        ),
    );
  }

  private async readKey(): Promise<string> {
    const stdin = this.io.stdin;
    const setRaw = typeof stdin.setRawMode === 'function' ? stdin.setRawMode.bind(stdin) : null;
    const wasRaw = stdin.isRaw === true;
    if (setRaw) setRaw(true);
    stdin.resume();
    try {
      const [chunk] = (await once(stdin, 'data')) as [Buffer | string];
      return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    } finally {
      if (setRaw) setRaw(wasRaw);
      stdin.pause();
    }
  }

  private readLine(prompt: string): Promise<string> {
    this.io.stdout.write(prompt);
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: this.io.stdin,
        output: this.io.stdout,
        terminal: false,
      });
      rl.once('line', (line) => {
        rl.close();
        resolve(line.trim());
      });
    });
  }
}

function branchUrl(payload: ReviewPayload): string {
  const { boundRepo, outcome } = payload.result;
  return `https://github.com/${boundRepo.owner}/${boundRepo.name}/tree/${outcome.branch}`;
}

function defaultOpenExternal(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    const args = platform === 'win32' ? ['', url] : [url];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: platform === 'win32' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
