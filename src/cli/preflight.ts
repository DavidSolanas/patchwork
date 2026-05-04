import { PatchworkError } from '../types.js';

export interface PreflightInput {
  /** True when this command will hit the human review gate; requires a TTY. */
  needsTty: boolean;
  /** True when this command will dispatch a Cursor agent; requires CURSOR_API_KEY. */
  needsCursor: boolean;
  /** True when this command needs the Anthropic API key (triage). Defaults to true. */
  needsAnthropic?: boolean;
  /** Injectable for tests. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests. Defaults to `process.stdin`. */
  stdin?: NodeJS.ReadStream;
  /** Injectable for tests. Defaults to `process.versions.node`. */
  nodeVersion?: string;
}

/**
 * Pre-run guard. Refuses non-interactive runs that need the review gate
 * (invariant #3), checks the env vars each command needs, and asserts
 * Node ≥ 22. Throws `PatchworkError` with a `hint` so the top-level handler
 * can render it cleanly.
 *
 * `needsTty` and `needsCursor` are independent: `patchwork review` needs a
 * TTY but never dispatches a Cursor agent, so it asks for the former and
 * not the latter.
 */
export function preflight(input: PreflightInput): void {
  const env = input.env ?? process.env;
  const stdin = input.stdin ?? process.stdin;
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const needsAnthropic = input.needsAnthropic ?? true;

  const major = parseMajor(nodeVersion);
  if (major === null || major < 22) {
    throw new PatchworkError(
      `patchwork requires Node.js 22+, found ${nodeVersion}.`,
      'Upgrade Node (e.g. via nvm: `nvm install 22`) and retry.',
    );
  }

  // `process.stdin.isTTY` is `undefined` (not literally `false`) when piped,
  // so a truthy check is the correct guard.
  if (input.needsTty && !stdin.isTTY) {
    throw new PatchworkError(
      'patchwork run requires an interactive terminal because every PR needs human approval. Use --dry-run for non-interactive triage.',
      'Run patchwork in a terminal, not in CI or piped stdin.',
    );
  }

  requireEnv(env, 'GITHUB_TOKEN', 'A fine-grained GitHub PAT scoped to the repos you contribute to.');
  if (needsAnthropic) {
    requireEnv(env, 'ANTHROPIC_API_KEY', 'Used for the Haiku triage step.');
  }
  if (input.needsCursor) {
    requireEnv(env, 'CURSOR_API_KEY', 'Cursor SDK key for cloud agent dispatch.');
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string, hint: string): void {
  const v = env[name];
  if (!v || v.trim() === '') {
    throw new PatchworkError(`${name} is missing or empty.`, hint);
  }
}

function parseMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}
