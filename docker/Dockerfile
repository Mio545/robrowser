# syntax=docker/dockerfile:1.7
#
# RoboBrowser headless server image (spec 10).
#
# The image bundles Chromium and the CJK fonts, because:
#   * headless Chrome renders text with whatever fonts are installed, and
#     `node:20-slim` ships none of the CJK families;
#   * screenshot / extract assertions on Chinese pages break without them.
#
# Build:
#   docker build -f docker/Dockerfile -t robrowser:latest .
# Run (headless=new):
#   docker run --rm -p 8080:8080 -v robrowser-data:/data robrowser:latest serve --host 0.0.0.0
#
# `--no-sandbox` is passed through CHROME_ARGS at *runtime* and is deliberately
# not baked in here: it weakens the browser sandbox and is only appropriate
# inside a container.

# ---------------------------------------------------------------- build stage
FROM node:20-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# pnpm 9 ships as a standalone script; corepack's bundled pnpm version drifts
# between Node releases, which would silently change the lockfile semantics.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /repo

# Install with the full workspace manifest set first so Docker can cache the
# dependency layer across source-only edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/browser/package.json packages/browser/
COPY packages/desktop/package.json packages/desktop/
COPY packages/server/package.json packages/server/

# better-sqlite3 / esbuild need their install scripts to fetch prebuilt binaries.
# The desktop package is filtered in so the workspace graph stays consistent,
# but its Electron binary is skipped with an env override.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --filter @robrowser/server... --filter @robrowser/browser... --filter @robrowser/core...

COPY tsconfig.base.json ./
COPY packages ./packages
COPY flows ./flows
COPY fixtures ./fixtures

RUN pnpm --filter @robrowser/server... run build

# --------------------------------------------------------------- runtime stage
FROM node:20-slim AS runtime

# Chromium + the libraries it needs on a slim base; Xvfb is the fallback for
# sites that refuse headless mode (see README section "headless vs Xvfb").
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk \
      fonts-liberation \
      ca-certificates \
      xvfb \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

WORKDIR /repo

COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/pnpm-lock.yaml /repo/tsconfig.base.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/flows ./flows
COPY --from=build /repo/fixtures ./fixtures

# Container defaults. Everything can be overridden with `-e` / compose env.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    RUN_DIR=/data \
    CHROME_PATH=/usr/bin/chromium \
    HEADLESS=true \
    CHROME_ARGS=--no-sandbox,--disable-dev-shm-usage,--disable-gpu \
    LOG_LEVEL=info \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

VOLUME ["/data"]
EXPOSE 8080

# The image entry point is the CLI itself (spec 10). Signal handling for the
# Chromium children is provided by tini: docker-compose sets `init: true`, and
# bare `docker run` should pass `--init` for the same behaviour.
ENTRYPOINT ["node", "packages/server/dist/cli.js"]
CMD ["serve"]
