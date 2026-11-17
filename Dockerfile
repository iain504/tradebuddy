# Root Dockerfile - builds the Next.js 16 web app (standalone output).
# docker build -t mt-monitor-app .
#
# Build stages:
#   deps    : bun install + prisma generate (cached independently of source)
#   builder : next build (repo build script copies .next/static + public into
#             .next/standalone, so the standalone bundle is self-contained)
#   runner  : node:20-slim runs the standalone server.js; prisma CLI is kept
#             so the entrypoint can `prisma db push` the SQLite schema on boot

# --------------------------------------------------------------------------- #
# deps
# --------------------------------------------------------------------------- #
FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile
RUN bunx prisma generate

# --------------------------------------------------------------------------- #
# builder
# --------------------------------------------------------------------------- #
FROM oven/bun:1 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock next.config.ts tsconfig.json tailwind.config.ts postcss.config.mjs components.json eslint.config.mjs ./
COPY src ./src
COPY public ./public
COPY prisma ./prisma

# package.json "build" = next build && cp .next/static .next/standalone/.next/ && cp public .next/standalone/
RUN bun run build

# --------------------------------------------------------------------------- #
# runner
# --------------------------------------------------------------------------- #
FROM node:20-slim AS runner
# openssl: required by Prisma engines; curl: HEALTHCHECK
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/data/monitor.db

# Standalone server + static assets + public files
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Prisma schema + full node_modules so `prisma db push` works offline at boot.
# (Full node_modules is a deliberate size-for-reliability tradeoff: the
# standalone bundle already carries the app runtime deps, the CLI needs the
# rest. Trim to node_modules/{prisma,@prisma,.prisma} if image size matters
# and you verified the CLI deps are complete.)
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules

# Entrypoint: ensure /data exists, sync the SQLite schema, start Next standalone.
# (Kept inline to avoid adding files outside the allowed set.)
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      'mkdir -p /data' \
      'echo "[app-entrypoint] prisma db push (schema sync)"' \
      'node ./node_modules/prisma/build/index.js db push --skip-generate' \
      'echo "[app-entrypoint] starting Next standalone server"' \
      'exec node server.js' \
      > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
