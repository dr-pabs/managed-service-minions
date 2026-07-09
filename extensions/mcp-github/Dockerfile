FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .npmrc ./

COPY extensions/mcp-github/package.json ./extensions/mcp-github/

RUN pnpm install --frozen-lockfile


COPY extensions/mcp-github ./extensions/mcp-github

RUN pnpm --filter "@minions-agent-framework/mcp-github" build \
    && pnpm --filter "@minions-agent-framework/mcp-github" deploy --prod --legacy /prod

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=builder /prod .

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
