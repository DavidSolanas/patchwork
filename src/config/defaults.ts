export const DEFAULT_MODEL = 'composer-2-standard';

export const DEFAULT_CONFIG_PATH = 'config/targets.yaml';

export const DEFAULT_TRIAGE_MODEL = 'claude-haiku-4-5-20251001';

export const DEFAULT_MAX_ISSUES = 5;
export const DEFAULT_MAX_TOKENS_PER_ISSUE = 150_000;
export const DEFAULT_SKIP_IF_COMMENTS_GT = 30;

export const DEFAULT_MIN_SCORE = 7;
export const DEFAULT_COST_LIMIT_USD = 2;

export const STATE_DIR = '.patchwork';
export const STATE_FILE = `${STATE_DIR}/state.json`;
export const DEFERRED_QUEUE_FILE = `${STATE_DIR}/deferred.json`;
export const SUMMARY_FILE = `${STATE_DIR}/SUMMARY.md`;
export const TRIAGE_FILE = `${STATE_DIR}/TRIAGE.md`;
