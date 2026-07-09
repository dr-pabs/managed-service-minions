FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.10.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json .npmrc ./

COPY extensions/mcp-azure-devops/package.json ./extensions/mcp-azure-devops/

RUN pnpm install --frozen-lockfile


COPY extensions/mcp-azure-devops ./extensions/mcp-azure-devops

RUN pnpm --filter "@minions-agent-framework/mcp-azure-devops" build \
    && pnpm --filter "@minions-agent-framework/mcp-azure-devops" deploy --prod --legacy /prod

FROM node:22-bookworm-slim

WORKDIR /app

COPY --from=builder /prod .

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
