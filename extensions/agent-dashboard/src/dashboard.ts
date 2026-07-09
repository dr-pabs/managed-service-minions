import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMinionTypeToTierMap,
  computeSessionCost,
  loadModelPricing,
  type AuditEntry,
  type MinionRun,
  type PendingApproval,
  type SessionStore,
} from 'framework-core';

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Minions Agent Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
header{background:#1e293b;border-bottom:1px solid #334155;padding:1rem 2rem;display:flex;align-items:center;gap:1rem}
header h1{font-size:1.25rem;font-weight:600;color:#f8fafc}
.status-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
main{display:grid;grid-template-columns:300px 1fr;gap:0;height:calc(100vh - 56px)}
.sidebar{background:#1e293b;border-right:1px solid #334155;overflow-y:auto;padding:1rem}
.sidebar h2{font-size:.75rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.75rem}
.session-list{list-style:none}
.session-item{padding:.625rem .75rem;border-radius:.375rem;cursor:pointer;margin-bottom:.25rem;border:1px solid transparent;transition:all .15s}
.session-item:hover{background:#334155;border-color:#475569}
.session-item.active{background:#1d4ed8;border-color:#3b82f6}
.session-id{font-size:.8rem;font-weight:500;font-family:monospace;color:#93c5fd}
.session-meta{font-size:.7rem;color:#94a3b8;margin-top:.2rem}
.content{overflow-y:auto;padding:1.5rem}
.panel{background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:1.25rem;margin-bottom:1.25rem}
.panel h2{font-size:.875rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:1rem}
.run-item{background:#0f172a;border:1px solid #334155;border-radius:.375rem;padding:.75rem;margin-bottom:.5rem}
.run-header{display:flex;align-items:center;gap:.75rem;margin-bottom:.375rem}
.run-type{font-size:.8rem;font-weight:600;color:#f8fafc}
.run-id{font-size:.7rem;font-family:monospace;color:#64748b}
.badge{display:inline-flex;align-items:center;padding:.125rem .5rem;border-radius:9999px;font-size:.7rem;font-weight:500}
.badge-completed{background:#14532d;color:#86efac}
.badge-running{background:#1e3a5f;color:#93c5fd;animation:pulse 1.5s infinite}
.badge-failed{background:#450a0a;color:#fca5a5}
.badge-pending{background:#422006;color:#fed7aa}
.empty{color:#475569;font-size:.875rem;text-align:center;padding:2rem}
.approval-item{background:#0f172a;border:1px solid #854d0e;border-radius:.375rem;padding:.75rem;margin-bottom:.5rem}
.approval-tool{font-size:.8rem;font-weight:600;color:#fcd34d;margin-bottom:.25rem}
.approval-meta{font-size:.7rem;color:#94a3b8}
.refresh-info{font-size:.7rem;color:#475569;text-align:right;margin-bottom:.75rem}
.tabs{display:flex;gap:.5rem;margin-bottom:1rem}
.tab{padding:.375rem .875rem;border-radius:.375rem;font-size:.8rem;cursor:pointer;border:1px solid #334155;color:#94a3b8;background:transparent;transition:all .15s}
.tab:hover{border-color:#475569;color:#e2e8f0}
.tab.active{background:#1d4ed8;border-color:#3b82f6;color:#f8fafc}
.btn{border:none;border-radius:.25rem;padding:.25rem .625rem;font-size:.7rem;font-weight:600;cursor:pointer;margin-right:.375rem}
.btn-approve{background:#16a34a;color:#f0fdf4}
.btn-deny{background:#dc2626;color:#fef2f2}
.btn:disabled{opacity:.5;cursor:default}
.search-row{display:flex;gap:.5rem;margin-bottom:1rem}
.search-row input{flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:.375rem;padding:.5rem .75rem;font-size:.8rem;font-family:monospace}
.search-row button{background:#1d4ed8;color:#f8fafc;border:none;border-radius:.375rem;padding:.5rem .875rem;font-size:.8rem;cursor:pointer}
.audit-item{background:#0f172a;border:1px solid #334155;border-radius:.375rem;padding:.625rem;margin-bottom:.5rem;font-size:.75rem}
.cost-line{font-size:.8rem;margin-bottom:.375rem}
.token-auth{display:flex;align-items:center;gap:.5rem;margin-left:auto}
.token-auth input{background:#0f172a;border:1px solid #334155;color:#e2e8f0;border-radius:.375rem;padding:.375rem .625rem;font-size:.75rem}
</style>
</head>
<body>
<header>
  <div class="status-dot" id="healthDot"></div>
  <h1>Minions Agent Dashboard</h1>
  <div class="token-auth">
    <input type="password" id="authTokenInput" placeholder="Bearer token (if required)">
    <span style="font-size:.7rem;color:#64748b" id="refreshLabel"></span>
  </div>
</header>
<main>
  <aside class="sidebar">
    <h2>Sessions</h2>
    <ul class="session-list" id="sessionList"></ul>
  </aside>
  <div class="content">
    <div class="refresh-info" id="lastRefresh"></div>
    <div class="tabs">
      <button class="tab active" onclick="showTab('runs')">Minion Runs</button>
      <button class="tab" onclick="showTab('approvals')">Pending Approvals</button>
      <button class="tab" onclick="showTab('tree')">Correlation Tree</button>
      <button class="tab" onclick="showTab('audit')">Audit Search</button>
      <button class="tab" onclick="showTab('cost')">Cost</button>
    </div>
    <div id="tabRuns">
      <div class="panel">
        <h2>Minion Runs</h2>
        <div id="runsList"><div class="empty">Select a session to view runs.</div></div>
      </div>
    </div>
    <div id="tabApprovals" style="display:none">
      <div class="panel">
        <h2>Pending Approvals</h2>
        <div id="approvalsList"><div class="empty">Loading...</div></div>
      </div>
    </div>
    <div id="tabTree" style="display:none">
      <div class="panel">
        <h2>Correlation Tree</h2>
        <div id="treeList"><div class="empty">Select a session to view its correlation tree.</div></div>
      </div>
    </div>
    <div id="tabAudit" style="display:none">
      <div class="panel">
        <h2>Audit Search</h2>
        <div class="search-row">
          <input type="text" id="auditSearchInput" placeholder="correlation ID">
          <button onclick="searchAudit()">Search</button>
        </div>
        <div id="auditList"><div class="empty">Enter a correlation ID and search.</div></div>
      </div>
    </div>
    <div id="tabCost" style="display:none">
      <div class="panel">
        <h2>Token / Cost per Session</h2>
        <div id="costPanel"><div class="empty">Select a session to view cost.</div></div>
      </div>
    </div>
  </div>
</main>
<script>
var selectedSessionId = null;
var selectedCorrRoot = null;
var activeTab = 'runs';

function authHeaders() {
  var token = document.getElementById('authTokenInput').value;
  return token ? { Authorization: 'Bearer ' + token } : {};
}

function authFetch(url, init) {
  init = init || {};
  init.headers = Object.assign({}, init.headers || {}, authHeaders());
  return fetch(url, init);
}

function showTab(tab) {
  activeTab = tab;
  document.getElementById('tabRuns').style.display = tab === 'runs' ? '' : 'none';
  document.getElementById('tabApprovals').style.display = tab === 'approvals' ? '' : 'none';
  document.getElementById('tabTree').style.display = tab === 'tree' ? '' : 'none';
  document.getElementById('tabAudit').style.display = tab === 'audit' ? '' : 'none';
  document.getElementById('tabCost').style.display = tab === 'cost' ? '' : 'none';
  document.querySelectorAll('.tab').forEach(function(el) {
    el.classList.toggle('active', el.textContent.toLowerCase().replace(/ /g, '') === tab.replace(/ /g, ''));
  });
  if (tab === 'approvals') loadApprovals();
  if (tab === 'tree' && selectedCorrRoot) loadTree(selectedCorrRoot);
  if (tab === 'cost' && selectedSessionId) loadCost(selectedSessionId);
}

function badge(status) {
  var cls = 'badge-pending';
  if (status === 'completed') cls = 'badge-completed';
  else if (status === 'running') cls = 'badge-running';
  else if (status === 'failed') cls = 'badge-failed';
  return '<span class="badge ' + cls + '">' + status + '</span>';
}

function escape(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function loadSessions() {
  authFetch('/sessions').then(function(r) { return r.json(); }).then(function(sessions) {
    var list = document.getElementById('sessionList');
    if (!sessions.length) {
      list.innerHTML = '<li class="empty">No sessions yet.</li>';
      return;
    }
    list.innerHTML = sessions.map(function(s) {
      var active = s.id === selectedSessionId ? ' active' : '';
      return '<li class="session-item' + active + '" onclick="selectSession(\\'' + escape(s.id) + '\\',\\'' + escape(s.correlationRoot) + '\\')">' +
        '<div class="session-id">' + escape(s.id.slice(0, 16)) + '&hellip;</div>' +
        '<div class="session-meta">' + escape(s.platform) + ' &bull; ' + escape(s.userId) + '</div>' +
        '</li>';
    }).join('');
  }).catch(function() {});
}

function selectSession(id, corrRoot) {
  selectedSessionId = id;
  selectedCorrRoot = corrRoot;
  loadSessions();
  if (activeTab === 'runs') loadRuns(id);
  if (activeTab === 'tree') loadTree(corrRoot);
}

function loadRuns(sessionId) {
  if (!sessionId) return;
  authFetch('/sessions/' + encodeURIComponent(sessionId) + '/minion-runs')
    .then(function(r) { return r.json(); })
    .then(function(runs) {
      var el = document.getElementById('runsList');
      if (!runs.length) { el.innerHTML = '<div class="empty">No runs for this session.</div>'; return; }
      el.innerHTML = runs.map(function(r) {
        return '<div class="run-item"><div class="run-header"><span class="run-type">' + escape(r.minionType) + '</span>' +
          badge(r.status) + '<span class="run-id">' + escape(r.correlationId) + '</span></div>' +
          '<div class="session-meta">Started: ' + new Date(r.createdAt).toLocaleTimeString() + '</div></div>';
      }).join('');
    }).catch(function() {});
}

function loadApprovals() {
  authFetch('/api/approvals/pending').then(function(r) { return r.json(); }).then(function(approvals) {
    var el = document.getElementById('approvalsList');
    if (!approvals.length) { el.innerHTML = '<div class="empty">No pending approvals.</div>'; return; }
    el.innerHTML = approvals.map(function(a) {
      return '<div class="approval-item"><div class="approval-tool">' + escape(a.serverAlias) + ' / ' + escape(a.toolName) + '</div>' +
        '<div class="approval-meta">Session: ' + escape(a.sessionId) + ' &bull; Requested: ' + new Date(a.requestedAt).toLocaleTimeString() + '</div>' +
        '<div style="margin-top:.5rem">' +
        '<button class="btn btn-approve" onclick="resolveApproval(\\'' + escape(a.id) + '\\',\\'approved\\',this)">Approve</button>' +
        '<button class="btn btn-deny" onclick="resolveApproval(\\'' + escape(a.id) + '\\',\\'denied\\',this)">Deny</button>' +
        '</div></div>';
    }).join('');
  }).catch(function() {});
}

function resolveApproval(id, decision, btn) {
  var approverId = window.prompt('Approver identity (e.g. your email):');
  if (!approverId) return;
  btn.closest('.approval-item').querySelectorAll('button').forEach(function(b) { b.disabled = true; });
  authFetch('/api/approvals/' + encodeURIComponent(id) + '/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: decision, approverId: approverId }),
  }).then(function() { loadApprovals(); }).catch(function() { loadApprovals(); });
}

function loadTree(corrRoot) {
  if (!corrRoot) return;
  authFetch('/correlation-tree/' + encodeURIComponent(corrRoot))
    .then(function(r) { return r.json(); })
    .then(function(runs) {
      var el = document.getElementById('treeList');
      if (!runs.length) { el.innerHTML = '<div class="empty">No runs in this correlation tree.</div>'; return; }
      el.innerHTML = runs.map(function(r) {
        return '<div class="run-item"><div class="run-header"><span class="run-type">' + escape(r.minionType) + '</span>' +
          badge(r.status) + '<span class="run-id">' + escape(r.correlationId) + '</span></div>' +
          '<div class="session-meta">Session: ' + escape(r.sessionId) + '</div></div>';
      }).join('');
    }).catch(function() {});
}

function searchAudit() {
  var corrId = document.getElementById('auditSearchInput').value;
  var url = corrId ? '/api/audit?correlationId=' + encodeURIComponent(corrId) : '/api/audit';
  authFetch(url).then(function(r) { return r.json(); }).then(function(entries) {
    var el = document.getElementById('auditList');
    if (!entries.length) { el.innerHTML = '<div class="empty">No audit entries found.</div>'; return; }
    el.innerHTML = entries.map(function(e) {
      return '<div class="audit-item"><strong>' + escape(e.status) + '</strong> ' + escape(e.minionType) + ' ' +
        escape(e.serverAlias) + '.' + escape(e.toolName) + '<br>' +
        '<span style="color:#64748b">' + escape(e.correlationId) + ' &bull; ' + new Date(e.timestamp).toLocaleTimeString() + '</span></div>';
    }).join('');
  }).catch(function() {});
}

function loadCost(sessionId) {
  if (!sessionId) return;
  authFetch('/api/sessions/' + encodeURIComponent(sessionId) + '/cost')
    .then(function(r) { return r.json(); })
    .then(function(cost) {
      var el = document.getElementById('costPanel');
      var byType = Object.keys(cost.byMinionType || {}).map(function(k) {
        var v = cost.byMinionType[k];
        return '<div class="cost-line">' + escape(k) + ': ' + v.tokens + ' tokens, $' + v.costUsd.toFixed(4) + '</div>';
      }).join('');
      el.innerHTML = '<div class="cost-line"><strong>Total: ' + cost.totalTokens + ' tokens, $' + cost.totalCostUsd.toFixed(4) + '</strong></div>' + byType;
    }).catch(function() {});
}

function checkHealth() {
  authFetch('/health').then(function(r) {
    document.getElementById('healthDot').style.background = r.ok ? '#22c55e' : '#ef4444';
  }).catch(function() {
    document.getElementById('healthDot').style.background = '#ef4444';
  });
}

function refresh() {
  checkHealth();
  loadSessions();
  if (activeTab === 'approvals') loadApprovals();
  if (activeTab === 'runs' && selectedSessionId) loadRuns(selectedSessionId);
  if (activeTab === 'tree' && selectedCorrRoot) loadTree(selectedCorrRoot);
  if (activeTab === 'cost' && selectedSessionId) loadCost(selectedSessionId);
  document.getElementById('lastRefresh').textContent = 'Last refresh: ' + new Date().toLocaleTimeString();
}

var sseSource = null;
function connectEvents() {
  if (sseSource) { sseSource.close(); }
  var token = document.getElementById('authTokenInput').value;
  var url = '/api/events' + (token ? '?token=' + encodeURIComponent(token) : '');
  sseSource = new EventSource(url);
  sseSource.onmessage = function(evt) {
    try {
      var msg = JSON.parse(evt.data);
      if (msg.type === 'approval' && activeTab === 'approvals') loadApprovals();
      if (msg.type === 'run' && activeTab === 'runs' && selectedSessionId) loadRuns(selectedSessionId);
      if (msg.type === 'audit' && activeTab === 'audit') { /* leave results as-is until next explicit search */ }
    } catch (e) { /* ignore malformed event */ }
  };
  sseSource.onerror = function() { /* EventSource auto-reconnects */ };
}

refresh();
setInterval(refresh, 5000);
connectEvents();
</script>
</body>
</html>`;


export interface DashboardServer {
  port: number;
  close: () => Promise<void>;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, matches: RegExpExecArray) => Promise<void>;
}

function jsonResponse(res: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/**
 * Reads an optional `teamId` query param (ADR-022 multi-tenancy, Milestone
 * 9). Returns `undefined` when absent so every scoped store call falls
 * through to its pre-Milestone-9 "list everything" default.
 */
function readTeamIdParam(req: http.IncomingMessage): string | undefined {
  // req.url is always set by the time a route handler runs — the dispatcher
  // above has already parsed it once to match the route.
  const url = new URL(req.url as string, 'http://localhost');
  return url.searchParams.get('teamId') ?? undefined;
}

function htmlResponse(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function notFound(res: http.ServerResponse): void {
  jsonResponse(res, 404, { error: 'Not found' });
}

function unauthorized(res: http.ServerResponse): void {
  jsonResponse(res, 401, { error: 'unauthorized' });
}

/**
 * Bearer-token check for `DASHBOARD_AUTH_TOKEN` (Milestone 14, review
 * finding M7 "dashboard has no auth"). Mirrors `operator-http.ts`'s
 * `isAuthorized` string-length-then-equality check — this endpoint's threat
 * model (a shared operator secret) doesn't need `timingSafeEqual`-grade
 * constant-time comparison, same rationale as that file.
 *
 * The `/api/events` SSE route additionally accepts the token as a `?token=`
 * query param, because the browser's `EventSource` API cannot set custom
 * request headers — this is the ONLY route where a query-string credential is
 * accepted (Milestone 18, carried-forward Milestone 14 review finding:
 * previously `?token=` was accepted on every route whenever the bearer
 * header was absent, which put the shared secret into ordinary API access
 * logs and browser history for routes that don't need it; not a hole today
 * since a wrong value still 401s, but needless exposure). Every other route
 * requires the header — a valid `?token=` value on a non-events route is
 * rejected, not merely a missing one.
 */
function isDashboardAuthorized(req: http.IncomingMessage, authToken: string | undefined): boolean {
  if (!authToken) {
    // No token configured: current open dev behavior, unchanged from before
    // Milestone 14 (loudly warned about at startup instead).
    return true;
  }
  const header = req.headers.authorization;
  const expected = `Bearer ${authToken}`;
  if (header && header.length === expected.length && header === expected) {
    return true;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/events') {
    return false;
  }
  const queryToken = url.searchParams.get('token');
  return queryToken !== null && queryToken === authToken;
}

function defaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // extensions/agent-dashboard/src (or dist) -> repo root is three levels up
  // (same convention as extensions/orchestrator/src/runner.ts's
  // defaultRepoRoot and mcp-toolshed's TOOLSHED_REPO_ROOT default).
  return path.resolve(here, '../../../');
}

/**
 * `GET /api/sessions/:id/cost` (Milestone 13, review finding M9/F9): joins
 * every `MinionRun.tokensUsed` for the session against `rules/models.yaml`
 * tier prices (via the minion's frontmatter `model_tier`) — see
 * `framework-core`'s `model-cost.ts` for the actual math, kept there (not
 * duplicated here) so it has one deterministic-fixture test suite covering
 * the arithmetic and this endpoint only wires it to HTTP + the store.
 *
 * Auth posture: this endpoint intentionally matches every OTHER dashboard
 * route today — no bearer-token/Entra check, because Milestone 14 (not this
 * one) adds `DASHBOARD_AUTH_TOKEN` gating across the whole dashboard server.
 * Adding auth to just this one new route while every existing route stays
 * open would be inconsistent and not meaningfully more secure; M14's gate
 * wraps the entire route table in one place, this endpoint included. Scoped
 * by the SAME optional `?teamId=` param the M9 `/sessions/:id/minion-runs`
 * endpoint already respects (ADR-022 multi-tenancy), via the identical
 * `store.listMinionRunsBySession(id, teamId)` call.
 */
/**
 * Reads and parses a JSON request body, throwing on malformed JSON. Mirrors
 * `operator-http.ts`'s `readBody`, kept local here since the dashboard and
 * mcp-toolshed packages intentionally don't share HTTP-handler internals
 * (only their public `SessionStore`/type surface, via `framework-core`).
 */
function readJsonBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Proxies `GET /api/approvals/pending` and `POST /api/approvals/:id/resolve`
 * to the toolshed's own operator HTTP endpoint (Milestone 4,
 * `extensions/mcp-toolshed/src/operator-http.ts`) using `TOOLSHED_OPERATOR_TOKEN`
 * — the dashboard never resolves an approval directly against the store,
 * because `resolveApprovalRecord` is intentionally NOT exported for
 * cross-process use outside the toolshed's own HTTP surface (C1's fix: no
 * approve path exists except operator-authenticated HTTP).
 *
 * toolshed-governance-invariants #4: approvals resolved via the dashboard
 * must record `approverKind:'dashboard'`. That is enforced HERE, not left to
 * the caller — the request body's `approverKind` (if any) is always
 * overwritten with the literal `'dashboard'` before forwarding, so this
 * proxy can never become a route for impersonating a different operator
 * surface.
 */
function buildApprovalRoutes(operatorUrl: string | undefined, operatorToken: string | undefined, fetchImpl: typeof fetch): Route[] {
  async function operatorRequest(
    path: string,
    init: { method: string; body?: unknown }
  ): Promise<{ status: number; body: unknown }> {
    if (!operatorUrl) {
      return { status: 500, body: { error: 'dashboard is not configured with TOOLSHED_OPERATOR_URL' } };
    }
    let response: Response;
    try {
      response = await fetchImpl(`${operatorUrl}${path}`, {
        method: init.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${operatorToken ?? ''}`,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      return { status: 502, body: { error: `toolshed operator endpoint unreachable: ${err instanceof Error ? err.message : String(err)}` } };
    }
    const body = await response.json().catch(() => undefined);
    return { status: response.status, body };
  }

  return [
    {
      method: 'GET',
      pattern: /^\/api\/approvals\/pending$/,
      handler: async (_req, res) => {
        const result = await operatorRequest('/approvals/pending', { method: 'GET' });
        jsonResponse(res, result.status, result.body);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/approvals\/([^/]+)\/resolve$/,
      handler: async (req, res, matches) => {
        const approvalId = decodeURIComponent(matches[1]);
        const bodyText = await readJsonBody(req);
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
        const result = await operatorRequest(`/approvals/${encodeURIComponent(approvalId)}/resolve`, {
          method: 'POST',
          // approverKind is always 'dashboard' here, never taken from the
          // request body (toolshed-governance-invariants #4).
          body: { decision: body.decision, approverId: body.approverId, approverKind: 'dashboard' },
        });
        jsonResponse(res, result.status, result.body);
      },
    },
  ];
}

/**
 * `GET /api/audit?correlationId=...` (Milestone 14 audit search). The store
 * already supports filtering by `correlationId` (`listAuditEntries`), so
 * this route is a thin wire-up.
 */
function buildAuditRoute(store: SessionStore): Route {
  return {
    method: 'GET',
    pattern: /^\/api\/audit$/,
    handler: async (req, res) => {
      const url = new URL(req.url as string, 'http://localhost');
      const correlationId = url.searchParams.get('correlationId') ?? undefined;
      jsonResponse(res, 200, store.listAuditEntries(correlationId ? { correlationId } : undefined));
    },
  };
}

/** A single item pushed over `GET /api/events`. */
interface DashboardEvent {
  type: 'run' | 'approval' | 'audit';
  data: MinionRun | PendingApproval | AuditEntry;
}

/**
 * `GET /api/events` — Server-Sent Events (Milestone 14). Polls the store
 * every `pollIntervalMs` (default 2s, real `setInterval`/`clearInterval` by
 * default, both injectable so tests never wait on a real timer) and pushes
 * one SSE `data:` line per NEW run/approval/audit entry seen since the last
 * poll. "New" is tracked per-connection via a set of already-seen IDs, so a
 * client that connects mid-session doesn't get a backlog reply-of-everything
 * — only entries created after it connected.
 *
 * Cleanup: the interval is cleared on the request's `close` event (fires on
 * both a clean client disconnect and an aborted connection), so a dropped
 * SSE client never leaks a running interval — this was flagged explicitly as
 * a "real bug" risk in the milestone text and is covered by a dedicated
 * regression test.
 */
function buildEventsRoute(
  store: SessionStore,
  pollIntervalMs: number,
  setIntervalFn: typeof setInterval,
  clearIntervalFn: typeof clearInterval
): Route {
  return {
    method: 'GET',
    pattern: /^\/api\/events$/,
    handler: async (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        // Disables buffering in reverse proxies (nginx convention) so SSE
        // chunks flush immediately instead of batching — dependency-free
        // equivalent of what a websocket library would handle for you.
        'X-Accel-Buffering': 'no',
      });
      // node:http buffers headers until the first body write/flush by
      // default; SSE has no guaranteed first write (a client may connect
      // between poll ticks), so headers must be flushed explicitly or the
      // client's connection callback never fires.
      res.flushHeaders();

      const seenRunIds = new Set<string>();
      const seenApprovalIds = new Set<string>();
      const seenAuditIds = new Set<string>();

      /**
       * `SessionStore` has no "list every run" method (by design — runs are
       * always scoped to a session or a correlation root, see `store.ts`).
       * The dashboard already knows every session via `listSessions()`, so
       * new-run detection walks each session's `correlationRoot` — the same
       * approach the existing Correlation Tree tab already uses per-session,
       * just swept across all sessions on each poll tick.
       */
      function allRuns(): MinionRun[] {
        const runs: MinionRun[] = [];
        for (const session of store.listSessions()) {
          runs.push(...store.listMinionRunsByCorrelationRoot(session.correlationRoot));
        }
        return runs;
      }

      // Seed "seen" with everything that exists at connect time so only
      // NEW items (created after this client connected) are pushed.
      for (const r of allRuns()) seenRunIds.add(r.id);
      for (const a of store.listPendingApprovals()) seenApprovalIds.add(a.id);
      for (const e of store.listAuditEntries()) seenAuditIds.add(e.id);

      function send(event: DashboardEvent): void {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      function poll(): void {
        for (const r of allRuns()) {
          if (!seenRunIds.has(r.id)) {
            seenRunIds.add(r.id);
            send({ type: 'run', data: r });
          }
        }
        for (const a of store.listPendingApprovals()) {
          if (!seenApprovalIds.has(a.id)) {
            seenApprovalIds.add(a.id);
            send({ type: 'approval', data: a });
          }
        }
        for (const e of store.listAuditEntries()) {
          if (!seenAuditIds.has(e.id)) {
            seenAuditIds.add(e.id);
            send({ type: 'audit', data: e });
          }
        }
      }

      const interval = setIntervalFn(poll, pollIntervalMs);
      req.on('close', () => {
        clearIntervalFn(interval);
      });
    },
  };
}

function buildCostRoute(store: SessionStore, repoRoot: string): Route {
  let pricing: ReturnType<typeof loadModelPricing> | undefined;
  let tierMap: Map<string, string> | undefined;
  function loaded() {
    if (!pricing || !tierMap) {
      pricing = loadModelPricing(path.join(repoRoot, 'rules', 'models.yaml'));
      tierMap = buildMinionTypeToTierMap(repoRoot);
    }
    return { pricing, tierMap };
  }

  return {
    method: 'GET',
    pattern: /^\/api\/sessions\/([^/]+)\/cost$/,
    handler: async (req, res, matches) => {
      const runs = store.listMinionRunsBySession(matches[1], readTeamIdParam(req));
      const { pricing: p, tierMap: t } = loaded();
      jsonResponse(res, 200, computeSessionCost(runs, t, p));
    },
  };
}

/**
 * Milestone 14 options, all optional so every pre-Milestone-14 call site
 * (tests included) keeps compiling and behaving exactly as before.
 */
export interface DashboardServerOptions {
  /**
   * `DASHBOARD_AUTH_TOKEN` — when set, every request must present
   * `Authorization: Bearer <authToken>` (or `?token=` for the SSE route,
   * see `isDashboardAuthorized`) or receive a 401. When unset (or an empty
   * string), the dashboard keeps its pre-Milestone-14 open behavior for
   * local dev, but logs a loud startup warning — same pattern as the
   * toolshed's `TOOLSHED_ALLOW_UNSIGNED`/missing-`TOOLSHED_SIGNING_SECRET`
   * warnings in `server.ts`. Production fronts the dashboard with Azure
   * Container Apps' built-in Entra ID "easy auth" instead (see
   * `infra/terraform/modules/container_apps/main.tf`); this token is the
   * local-dev/no-easy-auth-yet fallback.
   */
  authToken?: string;
  /**
   * Base URL of the toolshed's operator HTTP server (Milestone 4,
   * `startOperatorHttpServer`), e.g. `http://localhost:8090`. Required for
   * the `/api/approvals/*` proxy routes to do anything but 500.
   */
  operatorUrl?: string;
  /** `TOOLSHED_OPERATOR_TOKEN` — the shared secret the proxy authenticates itself to the toolshed with. */
  operatorToken?: string;
  /** Injectable for tests; defaults to the real global `fetch` (Node 20+). */
  fetchImpl?: typeof fetch;
  /** SSE poll interval in ms. Defaults to 2000 per the milestone text. */
  pollIntervalMs?: number;
  /** Injectable timer functions so SSE tests never wait on a real interval. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export async function startDashboardServer(
  store: SessionStore,
  port: number,
  createServer: typeof http.createServer = http.createServer,
  agentTypes: string[] = [],
  repoRoot: string = defaultRepoRoot(),
  options: DashboardServerOptions = {}
): Promise<DashboardServer> {
  const configuredAgentTypes = Object.freeze([...agentTypes]);
  const authToken = options.authToken;
  if (!authToken) {
    console.warn(
      '[dashboard] DASHBOARD_AUTH_TOKEN is not set — every dashboard route (including approve/deny) is open with no authentication. This is only acceptable in local development; production must front this service with Azure Container Apps Entra ID easy-auth or set DASHBOARD_AUTH_TOKEN.'
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/$/,
      handler: async (_req, res) => {
        htmlResponse(res, DASHBOARD_HTML);
      },
    },
    {
      method: 'GET',
      pattern: /^\/health$/,
      handler: async (_req, res) => {
        jsonResponse(res, 200, { status: 'ok' });
      },
    },
    {
      method: 'GET',
      pattern: /^\/sessions$/,
      handler: async (req, res) => {
        jsonResponse(res, 200, store.listSessions(readTeamIdParam(req)));
      },
    },
    {
      method: 'GET',
      pattern: /^\/sessions\/([^/]+)$/,
      handler: async (_req, res, matches) => {
        const session = store.getSession(matches[1]);
        if (!session) {
          return notFound(res);
        }
        jsonResponse(res, 200, session);
      },
    },
    {
      method: 'GET',
      pattern: /^\/sessions\/([^/]+)\/minion-runs$/,
      handler: async (req, res, matches) => {
        jsonResponse(res, 200, store.listMinionRunsBySession(matches[1], readTeamIdParam(req)));
      },
    },
    {
      method: 'GET',
      pattern: /^\/correlation-tree\/([^/]+)$/,
      handler: async (_req, res, matches) => {
        jsonResponse(res, 200, store.listMinionRunsByCorrelationRoot(matches[1]));
      },
    },
    {
      method: 'GET',
      pattern: /^\/pending-approvals$/,
      handler: async (_req, res) => {
        jsonResponse(res, 200, store.listPendingApprovals());
      },
    },
    buildCostRoute(store, repoRoot),
    ...buildApprovalRoutes(options.operatorUrl, options.operatorToken, fetchImpl),
    buildAuditRoute(store),
    buildEventsRoute(store, pollIntervalMs, setIntervalFn, clearIntervalFn),
    {
      // Internal operator endpoint — do not expose the dashboard port to untrusted networks.
      method: 'GET',
      pattern: /^\/api\/config$/,
      handler: async (_req, res) => {
        jsonResponse(res, 200, { agentTypes: configuredAgentTypes });
      },
    },
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (!isDashboardAuthorized(req, authToken)) {
        unauthorized(res);
        return;
      }

      for (const route of routes) {
        if (route.method !== req.method) {
          continue;
        }
        const matches = route.pattern.exec(pathname);
        if (matches) {
          await route.handler(req, res, matches);
          return;
        }
      }

      notFound(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jsonResponse(res, 500, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      const address = server.address();
      const listeningPort = typeof address === 'object' && address !== null ? address.port : port;
      console.log(`Dashboard backend listening on port ${listeningPort}`);
      resolve({
        port: listeningPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            // SSE connections (Milestone 14) are long-lived keep-alive
            // sockets that `server.close()` alone will wait on forever if
            // any client is still connected — force them closed on
            // shutdown, same as any other in-flight request would be
            // dropped. Guarded because test doubles for `http.Server`
            // (see dashboard-server-errors.test.ts) don't implement this
            // Node 18.2+ method.
            server.closeAllConnections?.();
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

    server.on('error', (err) => {
      reject(err);
    });
  });
}
