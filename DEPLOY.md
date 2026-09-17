# Deployment — Docker, Harbor, ArgoCD

Platform ships as a **single-process container**: the supervisor (`scripts/start.js` → `local-services.js`) spawns `server.js`, which in turn runs the dsh agent as its child — exactly like `npm start`. One image, one process tree, one data volume.

```
GitHub push ──► docker-deploy.yml ──► build image ──► push to Harbor
                                          │
                                          └─► commit sha tag into k8s/deployment.yaml
                                                  │
                                                  └─► ArgoCD auto-sync ──► k3s rollout
```

---

## Architecture

| Piece | Where | What |
|---|---|---|
| `Dockerfile` | repo root | Multi-stage build: compiles native addons + installs the pinned dsh CLI/profile into `/opt/dsh` + builds `web/dist` + runs `npm run predist` (`build-node` → the standalone Node in `resources/node`, then `verify-bundle`), then copies into a slim runtime. Entrypoint `node scripts/start.js`. |
| `.dockerignore` | repo root | Excludes the built `resources/node` payload and any leftover `resources/**/*.tar.*` archives so a host's mac/win binaries never leak into the Linux image — the image builds its own Linux payload. Also excludes secrets (`.env*`, `mcp.json`) and dev-only trees (`electron`, `openspec`, `e2e`, the local store dirs). |
| `k8s/` | `service.yaml`, `deployment.yaml` | Plain manifests (no Helm). Deployment = 1 replica, Recreate strategy (single stateful agent). |
| `argocd/application.yaml` | ArgoCD Application CR | Watches `k8s/` in this repo, auto-sync prune+selfHeal, `CreateNamespace=true`, in-cluster destination (`https://kubernetes.default.svc`). |
| `.github/workflows/docker-deploy.yml` | CI | Builds + pushes to Harbor (insecure HTTP), then commit-backs the new `sha-<short>` tag into `k8s/deployment.yaml` (GitOps). |
| `Makefile` | repo root | `make build/run/logs/k8s-apply/k8s-deploy/argocd-sync` shortcuts. |

**Why a `harbor-pull` imagePullSecret?** The k3s containerd mirror (`/etc/rancher/k3s/registries.yaml` on the node) resolves `harbor.local` → `http://localhost:30880` (`insecure_skip_verify: true`) and *does* carry an `auth` block. **However, containerd does not honor the `auth` block for mirrored endpoints** — it keys credentials by endpoint host (`localhost:30880`), not the mirror name (`harbor.local`), so the auth is never sent and pulls return `401 Unauthorized`. Every other `harbor.local` deployment in this cluster (lawcraw, law-bench, review-agent) works around this with a per-namespace `kubernetes.io/dockerconfigjson` secret named `harbor-pull`. We follow the same pattern. CI pushes to the external `23.144.68.246:30880` address — same registry, two names.

---

## Prerequisites (one-time)

### 1. Harbor project + robot account (for CI push)

The `paas_private` Harbor project must exist first — Harbor returns **401 Unauthorized** for unknown projects, which masquerades as an auth failure (this was the actual root cause of the first `ImagePullBackOff`). Create it via the UI (`http://23.144.68.246:30880` → New Project) or the admin API. *(Created during this setup.)*

Then create a robot account in `paas_private` with **push** permission for CI:

```bash
# Harbor UI: http://23.144.68.246:30880 → paas_private → Robot Accounts → New
# Name: github-actions, Permissions: push to paas_private
# → note the username (robot$paas_private+github-actions) + generated secret
```

> The `harbor-pull` secrets already in the cluster use the Harbor `admin` account, so reusing those same credentials as `HARBOR_USER`/`HARBOR_PASS` for CI push is the path of least resistance (the smoke test during setup pushed with them). A dedicated robot account scoped to `paas_private` push is cleaner if you prefer least-privilege.

### 2. `harbor-pull` imagePullSecret (in-cluster pulls)

The k3s containerd mirror does **not** honor the `registries.yaml` `auth` block for mirrored endpoints (see the architecture note above), so pods need a per-namespace `kubernetes.io/dockerconfigjson` secret to pull `harbor.local/*` images. Every other namespace in this cluster (lawcraw, law-bench, review-agent) uses one named `harbor-pull`. Create it in `platform-private` (or copy law-bench's):

```bash
kubectl -n platform-private create secret docker-registry harbor-pull \
  --docker-server=harbor.local \
  --docker-username=<robot-or-admin> \
  --docker-password=<secret>
# or copy an existing one: kubectl -n law-bench get secret harbor-pull -o yaml \
#   | sed 's/namespace: law-bench/namespace: platform-private/' | kubectl apply -f -
```

The Deployment already references it via `imagePullSecrets` (commit `149f449`).

### 3. GitHub Secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `HARBOR_HOST` | `23.144.68.246:30880` (external Harbor address for CI) |
| `HARBOR_PROJECT` | `paas_private` |
| `HARBOR_USER` | `robot$paas_private+github-actions` |
| `HARBOR_PASS` | `<robot account secret>` |

### 4. ArgoCD registers the app (once)

```bash
kubectl apply -f argocd/application.yaml -n argocd
```

ArgoCD then watches `k8s/` and auto-syncs. Thereafter **never edit the live resources directly** — change `k8s/*` in the repo and let ArgoCD reconcile.

---

## Local testing (Docker)

> Requires Docker. The build compiles native addons, installs the pinned dsh packages from npm, and downloads the Node standalone tarball — expect **5-10 min** for a cold build, ~2 min with the GHA cache.

```bash
make build                              # docker build -t platform:dev .
make run                                # -p 3000:3000 -v platform-data-dev:/data
# cold start: server.js boot + dsh initialize handshake → ~60s
make logs                               # tail until "Platform ready"
curl http://localhost:3000/api/config   # health check
open http://localhost:3000              # the app

make stop                               # stop + rm container (keeps the volume)
make shell                              # exec a shell in the running container
make clean                              # stop + delete the data volume
```

Override the Volces key (optional — `server.js` has a fallback baked in):

```bash
make run VOLCES_API_KEY=your-key
```

**What to look for in `make logs`:**

```
[local-services] Platform ready: http://localhost:3000
```

If the container exits instead, the supervisor dumps `server.js`'s log tail right before it — read that for the failing step.

---

## Cluster deployment (k3s via ArgoCD)

### First deploy (before CI has run)

The manifest ships with `image: harbor.local/paas_private/platform:latest`. Either:

**(a)** Trigger CI to build + push `:latest`:
```bash
gh workflow run docker-deploy.yml -f skip_commit_back=true   # push only, no commit-back
```

**(b)** Or build + push manually from a machine with Docker + Harbor access:
```bash
make build
docker tag platform:dev 23.144.68.246:30880/paas_private/platform:latest
docker push 23.144.68.246:30880/paas_private/platform:latest
```

Then let ArgoCD sync (it will within ~30s of the app being registered, or force it):
```bash
make argocd-sync
```

### Steady-state deploys (after CI is wired)

Every push to `main` (that touches source) triggers CI → builds `sha-<short>` + `latest` → pushes both → commits `sha-<short>` into `k8s/deployment.yaml` → ArgoCD auto-sync rolls out. **You do nothing.**

### Inspect the deployment

```bash
make k8s-status        # pods, svc, rollout
make k8s-logs          # tail the platform pod
kubectl -n platform-private describe pod -l app.kubernetes.io/name=platform
```

Reach it: **http://23.144.68.246:30950**

### Override the Volces key in-cluster (optional)

```bash
kubectl -n platform-private create secret generic platform-secrets \
  --from-literal=volces-api-key=your-key
# ArgoCD self-heal keeps the secret; the Deployment reads it via optional secretKeyRef.
```

---

## NodePort

`30950` was free at authoring time (k3s range 30000-32767). If it collides with a future service, edit `k8s/service.yaml` `nodePort` and let ArgoCD sync. Current NodePorts in the cluster:

```
harbor 30880, argocd 30910, minio 30900, lawcraw 30500, litellm 30400, …
```

---

## Resource sizing

The container runs a single Node process (`server.js`) plus the dsh agent child it spawns. Set `resources.requests` / `resources.limits` in `k8s/deployment.yaml` to suit the node; a Node + dsh pair is comfortable around 1 CPU / 1.5Gi requested with headroom to ~2Gi.

The startup window is generous (`startupProbe` allows several minutes) because the first boot has to seed the SQLite store and complete the dsh `initialize` handshake before `/api/config` answers.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ImagePullBackOff` (401 Unauthorized) | Two root causes, both one-time: (1) the `paas_private` Harbor project doesn't exist yet — Harbor returns **401** for unknown projects, which looks like an auth failure but isn't (create it in the Harbor UI or via admin API); (2) the `harbor-pull` imagePullSecret is missing in `platform-private` — the k3s containerd mirror does NOT honor the `registries.yaml` `auth` block for mirrored endpoints (see architecture note). Run `make k8s-logs` and check the pod events; a `401 Unauthorized` from `localhost:30880` means one of these. |
| Pod restarts (OOMKilled) | Raise `limits.memory` in `k8s/deployment.yaml`. |
| `startupProbe` fails → `CrashLoopBackOff` | `make k8s-logs`; look for the supervisor's `server.js` log dump. Most common: the dsh CLI is missing from `PATH` or its profile home is unwritable, so the `initialize` handshake never completes. |
| ArgoCD shows `OutOfSync` on `Namespace` | Harmless — `CreateNamespace=true` created it; ArgoCD will self-heal. Or `make argocd-sync`. |
| Image built with mac binaries | `.dockerignore` wasn't in the build context, or you built from a dir with stale `resources/`. Rebuild from a clean checkout. |
| CI loop (workflow re-triggers itself) | The `paths:` filter excludes `k8s/**` and the commit message has `[skip ci]`. If you edit the filter, keep both guards. |

---

## Live service testing

The repo ships a Playwright suite that runs **read-only** checks against the
deployed k3s NodePort - so you can verify a deploy actually serves a working app
with one command, instead of opening the URL and clicking around.

```bash
make test-live                 # read-only suite against http://23.144.68.246:30950
# or, equivalently:
npm run test:e2e:live
```

The `live` Playwright project connects to an already-running external URL
(`LIVE_SERVICE_URL`, default `http://23.144.68.246:30950`); it **never** launches
a local `node server.js` and **never** creates temp store dirs. Point it at a
different deploy by overriding the URL:

```bash
make test-live LIVE_SERVICE_URL=http://staging-host:30950
# or
LIVE_SERVICE_URL=http://staging-host:30950 npm run test:e2e:live
```

### What the read-only `@live` tests check

- `/api/config` responds 2xx with JSON (backend booted).
- `/` serves the SPA and routes to `/chat`.
- The chat shell renders (sidebar + composer + session list) and the **WebSocket
  connects** (`status-text` becomes `Connected`).
- A `list_models` WS round-trip returns a `models` response (the deployed agent
  session is live) - no tokens spent.
- The sidebar shows all nav entries; `/dashboard` resolves via the SPA fallback.

The read-only suite **never** writes chat history, uploads documents, switches
models, or spends LLM tokens.

### Opt-in LLM round-trip (`@live-smoke`)

To verify the full server -> Volces path with one real chat turn
(which **does** spend one LLM token and writes one chat session to the deployed
data dir), run the smoke variant - gated behind `LIVE_SMOKE=1` so it never runs by
default:

```bash
make test-live-smoke           # sets LIVE_SMOKE=1
# or
npm run test:e2e:live:smoke
```

> **Note:** live tests target a NodePort on a private IP, so they are a
> dev-machine / self-hosted-runner concern - not run from `ubuntu-latest` CI
> (which has no route to `23.144.68.246:30950`). The local `fast`/`smoke`
> suites (`npm run test:e2e`) are unaffected and still launch their own local
> `node server.js`.

---

## Multi-tenant cloud deployment (gateway + cells)

The single-process deployment above serves **one** shared runtime. The hosted
product shape is different: each user gets their own isolated runtime, and a
thin **gateway** in front authenticates them and routes to it.

```
                  ┌──────────────────────────────────────────────┐
browser ──https──►│ gateway  (gateway/index.js)                  │
                  │  Logto login · session cookie · WS upgrade    │
                  │  cell registry: spawn / health / idle reap    │
                  └───────┬───────────────────┬──────────────────┘
                          │ loopback + gateway secret
              ┌───────────▼─────────┐  ┌──────▼──────────────┐
              │ cell alice          │  │ cell bob            │
              │  server.js + dsh    │  │  server.js + dsh    │
              │  /data/<alice>/…    │  │  /data/<bob>/…      │
              └─────────────────────┘  └─────────────────────┘
```

A **cell** is exactly the single-process deployment above — one `server.js`,
one dsh child, one data root — so the desktop app and `npm start` are the
one-cell form of the same thing. Nothing inside a cell knows other users exist;
that is what makes isolation a process boundary instead of application logic.

### Running it

```bash
# One gateway, which starts cells as users arrive.
CELL_GATEWAY_SECRET=$(openssl rand -base64 32) \
CELL_DATA_ROOT=/data/cells \
GATEWAY_PORT=3080 GATEWAY_HOST=127.0.0.1 \
AUTH_MODE=logto PAAS_BASE_URL=https://paas.example.com \
LOGTO_ENDPOINT=https://auth.example.com LOGTO_APP_ID=… LOGTO_APP_SECRET=… \
SESSION_SECRET=$(openssl rand -base64 32) \
node gateway/index.js
```

`npm run gateway` is the same thing. Cells are spawned by the gateway; you
never start them by hand in production (`.env.example` documents the per-cell
env matrix for doing so while debugging).

### Environment

**Gateway:** `GATEWAY_PORT` (default 3080), `GATEWAY_HOST` (bind address — this
is the deploy's public surface), `CELL_DATA_ROOT` (per-user data root),
`CELL_GATEWAY_SECRET` (**required**; the gateway and cells share it),
`CELL_IDLE_REAP_SECS` (default `0` = never), `CELL_START_TIMEOUT_MS` (default
60000), plus the `LOGTO_*` / `SESSION_SECRET` / `PAAS_BASE_URL` set from the
Logto section above.

**Cells** are configured entirely by the spawner: `PLATFORM_DATA_DIR`,
`DSH_HOME`, `MCP_CONFIG_PATH`, `PORT`, `HOST=127.0.0.1`, `AUTH_MODE=forward_auth`,
`CLOUD_MODE=1`, `CELL_GATEWAY_SECRET`, `CELL_USER_EMAIL`. They inherit the
gateway's environment for everything else, which is how they get `LLM_API_KEY`
and friends. `DSH_SHARED_HOME` (default `~/.dsh`) is the deployment's installed
dsh tree; a fresh per-user `DSH_HOME` is scaffolded from `dsh-profile-template/`
and linked to it read-only, so every cell resolves the same bundles without a
per-user install.

Two rules are not optional:

1. **Cells bind loopback only.** Never expose a cell port. The gateway is the
   only reachable surface; the secret is defence-in-depth for the shared-host
   case, not a substitute for this.
2. **`CELL_DATA_ROOT` must be local disk.** Every store is SQLite + WAL, and
   SQLite over NFS corrupts. A network filesystem here will lose data.

### Logto app registration

The gateway is the **only** Logto client; cells never talk to the identity
provider. Register one confidential web application with redirect URI
`<PAAS_BASE_URL>/auth/callback` and post-logout `<PAAS_BASE_URL>/`, enable the
`organizations` / `organization_roles` claims as described above, and give the
gateway `LOGTO_ENDPOINT` / `LOGTO_APP_ID` / `LOGTO_APP_SECRET`. Group names
still arrive as cell identity (`X-Forwarded-Groups`), so `admin` remains the
administrative group.

### Sizing and lifecycle

Each resident cell is a Node process plus a dsh child plus that user's page
cache — budget **roughly 150–300 MB per cell** and size the host for the number
of users you expect *concurrently resident*. 100 resident cells wants on the
order of 20–30 GB of RAM, so the always-on default is comfortable to low
hundreds of users on a modest pool and wants reaping or Phase 3 density work
beyond that.

Cells are **always-on by default**: the first authenticated request starts one
and it stays. Being started means the user's cron jobs fire and bots poll,
which is the point. Setting `CELL_IDLE_REAP_SECS` trades that away: after that
much idle time a cell is stopped. The reaper asks the cell for its enabled
scheduled work before stopping it, and a cell with **any enabled cron job or
bot is exempt** — so "reaped" never silently breaks a schedule that the user
set up and left enabled. A disabled job does not block reaping.

The offline contract, which must be stated to users: **a stopped cell means
that user's chat is briefly unavailable on their next visit and their scheduled
jobs do not fire while it is stopped.** Coming back is a cold start — the
server boots and completes its dsh handshake before the agent can answer, which
is seconds, once per idle cycle. Nothing is lost; the data root persists.

### Observability and operation

```bash
curl http://127.0.0.1:3080/healthz                 # liveness (+ resident cell count)
curl -H "Cookie: paas_session=…" http://127.0.0.1:3080/api/gateway/status
```

`/api/gateway/status` is admin-gated and lists every cell as
`{user, userId, state, pid, port, lastTraffic, uptimeMs, error}`. `state` is
`starting` → `running` → `stopping`, or `error` when a cell exits unexpectedly
(its user's next request cold-starts a fresh one). A crash is scoped: one cell's
failure never touches another user's.

`SIGTERM` on the gateway stops every cell before exiting, so a redeploy does not
leak one process per user on the host.

### Phase 3 outlook (explicitly out of scope today)

Cells here are child processes on one host, and `gateway/spawner.js` is the only
file that knows that. The intended next step replaces `spawn()` with a k8s
client and PVC-per-user, at which point:

- **Density and isolation** come from pods and namespaces rather than process
  cgroups; the gateway↔cell contract (HTTP + WS to a loopback-reachable cell,
  identity via headers + shared secret) is unchanged.
- **Durability**: cell data roots move to per-user PVCs, and backup/restore
  becomes a per-directory operation — the layout was chosen so it would be.
  Until then, **losing the host loses that host's users' data**; there is no
  replication or backup in this cut.
- **Scaling**: the gateway is single-instance and in-memory, so cells are not
  HA either. That is a deliberate first-cut trade, not an oversight.

---

## File map

```
Dockerfile                          # multi-stage single-process image build
.dockerignore                       # excludes built resource payloads + secrets
Makefile                            # build/run/k8s/argocd shortcuts
k8s/
  service.yaml                      # NodePort 30950 → :3000
  deployment.yaml                   # 1 replica, Recreate, image tag set by CI
argocd/
  application.yaml                  # ArgoCD app (apply once)
.github/workflows/
  docker-deploy.yml                 # build + push + GitOps commit-back
  release.yml                       # (unchanged) Electron .dmg/.exe installers

gateway/                            # multi-tenant front door (not used by the single-process deploy)
  index.js                          # Logto auth, routing, WS upgrade, /healthz + /api/gateway/status
  spawner.js                        # cell lifecycle: spawn, health, idle reap, shutdown
  proxy.js                          # HTTP + WebSocket forwarding; injects the verified identity
scripts/
  test-cell-containment.mjs         # a cell writes only under its data roots
  test-cell-isolation.mjs           # two cells: no cross-cell state, events, or errors
  test-cell-gateway.mjs             # gateway auth, routing, sticky WS, restart, idle reap
  test-cell-bindings.mjs            # saved bindings are what a cell boots on
```
