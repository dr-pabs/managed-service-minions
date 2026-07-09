/* eslint-disable @typescript-eslint/no-explicit-any */
import { jest } from '@jest/globals';
import type { GitHubClient } from '../client.js';

const mockSetRequestHandler = jest.fn() as jest.Mock<any>;
const mockConnect = jest.fn() as jest.Mock<any>;
const MockServer = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: MockServer,
}));

MockServer.mockImplementation(() => ({
  setRequestHandler: mockSetRequestHandler,
  connect: mockConnect,
}));

const { createGitHubServer } = await import('../server.js');

describe('createGitHubServer', () => {
  let mockClient: GitHubClient;

  beforeEach(() => {
    mockClient = {
      listPullRequests: jest.fn(),
      getPullRequest: jest.fn(),
      getPullRequestDiff: jest.fn(),
      createPullRequest: jest.fn(),
      mergePullRequest: jest.fn(),
      createIssueComment: jest.fn(),
    } as unknown as GitHubClient;

    mockSetRequestHandler.mockClear();
    mockConnect.mockClear();
  });

  it('creates an MCP server and registers handlers', () => {
    createGitHubServer(mockClient);
    expect(MockServer).toHaveBeenCalledWith(
      { name: 'mcp-github', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
    expect(mockSetRequestHandler).toHaveBeenCalledTimes(2);
  });

  it('lists the GitHub tools', async () => {
    createGitHubServer(mockClient);
    const listToolsHandler = mockSetRequestHandler.mock.calls[0][1] as () => Promise<{
      tools: Array<{ name: string }>;
    }>;
    const response = await listToolsHandler();
    expect(response.tools).toHaveLength(6);
    expect(response.tools.map((t) => t.name)).toEqual([
      'github_list_pull_requests',
      'github_get_pull_request',
      'github_get_pull_request_diff',
      'github_create_pull_request',
      'github_merge_pull_request',
      'github_create_issue_comment',
    ]);
  });

  describe('call tool handler', () => {
    async function callTool(name: string, args: Record<string, unknown> = {}) {
      createGitHubServer(mockClient);
      const handler = mockSetRequestHandler.mock.calls[1][1] as (req: {
        params: { name: string; arguments?: Record<string, unknown> };
      }) => Promise<{ content: Array<{ text: string }> }>;
      return handler({ params: { name, arguments: args } });
    }

    it('lists pull requests', async () => {
      const prs = [{ number: 1, title: 'PR 1' }];
      (mockClient.listPullRequests as jest.Mock<any>).mockResolvedValue(prs);
      const response = await callTool('github_list_pull_requests', {
        owner: 'org',
        repo: 'repo',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.data).toEqual(prs);
      expect(mockClient.listPullRequests).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'org', repo: 'repo', state: 'open' })
      );
    });

    it('gets a pull request', async () => {
      const pr = { number: 2, title: 'PR 2' };
      (mockClient.getPullRequest as jest.Mock<any>).mockResolvedValue(pr);
      const response = await callTool('github_get_pull_request', {
        owner: 'org',
        repo: 'repo',
        pull_number: 2,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.data).toEqual(pr);
    });

    it('gets a pull request diff', async () => {
      (mockClient.getPullRequestDiff as jest.Mock<any>).mockResolvedValue('diff text');
      const response = await callTool('github_get_pull_request_diff', {
        owner: 'org',
        repo: 'repo',
        pull_number: 3,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.data).toBe('diff text');
    });

    it('creates a pull request', async () => {
      const created = { number: 4 };
      (mockClient.createPullRequest as jest.Mock<any>).mockResolvedValue(created);
      const response = await callTool('github_create_pull_request', {
        owner: 'org',
        repo: 'repo',
        title: 'New PR',
        head: 'feature',
        base: 'main',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.data).toEqual(created);
    });

    it('merges a pull request', async () => {
      const merged = { sha: 'abc', merged: true, message: 'Merged' };
      (mockClient.mergePullRequest as jest.Mock<any>).mockResolvedValue(merged);
      const response = await callTool('github_merge_pull_request', {
        owner: 'org',
        repo: 'repo',
        pull_number: 5,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.data).toEqual(merged);
    });

    it('creates an issue comment (Milestone 15, F11)', async () => {
      const comment = { id: 7, body: 'Nice work.', html_url: 'https://github.com/org/repo/issues/1#issuecomment-7' };
      (mockClient.createIssueComment as jest.Mock<any>).mockResolvedValue(comment);
      const response = await callTool('github_create_issue_comment', {
        owner: 'org',
        repo: 'repo',
        issue_number: 1,
        body: 'Nice work.',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.data).toEqual(comment);
      expect(mockClient.createIssueComment).toHaveBeenCalledWith(
        expect.objectContaining({ owner: 'org', repo: 'repo', issue_number: 1, body: 'Nice work.' })
      );
    });

    it('returns an error for unknown tools', async () => {
      const response = await callTool('github_unknown_tool', {});
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
      expect(payload.error).toContain('Unknown tool');
    });

    it('returns an error for invalid arguments', async () => {
      const response = await callTool('github_get_pull_request', {
        owner: 'org',
        repo: 'repo',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
      expect(payload.error).toBeDefined();
    });

    it('returns an error when the client throws', async () => {
      (mockClient.listPullRequests as jest.Mock<any>).mockRejectedValue(
        new Error('rate limit exceeded')
      );
      const response = await callTool('github_list_pull_requests', {
        owner: 'org',
        repo: 'repo',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('rate limit exceeded');
    });

    it('returns a stringified error for non-Error rejections', async () => {
      (mockClient.listPullRequests as jest.Mock<any>).mockRejectedValue('string failure');
      const response = await callTool('github_list_pull_requests', {
        owner: 'org',
        repo: 'repo',
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('string failure');
    });

    it('handles missing arguments', async () => {
      createGitHubServer(mockClient);
      const handler = mockSetRequestHandler.mock.calls[1][1] as (req: {
        params: { name: string; arguments?: Record<string, unknown> };
      }) => Promise<{ content: Array<{ text: string }> }>;
      const response = await handler({ params: { name: 'github_list_pull_requests' } });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.success).toBe(false);
      expect(payload.error).toBeDefined();
    });
  });
});
