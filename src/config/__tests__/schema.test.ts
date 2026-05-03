import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach } from 'vitest';
import { ConfigSchema } from '../schema.js';
import { ConfigError, loadConfig, parseConfig, _internal } from '../load.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

beforeEach(() => {
  _internal.resetComposer2Warning();
});

describe('ConfigSchema', () => {
  it('accepts a minimal valid config and fills defaults', () => {
    const parsed = ConfigSchema.parse({
      targets: [{ repo: 'octocat/hello-world' }],
    });
    expect(parsed.targets).toHaveLength(1);
    const t = parsed.targets[0]!;
    expect(t.repo).toBe('octocat/hello-world');
    expect(t.labels).toEqual([]);
    expect(t.max_issues).toBe(5);
    expect(t.max_tokens_per_issue).toBe(150_000);
    expect(t.skip_if_comments_gt).toBe(30);
    expect(t.model).toBe('composer-2-standard');
    expect(parsed.settings.mode).toBe('sequential');
    expect(parsed.settings.dry_run).toBe(false);
    expect(parsed.settings.min_score).toBe(7);
    expect(parsed.settings.cost_limit_usd).toBe(2);
  });

  it('rejects empty targets array', () => {
    expect(() => ConfigSchema.parse({ targets: [] })).toThrow();
  });

  it('rejects malformed repo strings', () => {
    expect(() => ConfigSchema.parse({ targets: [{ repo: 'not-a-slug' }] })).toThrow();
    expect(() => ConfigSchema.parse({ targets: [{ repo: 'a/b/c' }] })).toThrow();
  });

  it('rejects unknown keys at the root', () => {
    expect(() =>
      ConfigSchema.parse({ targets: [{ repo: 'a/b' }], typo: 1 }),
    ).toThrow();
  });

  it('rejects unknown keys inside a target', () => {
    expect(() =>
      ConfigSchema.parse({ targets: [{ repo: 'a/b', sneaky: true }] }),
    ).toThrow();
  });

  it('rejects unknown keys inside settings', () => {
    expect(() =>
      ConfigSchema.parse({
        targets: [{ repo: 'a/b' }],
        settings: { auto_pr: true },
      }),
    ).toThrow();
  });

  it('clamps max_issues to (0, 50]', () => {
    expect(() =>
      ConfigSchema.parse({ targets: [{ repo: 'a/b', max_issues: 0 }] }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({ targets: [{ repo: 'a/b', max_issues: 51 }] }),
    ).toThrow();
  });

  it('requires min_score in [0, 10]', () => {
    expect(() =>
      ConfigSchema.parse({
        targets: [{ repo: 'a/b' }],
        settings: { min_score: -1 },
      }),
    ).toThrow();
    expect(() =>
      ConfigSchema.parse({
        targets: [{ repo: 'a/b' }],
        settings: { min_score: 11 },
      }),
    ).toThrow();
  });

  it('requires cost_limit_usd > 0', () => {
    expect(() =>
      ConfigSchema.parse({
        targets: [{ repo: 'a/b' }],
        settings: { cost_limit_usd: 0 },
      }),
    ).toThrow();
  });
});

describe('parseConfig', () => {
  it('round-trips a fully-specified config', () => {
    const text = `
targets:
  - repo: foo/bar
    labels: [good-first-issue, help wanted]
    max_issues: 3
    max_tokens_per_issue: 50000
    skip_if_comments_gt: 10
    model: composer-2-fast
settings:
  mode: sequential
  dry_run: true
  min_score: 9
  cost_limit_usd: 1.5
`;
    const cfg = parseConfig(text, 'inline');
    expect(cfg.targets[0]?.model).toBe('composer-2-fast');
    expect(cfg.settings.dry_run).toBe(true);
    expect(cfg.settings.cost_limit_usd).toBe(1.5);
  });

  it('rewrites legacy "composer-2" to "composer-2-standard"', () => {
    const cfg = parseConfig('targets:\n  - repo: a/b\n    model: composer-2\n');
    expect(cfg.targets[0]?.model).toBe('composer-2-standard');
  });

  it('throws ConfigError on YAML parse failure', () => {
    expect(() => parseConfig('targets: [unclosed')).toThrow(ConfigError);
  });

  it('throws ConfigError on schema violation with file context', () => {
    expect(() => parseConfig('targets: []', 'inline.yaml')).toThrow(ConfigError);
  });

  it('throws ConfigError on empty input', () => {
    expect(() => parseConfig('', 'empty.yaml')).toThrow(ConfigError);
  });
});

describe('loadConfig — example files', () => {
  it('parses every file in examples/', () => {
    const examplesDir = join(REPO_ROOT, 'examples');
    const files = readdirSync(examplesDir).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const cfg = loadConfig(join(examplesDir, f));
      expect(cfg.targets.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('parses the starter config/targets.yaml', () => {
    const cfg = loadConfig(join(REPO_ROOT, 'config', 'targets.yaml'));
    expect(cfg.targets.length).toBeGreaterThanOrEqual(1);
    expect(cfg.settings.cost_limit_usd).toBeGreaterThan(0);
  });

  it('reports a missing file with a helpful hint', () => {
    try {
      loadConfig(join(REPO_ROOT, 'examples', 'does-not-exist.yaml'));
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).hint).toBeDefined();
    }
  });

  it('error message includes the file path on schema failure', () => {
    // Sanity check: schema errors via parseConfig include the source label.
    try {
      parseConfig('targets: [{ repo: bogus }]', 'broken.yaml');
      throw new Error('expected parseConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('broken.yaml');
    }
  });
});

describe('loadConfig — file path resolution', () => {
  it('reads the file as UTF-8 and validates it', () => {
    const path = join(REPO_ROOT, 'examples', 'minimal.yaml');
    const raw = readFileSync(path, 'utf8');
    expect(raw).toMatch(/octocat\/hello-world/);
    const cfg = loadConfig(path);
    expect(cfg.targets[0]?.repo).toBe('octocat/hello-world');
  });
});
