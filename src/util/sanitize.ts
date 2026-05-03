/**
 * Strip ANSI/CSI/OSC escape sequences and other control characters from
 * untrusted input before it is written to the operator's terminal or fed
 * back into a model prompt.
 *
 * Untrusted strings (issue titles, issue bodies, label names, etc.) flow
 * through GitHub from arbitrary contributors. Without this, sequences like
 * `\x1b[2J` could clear the operator's terminal mid-review, OSC 8 sequences
 * could spoof hyperlinks, and U+2028/U+2029 could insert silent line breaks
 * in a single-line context.
 */
export function sanitizeUntrusted(s: string): string {
  /* eslint-disable no-control-regex */
  return s
    // CSI sequences: ESC [ ... final byte
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    // OSC sequences: ESC ] ... BEL or ESC ] ... ESC \
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // Other ESC-introducer sequences (single intermediate byte)
    .replace(/\x1b[\x20-\x7e]/g, '')
    // C0 controls except \t, \n, \r; plus DEL and C1 controls
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  /* eslint-enable no-control-regex */
}
