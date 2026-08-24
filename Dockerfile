# syntax=docker/dockerfile:1
# ── Full-stack single-container image for Platform ────────────────────────────
#
# Bundles the backend (server.js) AND its sidecars (LiteLLM + OpenConnector +
# Postgres) into ONE container. The supervisor (scripts/start.js → local-services.js
# → supervisor/lifecycle.js) spawns each sidecar as a child process on localhost,
# exactly like `npm start` does locally — one image, one process tree, one PVC.
#
#   docker build -t harbor.local/paas_private/platform .
#   docker run -p 3000:3000 -v platform-data:/data harbor.local/paas_private/platform
#
# Multi-stage: the builder compiles native addons + builds web/dist + builds all
# Linux bundled resources (`npm run predist`); the runtime stage copies only what
# is needed. Node 25 is used in BOTH stages: the same major the release.yml CI
# uses, AND the lockfile was generated under npm 11 (Node 22's npm 10 misreads
# it — "Missing: zod@... from lock file"). The system Node ABI then matches the
# native addons compiled at `npm ci` time (better-sqlite3, tree-sitter); the
# supervisor runs server.js + sidecars on the system Node (process.execPath), so
# the bundled standalone Node (resources/node) is built for verify-bundle but not
# used at runtime.

# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:25-bookworm-slim AS builder

# python3/make/g++ for native addons (better-sqlite3); git + curl + tar for the
# resource build scripts — build-openconnector clones a repo; build-node
# curls the Node standalone release tarball and extracts it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates git curl tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install root + web deps first (cacheable layer). --ignore-scripts skips the
# package.json postinstall hook (node scripts/postinstall-web.js && …postinstall-bundle.js):
# at this layer only package*.json is copied, so scripts/ doesn't exist yet and the hook
# would throw "Cannot find module" before the PLATFORM_SKIP_* env guard can exit 0. We run
# the web build + resource builds explicitly below, so the postinstall is redundant here —
# AND making it best-effort (postinstall-bundle.js never fails `npm install`) would mask a
# broken resource build that should fail the docker build.
COPY package*.json ./
COPY web/package*.json ./web/
RUN npm ci --ignore-scripts \
    && npm --prefix web ci --ignore-scripts

# Copy the rest of the source. Built resource payload dirs are .dockerignored so
# a host's mac/win binaries never leak in — resources are built fresh for Linux.
COPY . .

# Build the React frontend, then all bundled Linux resources.
# predist = build-openconnector + build-node + verify-bundle (asserts every
# selected component is present).
RUN npm run web:build \
    && npm run predist

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:25-bookworm-slim AS runtime

# ca-certificates for outbound HTTPS (Volces upstreams); curl for the
# Docker HEALTHCHECK. Everything else is bundled under resources/ and needs
# no system packages.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps (native addons already compiled in the builder), built frontend,
# and the bundled resources (OpenConnector, Node).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/resources ./resources

# Application source: all root .js (server.js, paths.js, local-services.js,
# bundle-manifest.js, chat-history.js, documents.js, mcp-bridge.js, …) + the
# root JSON data files extension-store.js reads at runtime (market-catalog*.json)
# + the dirs the supervisor/launcher need at runtime.
COPY --from=builder /app/package.json /app/platform.bundle.json /app/mcp.example.json ./
COPY --from=builder /app/market-catalog.json /app/market-catalog-skills.json ./
COPY --from=builder /app/*.js ./
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/supervisor ./supervisor
COPY --from=builder /app/bootstrap ./bootstrap
COPY --from=builder /app/skills ./skills

# Persistent state lives under /data: SQLite, sessions, chat-history, cron,
# dev-settings.json. PLATFORM_DATA_DIR points the supervisor (local-services.js)
# + paths.js here. HOST=0.0.0.0 so k8s probes + docker port-forward reach
# server.js inside the container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLATFORM_DATA_DIR=/data

# Run as the image's non-root `node` user (UID/GID 1000 in the official node image).
# /data is chowned so first-run seeding + the sidecars can write there.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000

# Docker-level healthcheck for local `docker run`. k8s uses its own probes (see
# k8s/deployment.yaml). start-period must exceed server.js cold-start (~50s) +
# sidecar warmup; the supervisor's own START_TIMEOUT is 120s.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/config || exit 1

# start.js → local-services.js → Supervisor spawns server.js + OpenConnector
# as localhost child processes, then keeps running.
CMD ["node", "scripts/start.js"]
