import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'invariant-audit.mjs');
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeCandidate(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchwork-invariant-audit-'));
  tempRoots.push(root);

  const defaults = {
    'src/agent/cursorClient.ts': `
      export interface StartRunInput {
        repoUrl: string;
        autoCreatePR: false;
      }
    `,
    'src/github/createPR.ts': `
      export async function createPR(octokit: any) {
        return octokit.pulls.create({});
      }
    `,
  };

  for (const [relativePath, contents] of Object.entries({ ...defaults, ...files })) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  return root;
}

function runAudit(root) {
  try {
    return {
      ok: true,
      output: execFileSync(process.execPath, [scriptPath, root], { encoding: 'utf8' }),
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

describe('invariant-audit', () => {
  it('passes the minimal valid invariant surface', () => {
    const result = runAudit(makeCandidate());

    expect(result.ok).toBe(true);
    expect(result.output).toContain('Patchwork invariant audit passed.');
  });

  it('rejects aliased pull request creation outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            const pulls = octokit.pulls;
            return pulls.create({});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('INVARIANT #1');
  });

  it('rejects direct pull request REST routes outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            return octokit.request('POST /repos/{owner}/{repo}/pulls', {});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('GitHub pull request REST create route');
  });

  it('rejects widening autoCreatePR beyond the literal false type', () => {
    const result = runAudit(
      makeCandidate({
        'src/agent/cursorClient.ts': `
          export interface StartRunInput {
            repoUrl: string;
            autoCreatePR: boolean;
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('StartRunInput.autoCreatePR must be the literal false type');
  });

  it('rejects non-literal autoCreatePR values', () => {
    const result = runAudit(
      makeCandidate({
        'src/agent/runAgent.ts': `
          const autoCreatePR = false;
          export const cloud = { autoCreatePR };
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('autoCreatePR must not be passed through a variable');
  });
});
