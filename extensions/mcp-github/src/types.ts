import { z } from 'zod';

export const ownerRepoSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

export const listPullRequestsInputSchema = ownerRepoSchema.extend({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.number().int().min(1).max(100).optional(),
});
export type ListPullRequestsInput = z.infer<typeof listPullRequestsInputSchema>;

export const pullNumberInputSchema = ownerRepoSchema.extend({
  pull_number: z.number().int().min(1),
});
export type PullNumberInput = z.infer<typeof pullNumberInputSchema>;

export const createPullRequestInputSchema = ownerRepoSchema.extend({
  title: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1),
  body: z.string().optional(),
});
export type CreatePullRequestInput = z.infer<typeof createPullRequestInputSchema>;

export const mergePullRequestInputSchema = pullNumberInputSchema.extend({
  commit_title: z.string().optional(),
  commit_message: z.string().optional(),
  merge_method: z.enum(['merge', 'squash', 'rebase']).optional(),
});
export type MergePullRequestInput = z.infer<typeof mergePullRequestInputSchema>;

/**
 * PRs are issues in GitHub's REST API, so a PR comment is created via the
 * issues endpoint (`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`)
 * -- `issue_number` and `pull_number` are the same integer for a PR
 * (Milestone 15, F11: the webhook-ingress reply path).
 */
export const createIssueCommentInputSchema = ownerRepoSchema.extend({
  issue_number: z.number().int().min(1),
  body: z.string().min(1),
});
export type CreateIssueCommentInput = z.infer<typeof createIssueCommentInputSchema>;

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PullRequestUser {
  login: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  user: PullRequestUser | null;
  html_url: string;
}

export interface PullRequestRef {
  ref: string;
  sha: string;
}

export interface PullRequest extends PullRequestSummary {
  body: string | null;
  head: PullRequestRef;
  base: PullRequestRef;
  merged?: boolean;
  mergeable: boolean | null;
}

export interface MergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

export interface IssueComment {
  id: number;
  body: string;
  html_url: string;
}
