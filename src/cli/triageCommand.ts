import { promises as fs } from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CONFIG_PATH, DEFAULT_TRIAGE_MODEL, TRIAGE_FILE } from '../config/defaults.js';
import { loadConfig, type PatchworkConfig } from '../config/load.js';
import type { TargetConfig } from '../config/schema.js';
import { fetchIssues } from '../github/fetchIssues.js';
import { createDedupCache, findExistingPR } from '../github/deduplication.js';
import { makeOctokit, type Octokit } from '../github/octokit.js';
import { scoreIssue } from '../github/scoreIssue.js';
import { priceFor } from '../reporter/costs.js';
import { ConsoleReporter } from '../reporter/console.js';
import { RunState } from '../reporter/runState.js';
import { PatchworkError, type IssueRef, type TriageScore } from '../types.js';
import { preflight } from './preflight.js';

export interface TriageCommandOptions {
  config?: string;
}

export interface TriageCommandDeps {
  octokit: Octokit;
  anthropic: Anthropic;
  reporter: ConsoleReporter;
  /** Override the TRIAGE.md path — tests use this. */
  triagePath?: string;
}

/**
 * `patchwork triage` — fetch and score issues across all targets without
 * dispatching agents. Writes `.patchwork/TRIAGE.md` and prints a sorted
 * table to the terminal.
 *
 * Never instantiates `cursor` or a review surface: triage is read-only and
 * safe in non-TTY environments.
 */
export async function triageCommand(
  opts: TriageCommandOptions = {},
  deps?: TriageCommandDeps,
): Promise<void> {
  preflight({ needsTty: false, needsCursor: false });
  const config = loadConfig(opts.config ?? DEFAULT_CONFIG_PATH);
  const resolved = deps ?? buildDefaultDeps();
  await executeTriage(config, resolved);
}

function buildDefaultDeps(): TriageCommandDeps {
  const octokit = makeOctokit(process.env.GITHUB_TOKEN ?? '');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
  const reporter = new ConsoleReporter();
  return { octokit, anthropic, reporter };
}

interface TriageRow {
  issue: IssueRef;
  score: TriageScore;
  costUsd: number;
}

export async function executeTriage(
  config: PatchworkConfig,
  deps: TriageCommandDeps,
): Promise<TriageRow[]> {
  const { octokit, anthropic, reporter } = deps;
  const triagePath = deps.triagePath ?? TRIAGE_FILE;
  const state = new RunState(config.settings.cost_limit_usd);
  const dedupCache = createDedupCache();
  reporter.start(config);

  const rows: TriageRow[] = [];

  for (const target of config.targets) {
    const [owner, name] = target.repo.split('/') as [string, string];
    let issues: IssueRef[];
    try {
      issues = await fetchIssues({
        octokit,
        owner,
        name,
        labels: target.labels,
        maxIssues: target.max_issues,
        skipIfCommentsGt: target.skip_if_comments_gt,
      });
    } catch (err) {
      throw new PatchworkError(
        `Failed to fetch issues for ${target.repo}: ${(err as Error).message}`,
        'Check your GITHUB_TOKEN scopes and the repo name.',
      );
    }

    for (const issue of issues) {
      state.noteConsidered();

      // Same dedup discipline as `runCommand`: skip already-PR'd issues so the
      // triage report is honest about what's actually attemptable.
      const existing = await findExistingPR(octokit, issue, dedupCache);
      if (existing.exists) continue;

      reporter.issueStarting(issue, DEFAULT_TRIAGE_MODEL);
      const { score, tokens } = await scoreIssue(issue, { anthropic });
      const costUsd = priceFor(DEFAULT_TRIAGE_MODEL, tokens);
      state.addCost({ model: DEFAULT_TRIAGE_MODEL, tokens, usd: costUsd });
      state.noteScored();
      reporter.issueScored(issue, score);
      rows.push({ issue, score, costUsd });
    }
  }

  state.finish();
  const stats = state.snapshot();
  reporter.end(stats);

  rows.sort((a, b) => b.score.score - a.score.score);
  await writeTriageReport(rows, config, triagePath);
  return rows;
}

async function writeTriageReport(
  rows: TriageRow[],
  config: PatchworkConfig,
  outPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const lines: string[] = [];
  lines.push('# Patchwork triage report');
  lines.push('');
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Threshold: ${config.settings.min_score}/10`);
  lines.push('');
  lines.push('| Repo | # | Title | Score | Recommendation | Reason |');
  lines.push('|------|---|-------|-------|----------------|--------|');
  for (const row of rows) {
    const repo = `${row.issue.repo.owner}/${row.issue.repo.name}`;
    const title = escapeCell(truncate(row.issue.title, 60));
    const reason = escapeCell(truncate(row.score.reason, 100));
    lines.push(
      `| ${repo} | ${row.issue.number} | ${title} | ${row.score.score} | ${row.score.recommendation} | ${reason} |`,
    );
  }
  if (rows.length === 0) {
    lines.push('| _(none)_ | | | | | |');
  }
  lines.push('');
  const tmp = `${outPath}.tmp`;
  await fs.writeFile(tmp, lines.join('\n') + '\n', 'utf8');
  await fs.rename(tmp, outPath);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Re-export TargetConfig so the triage report can be tested with a typed harness.
export type { TargetConfig };
