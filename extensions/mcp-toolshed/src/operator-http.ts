import http from 'node:http';
import type { SessionStore } from 'framework-core';
import { resolveApprovalRecord } from './toolshed.js';

/**
 * Bare `node:http` operator surface for the toolshed (Milestone 4, H3/F1) —
 * dependency-free, consistent with `extensions/agent-dashboard`'s own
 * `node:http` server. This finally gives `startToolshedServer(port)` a use
 * for its `port` argument (previously prefixed `_port` and unused — see the
 * ExecPlan's Milestone 4 text and Milestone 18's "verify" follow-up).
 *
 * Routes:
 *   POST /approvals/:id/resolve   { decision: 'approved'|'denied', approverId: string }
 *     Requires `Authorization: Bearer <TOOLSHED_OPERATOR_TOKEN>`; 401s when
 *     missing or wrong. Resolves via the internal `resolveApprovalRecord`
 *     (never exposed as an MCP tool — C1's fix stands: only this
 *     operator-authenticated HTTP surface, and the Slack/Teams action
 *     handlers that call it, can resolve an approval).
 *   GET  /approvals/pending       -> store.listPendingApprovals()
 *     Same bearer-token requirement (this is an internal operator endpoint,
 *     not meant to be reachable from an untrusted network — same caveat the
 *     dashboard's own `/api/config` comment makes).
 */
export interface OperatorHttpServer {
  port: number;
  close: () => Promise<void>;
}

function jsonResponse(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isAuthorized(req: http.IncomingMessage, operatorToken: string): boolean {
  const header = req.headers.authorization;
  if (!header || !operatorToken) return false;
  const expected = `Bearer ${operatorToken}`;
  // Length check first: timing-safe comparison on unequal-length buffers
  // throws in node:crypto, and this endpoint's threat model (a shared
  // operator secret, not a per-user credential relied on at scale) doesn't
  // need constant-time comparison the way the minion token's HMAC does.
  return header.length === expected.length && header === expected;
}

export async function startOperatorHttpServer(
  store: SessionStore,
  port: number,
  operatorToken: string,
  createServer: typeof http.createServer = http.createServer
): Promise<OperatorHttpServer> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (!isAuthorized(req, operatorToken)) {
        jsonResponse(res, 401, { error: 'unauthorized' });
        return;
      }

      const resolveMatch = /^\/approvals\/([^/]+)\/resolve$/.exec(pathname);
      if (req.method === 'POST' && resolveMatch) {
        const approvalId = decodeURIComponent(resolveMatch[1]);
        const bodyText = await readBody(req);
        let body: { decision?: string; approverId?: string } = {};
        try {
          body = bodyText ? (JSON.parse(bodyText) as typeof body) : {};
        } catch {
          jsonResponse(res, 400, { error: 'invalid JSON body' });
          return;
        }
        if (body.decision !== 'approved' && body.decision !== 'denied') {
          jsonResponse(res, 400, { error: "decision must be 'approved' or 'denied'" });
          return;
        }
        if (!body.approverId) {
          jsonResponse(res, 400, { error: 'approverId is required' });
          return;
        }
        const result = resolveApprovalRecord(approvalId, body.decision, {
          kind: 'dashboard',
          id: body.approverId,
        });
        jsonResponse(res, result.status === 'success' ? 200 : 404, result);
        return;
      }

      if (req.method === 'GET' && pathname === '/approvals/pending') {
        jsonResponse(res, 200, store.listPendingApprovals());
        return;
      }

      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err) {
      jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      const address = server.address();
      const listeningPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({
        port: listeningPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) {
                rejectClose(err);
              } else {
                resolveClose();
              }
            });
          }),
      });
    });
  });
}
