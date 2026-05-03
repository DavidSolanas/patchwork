const SKIP_LINE = /^SKIP:\s*(.+)$/m;
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
 * Heuristic: take the last non-empty, non-code paragraph from the agent's
 * output and trim to `SUMMARY_MAX_CHARS`. This keeps the PR body focused
 * on the agent's narrative summary rather than its tool-call transcript.
 */
function extractSummary(output: string): string {
  const paragraphs = output
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0)
    .filter(p => !p.startsWith('```') && !p.endsWith('```'));

  const last = paragraphs[paragraphs.length - 1] ?? '';
  if (last.length <= SUMMARY_MAX_CHARS) return last;
  return last.slice(0, SUMMARY_MAX_CHARS) + '…';
}
