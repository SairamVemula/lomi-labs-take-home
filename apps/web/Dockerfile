# Web image (Next standalone). Build context is the repo root (see compose.yml).
FROM node:24-slim AS base
RUN npm i -g pnpm@12.14.0 turbo@^2.5.0 && npm cache clean --force
WORKDIR /app

FROM base AS pruner
COPY . .
RUN turbo prune @lomi/web --docker

FROM base AS builder
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# packages/shared copies expected-fields.json from here in its prebuild step.
COPY assignment/fixtures assignment/fixtures
# next.config.ts bakes the /api/* rewrite destination into the build, so it is a build argument.
ARG API_INTERNAL_URL=http://api:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm turbo build --filter=@lomi/web

FROM node:24-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
