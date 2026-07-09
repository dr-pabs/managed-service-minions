FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .npmrc ./
COPY packages/framework-core/package.json ./packages/framework-core/
COPY extensions/mcp-toolshed/package.json ./extensions/mcp-toolshed/
COPY extensions/orchestrator/package.json ./extensions/orchestrator/
COPY extensions/webhook-ingress/package.json ./extensions/webhook-ingress/

RUN pnpm install --frozen-lockfile

COPY packages/framework-core ./packages/framework-core
COPY extensions/mcp-toolshed ./extensions/mcp-toolshed
COPY extensions/orchestrator ./extensions/orchestrator
COPY extensions/webhook-ingress ./extensions/webhook-ingress

RUN pnpm --filter "webhook-ingress" build \
    && pnpm --filter "webhook-ingress" deploy --prod --legacy /prod

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=builder /prod .

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
