import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import { retry } from '@octokit/plugin-retry';
import { PatchworkError } from '../types.js';

// Re-exported so modules outside `src/github/**` can refer to the Octokit
// type without tripping invariant #3 / the ESLint no-restricted-imports rule.
// Only the type is re-exported — runtime construction stays inside this file.
export type { Octokit } from '@octokit/rest';

export class GitHubAuthError extends PatchworkError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'GitHubAuthError';
  }
}

export interface MakeOctokitOptions {
  userAgent?: string;
}

export function makeOctokit(token: string, opts: MakeOctokitOptions = {}): Octokit {
  if (!token || token.trim() === '') {
    throw new GitHubAuthError(
      'GITHUB_TOKEN is missing or empty.',
      'Set GITHUB_TOKEN in your environment. See .env.example for the variables patchwork expects.',
    );
  }

  const PatchworkOctokit = Octokit.plugin(throttling, retry);

  return new PatchworkOctokit({
    auth: token,
    userAgent: opts.userAgent ?? 'patchwork/0.1',
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `Primary rate limit hit for ${options.method} ${options.url} (attempt ${retryCount + 1})`,
        );
        if (retryCount < 2) {
          octokit.log.info(`Retrying after ${retryAfter}s.`);
          return true;
        }
        return false;
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        octokit.log.warn(
          `Secondary rate limit hit for ${options.method} ${options.url} (attempt ${retryCount + 1})`,
        );
        if (retryCount < 1) {
          octokit.log.info(`Waiting ${retryAfter}s once before failing.`);
          return true;
        }
        return false;
      },
    },
  });
}
