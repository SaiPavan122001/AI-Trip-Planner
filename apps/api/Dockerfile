# syntax=docker/dockerfile:1

# ── build ───────────────────────────────────────────────────────────────────
# The whole monorepo is copied in because the API depends on four workspace
# packages that are TypeScript source, not published artefacts.
FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/telemetry/package.json   packages/telemetry/
COPY packages/providers/package.json   packages/providers/
COPY packages/engine/package.json      packages/engine/
COPY packages/agents/package.json      packages/agents/
COPY packages/llm/package.json         packages/llm/
COPY packages/knowledge/package.json   packages/knowledge/
COPY apps/api/package.json             apps/api/
COPY apps/web/package.json             apps/web/
RUN npm ci --ignore-scripts

COPY packages packages
COPY apps/api apps/api

RUN npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w @trip/shared \
 && npm run build -w @trip/telemetry \
 && npm run build -w @trip/providers \
 && npm run build -w @trip/llm \
 && npm run build -w @trip/knowledge \
 && npm run build -w @trip/engine \
 && npm run build -w @trip/agents \
 && npm run build -w @trip/api \
 && npm prune --omit=dev

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Runs unprivileged: the API touches a database and outbound provider APIs and
# has no reason to be able to write anywhere else.
RUN addgroup -S wayfare && adduser -S wayfare -G wayfare

COPY --from=build --chown=wayfare:wayfare /repo/node_modules       node_modules
COPY --from=build --chown=wayfare:wayfare /repo/packages           packages
COPY --from=build --chown=wayfare:wayfare /repo/apps/api/dist      apps/api/dist
COPY --from=build --chown=wayfare:wayfare /repo/apps/api/prisma    apps/api/prisma
# The operator's tools (ingesting knowledge documents): run by hand, never by the server.
COPY --from=build --chown=wayfare:wayfare /repo/apps/api/scripts   apps/api/scripts
COPY --from=build --chown=wayfare:wayfare /repo/apps/api/package.json apps/api/
COPY --from=build --chown=wayfare:wayfare /repo/package.json       package.json

USER wayfare
EXPOSE 4000

# Liveness only: is this process running and answering? An orchestrator restarts a
# container that fails this, and a database or provider outage must never be a
# reason to restart the API. Readiness (/ready) is for load balancers to route by.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /repo/apps/api
CMD ["node", "dist/index.js"]
