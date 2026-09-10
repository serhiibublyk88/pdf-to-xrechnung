# Install from the monorepo root so postinstall can build the contracts workspace.

FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/contracts/tsconfig*.json packages/contracts/
COPY packages/contracts/src packages/contracts/src
RUN npm ci

FROM deps AS build
COPY apps/api apps/api
WORKDIR /repo/apps/api
RUN npx prisma generate
RUN npm run build
WORKDIR /repo

FROM build AS prod-deps
RUN npm prune --omit=dev --legacy-peer-deps

FROM build AS migrate
WORKDIR /repo/apps/api
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:22-bookworm-slim AS api
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl \
      poppler-utils=22.12.0-2+deb12u3 \
      tesseract-ocr=5.3.0-2 \
      tesseract-ocr-deu=1:4.1.0-2 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --shell /usr/sbin/nologin app

WORKDIR /repo

COPY --from=prod-deps --chown=app:app /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=app:app /repo/package.json /repo/package-lock.json ./
COPY --from=prod-deps --chown=app:app /repo/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=prod-deps --chown=app:app /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=prod-deps --chown=app:app /repo/apps/api/package.json ./apps/api/package.json
COPY --from=prod-deps --chown=app:app /repo/apps/api/dist ./apps/api/dist

RUN mkdir -p /repo/apps/api/data/uploads && chown -R app:app /repo/apps/api/data

WORKDIR /repo/apps/api
USER app

ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS http://127.0.0.1:3000/health/live -o /dev/null || exit 1

CMD ["node", "dist/main.js"]
