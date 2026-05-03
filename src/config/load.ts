import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { PatchworkError } from '../types.js';
import { ConfigSchema, type PatchworkConfig } from './schema.js';

export class ConfigError extends PatchworkError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'ConfigError';
  }
}

let warnedComposer2 = false;

function rewriteLegacyModelNames(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  const targets = obj.targets;
  if (!Array.isArray(targets)) return raw;
  for (const t of targets) {
    if (t && typeof t === 'object') {
      const tt = t as Record<string, unknown>;
      if (tt.model === 'composer-2') {
        tt.model = 'composer-2-standard';
        if (!warnedComposer2) {
          warnedComposer2 = true;
          console.warn(
            '[patchwork] model "composer-2" is ambiguous — Cursor split it into Standard and Fast variants. Rewriting to "composer-2-standard".',
          );
        }
      }
    }
  }
  return raw;
}

function formatZodError(err: ZodError, path: string): string {
  const lines = [`Invalid configuration in ${path}:`];
  for (const issue of err.issues) {
    const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    lines.push(`  • ${where}: ${issue.message}`);
  }
  return lines.join('\n');
}

export function loadConfig(path: string): PatchworkConfig {
  const absPath = resolve(path);

  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError(
        `Config file not found: ${absPath}`,
        'Create one based on config/targets.yaml or examples/minimal.yaml.',
      );
    }
    throw new ConfigError(`Failed to read config file ${absPath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(
      `Failed to parse YAML in ${absPath}: ${(err as Error).message}`,
      'Check YAML indentation and quoting.',
    );
  }

  if (parsed === null || parsed === undefined) {
    throw new ConfigError(
      `Config file ${absPath} is empty.`,
      'A patchwork config requires at least one entry under `targets:`.',
    );
  }

  const rewritten = rewriteLegacyModelNames(parsed);

  try {
    return ConfigSchema.parse(rewritten);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ConfigError(
        formatZodError(err, absPath),
        'See examples/minimal.yaml for the smallest valid config.',
      );
    }
    throw err;
  }
}

export function parseConfig(text: string, sourceLabel = '<inline>'): PatchworkConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`Failed to parse YAML in ${sourceLabel}: ${(err as Error).message}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new ConfigError(`Config ${sourceLabel} is empty.`);
  }
  const rewritten = rewriteLegacyModelNames(parsed);
  try {
    return ConfigSchema.parse(rewritten);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ConfigError(formatZodError(err, sourceLabel));
    }
    throw err;
  }
}

export type { PatchworkConfig };
export const _internal = {
  rewriteLegacyModelNames,
  resetComposer2Warning: () => {
    warnedComposer2 = false;
  },
};
