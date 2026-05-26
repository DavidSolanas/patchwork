import { spawnSync } from 'node:child_process';
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
  const result = spawnSync(process.execPath, [scriptPath, root], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    output: `${result.stdout}${result.stderr}`,
  };
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

  it('rejects pull request create method aliases outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            const createPull = octokit.pulls.create.bind(octokit.pulls);
            return createPull({});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('pull request create method alias');
  });

  it('rejects call/apply on pull request creation outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            return octokit.pulls.create.call(octokit.pulls, {});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('pull request create method alias');
  });

  it('rejects pull request create method references outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            return Reflect.apply(octokit.pulls.create, octokit.pulls, [{}]);
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('pull request create method reference');
  });

  it('rejects destructured pull request creation outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            const { create } = octokit.pulls;
            return create({});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('INVARIANT #1');
  });

  it('rejects exported pull request create method aliases outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            const { create: createPull } = octokit.pulls;
            return createPull;
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('pull request create method alias');
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

  it('rejects pull request REST routes stored in constants', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            const route = 'POST /repos/{owner}/{repo}/pulls';
            return octokit.request(route, {});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('GitHub pull request REST create route');
  });

  it('treats duplicate string constant names as non-static', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          const route = 'GET /search/issues';
          export async function rogue(octokit: any) {
            const route = 'POST /repos/{owner}/{repo}/pulls';
            return octokit.request(route, {});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('REST request routes outside src/github/createPR.ts must be static');
  });

  it('rejects dynamic REST routes outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any, route: string) {
            return octokit.request(route, {});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('REST request routes outside src/github/createPR.ts must be static');
  });

  it('allows static non-PR REST routes outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/deduplication.ts': `
          export async function dedupe(octokit: any) {
            return octokit.request('GET /search/issues', {});
          }
        `,
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects request defaults outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            const request = octokit.request.defaults('POST /repos/{owner}/{repo}/pulls');
            return request({});
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('request defaults outside src/github/createPR.ts');
  });

  it('rejects GraphQL REST routes outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            return octokit.request('POST /graphql', {
              query: 'mutation { createPullRequest(input: {}) { pullRequest { id } } }',
            });
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('GitHub pull request REST create route');
  });

  it('rejects GraphQL pull request creation outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any) {
            return octokit.graphql('mutation { createPullRequest(input: {}) { pullRequest { id } } }');
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('GitHub GraphQL createPullRequest');
  });

  it('rejects dynamic GraphQL operations outside createPR.ts', () => {
    const result = runAudit(
      makeCandidate({
        'src/github/rogue.ts': `
          export async function rogue(octokit: any, query: string) {
            return octokit.graphql(query);
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('GraphQL operations outside src/github/createPR.ts must be static');
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

  it('rejects computed autoCreatePR keys resolved from constants', () => {
    const result = runAudit(
      makeCandidate({
        'src/agent/cursorClient.ts': `
          export interface StartRunInput {
            repoUrl: string;
            autoCreatePR: false;
          }
          const key = 'autoCreatePR';
          export const cloud = { repos: [], [key]: true };
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('autoCreatePR values must be the literal false');
  });

  it('rejects computed autoCreatePR assignments resolved from constants', () => {
    const result = runAudit(
      makeCandidate({
        'src/agent/cursorClient.ts': `
          export interface StartRunInput {
            repoUrl: string;
            autoCreatePR: false;
          }
          const key = 'autoCreatePR';
          const cloud: any = {};
          cloud[key] = true;
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('autoCreatePR assignments must be the literal false');
  });

  it('rejects unresolved computed autoCreatePR keys with non-false values', () => {
    const result = runAudit(
      makeCandidate({
        'src/agent/cursorClient.ts': `
          export interface StartRunInput {
            repoUrl: string;
            autoCreatePR: false;
          }
          declare const key: string;
          export const cloud = { repos: [], [key]: true };
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('computed autoCreatePR keys must resolve statically');
  });

  it('rejects unresolved computed autoCreatePR assignments to true', () => {
    const result = runAudit(
      makeCandidate({
        'src/agent/cursorClient.ts': `
          export interface StartRunInput {
            repoUrl: string;
            autoCreatePR: false;
          }
          declare const key: string;
          const cloud: any = {};
          cloud[key] = true;
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('autoCreatePR assignments must be the literal false');
  });

  it('rejects computed autoCreatePR assignments resolved from indexed constants', () => {
    const result = runAudit(
      makeCandidate({
        'src/agent/cursorClient.ts': `
          export interface StartRunInput {
            repoUrl: string;
            autoCreatePR: false;
          }
          const key = ['autoCreatePR'][0];
          const cloud: any = {};
          cloud[key] = Boolean(1);
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('computed autoCreatePR assignment keys must resolve statically');
  });

  it('allows unresolved computed autoCreatePR assignments to literal false', () => {
    const result = runAudit(
      makeCandidate({
        'src/agent/cursorClient.ts': `
          export interface StartRunInput {
            repoUrl: string;
            autoCreatePR: false;
          }
          declare const key: string;
          const cloud: any = {};
          cloud[key] = false;
        `,
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('rejects dynamic @octokit/rest imports outside src/github', () => {
    const result = runAudit(
      makeCandidate({
        'src/cli/rogue.ts': `
          export async function rogue(moduleName: string) {
            return import(moduleName);
          }
        `,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('dynamic import specifiers outside src/github/** must be static');
  });
});
