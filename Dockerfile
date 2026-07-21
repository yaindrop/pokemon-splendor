FROM node:24.18.0-alpine3.23 AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.15.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig*.json ./
COPY apps ./apps
COPY packages ./packages

RUN pnpm install --frozen-lockfile && \
    pnpm build && \
    pnpm --filter @pokemon-splendor/server deploy --prod /release/server

FROM caddy:2.11.4-alpine AS web

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/apps/web/dist /srv

FROM node:24.18.0-alpine3.23 AS app

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /release/server ./

RUN mkdir -p /data/rooms && chown -R node:node /data
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
