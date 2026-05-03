import { describe, expect, it } from 'vitest';
import { parseResult } from '../parseResult.js';

describe('parseResult', () => {
  it('detects SKIP and returns the trimmed reason', () => {
    const out = parseResult({ output: 'preamble\nSKIP: not enough context\nignored' });
    expect(out).toEqual({ kind: 'skip', reason: 'not enough context' });
  });

  it('SKIP wins even when a stray diff is present (invariant #5)', () => {
    const out = parseResult({
      output: 'SKIP: ambiguous request',
      diff: 'diff --git a/x b/x\n+something',
    });
    expect(out.kind).toBe('skip');
  });

  it('returns no_diff when diff is missing', () => {
    expect(parseResult({ output: 'all good' })).toEqual({ kind: 'no_diff' });
  });

  it('returns no_diff when diff is whitespace-only', () => {
    expect(parseResult({ output: 'all good', diff: '   \n\t\n' })).toEqual({ kind: 'no_diff' });
  });

  it('returns success with a summary drawn from the last non-code paragraph', () => {
    const output = [
      'I read the file.',
      '',
      '```bash',
      'npm test',
      '```',
      '',
      'I changed the function to handle the empty array case.',
    ].join('\n');
    const out = parseResult({ output, diff: 'diff --git a/x b/x\n+ok' });
    expect(out.kind).toBe('success');
    if (out.kind === 'success') {
      expect(out.agentSummary).toBe('I changed the function to handle the empty array case.');
    }
  });

  it('truncates summaries longer than 1500 chars', () => {
    const long = 'a'.repeat(2000);
    const out = parseResult({ output: long, diff: 'diff' });
    expect(out.kind).toBe('success');
    if (out.kind === 'success') {
      expect(out.agentSummary.length).toBeLessThanOrEqual(1501);
      expect(out.agentSummary.endsWith('…')).toBe(true);
    }
  });
});
