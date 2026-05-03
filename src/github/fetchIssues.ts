import type { Octokit } from '@octokit/rest';
import type { IssueRef } from '../types.js';

export interface FetchIssuesInput {
  octokit: Octokit;
  owner: string;
  name: string;
  labels: string[];
  maxIssues: number;
  skipIfCommentsGt: number;
}

const DROP_LABELS: ReadonlySet<string> = new Set([
  'needs-design',
  'wontfix',
  'duplicate',
  'question',
]);

function labelIntersectsDropList(labels: readonly string[]): boolean {
  for (const label of labels) {
    if (DROP_LABELS.has(label.toLowerCase())) return true;
  }
  return false;
}

export async function fetchIssues(input: FetchIssuesInput): Promise<IssueRef[]> {
  const { octokit, owner, name, labels, maxIssues, skipIfCommentsGt } = input;

  const collected: IssueRef[] = [];
  const params: Parameters<typeof octokit.rest.issues.listForRepo>[0] = {
    owner,
    repo: name,
    state: 'open',
    per_page: 100,
  };
  if (labels.length > 0) {
    params.labels = labels.join(',');
  }

  const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, params);

  for await (const page of iterator) {
    for (const raw of page.data) {
      // 1. Drop PRs (the issues endpoint returns PRs too).
      if (raw.pull_request) continue;

      // 2. Drop assigned issues.
      const assignees = (raw.assignees ?? []).map(a => a.login);
      if (assignees.length > 0) continue;

      // 3. Drop issues touching the negative-label list.
      const issueLabels: string[] = (raw.labels ?? []).map(l =>
        typeof l === 'string' ? l : (l.name ?? ''),
      ).filter(Boolean);
      if (labelIntersectsDropList(issueLabels)) continue;

      // 4. Drop issues over the comment threshold.
      if (raw.comments > skipIfCommentsGt) continue;

      // 5. Drop issues with empty body.
      if (raw.body == null || raw.body.trim() === '') continue;

      collected.push({
        repo: { owner, name },
        number: raw.number,
        title: raw.title,
        body: raw.body,
        labels: issueLabels,
        commentsCount: raw.comments,
        assignees,
        htmlUrl: raw.html_url,
        createdAt: raw.created_at,
      });

      // 6. Stop early once we have enough.
      if (collected.length >= maxIssues) {
        return collected;
      }
    }
  }

  return collected;
}
