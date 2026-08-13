# Deployment — Docker, Harbor, ArgoCD

Platform ships as a **single full-stack container**: `server.js` + LiteLLM + OpenConnector + Postgres, all spawned as localhost child processes by the supervisor (`scripts/start.js` → `local-services.js`), exactly like `npm start`. One image, one process tree, one PVC.

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
| `Dockerfile` | repo root | Multi-stage build: compiles native addons + builds `web/dist` + runs `npm run predist` (builds Linux LiteLLM/Python, OpenConnector, Postgres, Node bundles), then copies into a slim runtime. Entrypoint `node scripts/start.js`. |
| `.dockerignore` | repo root | Excludes built resource payload dirs (`resources/node`, `resources/python`, `resources/postgres`, `resources/openconnector`, `resources/litellm/venv`, `resources/litellm/prisma-engine`, `resources/**/*.tar.*`) so a host's mac/win binaries never leak into the Linux image. Keeps the tracked `resources/litellm/default-config.yaml` seed. |
| `k8s/` | `namespace.yaml`, `pvc.yaml`, `service.yaml`, `deployment.yaml` | Plain manifests (no Helm). Deployment = 1 replica, Recreate strategy (RWO PVC + stateful agent). Service = NodePort 30950. PVC = 10Gi local-path. |
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

> Requires Docker. The build downloads python-build-standalone + Node + Postgres tarballs (~300MB) and runs `pip install litellm[proxy]` — expect **10-20 min** for a cold build, ~2 min with the GHA cache.

```bash
make build                              # docker build -t platform:dev .
make run                                # -p 3000:3000 -v platform-data-dev:/data
# cold start: Postgres initdb + LiteLLM prisma db push + OC warmup → 60-120s
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
[local-services]   server-js: local (healthy)
[local-services]   postgres: local (healthy)
[local-services]   litellm: local (healthy)
[local-services]   openconnector: local (healthy)
```

If a sidecar shows `absent` instead of `local`, the bundle build failed — re-run `make build` and check the build log for the failing `scripts/build-*.js` step.

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

Every push to `main` or `embed-litellm-openconnector` (that touches source) triggers CI → builds `sha-<short>` + `latest` → pushes both → commits `sha-<short>` into `k8s/deployment.yaml` → ArgoCD auto-sync rolls out. **You do nothing.**

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

The single container runs Node + a Python venv (LiteLLM) + Postgres + OpenConnector. Defaults in `k8s/deployment.yaml`:

```yaml
requests: { cpu: 1000m, memory: 1500Mi }
limits:   { cpu: 3000m, memory: 4Gi  }
```

Tune to node capacity. The startup window is generous (`startupProbe` 300s) because first-run Postgres `initdb` + LiteLLM `prisma db push` can take 1-3 min on a cold PVC.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ImagePullBackOff` (401 Unauthorized) | Two root causes, both one-time: (1) the `paas_private` Harbor project doesn't exist yet — Harbor returns **401** for unknown projects, which looks like an auth failure but isn't (create it in the Harbor UI or via admin API); (2) the `harbor-pull` imagePullSecret is missing in `platform-private` — the k3s containerd mirror does NOT honor the `registries.yaml` `auth` block for mirrored endpoints (see architecture note). Run `make k8s-logs` and check the pod events; a `401 Unauthorized` from `localhost:30880` means one of these. |
| Pod restarts (OOMKilled) | Raise `limits.memory` in `k8s/deployment.yaml`. 4GB is the floor for all four services. |
| `startupProbe` fails → `CrashLoopBackOff` | `make k8s-logs`; look for the supervisor's per-service log dump. Most common: first-run `prisma db push` needs `DATABASE_URL` (the supervisor injects it from the seeded Postgres). |
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
- If OpenConnector / LiteLLM are enabled in the deployed config, their embedded
  iframe panels mount (same-origin `/oc-web` / `/litellm-web`).

The read-only suite **never** writes chat history, uploads documents, switches
models, or spends LLM tokens.

### Opt-in LLM round-trip (`@live-smoke`)

To verify the full server -> LiteLLM -> Volces path with one real chat turn
(which **does** spend one LLM token and writes one chat session to the deployed
PVC), run the smoke variant - gated behind `LIVE_SMOKE=1` so it never runs by
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

## File map

```
Dockerfile                          # multi-stage full-stack image build
.dockerignore                       # excludes built resource payloads + secrets
Makefile                            # build/run/k8s/argocd shortcuts
k8s/
  namespace.yaml                    # platform-private (ArgoCD-managed)
  pvc.yaml                          # 10Gi local-path RWO → /data
  service.yaml                      # NodePort 30950 → :3000
  deployment.yaml                   # 1 replica, Recreate, image tag set by CI
argocd/
  application.yaml                  # ArgoCD app (apply once)
.github/workflows/
  docker-deploy.yml                 # build + push + GitOps commit-back
  release.yml                       # (unchanged) Electron .dmg/.exe installers
```
