import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetUnknownModelWarnings, priceFor } from '../costs.js';
import type { TokenUsage } from '../../types.js';

const tokens = (input: number, output: number, cacheRead = 0): TokenUsage => ({
  input,
  output,
  cacheRead,
});

describe('priceFor', () => {
  beforeEach(() => {
    _resetUnknownModelWarnings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses dedicated cache-read rate when present', () => {
    const cost = priceFor('composer-2', tokens(1_000_000, 0, 1_000_000));
    // input 0.50 + cache 0.20 = 0.70
    expect(cost).toBeCloseTo(0.7, 8);
  });

  it('sums input + output + cacheRead', () => {
    const cost = priceFor('claude-sonnet-4-6', tokens(1_000_000, 500_000, 200_000));
    // 3.00 + 7.50 + 0.06 = 10.56
    expect(cost).toBeCloseTo(10.56, 8);
  });

  it('warns once for an unknown model and returns 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(priceFor('not-a-model', tokens(1, 1))).toBe(0);
    expect(priceFor('not-a-model', tokens(1, 1))).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
