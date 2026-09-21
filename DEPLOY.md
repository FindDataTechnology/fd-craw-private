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

### 1. Harbor project + robot account (for the image push)

The registry actually used in production is the **internal** Harbor
`100.64.0.8:30880` (the America Harbor `23.144.68.246:30880` this section originally
described is unreachable from GitHub runners *and* from the China-side build hosts, so it
is no longer part of any working path). The `paas_private` project exists there, and push
comes from Jenkins with the project-scoped robot `robot$paas_private+ci-push-platform`
(credential id `harbor-platform` in Jenkins — push + pull, no expiry). Nothing needs to be
created per build; to re-create the robot: Harbor UI → `paas_private` → Robot Accounts → New
(scoped to `paas_private`, push).

> The `harbor-pull` secrets already in the cluster use the Harbor `admin` account — fine for
> pulls. A project-scoped push robot (what Jenkins uses) is the least-privilege way to push.
>
> Historical note: a `robot$paas_private+github-actions` robot was created for the
> GitHub Actions leg. That workflow no longer runs (see the header of
> `.github/workflows/docker-deploy.yml`); the robot is unused.

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

### 3. GitHub Secrets — **no longer used**

This table described the GitHub Actions push leg
(`robot$paas_private+github-actions` → America Harbor). That workflow cannot work from a
GitHub runner any more and has been reduced to manual dispatch; the image is built by
Jenkins instead (see "Cluster deployment"). Nothing needs to be configured here for a
deploy — the secrets, if still present, are leftovers:

| Secret | Value (historical) |
|---|---|
| `HARBOR_HOST` | `23.144.68.246:30880` — unreachable from runners |
| `HARBOR_PROJECT` | `paas_private` |
| `HARBOR_USER` | `robot$paas_private+github-actions` |
| `HARBOR_PASS` | `<robot account secret>` |

### 4. ArgoCD app (already registered)

`fd-prod` is reconciled by the app `all-services-prod` against the **external GitOps repo**
`fd-infra-deploy` (`all-services/prod/*.yaml`) — not against this repo's `k8s/`, which is
the older pre-k3s layout. The application object already exists; to inspect or refresh it:

```bash
kubectl --context cheap -n argocd get application all-services-prod
kubectl --context cheap -n argocd annotate application all-services-prod \
  argocd.argoproj.io/refresh=normal --overwrite
```

Thereafter **never edit the live resources directly** — change the manifest in
`fd-infra-deploy` and let ArgoCD reconcile.

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

The live cluster follows a **separate GitOps repo** —
`git@gitee.com:FindDataTechnology/fd-infra-deploy.git`, `all-services/prod/platform.yaml` —
through the ArgoCD app `all-services-prod` (auto-sync + selfHeal). That file's `image:`
line is the only thing that decides which build runs, so a deploy is always two steps:
build + push the image, then commit its tag there. The `k8s/` and `argocd/` directories in
*this* repo are the pre-k3s Bootstrap layout and are no longer what `fd-prod` reconciles
(section 3/4 below is kept for that older host only).

### 1. Build + push the image — Jenkins (canonical)

The `platform` job on the in-cluster Jenkins (`http://103.236.89.212:31000`, NodePort
`31000` in namespace `jenkins`) runs this repo's `Jenkinsfile`:

- **Source**: Gitee `fd-craw-private`, branch **`deploy/prod-snapshot`** — that branch is
  what gets built, so fast-forward it to the revision you want before triggering.
- **Build**: cheap-3's docker daemon (the pod mounts the host socket), with
  `BASE_IMAGE=100.64.0.8:30880/library/node:25-bookworm-slim` (cheap-3 cannot reach
  Docker Hub), tagged `100.64.0.8:30880/paas_private/platform:sha-<7>` **and** `:latest`.
- **Smoke test before push**: the image is booted with `AUTH_MODE=none` and probed on
  `/api/config`; a container that dies after binding its port fails the build (that is how
  two past images were caught).
- **Push**: internal Harbor, as the project-scoped robot
  `robot$paas_private+ci-push-platform` (credential id `harbor-platform`).
- **It does not touch the GitOps manifest**, deliberately: the tag bump stays a reviewable
  commit (same rule as law-bench).

Credentials and the job's SCM live in Jenkins; nothing to set up per build. A cold build is
~40 min (no BuildKit cache export), and `disableConcurrentBuilds()` makes a second trigger
queue behind the first.

Trigger it — a push to `deploy/prod-snapshot` normally fires the Gitee webhook, and the
job's own webhook endpoint works directly (token is the literal string `platform`):

```bash
curl -X POST "http://103.236.89.212:31000/generic-webhook-trigger/invoke?token=platform"
curl -s "http://103.236.89.212:31000/job/platform/api/json?tree=lastBuild[number,building,result]"
curl -s "http://103.236.89.212:31000/job/platform/lastBuild/consoleText" | tail -40
```

The build log's `Pushed 100.64.0.8:30880/paas_private/platform:sha-<7>` line names the tag
to deploy next.

Two things about this host. **It is the production node** — cheap-3 also runs the single
`fd-prod` platform pod, the image registry and the proxy, so a build that exhausts its
memory takes the site down with it: builds #14 and #16 on 2026-09-21 died that way
(`SystemOOM` killed kubelet, registry and proxy; the site 502s until the node recovers).
The Dockerfile therefore caps build-time memory in its builder stage
(`NODE_OPTIONS=--max-old-space-size=1024`, `UV_THREADPOOL_SIZE=2`) — keep that cap. And the
built-in node has **one executor**, so a trigger can wait at "Waiting for next available
executor" behind other services' jobs; the build checks out the branch **tip at build
start**, so the log's `Checking out Revision …` line — not the push that triggered it —
names the commit being tagged.

### 2. Deploy it — hand commit in the GitOps repo

```bash
cd fd-infra-deploy
# all-services/prod/platform.yaml: image: 100.64.0.8:30880/paas_private/platform:sha-<7>
git commit -am "deploy(platform): roll to sha-<7>" && git push
# skip ArgoCD's ~3 min poll, then wait for the rollout
kubectl --context cheap -n argocd annotate application all-services-prod \
  argocd.argoproj.io/refresh=normal --overwrite
kubectl --context cheap -n fd-prod rollout status deploy/platform
```

Prove afterwards that the *code* — not just the tag — is what is serving: the pod's bundle
carries the new UI and its server the new routes.

```bash
kubectl --context cheap -n fd-prod get deploy platform \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl --context cheap -n fd-prod exec deploy/platform -- \
  sh -c 'grep -rl <new-testid> /app/web/dist/assets | head -3; ls /app/server/routes/'
curl -s -o /dev/null -w '%{http_code}\n' https://craw.finddatatech.cloud/api/ready
```

### Fallback: build without Jenkins

Only when Jenkins is unavailable. cheap-1 already has a buildx builder for lawcraw
(`--builder lawcraw-builder`, with `100.64.0.8:30880` declared insecure), so the same
image can be produced there — note `DOCKER_CONFIG` must be a **copy** of `/root/.docker`
(buildx keeps its builder definitions there, and the copy leaves the lawcraw robot's own
credentials untouched), and the Harbor password comes from a file, never argv:

```bash
PW_FILE=/tmp/paas-harbor-pw bash /tmp/paas-build.sh sha-<7>   # on china-cheap-1
```

It pushes the same `sha-<7>` + `latest` tags, so step 2 above is unchanged.

### Inspect the deployment

```bash
make k8s-status        # pods, svc, rollout
make k8s-logs          # tail the platform pod
kubectl -n platform-private describe pod -l app.kubernetes.io/name=platform
```

Reach it: **https://craw.finddatatech.cloud** (canonical entry — Caddy on cheap1 →
`127.0.0.1:3000`, and the app's own `PAAS_BASE_URL`). The k3s `fd-prod` platform
also answers on its NodePort (**http://103.236.89.212:31870** when this was
written — NodePorts get reallocated: `kubectl --context cheap -n fd-prod get svc platform`).
Both entries now sit behind Logto (`/api/auth/me` → `mode: "logto"`), so anything
that drives the UI needs a session; the older `http://23.144.68.246:30950` in
notes below is dead — **no service in the cluster uses NodePort 30950 any more**.

The `fd-prod` deployment runs `100.64.0.8:30880/paas_private/platform:sha-cc148eb`
(per-user MCP market credentials, deployed 2026-09-21). The image tag lives in the
GitOps repo (`fd-infra-deploy`, `all-services/prod/platform.yaml`); ArgoCD
`all-services-prod` syncs it. `kubectl --context cheap -n fd-prod get deploy
platform -o jsonpath='{.spec.template.spec.containers[0].image}'` is the source of
truth — and if a rollout seems to ignore a new tag, force a refresh with
`kubectl --context cheap -n argocd annotate application all-services-prod
argocd.argoproj.io/refresh=normal --overwrite`.

### Override the Volces key in-cluster (optional)

```bash
kubectl -n platform-private create secret generic platform-secrets \
  --from-literal=volces-api-key=your-key
# ArgoCD self-heal keeps the secret; the Deployment reads it via optional secretKeyRef.
```

### Name the assistant (optional, per deployment)

One value renames every user-facing occurrence of the assistant — sidebar title,
turn header, composer placeholder, the built-in agent's row in the agent
picker, browser tab title — through `GET /api/config` (no rebuild; the web
resolves it before its first paint and falls back to the localized defaults
when unset):

```bash
# Local / docker: .env
ASSISTANT_NAME=Your Name Here
# In-cluster: the platform-config ConfigMap (fd-infra-deploy, e.g. ASSISTANT_NAME),
# then roll the pod.
kubectl -n fd-prod rollout restart deploy/platform
```

#### Chat fixes: pack agents on the local runtime, folded reasoning, one name — APPLIED 2026-09-22

Live on `sha-a90c2b1` (`fd-prod`, `ASSISTANT_NAME=FD`). Four reported defects, one
cause: a chat-mode catalog agent was forked to its entry's bare OpenAI endpoint, so
the turn had no persona, no tools and no history ("the agent has no memory", "the
conversation cannot see the marketplace MCPs"). A chat agent is now served by the
**local runtime with a generated persona preset** (see `docs/vertical-packs.md` §6.1),
an entry that really is a remote service opts out with `"local": false`, and the fork
path replays the mirrored conversation. Reasoning folds when a turn completes (a
reader who expanded it keeps it open), and `ASSISTANT_NAME` reaches the sidebar,
turn header, composer placeholder, tab title and the built-in agent's picker row.

Verify a deployment after any chat change:

```bash
node scripts/verify-live-chat-fixes.mjs          # Playwright probe; creds from .env
# and pod-side: the newest sessions' preset, persona line and MCP tool count
kubectl -n fd-prod exec deploy/platform -- node /app/scripts/inspect-live-session.mjs
```

Selecting a pack agent is a **preset switch** (the dsh child restarts, ~10 s; the
composer blocks until `agent_changed`). `user_preferences.agent.preset` is what a
restart composes — the pick made before the pack is parked under
`agent.preset.own`, which a switch back to the built-in agent restores.

### Registry market token (live layout: `fd-prod` namespace)

The Store merges registry entries from `https://mcp.finddatatech.cloud`
(registry-bridge). The bridge needs `REGISTRY_URL` + `MARKET_REGISTRY_TOKEN`;
without them it logs `registry source disabled` at boot and the market serves
only the bundled catalog. The registry API requires a Bearer token (401
otherwise), so the token is mandatory for registry entries to appear.

> **Where the platform actually runs** (verified 2026-09-18): namespace
> **`fd-prod`**, image from Harbor (`…/platform:sha-<short>`), env injected via
> `envFrom` → ConfigMap `platform-config` + Secret `platform-secrets`. The
> `default`-namespace `platform` deployment in this repo's manifest is a
> scaled-to-zero leftover of the pre-Harbor layout — patching it changes
> nothing user-visible.

1. **Issue a token** — sign in to `https://mcp.finddatatech.cloud` with an
   admin account (寻数科技账号登录), then "Get JWT Token" in the sidebar.
   Token lifetime (updated 2026-09-18): the registry host now runs
   `MCP_TOKEN_DEFAULT_TTL_HOURS=168` / `MCP_TOKEN_MAX_TTL_HOURS=168`
   (`/opt/mcp-gateway-registry/.env` on china-cheap-1; backup
   `.env.bak-ttl-*` alongside), so both the UI button and the mint API
   (`POST /api/tokens/generate` with `X-CSRF-Token` from
   `GET /api/auth/csrf-token`, `expires_in_hours: 168`) yield **7-day**
   tokens. Renew weekly (current one expires 2026-09-25 13:09 CST).
   Minting from a script: an authenticated browser session is required
   (admin login); the API route is otherwise identical.
   ⚠️ The registry's IAM > M2M Accounts (long-lived clients) remains broken:
   the IAM manager factory does not support `AUTH_PROVIDER=logto` (falls
   back to a Keycloak client that cannot connect → group list 502, and the
   M2M create form requires picking from that list), and the M2M client
   list 500s on its DocumentDB config. Fixing that is registry-repo work
   (local fork: FindDataTechnology + law-ai-official mirrors on Gitee/GitHub).
2. **Store it** (secret keys become env vars verbatim via `envFrom`):

   ```bash
   kubectl --context cheap -n fd-prod patch secret platform-secrets \
     -p '{"stringData":{"MARKET_REGISTRY_TOKEN":"<token>"}}'
   ```

3. **Set the URL** in the ConfigMap (plain value, not a secret):

   ```bash
   kubectl --context cheap -n fd-prod patch configmap platform-config \
     --type merge -p '{"data":{"REGISTRY_URL":"https://mcp.finddatatech.cloud"}}'
   ```

4. **Restart and verify** (bridge is silent on success; it only logs when
   disabled or on fetch failure):

   ```bash
   kubectl --context cheap -n fd-prod rollout restart deploy/platform
   kubectl --context cheap -n fd-prod rollout status deploy/platform
   kubectl --context cheap -n fd-prod exec deploy/platform -- \
     sh -c 'echo $REGISTRY_URL; echo ${MARKET_REGISTRY_TOKEN:+token-set}'
   ```

   Then check the market over an authenticated session
   (`GET /api/extensions/market`): bundled entries stay, and registry entries
   appear — MCP `fd-cn-report`, `fd-daas-mcp`, `fd-open-data-mcp`, `law-bench`,
   `airegistry-tools`; skills `contract-review`, `financial-statement-analysis`,
   `legal-research-cn` and the rest of the registry skill catalog; agents
   `registry-chatlaw`, `registry-fingpt` in `/api/catalog`.

#### Per-user market connect (registry-sso-credentials) — APPLIED 2026-09-21

The Store's 连接 MCP 市场 button mints a **personal** registry token. The registry
window it opens is the registry's own login page — the platform's sign-in has
already established a Logto session in the same browser, so the registry's single
`Continue with Logto` button completes the sign-in with **nothing typed**; the
platform then mints **cross-origin with credentials** (the registry session
cookie is `SameSite=None; Secure`) and hands the token to the backend, which
stores it per user (`user_registry_credentials`). It never touches browser
storage, and the popup itself is closed by the platform the moment the mint
lands.

Two registry-side pieces make that cross-origin leg work. Both are now in place
on china-cheap-1, and both are ops config rather than platform code:

1. **Credentialed CORS allowlist** — `CORS_ALLOWED_ORIGINS` in
   `/opt/mcp-gateway-registry/extra_env/registry.env` (the compose `env_file`
   for the `registry` service; note the project `.env` is only used for compose
   *interpolation* and does NOT reach the container):

   ```
   CORS_ALLOWED_ORIGINS=https://craw.finddatatech.cloud,http://103.236.89.212:31870
   ```

   The registry is fail-closed — its own origin is always included, nothing else
   is. List the origins the **browser** loads the platform from; a preflight from
   an unlisted origin is refused and the Store can only fall back to paste. The
   k3s NodePort is reallocatable (the older `30950` no longer exists in the
   cluster — see the note below), so re-check this line whenever the entry URL
   changes.

2. **Preflight exemption in nginx** — `/opt/mcp-gateway-registry/nginx_rev_proxy_http_only.conf`
   (mounted read-only into the container as the registry-API template; a second
   copy at `docker/nginx_rev_proxy_http_and_https.conf`). The `location /api/`
   block authenticates every request with `auth_request /validate`, and a CORS
   preflight never carries credentials by spec — so it could only ever 401, and
   the browser then blocks the real credentialed call. The hotfix routes OPTIONS
   to a named location that skips the auth subrequest and lets FastAPI's
   CORSMiddleware apply the strict origin allowlist (OPTIONS has no body, no
   cookies and no side effects; real requests are unchanged):

   ```nginx
   if ($request_method = OPTIONS) { return 418; }
   error_page 418 = @registry_api_preflight;
   # ...server scope:
   location @registry_api_preflight { proxy_pass http://127.0.0.1:7860; ... }
   ```

   The session cookie was already `SameSite=None; Secure`, so nothing was needed
   there.

Apply a change to either file with (only the `registry` service is recreated;
dependencies and the image are left alone, and a failed nginx reload keeps the
old config running):

```bash
cd /opt/mcp-gateway-registry
cp -a extra_env/registry.env extra_env/registry.env.bak-$(date +%Y%m%d-%H%M%S)   # or the .conf
docker compose -f docker-compose.prebuilt.yml up -d --no-deps --no-build --pull never --force-recreate registry
docker inspect -f '{{.State.Health.Status}}' mcp-gateway-registry-registry-1     # → healthy in ~1-2 min
```

Verify (all three from a machine that can reach the registry):

```bash
U=https://mcp.finddatatech.cloud; O=https://craw.finddatatech.cloud
curl -D- -o /dev/null -H "Origin: $O" $U/api/auth/csrf-token | grep -i access-control        # ACAO = $O
curl -D- -o /dev/null -X OPTIONS -H "Origin: $O" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-csrf-token' $U/api/tokens/generate      # 200 + ACAO
curl -D- -o /dev/null -X OPTIONS -H "Origin: https://evil.example" $U/api/tokens/generate    # 400, no ACAO
```

A browser check from the real origin (the anonymous case resolves the GET and
sends the POST; the anonymous POST still 401s at nginx, which is expected — the
mint needs a registry session):

```js
// devtools on https://craw.finddatatech.cloud
await fetch("https://mcp.finddatatech.cloud/api/auth/csrf-token", { credentials: "include" })
// → Response{status: 401, type: "cors"}  (a TypeError here means the allowlist is missing this origin)
```

**Verified end-to-end on fd-prod (2026-09-21, `sha-cc148eb`, account
`aloadtree@gmail.com`)** — `scripts/verify-live-connect-flow.mjs` (credentials
from `LOGTO_EMAIL`/`LOGTO_PASSWORD`; it resets the connection, picks a registry
entry the deployment does not already serve, and uninstalls it again, so running
it leaves the environment as it found it):

| Step | Result |
| --- | --- |
| Platform sign-in | `/login` → `Sign in with SSO` → Logto → `/chat` |
| Connect | Connect + the registry's own `Continue with Logto` — **no credential typed anywhere**; connected, `expiresAt` +168 h, `source: sso` |
| Install a registry entry | form has **no** `Authorization` field, Add enabled immediately; the stored record carries `credentialRef: "registry"` and **no** header |
| Effective profile on the pod | the entry in `mcp.patch.yml` carries `Authorization: Bearer …` whose JWT `exp` equals the connection's expiry — i.e. the user's own credential, resolved at write time |
| The credential works | `initialize` → serverInfo `AI Registry`; `tools/list` → 7 tools |
| Chat turn | answered through the deployed instance (LLM + agent path healthy) |
| Cleanup | entry uninstalled; the deployment's five managed servers untouched; the credential row left connected |

Two things that runbook should know about the registry side:

- The registry's login page is **not** an automatic redirect: the first connect
  takes one extra click (`Continue with Logto`) on the registry's own origin,
  which the platform cannot click for the user. Afterwards the registry cookie
  lives for 24 h, so repeat connects are a single click on Connect.
- That card renders **"No login methods are currently configured"** when its own
  `/api/auth/providers` call loses the race against a busy page load (observed
  while the SPA was still fetching its bundle; the endpoint itself stays 200).
  A reload fixes it, so the verification script retries the window; if a demo
  operator ever sees it, reload the window (or just click Connect again). The
  paste fallback stays available at all times.

Rollback: restore `extra_env/registry.env` / the `.conf` from its `.bak-*`
backup and recreate the container. Registry routes moved in a version bump?
Override the paths instead of patching code: `MARKET_REGISTRY_LOGIN_PATH`,
`MARKET_REGISTRY_CSRF_PATH`, `MARKET_REGISTRY_TOKENS_PATH`.

If the allowlist is missing an origin — or the registry is unreachable, or the
account cannot sign in there — the paste fallback is the supported path: the same
dialog takes a token minted via the registry UI's "Get JWT Token", stores it in
the same per-user row with `source: "paste"`, and drives exactly the same
injection (`Authorization` resolved at profile-write time, servers omitted with a
warning when the credential is missing/stale/expired — see the
`registry-credentials` and `dsh-runtime-bridge` specs for the profile side).

### Bot relay (machine callers → chat-platform bots)

Lets a cloud service on a trusted network push text through a configured bot
without a browser session (`add-bot-relay-endpoint`). The route
(`POST /api/bots/relay/send`) is identity-exempt like the bot webhooks and
carries its own bearer token. Deploy inert first, then enable:

1. **Confirm it is inert** on the running service (no token yet):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     <PLATFORM_URL>/api/bots/relay/send -d '{}'   # → 404, e.g. https://craw.finddatatech.cloud
   ```

2. **Add the token** (same rotation rhythm as `MARKET_REGISTRY_TOKEN`):

   ```bash
   TOKEN=$(openssl rand -base64 32)
   kubectl --context cheap -n fd-prod patch secret platform-secrets \
     -p "{\"stringData\":{\"BOTS_RELAY_TOKEN\":\"$TOKEN\"}}"
   kubectl --context cheap -n fd-prod rollout restart deploy/platform
   kubectl --context cheap -n fd-prod rollout status deploy/platform
   ```

3. **Verify both answers**, then keep `$TOKEN` only in the caller's server-side
   config (never in a browser, never in a repo):

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     <PLATFORM_URL>/api/bots/relay/send \
     -H 'authorization: Bearer wrong' -d '{}'                    # → 401
   curl -s -X POST <PLATFORM_URL>/api/bots/relay/send \
     -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     -d '{"channel":"ops-alerts","text":"hello"}'                # → {"ok":true}
   ```

4. **Bind a channel** (admin session required; the pair must be a chat the bot
   has already been messaged from, which requires inbound to work — see
   `PUBLIC_BASE_URL` below):

   ```bash
   curl -s <platform>/api/bots/chats                      # find botId + chatKey
   curl -s -X POST <platform>/api/bots/channels \
     -H 'content-type: application/json' \
     -d '{"name":"ops-alerts","botId":"<botId>","chatKey":"<chatKey>"}'
   ```

**Transport**: the token must only cross a network the operator trusts. Calling
from the same host (the registry stack) uses the loopback/node address and is
fine as-is; an off-host caller needs a TLS-terminated ingress in front of the
platform — do not send it over the plain-HTTP NodePort from the open internet.

**Inbound reminder**: webhook platforms (WeCom/Feishu/WeChat OA) can only
receive with `PUBLIC_BASE_URL` set on the deployment; without it only Telegram
works (long-poll), and no `bot_chats` row is recorded for webhook platforms, so
nothing is bindable there.

**Rollback**: unset the Secret key (`kubectl patch secret … -p
'{"stringData":{"BOTS_RELAY_TOKEN":""}}'`) and restart — the route answers 404
again. The `bot_chats` / `bot_channels` / `bot_relay_log` tables stay as inert
leftovers; dropping them is optional.

### Role-gated market entries (Logto groups)

Registry entries can be restricted to users holding a specific Logto role
(mapped into the platform's `groups` from Logto organizations/organization
roles at login). The registry API carries no group metadata, so visibility
groups come from an optional local file next to the data dir (CWD in the
container), `registry-groups.json`:

```json
{
  "servers": { "fd-cn-report": ["analysts"] },
  "skills":  { "contract-review": ["legal"] },
  "agents":  { "agents-weather": ["team-a"] }
}
```

Behavior (add-role-gated-extensions): a gated entry is hidden from the market
for users outside its groups; installing one stamps `requiredGroups` on the
MCP record and is rejected server-side for non-members; at runtime the
effective MCP profile drops stamped servers the current user's groups no
longer cover — so **revoking a Logto role takes effect on the user's next
profile application or cell restart** (in a hosted cell the owner's latest
groups are snapshotted to `PLATFORM_DATA_DIR/owner-groups.json` to survive
restarts). Bundled catalog entries never carry groups; with auth off
(desktop/dev) the requester is the machine owner and sees and installs
everything.

Operational note: renaming a group in Logto (or in `registry-groups.json`)
strands the mapping — gated servers silently disappear for affected users
until the file is updated. That is the designed failure mode: fail closed,
restore on fix.

**Ops access to the registry host** (updated 2026-09-18): china-cheap-1 is
`100.64.0.11` on the finddata Tailscale mesh (self-hosted control plane at
124.220.7.175; the paas workstation's profile `finddata` = chengs-mac
100.64.0.2). The workstation's key is in `/root/.ssh/authorized_keys`
(added 2026-09-18) and `~/.ssh/config` defines `Host cheap1` — so
`ssh cheap1` reaches it directly. The registry stack is docker compose at
`/opt/mcp-gateway-registry` (`docker-compose.prebuilt.yml`; recreate with
`--no-deps` — dependency init images reference docker.io and cannot pull
from the nodes). Fallback if mesh SSH is unavailable: privileged bridge pod
on cheap-4 (see git history of this file for the recipe).

**Registry nginx logto hotfix** (2026-09-19): the image's HTTP-only nginx
template (`/app/docker/nginx_rev_proxy_http_only.conf`) lacks the
`/oauth2/login/logto` + `/oauth2/callback/logto` proxy blocks that the
HTTP-and-HTTPS template has — with no TLS certs in the container the
entrypoint picks HTTP-only, so Logto login silently served the SPA shell
(blank "no login page" at `/oauth2/login/logto`). Fixed by patching those
blocks into a host-side copy at
`/opt/mcp-gateway-registry/nginx_rev_proxy_http_only.conf` and mounting it
read-only over the in-image template (see the `Hotfix 2026-09-19` volume in
`docker-compose.prebuilt.yml`); conf regenerations and container recreates
now keep them. Drop the mount after the upstream template gains the blocks.
Known residual after any conf regeneration: bare `/health` (use container
healthchecks; `/api/health` is also template-gated).

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
make test-live LIVE_SERVICE_URL=https://craw.finddatatech.cloud   # read-only suite
# or, equivalently:
LIVE_SERVICE_URL=https://craw.finddatatech.cloud npm run test:e2e:live
```

The `live` Playwright project connects to an already-running external URL
(`LIVE_SERVICE_URL`; the built-in default — the old `23.144.68.246:30950` — is
dead, see the entry note above, so pass the current URL explicitly); it **never**
launches a local `node server.js` and **never** creates temp store dirs.

⚠️ The deployed instances now enforce Logto, so the SPA/WebSocket specs fail
without a session (observed against `craw.finddatatech.cloud`: 5 failed with
`websocket error` / no `/chat` redirect). Use the suite against an
unauthenticated deploy, or sign in first. Point it at a different deploy by
overriding the URL:

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

> **Note:** live tests target a deployed entry (private IP NodePort or the
> public domain), so they are a dev-machine / self-hosted-runner concern - not
> run from `ubuntu-latest` CI, which has no route to either. The local
> `fast`/`smoke` suites (`npm run test:e2e`) are unaffected and still launch their own local
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

### WeChat mini program client (Taro)

`miniapp/` is a Taro (React) thin client — chat + session history — that speaks
the same WS/REST contracts as the web app through the shared `packages/core`
package. It authenticates through a second gateway identity path, WeChat
login, instead of the Logto browser redirect.

**Gateway env** (all three required to enable the path; unset = the login
route reports "not configured" and every browser flow is unchanged):

| Variable | Meaning |
|---|---|
| `MP_APPID` | the mini program's AppID |
| `MP_SECRET` | the mini program's AppSecret (**server-side only**) |
| `MP_TOKEN_SECRET` | JWT signing key for platform tokens (`openssl rand -base64 32`) |
| `MP_TOKEN_TTL_HOURS` | token lifetime, default `12` (the client silently re-logins via `wx.login`, so a shorter value is fine) |

Login is **account binding with bind codes** (Logto offers no password
grant — OAuth 2.1 removed the flow — so credentials never enter the mini
program):

1. First launch on a device: the user signs into the WEB app in a browser
   (the normal Logto flow) and opens **`/api/mp/bindcode`** — a small page
   shows a 6-digit code (5-minute, single-use, minted from their
   authenticated session).
2. They type that code ONCE on the mini-program login page:
   `POST /api/mp/login-bindcode {code, bindCode}` pairs the fresh
   `wx.login()` code (the WeChat user) with the bind code (account
   ownership) and binds the openid to the account
   (`<CELL_DATA_ROOT>/mp-bindings.json`).
3. Every later launch is silent: `wx.login()` → `POST /api/mp/login {code}`
   → `code2Session` → binding lookup → a platform JWT carrying the ACCOUNT
   email/groups, sent as `Authorization: Bearer` on REST and on the WS
   upgrade. Because the identity is the account email verbatim, the mini
   program and the browser resolve to the SAME per-user cell (shared
   sessions/model config).
4. `DELETE /api/mp/bind` (logout) removes the binding.

`MP_TOKEN_SECRET` is deliberately separate from `CELL_GATEWAY_SECRET`.
**Local rehearsal without the real MP AppSecret:**
`node scripts/dev-mp-gateway.mjs` — the real gateway + real Logto from
`.env`, with a mock code2Session that maps every wx.login code to one dev
openid, so the whole bind → silent-relogin flow can be rehearsed in
devtools.

**Release prerequisites (ops — start these early):**

1. **A registered mini program AppID** (个人主体 is fine for chat; web-view
   would require an enterprise entity — this client does not use web-view).
2. **HTTPS/WSS + an ICP-registered domain.** Release requires the domain in
   the WeChat admin console under 开发 → 开发管理 → 开发设置 → 服务器域名, in
   BOTH lists:
   - `request 合法域名` → `https://<PAAS_BASE_URL>`
   - `socket 合法域名` → `wss://<PAAS_BASE_URL>`
   An IP, a port-numbered host, or an unregistered domain cannot be added.
   Devtools bypasses the check (详情 → 本地设置 → 不校验合法域名), which is how
   the client is developed against a local server. The client's default base
   URL is `http://localhost:3000` — `localhost`, not `127.0.0.1`, because the
   dev server binds IPv6 localhost only; for 真机调试 (real-phone preview)
   set the base URL to the dev machine's LAN IP.

**Building the client:** `cd miniapp && npm install && npm run build:weapp`,
then open `miniapp/` in WeChat devtools (`miniprogramRoot: dist/`, test appid
— no devtools-side npm build needed). The API base URL lives in mini-program
storage (`platform.baseUrl`); the default is `http://localhost:3000`.

**Verification without devtools:** `node --test scripts/test-mp-auth.mjs`
(boots a real gateway against mocked WeChat/Logto upstreams and a stub cell —
login exchange, Bearer routing, header stripping, WS upgrade auth, identity
stability) and `node --test scripts/test-ws-reconnect.mjs` (the shared
reconnect state machine).

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
  mp-auth.js                        # mini-program identity: code2Session + platform JWT (Bearer)
  spawner.js                        # cell lifecycle: spawn, health, idle reap, shutdown
  proxy.js                          # HTTP + WebSocket forwarding; injects the verified identity
packages/core/                      # shared protocol core (WS client + chat store + REST clients)
                                    #   consumed by web/ and miniapp/ via file: — no build step
miniapp/                            # WeChat mini-program client (Taro + React)
  config/index.ts                   # webpack chain: @platform/core + zustand aliases
  src/lib/                          # runtime (auth/http/socket), markdown parser, canvas charts
  src/pages/chat|sessions/          # chat + read-only session history
scripts/
  test-cell-containment.mjs         # a cell writes only under its data roots
  test-cell-isolation.mjs           # two cells: no cross-cell state, events, or errors
  test-cell-gateway.mjs             # gateway auth, routing, sticky WS, restart, idle reap
  test-cell-bindings.mjs            # saved bindings are what a cell boots on
  test-mp-auth.mjs                  # mini-program login/Bearer/WS auth against a real gateway
  mp-stub-cell.mjs                  # stub cell used by test-mp-auth (not a test)
  test-ws-reconnect.mjs             # shared WsClient reconnect state machine
```
