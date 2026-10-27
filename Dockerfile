# SPDX-License-Identifier: Apache-2.0
FROM node:22-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json .npmrc ./
COPY cli ./cli
COPY packages ./packages
COPY spec ./spec
COPY conformance ./conformance
COPY examples ./examples
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && node cli/dist/index.js keygen /app/owner.private.json

CMD ["node", "cli/dist/index.js", "mcp-server", "--key", "/app/owner.private.json", "--relay", "https://acp-relay.agent-collab.workers.dev"]
