#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { createRequire } from 'node:module';
import chalk from 'chalk';
import { PatchworkError } from './types.js';
import { runCommand } from './cli/runCommand.js';
import { triageCommand } from './cli/triageCommand.js';
import { reviewCommand } from './cli/reviewCommand.js';
import { costCommand } from './cli/costCommand.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();
program.name('patchwork').version(pkg.version);

program
  .command('run')
  .description('Full pipeline: triage, dispatch agents, prompt for review, create PRs on approval.')
  .option('-c, --config <path>', 'config path', 'config/targets.yaml')
  .option('--dry-run', 'triage + score only, no agents, no PRs')
  .option('--repo <owner/name>', 'limit run to one target')
  .action(async (opts) => {
    await runCommand(opts);
  });

program
  .command('triage')
  .description('Score issues only. Writes .patchwork/TRIAGE.md. No agents, no PRs.')
  .option('-c, --config <path>', 'config path', 'config/targets.yaml')
  .action(async (opts) => {
    await triageCommand(opts);
  });

program
  .command('review')
  .description('Re-open the deferred-review queue from previous runs.')
  .action(async () => {
    await reviewCommand();
  });

program
  .command('cost')
  .description('Estimate worst-case cost for the current config.')
  .option('-c, --config <path>', 'config path', 'config/targets.yaml')
  .action(async (opts) => {
    await costCommand(opts);
  });

program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(chalk.red(message) + '\n');
  if (err instanceof PatchworkError && err.hint) {
    process.stderr.write(chalk.dim(err.hint) + '\n');
  }
  process.exit(1);
});
