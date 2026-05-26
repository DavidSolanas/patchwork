export interface IssueRef {
  repo: { owner: string; name: string };
  number: number;
  title: string;
  body: string;
  labels: string[];
  commentsCount: number;
  assignees: string[];
  htmlUrl: string;
  createdAt: string;
}

export interface TriageScore {
  score: number;
  breakdown: {
    clarity: number;
    scope: number;
    context: number;
    viability: number;
  };
  reason: string;
  recommendation: 'fix' | 'skip' | 'escalate';
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface CostEstimate {
  model: string;
  tokens: TokenUsage;
  usd: number;
}

export type RunOutcome =
  | { kind: 'success'; branch: string; diff: string; commitSha: string; agentSummary: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'no_diff' }
  | { kind: 'error'; message: string };

export interface AgentRunResult {
  issue: IssueRef;
  outcome: RunOutcome;
  model: string;
  tokens: TokenUsage;
  costUsd: number;
  startedAt: string;
  endedAt: string;
  cursorRunId: string;
  boundRepo: { owner: string; name: string };
  testingNotes: string;
}

export type SuccessfulAgentRunResult = AgentRunResult & {
  outcome: Extract<RunOutcome, { kind: 'success' }>;
};

export interface ReviewPayload {
  issue: IssueRef;
  result: SuccessfulAgentRunResult;
  filesChanged: { path: string; additions: number; deletions: number; binary: boolean }[];
  totalAdditions: number;
  totalDeletions: number;
  largeDiffWarning: boolean;
  estimatedPrCostUsd: number;
}

export type ReviewDecision =
  | { action: 'approve'; testedLocally: boolean }
  | { action: 'reject'; reason?: string }
  | { action: 'skip'; reason?: string }
  | { action: 'open_external' };

export interface ReviewSurface {
  readonly interactive: boolean;
  present(payload: ReviewPayload): Promise<ReviewDecision>;
}

export interface RunStats {
  startedAt: string;
  endedAt?: string;
  issuesConsidered: number;
  issuesScored: number;
  issuesAttempted: number;
  prsCreated: number;
  rejected: number;
  skipped: number;
  errors: number;
  totalCostUsd: number;
  perIssue: AgentRunResult[];
  costLimitHit: boolean;
}

export class PatchworkError extends Error {
  public readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'PatchworkError';
    this.hint = hint;
  }
}
