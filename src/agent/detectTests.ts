import type { Octokit } from '../github/octokit.js';

interface Probe {
  path: string;
  /** Returns the test command(s) implied by this file's contents, or null. */
  detect: (content: string) => string | null;
}

const PROBES: Probe[] = [
  {
    path: 'package.json',
    detect: content => {
      try {
        const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
        if (parsed.scripts && typeof parsed.scripts.test === 'string') {
          return 'npm test';
        }
      } catch {
        // malformed package.json — treat as no signal
      }
      return null;
    },
  },
  { path: 'pytest.ini', detect: () => 'pytest' },
  {
    path: 'pyproject.toml',
    detect: content => (content.includes('[tool.pytest') ? 'pytest' : null),
  },
  { path: 'Cargo.toml', detect: () => 'cargo test' },
  { path: 'go.mod', detect: () => 'go test ./...' },
  {
    path: 'Makefile',
    detect: content => (/(^|\n)test\s*:/.test(content) ? 'make test' : null),
  },
];

export interface DetectTestCommandsInput {
  octokit: Octokit;
  owner: string;
  name: string;
}

/**
 * Probe known tooling-config files at the repository root and return the
 * test commands implied by each. Order is preserved (`package.json` first,
 * `Makefile` last) to keep the agent prompt deterministic.
 *
 * 404s are expected for any individual probe — the caller (Phase 3 prompt)
 * tolerates an empty array as "no tests detected".
 */
export async function detectTestCommands(input: DetectTestCommandsInput): Promise<string[]> {
  const hits: string[] = [];

  for (const probe of PROBES) {
    const content = await readRootFile(input.octokit, input.owner, input.name, probe.path);
    if (content === null) continue;
    const cmd = probe.detect(content);
    if (cmd && !hits.includes(cmd)) hits.push(cmd);
  }

  return hits;
}

async function readRootFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path });
    const data = response.data;
    if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
      return null;
    }
    const encoding = data.encoding ?? 'base64';
    if (encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf8');
    }
    return data.content;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return null;
    throw err;
  }
}
