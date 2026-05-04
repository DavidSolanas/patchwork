import { z } from 'zod';
import {
  DEFAULT_COST_LIMIT_USD,
  DEFAULT_MAX_ISSUES,
  DEFAULT_MAX_TOKENS_PER_ISSUE,
  DEFAULT_MIN_SCORE,
  DEFAULT_MODEL,
  DEFAULT_SKIP_IF_COMMENTS_GT,
} from './defaults.js';

const Target = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, {
      message: 'repo must look like "owner/name"',
    }),
    labels: z.array(z.string()).default([]),
    max_issues: z.number().int().positive().max(50).default(DEFAULT_MAX_ISSUES),
    max_tokens_per_issue: z.number().int().positive().default(DEFAULT_MAX_TOKENS_PER_ISSUE),
    skip_if_comments_gt: z.number().int().nonnegative().default(DEFAULT_SKIP_IF_COMMENTS_GT),
    model: z.string().default(DEFAULT_MODEL),
  })
  .strict();

const Settings = z
  .object({
    mode: z.enum(['sequential']).default('sequential'),
    dry_run: z.boolean().default(false),
    min_score: z.number().int().min(0).max(10).default(DEFAULT_MIN_SCORE),
    cost_limit_usd: z.number().positive().default(DEFAULT_COST_LIMIT_USD),
  })
  .strict();

export const ConfigSchema = z
  .object({
    targets: z.array(Target).min(1),
    settings: Settings.default({}),
  })
  .strict();

export type PatchworkConfig = z.infer<typeof ConfigSchema>;
export type TargetConfig = z.infer<typeof Target>;
export type SettingsConfig = z.infer<typeof Settings>;
