import { loadConfig, type PatchworkConfig } from '../config/load.js';
import { DEFAULT_CONFIG_PATH, DEFAULT_TRIAGE_MODEL } from '../config/defaults.js';
import { AGENT_COST_TELEMETRY_COST_COMMAND_NOTE, priceFor } from '../reporter/costs.js';
import { preflight } from './preflight.js';

export interface CostCommandOptions {
  config?: string;
}

export interface CostCommandDeps {
  stdout?: NodeJS.WriteStream;
}

/** Rough averages for the worst-case projection. Conservative — actual runs
 * are typically cheaper. */
const HAIKU_AVG_TOKENS = { input: 2_000, output: 200, cacheRead: 0 };
const AGENT_AVG_TOKENS = { input: 50_000, output: 5_000, cacheRead: 20_000 };

export interface CostProjection {
  perTarget: {
    repo: string;
    maxIssues: number;
    model: string;
    haikuUsd: number;
    agentUsd: number;
    totalUsd: number;
  }[];
  grandTotalUsd: number;
  costLimitUsd: number;
  exceedsLimit: boolean;
}

/**
 * `patchwork cost` — worst-case projection from the YAML config alone.
 *
 * Per PLAN.md §1030: `Σ targets[i].max_issues × (haiku_avg + agent_avg)`
 * using `MODEL_PRICES`. Warns when the projection exceeds `cost_limit_usd`.
 */
export async function costCommand(
  opts: CostCommandOptions = {},
  deps?: CostCommandDeps,
): Promise<CostProjection> {
  preflight({ needsTty: false, needsCursor: false, needsAnthropic: false });
  const config = loadConfig(opts.config ?? DEFAULT_CONFIG_PATH);
  const resolved = deps ?? buildDefaultDeps();
  return executeCost(config, resolved);
}

function buildDefaultDeps(): CostCommandDeps {
  return {};
}

export function executeCost(
  config: PatchworkConfig,
  deps: CostCommandDeps,
): CostProjection {
  const stdout = deps.stdout ?? process.stdout;
  const perTarget: CostProjection['perTarget'] = [];

  for (const target of config.targets) {
    const haikuPerIssue = priceFor(DEFAULT_TRIAGE_MODEL, HAIKU_AVG_TOKENS);
    const agentPerIssue = priceFor(target.model, AGENT_AVG_TOKENS);
    const haikuUsd = haikuPerIssue * target.max_issues;
    const agentUsd = agentPerIssue * target.max_issues;
    const totalUsd = haikuUsd + agentUsd;
    perTarget.push({
      repo: target.repo,
      maxIssues: target.max_issues,
      model: target.model,
      haikuUsd,
      agentUsd,
      totalUsd,
    });
  }

  const grandTotalUsd = perTarget.reduce((acc, t) => acc + t.totalUsd, 0);
  const costLimitUsd = config.settings.cost_limit_usd;
  const exceedsLimit = grandTotalUsd > costLimitUsd;

  printProjection({ perTarget, grandTotalUsd, costLimitUsd, exceedsLimit }, stdout);

  return { perTarget, grandTotalUsd, costLimitUsd, exceedsLimit };
}

function printProjection(p: CostProjection, stdout: NodeJS.WriteStream): void {
  stdout.write('Worst-case cost projection (assuming every issue runs to completion):\n\n');
  stdout.write('  Repo                           Issues  Model                 Haiku $    Agent $    Total $\n');
  for (const t of p.perTarget) {
    stdout.write(
      `  ${pad(t.repo, 30)} ${pad(String(t.maxIssues), 6)}  ${pad(t.model, 20)} ${formatUsd(t.haikuUsd, 8)} ${formatUsd(t.agentUsd, 10)} ${formatUsd(t.totalUsd, 10)}\n`,
    );
  }
  stdout.write('\n');
  stdout.write(`Grand total: ${formatUsd(p.grandTotalUsd, 0)} (limit: ${formatUsd(p.costLimitUsd, 0)})\n`);
  if (p.exceedsLimit) {
    stdout.write(
      `⚠ projection exceeds cost_limit_usd — the run will abort partway through.\n`,
    );
  }
  stdout.write(`\n${AGENT_COST_TELEMETRY_COST_COMMAND_NOTE}\n`);
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function formatUsd(n: number, width: number): string {
  const s = `$${n.toFixed(3)}`;
  if (width <= 0 || s.length >= width) return s;
  return ' '.repeat(width - s.length) + s;
}
