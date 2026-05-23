const SKIP_LINE = /^SKIP:\s*(.+)$/m;
const SUMMARY_BLOCK = /<summary>([\s\S]*?)<\/summary>/;
const SUMMARY_MAX_CHARS = 1500;

export type ParsedAgentOutcome =
  | { kind: 'skip'; reason: string }
  | { kind: 'no_diff' }
  | { kind: 'success'; agentSummary: string };

export interface ParseResultInput {
  output: string;
  diff?: string;
}

/**
 * Classify the agent's terminal output into one of three outcomes.
 *
 * Order matters (invariant #5 — failure mode is SKIP):
 *   1. An explicit `SKIP: ...` line wins over everything, even if a stray
 *      diff was emitted alongside it.
 *   2. An absent or whitespace-only diff is `no_diff` (never silently
 *      promoted to success).
 *   3. Otherwise, `success` with a short summary the caller can attach
 *      to the PR body.
 */
export function parseResult(raw: ParseResultInput): ParsedAgentOutcome {
  const skipMatch = raw.output.match(SKIP_LINE);
  if (skipMatch && skipMatch[1] !== undefined) {
    return { kind: 'skip', reason: skipMatch[1].trim() };
  }

  if (!raw.diff || raw.diff.trim() === '') {
    return { kind: 'no_diff' };
  }

  return { kind: 'success', agentSummary: extractSummary(raw.output) };
}

/**
 * Prefer a structured `<summary>...</summary>` block when present; otherwise
 * take the last non-empty, non-code paragraph from the agent's output and trim
 * to `SUMMARY_MAX_CHARS`.
 */
function extractSummary(output: string): string {
  const structured = SUMMARY_BLOCK.exec(output);
  if (structured?.[1] !== undefined) {
    return clampSummary(structured[1].trim());
  }

  const paragraphs = output
    .replace(SUMMARY_BLOCK, '')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .filter(p => !p.startsWith('```') && !p.endsWith('```'));

  const last = paragraphs[paragraphs.length - 1] ?? '';
  return clampSummary(last);
}

function clampSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  return text.slice(0, SUMMARY_MAX_CHARS) + '…';
}
