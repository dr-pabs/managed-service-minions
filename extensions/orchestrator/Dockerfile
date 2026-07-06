# syntax=docker/dockerfile:1
# Orchestrator container — runs `goose serve` with the Minions framework plugin
# and the mcp-toolshed extension so it can dispatch minions.
#
# Build context: repo root
#   docker build -f extensions/orchestrator/Dockerfile -t orchestrator .

FROM node:20-slim AS base

# Install system dependencies needed by goose and native Node addons
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# ── Install Goose CLI ─────────────────────────────────────────────────────────
# Download the latest goose binary for Linux x86_64.
# The binary is statically linked; no additional runtime libraries are needed.
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then GOOSE_ARCH="x86_64"; \
    elif [ "$ARCH" = "aarch64" ]; then GOOSE_ARCH="aarch64"; \
    else echo "Unsupported architecture: $ARCH" && exit 1; fi && \
    curl -fsSL \
      "https://github.com/block/goose/releases/latest/download/goose-linux-${GOOSE_ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin && \
    chmod +x /usr/local/bin/goose && \
    goose --version

# ── Install pnpm and build the toolshed extension ────────────────────────────
FROM base AS builder

WORKDIR /build

RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/ packages/
COPY extensions/mcp-toolshed/ extensions/mcp-toolshed/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter mcp-toolshed build

# ── Final image ───────────────────────────────────────────────────────────────
FROM base

WORKDIR /app

# Copy the built toolshed
COPY --from=builder /build/extensions/mcp-toolshed/dist/ /app/toolshed/
COPY --from=builder /build/node_modules/ /app/node_modules/
COPY --from=builder /build/packages/framework-core/dist/ /app/node_modules/framework-core/dist/

# Copy the framework plugin content (agents, skills, commands, rules, hooks)
COPY agents/ /app/plugin/agents/
COPY skills/ /app/plugin/skills/
COPY commands/ /app/plugin/commands/
COPY rules/ /app/plugin/rules/
COPY .plugin/ /app/plugin/.plugin/

# Install the framework plugin into Goose's plugin directory
RUN goose plugin install /app/plugin --name goose-agent-framework || true

EXPOSE 3284

# goose serve loads the mcp-toolshed stdio extension and starts an HTTP listener.
# GOOSE_PROVIDER, GOOSE_MODEL, and Key Vault env vars are injected at runtime
# by the Azure Container App via managed identity.
CMD ["goose", "serve", \
     "--port", "3284", \
     "--with-extension", "node /app/toolshed/index.js"]
