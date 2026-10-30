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
COPY docker-entrypoint.sh ./

RUN pnpm install --frozen-lockfile \
  && pnpm build

RUN mkdir -p /data && chown node:node /data && chmod 700 /data

VOLUME ["/data"]
USER node

ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
CMD ["mcp-server"]
