import http from 'node:http';
import type { SessionStore } from 'framework-core';

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Goose Agent Dashboard</title>
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
</style>
</head>
<body>
<header>
  <div class="status-dot" id="healthDot"></div>
  <h1>Goose Agent Dashboard</h1>
  <span style="margin-left:auto;font-size:.75rem;color:#64748b" id="refreshLabel"></span>
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
  </div>
</main>
<script>
var selectedSessionId = null;
var selectedCorrRoot = null;
var activeTab = 'runs';

function showTab(tab) {
  activeTab = tab;
  document.getElementById('tabRuns').style.display = tab === 'runs' ? '' : 'none';
  document.getElementById('tabApprovals').style.display = tab === 'approvals' ? '' : 'none';
  document.getElementById('tabTree').style.display = tab === 'tree' ? '' : 'none';
  document.querySelectorAll('.tab').forEach(function(el) {
    el.classList.toggle('active', el.textContent.toLowerCase().replace(/ /g, '') === tab.replace(/ /g, ''));
  });
  if (tab === 'approvals') loadApprovals();
  if (tab === 'tree' && selectedCorrRoot) loadTree(selectedCorrRoot);
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
  fetch('/sessions').then(function(r) { return r.json(); }).then(function(sessions) {
    var list = document.getElementById('sessionList');
    if (!sessions.length) {
      list.innerHTML = '<li class="empty">No sessions yet.</li>';
      return;
    }
    list.innerHTML = sessions.map(function(s) {
      var active = s.id === selectedSessionId ? ' active' : '';
      return '<li class="session-item' + active + '" onclick="selectSession(\'' + escape(s.id) + '\',\'' + escape(s.correlationRoot) + '\')">' +
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
  fetch('/sessions/' + encodeURIComponent(sessionId) + '/minion-runs')
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
  fetch('/pending-approvals').then(function(r) { return r.json(); }).then(function(approvals) {
    var el = document.getElementById('approvalsList');
    if (!approvals.length) { el.innerHTML = '<div class="empty">No pending approvals.</div>'; return; }
    el.innerHTML = approvals.map(function(a) {
      return '<div class="approval-item"><div class="approval-tool">' + escape(a.serverAlias) + ' / ' + escape(a.toolName) + '</div>' +
        '<div class="approval-meta">Session: ' + escape(a.sessionId) + ' &bull; Requested: ' + new Date(a.requestedAt).toLocaleTimeString() + '</div></div>';
    }).join('');
  }).catch(function() {});
}

function loadTree(corrRoot) {
  if (!corrRoot) return;
  fetch('/correlation-tree/' + encodeURIComponent(corrRoot))
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

function checkHealth() {
  fetch('/health').then(function(r) {
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
  document.getElementById('lastRefresh').textContent = 'Last refresh: ' + new Date().toLocaleTimeString();
}

refresh();
setInterval(refresh, 5000);
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

function htmlResponse(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function notFound(res: http.ServerResponse): void {
  jsonResponse(res, 404, { error: 'Not found' });
}

export async function startDashboardServer(
  store: SessionStore,
  port: number,
  createServer: typeof http.createServer = http.createServer
): Promise<DashboardServer> {
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
      handler: async (_req, res) => {
        jsonResponse(res, 200, store.listSessions());
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
      handler: async (_req, res, matches) => {
        jsonResponse(res, 200, store.listMinionRunsBySession(matches[1]));
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
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

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
