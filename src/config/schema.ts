import { z } from 'zod';

const Target = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, {
      message: 'repo must look like "owner/name"',
    }),
    labels: z.array(z.string()).default([]),
    max_issues: z.number().int().positive().max(50).default(5),
    max_tokens_per_issue: z.number().int().positive().default(150_000),
    skip_if_comments_gt: z.number().int().nonnegative().default(30),
    model: z.string().default('composer-2-standard'),
  })
  .strict();

const Settings = z
  .object({
    mode: z.enum(['sequential']).default('sequential'),
    dry_run: z.boolean().default(false),
    min_score: z.number().int().min(0).max(10).default(7),
    cost_limit_usd: z.number().positive().default(2),
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
