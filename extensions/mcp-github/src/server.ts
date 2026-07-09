import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { GitHubClient } from './client.js';
import {
  createIssueCommentInputSchema,
  createPullRequestInputSchema,
  listPullRequestsInputSchema,
  mergePullRequestInputSchema,
  pullNumberInputSchema,
} from './types.js';

const githubTools: Tool[] = [
  {
    name: 'github_list_pull_requests',
    description: 'List pull requests for a GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'integer' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github_get_pull_request',
    description: 'Get details for a single GitHub pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'github_get_pull_request_diff',
    description: 'Get the diff text for a single GitHub pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'github_create_pull_request',
    description: 'Create a new GitHub pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'github_merge_pull_request',
    description: 'Merge a GitHub pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
        commit_title: { type: 'string' },
        commit_message: { type: 'string' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'github_create_issue_comment',
    description: 'Post a comment on a GitHub issue or pull request (PRs are issues in the GitHub API).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'integer' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
];

export function createGitHubServer(client: GitHubClient): Server {
  const server = new Server(
    { name: 'mcp-github', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: githubTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};

    try {
      let data: unknown;

      switch (name) {
        case 'github_list_pull_requests':
          data = await client.listPullRequests(listPullRequestsInputSchema.parse(args));
          break;
        case 'github_get_pull_request':
          data = await client.getPullRequest(pullNumberInputSchema.parse(args));
          break;
        case 'github_get_pull_request_diff':
          data = await client.getPullRequestDiff(pullNumberInputSchema.parse(args));
          break;
        case 'github_create_pull_request':
          data = await client.createPullRequest(createPullRequestInputSchema.parse(args));
          break;
        case 'github_merge_pull_request':
          data = await client.mergePullRequest(mergePullRequestInputSchema.parse(args));
          break;
        case 'github_create_issue_comment':
          data = await client.createIssueComment(createIssueCommentInputSchema.parse(args));
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, data }) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }) }],
      };
    }
  });

  return server;
}
