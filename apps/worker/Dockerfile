# Worker image. Build context is the repo root (see compose.yml).
FROM node:24-slim AS base
RUN npm i -g pnpm@12.14.0 turbo@^2.5.0 && npm cache clean --force
WORKDIR /app

FROM base AS pruner
COPY . .
RUN turbo prune @lomi/worker --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
COPY assignment/fixtures assignment/fixtures
RUN pnpm turbo build --filter=@lomi/worker
# Drop devDependencies now that everything is built.
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/ ./
# Named volume `files` mounts here; it inherits this ownership on first use.
RUN mkdir -p /data/files && chown node:node /data/files
USER node
ENV STORAGE_DIR=/data/files
CMD ["node", "apps/worker/dist/main.js"]
