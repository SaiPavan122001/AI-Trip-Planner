# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json      packages/shared/
COPY packages/providers/package.json   packages/providers/
COPY packages/engine/package.json      packages/engine/
COPY packages/llm/package.json         packages/llm/
COPY apps/api/package.json             apps/api/
COPY apps/web/package.json             apps/web/
RUN npm ci --ignore-scripts

COPY packages packages
COPY apps/web apps/web

# Baked into the client bundle at build time, so it must be supplied here and
# not only at runtime.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build -w @trip/shared && npm run build -w @trip/web

FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

RUN addgroup -S wayfare && adduser -S wayfare -G wayfare

COPY --from=build --chown=wayfare:wayfare /repo/node_modules  node_modules
COPY --from=build --chown=wayfare:wayfare /repo/packages      packages
COPY --from=build --chown=wayfare:wayfare /repo/apps/web      apps/web
COPY --from=build --chown=wayfare:wayfare /repo/package.json  package.json

USER wayfare
EXPOSE 3000

WORKDIR /repo/apps/web
CMD ["npm", "run", "start"]
