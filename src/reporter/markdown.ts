import type { AgentRunResult, RunStats } from '../types.js';
import { atomicWriteFile } from '../util/atomicWrite.js';
import { formatCostUsd, formatTotalCostUsd } from './costs.js';

/**
 * Write a human-readable run summary to `path` (default `.patchwork/SUMMARY.md`).
 * Shape per PLAN.md §880–901.
 *
 * Atomic write: `path.tmp` + `rename` so an interrupted process never leaves a
 * half-written summary.
 */
export async function writeSummary(stats: RunStats, outPath: string): Promise<void> {
  await atomicWriteFile(outPath, renderSummary(stats));
}

export function renderSummary(stats: RunStats): string {
  const lines: string[] = [];
  lines.push('# Patchwork run summary');
  lines.push('');
  lines.push(`- **Started:** ${stats.startedAt}`);
  lines.push(`- **Ended:**   ${stats.endedAt ?? '(in progress)'}`);
  lines.push(`- **Total cost:** ${formatTotalCostUsd(stats)}${stats.costLimitHit ? ' _(cost limit hit)_' : ''}`);
  lines.push('');
  lines.push(`- Issues considered: ${stats.issuesConsidered}`);
  lines.push(`- Issues scored:     ${stats.issuesScored}`);
  lines.push(`- Issues attempted:  ${stats.issuesAttempted}`);
  lines.push(`- PRs created:       ${stats.prsCreated}`);
  lines.push(`- Rejected:          ${stats.rejected}`);
  lines.push(`- Skipped:           ${stats.skipped}`);
  lines.push(`- Errors:            ${stats.errors}`);
  lines.push('');
  lines.push('## Issues');
  lines.push('');
  lines.push('| Repo | # | Title | Outcome | Model | Cost |');
  lines.push('|------|---|-------|---------|-------|------|');
  for (const r of stats.perIssue) {
    const repo = `${r.issue.repo.owner}/${r.issue.repo.name}`;
    const title = escapeCell(truncate(r.issue.title, 60));
    lines.push(
      `| ${repo} | ${r.issue.number} | ${title} | ${r.outcome.kind} | ${r.model} | ${formatCostUsd(r.costUsd, r.tokens)} |`,
    );
  }
  if (stats.perIssue.length === 0) {
    lines.push('| _(none)_ | | | | | |');
  }
  lines.push('');
  lines.push('## Per-issue details');
  lines.push('');
  for (const r of stats.perIssue) {
    lines.push(renderDetails(r));
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function renderDetails(r: AgentRunResult): string {
  const repo = `${r.issue.repo.owner}/${r.issue.repo.name}`;
  const summary = `${repo}#${r.issue.number} — ${escapeCell(truncate(r.issue.title, 80))}`;
  const inner: string[] = [];
  inner.push(`- Outcome: \`${r.outcome.kind}\``);
  inner.push(`- Model: \`${r.model}\``);
  inner.push(
    `- Tokens: input=${r.tokens.input}, output=${r.tokens.output}, cacheRead=${r.tokens.cacheRead}`,
  );
  inner.push(`- Cost: ${formatCostUsd(r.costUsd, r.tokens)}`);
  inner.push(`- Duration: ${r.startedAt} → ${r.endedAt}`);
  inner.push(`- Cursor run: \`${r.cursorRunId}\``);
  switch (r.outcome.kind) {
    case 'success':
      inner.push(`- Branch: \`${r.outcome.branch}\``);
      inner.push('', '<details><summary>Agent summary</summary>', '');
      inner.push('```');
      inner.push(r.outcome.agentSummary);
      inner.push('```');
      inner.push('', '</details>');
      break;
    case 'skip':
      inner.push(`- Skip reason: ${r.outcome.reason}`);
      break;
    case 'error':
      inner.push(`- Error: ${r.outcome.message}`);
      break;
    case 'no_diff':
      inner.push('- Agent produced no diff.');
      break;
  }
  return [
    '<details><summary>' + summary + '</summary>',
    '',
    ...inner,
    '',
    '</details>',
  ].join('\n');
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
