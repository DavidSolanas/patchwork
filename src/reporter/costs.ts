import type { RunStats, TokenUsage } from '../types.js';

interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'composer-2':       { inputPer1M: 0.50, outputPer1M:  2.50, cacheReadPer1M: 0.20 },
  'composer-2-fast':           { inputPer1M: 1.50, outputPer1M:  7.50, cacheReadPer1M: 0.35 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1.00, outputPer1M:  5.00, cacheReadPer1M: 0.10 },
  'claude-sonnet-4-6':         { inputPer1M: 3.00, outputPer1M: 15.00, cacheReadPer1M: 0.30 },
  'claude-opus-4-7':           { inputPer1M: 5.00, outputPer1M: 25.00, cacheReadPer1M: 0.50 },
  'gpt-5.5':                   { inputPer1M: 5.00, outputPer1M: 30.00, cacheReadPer1M: 0.50 },
};

const warnedUnknownModels = new Set<string>();

/**
 * Reset the warn-once cache. Tests use this to assert the warning fires.
 * Not part of the public surface — exported for `__tests__` only.
 */
export function _resetUnknownModelWarnings(): void {
  warnedUnknownModels.clear();
}

/**
 * Compute total USD cost for a `(model, tokens)` pair.
 *
 * Cache-read pricing falls back to the input rate when a model has no
 * dedicated `cacheReadPer1M` — this is a safe upper bound, not free.
 *
 * Unknown models warn once (per model id, per process) and return 0.
 * `runState`/`ConsoleReporter` surface that warning so operators can update
 * the table.
 */
export function priceFor(model: string, tokens: TokenUsage): number {
  const price = MODEL_PRICES[model];
  if (!price) {
    if (!warnedUnknownModels.has(model)) {
      warnedUnknownModels.add(model);
      console.warn(
        `[patchwork] Unknown model "${model}" — pricing returns 0. Add it to MODEL_PRICES in src/reporter/costs.ts.`,
      );
    }
    return 0;
  }

  const inputCost = (price.inputPer1M * tokens.input) / 1_000_000;
  const outputCost = (price.outputPer1M * tokens.output) / 1_000_000;
  const cacheRate = price.cacheReadPer1M ?? price.inputPer1M;
  const cacheReadCost = (cacheRate * tokens.cacheRead) / 1_000_000;

  return inputCost + outputCost + cacheReadCost;
}

export const COST_UNKNOWN_LABEL = 'cost unknown';

export function isCostUnknown(tokens: TokenUsage, costUsd: number): boolean {
  return costUsd === 0 && tokens.input === 0 && tokens.output === 0 && tokens.cacheRead === 0;
}

export function formatCostUsd(costUsd: number, tokens: TokenUsage): string {
  return isCostUnknown(tokens, costUsd) ? COST_UNKNOWN_LABEL : `$${costUsd.toFixed(2)}`;
}

export function formatTotalCostUsd(stats: RunStats): string {
  if (stats.totalCostUsd > 0) {
    return `$${stats.totalCostUsd.toFixed(2)}`;
  }
  if (stats.perIssue.some((r) => isCostUnknown(r.tokens, r.costUsd))) {
    return COST_UNKNOWN_LABEL;
  }
  return `$${stats.totalCostUsd.toFixed(2)}`;
}
