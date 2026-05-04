import { describe, expect, it } from 'vitest';
import { renderPRBody, renderPRTitle } from '../prTemplate.js';
import type { IssueRef } from '../../types.js';

function makeIssue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    repo: { owner: 'o', name: 'r' },
    number: 42,
    title: 'segfault when loading empty config',
    body: 'b',
    labels: [],
    commentsCount: 0,
    assignees: [],
    htmlUrl: 'https://github.com/o/r/issues/42',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

describe('renderPRTitle', () => {
  it('formats as `fix: <title> (#N)`', () => {
    expect(renderPRTitle(makeIssue())).toBe('fix: segfault when loading empty config (#42)');
  });

  it('strips a redundant leading `fix:` from the issue title', () => {
    const t = renderPRTitle(makeIssue({ title: 'Fix: crash on startup' }));
    expect(t).toBe('fix: crash on startup (#42)');
  });

  it('collapses internal whitespace runs', () => {
    const t = renderPRTitle(makeIssue({ title: 'foo   bar\tbaz' }));
    expect(t).toBe('fix: foo bar baz (#42)');
  });

  it('truncates very long titles with an ellipsis', () => {
    const long = 'a'.repeat(200);
    const out = renderPRTitle(makeIssue({ title: long }));
    expect(out.endsWith('… (#42)')).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });
});

describe('renderPRBody', () => {
  const baseInput = {
    issue: makeIssue(),
    model: 'composer-2',
    agentSummary: 'Replaced unwrap() with a graceful error path.',
    testingNotes: 'npm test',
  };

  it('contains the mandatory AI disclosure substring (invariant #4)', () => {
    const body = renderPRBody(baseInput);
    expect(body).toContain('AI Disclosure');
    expect(body).toContain('developed with AI assistance using the Cursor SDK');
    expect(body).toContain('reviewed, tested, and approved');
    expect(body).toContain('by the author before submission.');
  });

  it('embeds the model name and the issue number in the disclosure', () => {
    const body = renderPRBody(baseInput);
    expect(body).toContain('(composer-2 model)');
    expect(body).toContain('Fixes #42');
  });

  it('renders the agent summary verbatim when no `---` line is present', () => {
    const body = renderPRBody(baseInput);
    expect(body).toContain('Replaced unwrap() with a graceful error path.');
    expect(body).not.toMatch(/```\nReplaced/);
  });

  it('fences the agent summary in a code block when it contains a `---` line', () => {
    const body = renderPRBody({
      ...baseInput,
      agentSummary: 'before\n---\nafter',
    });
    expect(body).toMatch(/```\nbefore\n---\nafter\n```/);
  });

  it('truncates an oversized agent summary', () => {
    const body = renderPRBody({
      ...baseInput,
      agentSummary: 'x'.repeat(5000),
    });
    expect(body).toContain('…(truncated)');
    expect(body.length).toBeLessThan(5500);
  });

  it('falls back to a placeholder when the agent summary is empty', () => {
    const body = renderPRBody({ ...baseInput, agentSummary: '   ' });
    expect(body).toContain('_No summary supplied by the agent._');
  });

  it('falls back to a placeholder when testing notes are empty', () => {
    const body = renderPRBody({ ...baseInput, testingNotes: '' });
    expect(body).toContain('No automated tests were detected or run.');
  });

  it('emits the patchwork footer separator and tag', () => {
    const body = renderPRBody(baseInput);
    expect(body).toContain('---\n*Submitted via patchwork.*');
  });
});
