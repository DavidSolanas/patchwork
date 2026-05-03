import chalk from 'chalk';
import parseDiff from 'parse-diff';

export interface RenderDiffOptions {
  /** Maximum number of changed lines (added + deleted + context) printed per file. Defaults to 200. */
  maxLinesPerFile?: number;
}

const DEFAULT_MAX_LINES_PER_FILE = 200;

/**
 * Render a unified diff string into a coloured, terminal-ready string.
 *
 * Pure: no console writes, no I/O. The caller decides where the result goes.
 * Chalk auto-strips colour when the destination is not a TTY (so snapshot
 * tests stay readable and CI logs stay clean).
 */
export function renderDiff(diff: string, opts: RenderDiffOptions = {}): string {
  const maxLines = opts.maxLinesPerFile ?? DEFAULT_MAX_LINES_PER_FILE;

  if (diff.trim() === '') return chalk.dim('(empty diff)');

  const files = parseDiff(diff);
  if (files.length === 0) return chalk.dim('(no parseable files in diff)');

  const out: string[] = [];

  for (const file of files) {
    const path = file.to && file.to !== '/dev/null' ? file.to : (file.from ?? '(unknown)');
    out.push(chalk.bold.cyan(`── ${path} ──`));
    out.push(chalk.dim(`+${file.additions} -${file.deletions}`));

    if (isBinary(file)) {
      out.push(`[binary file: ${path}]`);
      out.push('');
      continue;
    }

    const lines: string[] = [];
    for (const chunk of file.chunks) {
      lines.push(chalk.magenta(chunk.content));
      for (const change of chunk.changes) {
        // change.content already includes the leading +/-/' '
        if (change.type === 'add') {
          lines.push(chalk.green(change.content));
        } else if (change.type === 'del') {
          lines.push(chalk.red(change.content));
        } else {
          lines.push(change.content);
        }
      }
    }

    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      const remaining = lines.length - maxLines;
      out.push(...kept);
      out.push(chalk.dim(`… <${remaining} more lines>`));
    } else {
      out.push(...lines);
    }
    out.push('');
  }

  return out.join('\n').trimEnd();
}

function isBinary(file: parseDiff.File): boolean {
  // parse-diff doesn't expose a binary flag, but binary diffs have no chunks
  // and an `index` line of the form `Binary files ... differ`.
  if (file.chunks.length > 0) return false;
  if (file.index?.some((line) => /Binary files .* differ/i.test(line))) return true;
  // Fallback: zero chunks with both add/del counts at 0 is also binary-ish.
  return file.additions === 0 && file.deletions === 0;
}
