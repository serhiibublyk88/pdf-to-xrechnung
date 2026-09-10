FROM node:22-bookworm-slim AS base
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts/tsconfig*.json packages/contracts/
COPY packages/contracts/src packages/contracts/src
RUN npm ci

FROM deps AS build
COPY apps/web apps/web
# Standalone freezes the rewrite destination, so API_ORIGIN is a build-time value.
ARG API_ORIGIN
ENV API_ORIGIN=${API_ORIGIN}
RUN npm run build -w apps/web

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --shell /usr/sbin/nologin app

WORKDIR /app

COPY --from=build --chown=app:app /repo/apps/web/.next/standalone/ ./

WORKDIR /app/apps/web
USER app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=6 \
  CMD curl -fsS http://127.0.0.1:3000/de -o /dev/null || exit 1

CMD ["node", "server.js"]
