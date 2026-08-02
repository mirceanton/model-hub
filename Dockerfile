# syntax=docker/dockerfile:1

# Build and runtime share the exact same base image (not just the same distro
# family) so better-sqlite3's native addon is guaranteed binary-compatible
# between the two stages — no glibc version mismatch to worry about.
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.62.1-noble

FROM ${PLAYWRIGHT_IMAGE} AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @model-hub/shared build \
    && pnpm --filter @model-hub/server build \
    && pnpm --filter @model-hub/web build

# Extracts just the server + its resolved production dependencies (workspace:*
# deps inlined as real files) into a self-contained directory — excludes
# apps/web's entire dependency tree and every devDependency, which is most of
# what made a naive `COPY node_modules` copy so large.
RUN pnpm --filter @model-hub/server deploy --prod --legacy /app/deploy/server

FROM ${PLAYWRIGHT_IMAGE} AS runtime
WORKDIR /app

# Note: the base image bundles Firefox/WebKit alongside Chromium (the only
# one this app ever launches) as separate layers; deleting them in a later
# layer doesn't reduce pull/storage size (still-required Docker layering),
# so it's not worth doing — the ~4GB image size is an accepted cost of this
# base image, not something fixable from within this Dockerfile.

RUN mkdir -p /library /data && chown pwuser:pwuser /library /data

COPY --chown=pwuser:pwuser --from=build /app/deploy/server ./server
COPY --chown=pwuser:pwuser --from=build /app/apps/web/dist ./web-dist

ENV NODE_ENV=production \
    STATIC_WEB_DIR=/app/web-dist \
    LIBRARY_ROOT=/library \
    DATABASE_PATH=/data/model-hub.sqlite3 \
    PORT=4000

EXPOSE 4000
VOLUME ["/library", "/data"]

USER pwuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
