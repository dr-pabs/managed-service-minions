#!/usr/bin/env bash
# Local development convenience script for the Minions framework.
#
# Builds all TypeScript packages and extensions, starts the mock MCP servers
# via docker-compose (SSE over HTTP on ports 3001-3005), then instructs you to
# start the Minions runtime with the toolshed extension configured to use the mock servers.
#
# The toolshed connects to the mock servers via SSE (url-based MCP adapter,
# see extensions/mcp-toolshed/src/adapter.ts). SQLite session/audit storage is
# a local file at /tmp/minions-dev.sqlite.
#
# Prerequisites: Node.js >= 20, pnpm 10.10.0, Docker, Minions CLI >= 1.37.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Prerequisites ---

if ! command -v pnpm &>/dev/null; then
  echo "ERROR: pnpm is required but not installed." >&2
  echo "Install via: corepack enable && corepack prepare pnpm@10.10.0 --activate" >&2
  exit 1
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker is required but not installed." >&2
  exit 1
fi

if ! command -v minions &>/dev/null; then
  echo "ERROR: the Minions CLI is required. Install from https://github.com/dr-pabs/managed-service-minions" >&2
  exit 1
fi

# --- Build TypeScript packages and extensions ---

echo "==> Building TypeScript packages and extensions..."
pnpm build

# --- Start mock MCP servers (docker-compose) ---

echo ""
echo "==> Starting mock MCP servers (docker compose --profile dev up)..."
docker compose --profile dev up --build -d

echo ""
echo "==> Mock MCP servers are running:"
echo "    GitHub:          http://localhost:3001/sse"
echo "    Azure DevOps:    http://localhost:3002/sse"
echo "    ServiceNow:      http://localhost:3003/sse"
echo "    Jira:            http://localhost:3004/sse"
echo "    Shell:           http://localhost:3005/sse"

# --- Start Goose with the toolshed extension + mock servers ---

SECRET="${TOOLSHED_SIGNING_SECRET:-dev-local-signing-secret}"
export TOOLSHED_SIGNING_SECRET="$SECRET"
export TOOLSHED_STORE_PATH="${TOOLSHED_STORE_PATH:-/tmp/minions-dev.sqlite}"
export TOOLSHED_ALLOW_UNSIGNED=1  # dev escape hatch: no HMAC verification needed for local mocks

# TOOLSHED_ADAPTERS tells the toolshed which MCP servers to connect to.
# Each adapter uses url= for SSE connection to the docker-compose mock servers.
export TOOLSHED_ADAPTERS="[{\"alias\":\"github\",\"url\":\"http://host.docker.internal:3001/sse\"},{\"alias\":\"azure_devops\",\"url\":\"http://host.docker.internal:3002/sse\"},{\"alias\":\"servicenow\",\"url\":\"http://host.docker.internal:3003/sse\"},{\"alias\":\"jira\",\"url\":\"http://host.docker.internal:3004/sse\"},{\"alias\":\"shell\",\"url\":\"http://host.docker.internal:3005/sse\"}]"

echo ""
echo "==> Toolshed config:"
echo "    SIGNING SECRET:  set (dev default: dev-local-signing-secret)"
echo "    STORE PATH:      $TOOLSHED_STORE_PATH"
echo "    ADAPTERS:        SSE connections to mock servers on ports 3001-3005"

# If the TOOLSHED_STORE_PATH file exists from a prior run, this will create a fresh
# one by truncating (idempotent: SQLite handles file creation).
mkdir -p "$(dirname "$TOOLSHED_STORE_PATH")"

echo ""
echo "==> Starting the Minions runtime with the orchestrator toolshed extension..."
echo "    (Press Ctrl-C to stop. The mock servers stay running in the background.)"
echo ""

trap 'echo ""; echo "==> Stopping mock MCP servers..."; docker compose --profile dev down 2>/dev/null || true' EXIT INT TERM

exec minions serve \
  --port 3284 \
  --with-extension "node extensions/mcp-toolshed/dist/server.js"
