# syntax=docker/dockerfile:1
# ── Full-stack single-container image for Platform ────────────────────────────
#
# Runs the backend (server.js) in ONE container via the supervisor
# (scripts/start.js → local-services.js → supervisor/lifecycle.js), exactly like
# `npm start` does locally. dsh's native plugins cover LLM routing and SaaS
# connectors, so there are no sidecar processes.
#
#   docker build -t harbor.local/paas_private/platform .
#   docker run -p 3000:3000 -v platform-data:/data harbor.local/paas_private/platform
#
# Multi-stage: the builder compiles native addons + builds web/dist; the runtime
# stage copies only what is needed. Node 25 is used in BOTH stages: the same major
# the release.yml CI uses, AND the lockfile was generated under npm 11 (Node 22's
# npm 10 misreads it — "Missing: zod@... from lock file"). The system Node ABI then
# matches the native addons compiled at `npm ci` time (better-sqlite3, tree-sitter).
#
# `npm run predist` is deliberately NOT run here. It builds resources/node — the
# standalone Node the *desktop* bundle needs — while the supervisor runs server.js
# on the system Node (process.execPath: this image's own Node), so nothing in the
# container would use it. It is also a 53 MB download from nodejs.org that stalls
# from the China build host.

# ── Base image ───────────────────────────────────────────────────────────────
# A build arg because the two build hosts have opposite network access: the
# GitHub runner (docker-deploy.yml) reaches Docker Hub, while the China build
# host (Jenkins on cheap-3) cannot reach registry-1.docker.io at all and pulls
# the cluster's Harbor mirror instead — its Jenkinsfile passes that as
# BASE_IMAGE. Declared before the first FROM so both stages can use it.
ARG BASE_IMAGE=node:25-bookworm-slim

# ── Builder ──────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS builder

# python3/make/g++ for native addons (better-sqlite3); curl + tar for
# build-node, which curls the Node standalone release tarball and extracts it.
# deb.debian.org crawls at ~130KB/s from the China build host (mirrors.aliyun.com
# is 100x faster); swap before any apt fetch in both stages.
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates git curl tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bound every build-time Node process. The China build host (Jenkins on cheap-3)
# is a 4GB machine that ALSO runs the production pod: a build that spikes past its
# free memory makes the kernel OOM-kill kubelet and the node's registry/proxy —
# node NotReady, site 502 — which happened twice on 2026-09-21. A build that needs
# more than this cap fails HERE, which is recoverable, instead of taking the
# deployment down with it. (The web build peaks well under 1GB; measured.)
ENV NODE_OPTIONS=--max-old-space-size=1024 \
    npm_config_jobs=1 \
    UV_THREADPOOL_SIZE=2

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

# dsh-profile-template/ is consumed by the dsh install layer below (cp →
# /opt/dsh-home), so it must exist in the builder BEFORE that RUN. Copying it
# here keeps the slow dsh installs cacheable: these four tiny text files change
# far less often than the source that arrives via `COPY . .` further down.
COPY dsh-profile-template/ ./dsh-profile-template/

# dsh CLI (the agent runtime server.js spawns by name) + the JSON-RPC plugin
# profile scaffold comes from dsh-profile-template/ copied above. All
# pinned to the rcs the profiles were developed against — see ci(quality-gates)
# "pin dsh-base bundle version" for why rc tags must not float. These installs
# are SLOW and flaky on CI, so they run BEFORE `COPY . .`: source edits then
# never invalidate these layers. dsh-profile-template/ mirrors
# ~/.dsh/profiles/platform; the base bundle is pre-installed because the
# deployed runtime's network cannot reach npm. dsh-base must be 0.1.1-rc.2:
# 0.0.1-rc.1 pulls dsh-tool-bash → dsh-bash-env, which is not published (404);
# dsh-sdk-protocol is added because jsonrpc-server imports it undeclared
# (same reason ci.yml adds it). legacy-peer-deps mirrors ci.yml's pnpm
# profile (autoInstallPeers: false): jsonrpc-server@0.0.1-rc.5 sits on the
# 0.0.1 peer line (dsh-invariants ^0.0.1-rc.5) while dsh-base/protocol
# 0.1.1-rc.2 declare ^0.1.1-rc.2 — a mix pnpm tolerates and npm hard-fails
# with ERESOLVE (verified both ways locally before pushing).
#
# The explicit 0.1.1-rc.2 rows below exist because legacy-peer-deps disables
# peer auto-installation for TRANSITIVE packages too: dsh's tree declares them
# as peerDependencies only, so without them the runtime dies at boot with
# ERR_MODULE_NOT_FOUND (first seen as @deepseek-ai/dsh-sandbox from
# dsh-sandbox-policy). Enumerated by a peer-deps gap analysis over the
# installed tree; validated by booting `dsh --profile platform` and completing
# the sdk-client initialize handshake before this change was shipped.
# cordis-plugin-hmr is pinned deliberately (BOTH prefixes — dsh-base's transitive
# range floats to 1.0.17+ inside the profile tree otherwise): 1.0.17+ removed registerConfig,
# which dsh-app-boot's watchUserPatches calls unconditionally — a build that
# floats to >=1.0.17 crash-loops every dsh child at boot (2026-09-23 outage).
RUN npm config set fetch-retries 5 fetch-retry-mintimeout 20000 fetch-retry-maxtimeout 120000 fetch-timeout 600000 legacy-peer-deps true \
    && npm install --prefix /opt/dsh \
         @deepseek-ai/dsh@0.1.1-rc.2 \
         @deepseek-ai/dsh-sdk-jsonrpc-server@0.0.1-rc.5 \
         @deepseek-ai/dsh-sdk-protocol@0.0.1-rc.5 \
         @deepseek-ai/cordis-plugin-group@1.0.2 \
         @deepseek-ai/cordis-plugin-hmr@1.0.16 \
         @deepseek-ai/dsh-anonymous-user-id@0.1.1-rc.2 \
         @deepseek-ai/dsh-atomic-write@0.1.1-rc.2 \
         @deepseek-ai/dsh-authorization@0.1.1-rc.2 \
         @deepseek-ai/dsh-bash-local@0.1.1-rc.2 \
         @deepseek-ai/dsh-code-runtime@0.1.1-rc.2 \
         @deepseek-ai/dsh-compaction@0.1.1-rc.2 \
         @deepseek-ai/dsh-fs@0.1.1-rc.2 \
         @deepseek-ai/dsh-invariants@0.1.1-rc.2 \
         @deepseek-ai/dsh-output-retention@0.1.1-rc.2 \
         @deepseek-ai/dsh-sandbox@0.1.1-rc.2 \
         @deepseek-ai/dsh-scope@0.1.1-rc.2 \
         @deepseek-ai/dsh-session-telemetry@0.1.1-rc.2 \
         @deepseek-ai/dsh-session-title-llm@0.1.1-rc.2 \
         @deepseek-ai/dsh-shell@0.1.1-rc.2 \
         @deepseek-ai/dsh-spill@0.1.1-rc.2 \
         @deepseek-ai/dsh-subagent-in-process-driver@0.1.1-rc.2 \
         @deepseek-ai/dsh-timeout@0.1.1-rc.2 \
         @deepseek-ai/dsh-workflow@0.1.1-rc.2 \
    && mkdir -p /opt/dsh-home/profiles/platform \
    && cp dsh-profile-template/package.json \
          dsh-profile-template/pnpm-workspace.yaml \
          dsh-profile-template/cordis.yml \
          dsh-profile-template/cordis.patch.yml \
          /opt/dsh-home/profiles/platform/ \
    && npm install --prefix /opt/dsh-home/profiles/platform \
         @deepseek-ai/dsh-base@0.1.1-rc.2 \
         @deepseek-ai/dsh-sdk-jsonrpc-server@0.0.1-rc.5 \
         @deepseek-ai/dsh-sdk-protocol@0.1.1-rc.2 \
         @deepseek-ai/cordis-plugin-hmr@1.0.16

# Copy the rest of the source. resources/ is .dockerignored: it holds only the
# platform-specific standalone Node that predist downloads, which this image does
# not build and does not use.
COPY . .

# Build the React frontend. (No `npm run predist` — see the header note.)
#
# No `npm prune --omit=dev` here, deliberately — it was tried and it produced an
# image that dies at boot with ERR_MODULE_NOT_FOUND. @llamaindex/readers is the
# only @llamaindex package in `dependencies` and it declares @llamaindex/core as
# a peer, so prune drops the whole @llamaindex tree (core/env/openai, 344MB) even
# though readers/docx/dist/index.js imports it at load time. Same failure mode as
# the dsh peer rows above. The saving is illusory anyway: root devDependencies are
# only electron/typescript/playwright/biome (~12MB) — the web build's deps live in
# web/node_modules and are never copied to the runtime stage.
RUN npm run web:build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS runtime

# ca-certificates for outbound HTTPS (Volces upstreams); curl for the
# Docker HEALTHCHECK. Everything else is bundled in node_modules / web/dist and
# needs no system packages.
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps (native addons already compiled in the builder) and the built
# frontend. Ownership is applied on the way in (`--chown`) instead of with a
# recursive `chown -R` afterwards: chown rewrites every inode, so a later RUN
# would duplicate the whole tree — node_modules included — into an extra layer.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /opt/dsh /opt/dsh
COPY --chown=node:node --from=builder /opt/dsh-home /opt/dsh-home
ENV PATH="/opt/dsh/node_modules/.bin:${PATH}" \
    DSH_HOME="/opt/dsh-home"
COPY --chown=node:node --from=builder /app/web/dist ./web/dist

# Application source: all root .js (server.js, paths.js, local-services.js,
# bundle-manifest.js, chat-history.js, documents.js, mcp-bridge.js, …) + the
# root JSON data files extension-store.js reads at runtime (market-catalog*.json)
# + the dirs the supervisor/launcher need at runtime.
COPY --chown=node:node --from=builder /app/package.json /app/platform.bundle.json /app/mcp.example.json ./
COPY --chown=node:node --from=builder /app/market-catalog.json /app/market-catalog-skills.json ./
COPY --chown=node:node --from=builder /app/*.js ./
COPY --chown=node:node --from=builder /app/server ./server
# gateway/ is imported by server.js (the mini-program identity modules,
# add-single-process-mp-auth); /app/*.js does not descend into dirs, and a
# missing dir here boots the image just fine until its first import — the
# smoke test catches it as ERR_MODULE_NOT_FOUND.
COPY --chown=node:node --from=builder /app/gateway ./gateway
COPY --chown=node:node --from=builder /app/lib ./lib
COPY --chown=node:node --from=builder /app/scripts ./scripts
COPY --chown=node:node --from=builder /app/supervisor ./supervisor
COPY --chown=node:node --from=builder /app/bootstrap ./bootstrap
COPY --chown=node:node --from=builder /app/skills ./skills
# Read at RUNTIME by dsh-profile.js (it copies the two bridge plugins out of here
# into $DSH_HOME/profiles/<name>), so the builder copy above is not enough — an
# image without this dir boots, binds the port, then dies on ENOENT.
COPY --chown=node:node --from=builder /app/dsh-profile-template ./dsh-profile-template

# Persistent state lives under /data: SQLite, sessions, chat-history, cron,
# dev-settings.json. PLATFORM_DATA_DIR points the supervisor (local-services.js)
# + paths.js here. HOST=0.0.0.0 so k8s probes + docker port-forward reach
# server.js inside the container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLATFORM_DATA_DIR=/data

# Run as the image's non-root `node` user (UID/GID 1000 in the official node image).
# Only /data is writable at runtime (PLATFORM_DATA_DIR); the app tree already
# carries node ownership from the COPY --chown above, so there is no recursive
# chown here — see the note on those COPY lines.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000

# Docker-level healthcheck for local `docker run`. k8s uses its own probes (see
# k8s/deployment.yaml). start-period must exceed server.js cold-start (~50s) +
# sidecar warmup; the supervisor's own START_TIMEOUT is 120s.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/config || exit 1

# start.js → local-services.js → Supervisor spawns server.js, then keeps running.
CMD ["node", "scripts/start.js"]
