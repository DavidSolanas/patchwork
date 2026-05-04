import type { IssueRef } from '../types.js';

const TITLE_MAX = 70;
const SUMMARY_MAX = 4000;

export interface PRTemplateInput {
  issue: IssueRef;
  model: string;
  agentSummary: string;
  testingNotes: string;
}

/**
 * Render the PR title in `fix: <truncated title> (#N)` form.
 *
 * The title is normalised: leading/trailing whitespace stripped, internal
 * runs of whitespace collapsed, and a leading `fix:` / `Fix:` stripped so
 * the result is not `fix: fix: …`.
 */
export function renderPRTitle(issue: IssueRef): string {
  const cleaned = issue.title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^fix\s*:\s*/i, '');
  const truncated =
    cleaned.length > TITLE_MAX ? `${cleaned.slice(0, TITLE_MAX - 1).trimEnd()}…` : cleaned;
  return `fix: ${truncated} (#${issue.number})`;
}

/**
 * Render the PR body. The AI Disclosure block is mandatory (invariant #4) —
 * there is no flag to suppress it, and a unit test asserts the substring is
 * always present.
 *
 * `agentSummary` is stripped + truncated to 4000 chars. If it contains a
 * literal `---` line it is fenced in a code block so the template's own
 * `---` separator stays the only horizontal rule that markdown renderers
 * see between the disclosure and the footer.
 */
export function renderPRBody(input: PRTemplateInput): string {
  const summary = formatAgentSummary(input.agentSummary);
  const notes = input.testingNotes.trim() || 'No automated tests were detected or run.';

  return [
    `Fixes #${input.issue.number}`, // Moved to the top for instant visibility
    '',
    '## What was changed and why',
    '',
    summary,
    '',
    '## Testing notes',
    '',
    notes,
    '',
    '## Type of change',
    '',
    '- [ ] Bug fix (non-breaking)',
    '- [ ] New feature (non-breaking)',
    '- [ ] Breaking change',
    '- [ ] Documentation update',
    '',
    '## AI Disclosure',
    '',
    'This contribution was developed with AI assistance using the Cursor SDK',
    `(${input.model} model). All code changes were reviewed and approved`,
    'by the author before submission.',
    '',
    '---',
    '*Submitted via patchwork.*', // Italicized for a cleaner footer look
    '',
  ].join('\n');
}

function formatAgentSummary(raw: string): string {
  const trimmed = raw.trim();
  const truncated =
    trimmed.length > SUMMARY_MAX
      ? `${trimmed.slice(0, SUMMARY_MAX).trimEnd()}\n\n…(truncated)`
      : trimmed;

  if (truncated === '') {
    return '_No summary supplied by the agent._';
  }

  if (/^---\s*$/m.test(truncated)) {
    return ['```', truncated, '```'].join('\n');
  }
  return truncated;
}
