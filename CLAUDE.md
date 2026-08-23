# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`Platform` — a browser-based chat interface built on the **DeepSeek Harness (dsh)** runtime. The project's stated long-term goal is an "openclaw-like" assistant targeting a special industry, but the code today is a general-purpose coding-assistant web app: an Express + WebSocket server that spawns a dsh runtime as a stdio JSON-RPC child process, translates dsh events onto the existing WebSocket contract for React frontend clients, and adds two optional capabilities — a first-party documents RAG (LlamaIndex + PageIndex + SQLite, Volces-backed) and an OpenConnector proxy (1000+ SaaS actions via MCP). The earlier `@earendil-works/pi-coding-agent` SDK has been removed (see the `migrate-pi-to-dsh` OpenSpec change); dsh is now the sole agent runtime.

This is a **greenfield, ESM** Node project (`"type": "module"`). The backend remains buildless plain JavaScript — no transpiler, no bundler, no test runner, no linter configured. The **frontend is React** under `web/` (Vite + TypeScript + Tailwind v4 + shadcn/ui — see `web/README.md`). Routes: `/chat` (default), `/chat/:sessionId`, `/documents` (Knowledge), `/dashboard`, `/extensions`, `/agents` (Agents & Apps catalog), `/openconnector`, `/litellm`.

## Commands

```bash
npm install        # installs backend + runs postinstall that installs & builds web/
npm start          # headless launcher (scripts/start.js) - spawns the bundled LiteLLM +
                   #   OpenConnector locally (when resources/ are built and no external URL is
                   #   set in .env) plus server.js; serves http://localhost:3000 (PORT/HOST env overridable).
npm run web:dev    # Vite dev server on :5173 with HMR (backend must ALSO run on :3000)
npm run web:build  # rebuild web/dist without touching backend deps
```

Set `PLATFORM_SKIP_WEB_BUILD=1` to skip the postinstall frontend build (CI, or when iterating with `web:dev`).

**Local services (`npm start`):** the launcher reuses the desktop supervisor's shared primitives (`supervisor/`) to bring up the bundled LiteLLM (Python venv) and OpenConnector (Node/tsx) as localhost child processes on the ports parsed from their .env URLs (LiteLLM 4000, OpenConnector 3001 by default), injecting `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` into `server.js`'s env. Which of these get built + bundled is governed by `platform.bundle.json` (see below) — `resolveBundle()` (in `bundle-manifest.js`) is the single source of truth, and `PLATFORM_BUNDLE_COMPONENTS=all|none|openconnector,litellm` overrides it without editing the file. Build the resources first with `npm run predist` (runs `scripts/build-openconnector.js`, then `scripts/build-node.js` which downloads the standalone Node matching `process.version` into `resources/node/` - required for the supervisor to spawn child servers, and so the bundled Node ABI matches the prebuilt native addons - then `scripts/build-python-litellm.js`, then `scripts/verify-bundle.js`); `postinstall-bundle.js` skips building deselected components and `verify-bundle.js` asserts exactly the selected set is present, so a lean build omits e.g. the Python venv payload. The OC build generates `resources/openconnector/src/providers/registry.generated.ts` (the action catalog) which must be present at runtime. Set `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` to localhost URLs in `.env` (e.g. `http://localhost:4000`, `http://localhost:3001`) to run the project's internal services on those ports; set a non-localhost URL to use a remote server instead (external URLs work regardless of the manifest — it governs bundling, not remote access). Generated credentials + seeded `litellm.yaml` persist to `dev-settings.json` / `litellm.yaml` under `PLATFORM_DATA_DIR` (CWD-relative when unset), gitignored. When resources are absent or external URLs are set, the launcher degrades to running `server.js` alone; deselected components report `excluded (manifest)` in the startup summary rather than `absent`.

To run the web server with a different port: `PORT=8080 npm start`. To run the desktop app: `npm run start:electron` (the supervisor assigns server.js a dynamic free port and loads `http://localhost:<port>` in the window). `npm run dist` produces `dist/Platform-<version>-arm64.dmg` (mac) / `Platform Setup <version>.exe` (win).

**CI release (`.github/workflows/release.yml`):** builds three installers on a 3-entry matrix - `macos-latest` arm64, `macos-latest` x64 (via Rosetta on the arm64 host - `setup-node architecture: x64` so native addons compile for the x64 ABI), and `windows-latest` x64; the bundled LiteLLM venv is host-interpreter-specific so the `.exe` must be built on Windows (no cross-compile). Push a `v*` tag to cut a GitHub Release with the `.dmg` (arm64 + x64) + `.exe` attached; `workflow_dispatch` builds on demand and uploads artifacts without releasing. The dispatch workflow takes a `components` input (comma-separated `litellm,openconnector,postgres`, or `all`/`none`; empty = `platform.bundle.json` as-is) which is exported as `PLATFORM_BUNDLE_COMPONENTS` for the predist + dist steps on every matrix job, added to the resources cache key (with `hashFiles('platform.bundle.json')`) so a component-selection change never restores a stale cache, and marks lean-build artifacts with a `-lean` suffix. The electron-builder config is `electron-builder.js` (JS, reads `resolveBundle()` for conditional `extraResources`) - not a yml. Code signing + notarization are gated on Actions secrets - `CSC_LINK`/`CSC_KEY_PASSWORD` (mac signing), `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` (mac notarize via built-in `mac.notarize`), `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (win); when absent the build still succeeds unsigned (Gatekeeper/SmartScreen warnings only). `scripts/build-node.js` reads `process.version`, so the bundled standalone Node's ABI always matches the Node that ran `npm ci` (required because `npmRebuild: false`).

The `openspec` CLI (v1.4.1, `@fission-ai/openspec`, installed globally) drives spec-driven development — see **OpenSpec workflow** below.

## Starting the full service ("open web")

When the user says **"open web"** (or "open the app" / "start the app" / equivalent), start the **full service** with `npm start` - **not** `node server.js`. `npm start` (`scripts/start.js`) brings up `server.js` **plus** the bundled LiteLLM and OpenConnector as localhost child processes, so every panel - Chat, Dashboard, Knowledge (Documents), OpenConnector, LiteLLM - works for real at http://localhost:3000. `node server.js` alone does **not** spawn OC/LiteLLM; with a localhost `OPENCONNECTOR_BASE_URL` it then burns ~30s retrying the OC MCP connection, and the OpenConnector/LiteLLM panels fall back to "not configured" / blocked-frame placeholders. The Knowledge (Documents) panel is first-party and needs no separate deployment — only `VOLCES_API_KEY` set (see Configuration below).

Steps:
1. Stop anything already holding :3000 (e.g. a leftover `node server.js`) first.
2. `npm start` in the background.
3. Wait for the `Platform running at http://localhost:3000` line (and for the bundled children to report healthy).
4. `open http://localhost:3000`.

Caveats: the bundled LiteLLM/OC spawn only when `resources/` are built (`npm run predist`) **and** their `.env` URLs are localhost; a non-localhost URL (e.g. a remote LiteLLM) is used as-is with no spawn. If `resources/` are absent or both URLs are external, `npm start` degrades to `server.js` alone - in that case the panels won't be live, so say so rather than presenting the placeholder UI as "working".

## Configuration (all optional, all env-driven)

Everything sensitive or environment-specific lives in **`.env`** (gitignored) and **`mcp.json`** (gitignored). `mcp.example.json` is the template. The server degrades gracefully when optional config is missing — it always starts.

- `VOLCES_API_KEY` / `VOLCES_BASE_URL` — the hardcoded default provider (火山引擎/Volces Coding). A fallback API key is baked into `server.js`; override via env.
- `LITELLM_BASE_URL` / `LITELLM_API_KEY` — registers the `pi-provider-litellm` extension as an extra provider. If either is unset, litellm is skipped (server starts Volces-only). Under `npm start`, setting this to a localhost URL (e.g. `http://localhost:4000`) makes the launcher spawn the **bundled local LiteLLM** on that port (see Local services above); set a non-localhost URL to use a remote proxy.
- `OPENCONNECTOR_BASE_URL` (+ `OPENCONNECTOR_RUNTIME_TOKEN`, `OPENCONNECTOR_ADMIN_TOKEN`) — enables the OpenConnector panel, MCP registration, and the embedded native web UI at `/oc-web`. Unset = fully disabled. Under `npm start`, setting this to a localhost URL (e.g. `http://localhost:3001`) makes the launcher spawn the **bundled local OpenConnector** on that port; set a non-localhost URL to use a remote runtime.
- `AUTH_MODE` — `none` (default) or `forward_auth`. With `forward_auth`, every HTTP request and WS upgrade requires a proxy-injected `X-Forwarded-Email` header (identity from `X-Forwarded-Email`/`X-Forwarded-Groups`; Caddy `forward_auth` → oauth2-proxy → Logto upstream). **Trust boundary:** enabling it asserts the server is reachable ONLY through the auth proxy (bind localhost / firewall) — otherwise those headers are attacker-controlled. Adds `GET /api/auth/me` and gates `POST /api/catalog/refresh` on the `admin` group.
- `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` / `NANGO_SECRET_KEY` — agent & app catalog config (see catalog.js below). `NANGO_SECRET_KEY` backs the connect-session broker; it never reaches the browser.
- `DOCUMENTS_MODEL` — the model id used for documents RAG indexing + retrieval (default `deepseek-v4-pro`; must be a model registered on the configured provider). The Knowledge (Documents) panel ingests PDF/Markdown/plain-text/web-URL files and stores them in the SQLite project DB via `documents.js` (LlamaIndex + PageIndex). Requires `VOLCES_API_KEY`; without it the documents RAG indexing/query calls fail at call time.
- `PORT` / `HOST` — bind address (default `3000` / `localhost`).
- `PLATFORM_DATA_DIR` - root for all on-disk stores (SQLite, sessions, cron). Unset in dev (stores stay relative to CWD); the Electron supervisor sets this to `app.getPath('userData')` when packaged so state lands in a per-user, update-safe directory (the macOS bundle is read-only). See `paths.js`.
- In the **packaged Electron app**, end users cannot edit `.env`; the same knobs are read from `app.getPath('userData')/settings.json` (`electron/config/settings.js`), which the supervisor injects into the `server.js` child's env. Settings.json takes precedence over inherited env.

## Architecture

### electron/ - desktop supervisor (Electron main process)
The Electron main process (`electron/main.js`) runs NO app logic - it is a process supervisor (`electron/supervisor/`: descriptors, lifecycle, health, ports, process, logs, status) that starts, health-checks, restarts, and stops the backend as independent child processes, then opens a `BrowserWindow` at `http://localhost:<port>` only after `server.js` is healthy. When fully bundled (packaged for external download):

| Component | Runtime | Description | Where it lives |
|---|---|---|---|
| `server-js` | Node (bundled) | Platform backend | `resources/node/` already ships bundled Node |
| `pi-agent` | Node (bundled) | In-process via SDK (disabled for extraction) | disabled until phase 2 |
| **OpenConnector** | Node (bundled) | 1000+ SaaS actions connector | Built from pinned git SHA into `resources/openconnector/`, spawned on a free port |
| **LiteLLM** | Python (bundled) | LLM proxy/gateway | `python-build-standalone` + venv with pinned litellm in `resources/{python,litellm}/` (mac arm64 + win x64) |

`asar: false` because the standalone Node cannot read inside an asar archive. `npmRebuild: false` because native addons run under the bundled Node's ABI. Spec: `openspec/specs/desktop-supervisor/`. Build: `npm run start:electron` (dev), `npm run dist` -> `dist/Platform-<ver>-{arm64,x64}.dmg` (mac) or a Windows x64 `.exe`. The bundled-resource build (`scripts/build-openconnector.js`, `scripts/build-python-litellm.js`) is cross-platform Node and runs on both macOS and Windows; build the `.exe` on a Windows host so the Windows python-build-standalone + venv (`venv/Scripts/litellm.exe`) are produced. `supervisor/descriptors.js` resolves the platform-correct python/venv binary paths.

### server.js — the orchestrator
Single Express app + `ws` WebSocketServer. At startup it: (1) writes the dsh profile's LLM routes + MCP/skills patches (`dsh-profile.js`), (2) spawns a dsh child (`dsh-bridge.js`) via the `@deepseek-ai/dsh-sdk-client` `HarnessClient` and performs the `initialize` handshake, (3) subscribes to dsh notifications and re-broadcasts them to all WS clients via `broadcast()` through a `handleDshEvent` translation map. One dsh session serves all connected clients (it is **not** per-connection). REST routes under `/api/documents/*`, `/api/chat-history/*`, and `/api/openconnector/*` are mounted alongside static file serving of `web/dist/`. When OpenConnector is enabled, a token-injecting reverse proxy at `/oc-web` (plus root-level `/assets/*`, `/v1/*`, and a `/api/*` catch-all registered after the app's own `/api/*` routes) embeds the runtime's native management UI in a same-origin iframe.

WS message protocol (client→server): `prompt`, `list_models`, `set_model`, `list_skills`, `list_agents`, `set_agent`. (server→client): `user`, `agent_start`, `text`, `thinking`, `tool_start/update/end`, `skill_use`, `models`, `current_model`, `model_changed`, `agents`, `current_agent`, `agent_changed`, `catalog_changed`, `skills`, `documents_status`, `done`, `error`. See `openspec/specs/{model-selection,skill-invocation,tool-use-rendering}/spec.md` for the contractual behavior.

### MCP servers — dsh-mcp-client profile plugin (was mcp-bridge.js)
The pi path's hand-rolled `mcp-bridge.js` (connect each `mcp.json` server, wrap every MCP tool as a pi `ToolDefinition`) is **deleted** — dsh ships a first-party `@deepseek-ai/dsh-mcp-client` plugin that does this natively. `dsh-profile.js`'s `writeMcpPatch()` is the seam: it gathers MCP server configs from `mcp.json` + the OpenConnector `/mcp` endpoint + the SQLite MCP-config table (DB overrides on name collision; a DB-disabled row drops its entry), maps each to a `dsh-mcp-client` cordis loader entry, and writes a `--patch` overlay so the user's `cordis.patch.yml` stays untouched. Tool naming is `mcp__<serverName>__<rawName>` — identical to the old mcp-bridge.js convention, so the migration is invisible to anything that references tool names. `failOnStartupError:false` on every entry preserves **graceful degradation** (a failed server is logged and skipped, never aborts startup); the plugin's built-in reconnect (500ms→30s backoff) covers an OpenConnector runtime that boots in parallel with `server.js`. Runtime add/remove/enable/disable (the `/api/extensions/mcp*` REST routes) regenerate the patch + `dshBridge.restart({mcpPatchPath})` — dsh has no stock reload-profile RPC, and it persists sessions by id so the restart resumes the conversation from disk.

### documents.js — first-party documents RAG (Knowledge panel)
First-party document management module (LlamaIndex.TS framework + the `pageindex` indexing layer via `pageindex-bridge.js`, persisted to the SQLite project DB `db.js`). Ingests PDF, Markdown, plain text, and web-page/URL sources; indexing runs in a serialized queue with per-document failure isolation, and status transitions broadcast as `documents_status` WS events. Query (reasoning-based retrieval over the PageIndex trees) is delegated to `pageindex-bridge.js`. Backed by the configured provider (`VOLCES_API_KEY`; `DOCUMENTS_MODEL`, default `deepseek-v4-pro`). No separate deployment needed — this replaced the earlier WeKnora integration.

### chat-history.js — read-only chat persistence
Persists each chat session as `chat-history-store/<sessionId>.json` (atomic temp+rename). The server tracks one in-memory "current" session (single shared agent) and appends the user turn on `prompt` and the assistant's final text on `done`. `/api/chat-history/sessions` lists metadata (title derived from the first user message); `/api/chat-history/sessions/:id` returns full messages for read-only viewing. No resume into the live agent.

### open-connector.js — SaaS-actions proxy
Thin HTTP client for an **externally-run** OpenConnector runtime (a Composio alternative; https://github.com/oomol-lab/open-connector). This module does NOT embed the gateway — it only proxies the browser-facing `/api/openconnector/*` routes to the runtime's `/v1/*` (runtime token) and `/api/*` (admin token) endpoints, and builds the MCP server config that registers the runtime's `/mcp` endpoint with the agent (so the agent gets `list_apps`/`search_actions`/`get_action_guide`/`execute_action`). **Tokens stay server-side; the browser never sees them and cannot override them.** The `/api/openconnector/config` route is always mounted (so the UI can detect enabled/disabled); the rest mount only when enabled. `getRuntimeBase()` + `tokenForPath()` expose the base URL and per-path token selection so `server.js` can mount the `/oc-web` reverse proxy of the runtime's native web UI.

### catalog.js — agent & app catalog (dual-source)
Serves `GET /api/catalog` (the `/agents` page + chat agent switcher). Two sources — local `agents.json` (gitignored; `agents.example.json` is the template) and cloud `AGENTS_CONFIG_URL` — are merged by id with **cloud winning**; entries with unknown type / duplicate id / missing required fields are dropped with a warning; a failed cloud fetch keeps the last-good doc. Refreshed every `CATALOG_REFRESH_SECS` (default 60, `0` disables the timer) and via admin-gated `POST /api/catalog/refresh`; a content change broadcasts `catalog_changed` so clients refetch. `GET /api/catalog` is role-filtered (entry `roles[]` must intersect the user's groups when auth is on) and the serializer whitelists display fields only — `apiKey`/`apiKeyEnv` never reach the browser; the remote key is resolved server-side at call time from `apiKey` or `apiKeyEnv`. Chat-mode `agent-remote` entries stream via `streamRemoteChat()` in `server.js` (POST `<baseUrl>/chat/completions`, SSE → `text` events); when one is active, prompts fork away from the local dsh session. `kind: "nango-connect"` app entries use `POST /api/apps/:id/connect` (a server-side broker that mints a Nango connect session tagged `end_user_id` = the requesting user's email with `NANGO_SECRET_KEY` never reaching the browser; 400 when auth is off). **v1 ceilings:** remote turns are broadcast-only (not persisted to chat-history) and one at a time; WS identity is fixed at upgrade; one `NANGO_SECRET_KEY` per deployment; no catalog-editing UI (edit `agents.json` or the cloud doc).

### web/ - React SPA (sole frontend)
Vite + React 19 + TypeScript + Tailwind v4 + shadcn-style primitives + `react-router-dom`. The **sole frontend** - the legacy vanilla `public/` directory has been deleted. `server.js` serves `web/dist/` at `/` with a SPA fallback so the client router handles deep links. Vite `base` is `/`.

Routes: `/chat` (default), `/chat/:sessionId`, `/documents` (Knowledge panel), `/dashboard`, `/extensions`, `/agents` (Agents & Apps catalog page), `/openconnector`, `/litellm`. The sidebar uses `<NavLink>` for in-app navigation (no page reload, WebSocket stays connected). OpenConnector + LiteLLM are third-party projects with their own native UIs - the React pages are thin `<iframe>` wrappers around the `/oc-web` and `/litellm-web` same-origin proxies (tokens injected server-side, never reach the renderer). Documents, Dashboard, and Extensions are first-party React pages. WebSocket + REST contracts are unchanged - the React app talks to the same `ws://<host>/` and `/api/*` endpoints.

Dev: `npm run web:dev` (Vite on :5173, proxies `/api` + `/oc-web` + `/litellm-web` to :3000; backend must also run). Prod: `npm run web:build` -> `web/dist/`, served by `server.js` at `/`. See `web/README.md` for layout and dev workflow.

### skills/ — local skills
Markdown `SKILL.md` files (YAML frontmatter `name`/`description` + body). Loaded into the agent via `additionalSkillPaths: [path.resolve("skills")]`. Invoked from the chat as `/skill:<name> <args>`; `server.js` parses this, broadcasts a `skill_use` event, and **manually expands** the skill body (stripping frontmatter) before forwarding to `session.prompt()` — it does not rely on the SDK's slash-command expansion. `skills/example-skill/` is a template.

## Provider & model registration

Under dsh there are **no `extensionFactories` / `EXPOSED_PROVIDERS` / `authStorage`** — the pi SDK's in-process provider registration is gone. Instead, `dsh-profile.js` is the single source of truth: `writeLlmProfile()` reads the host's `LLM_API_KEY`/`LLM_BASE_URL` (Volces gateway) + `LITELLM_BASE_URL`/`LITELLM_API_KEY` (LiteLLM proxy) from env and writes an OpenAI-compatible (`openai-completions`) `llm-pi-ai:` providers section to `$DSH_HOME/settings.yaml`. The generator's declared model list IS the dsh model list (dsh has no stock `listModels` RPC) — `initDshAgent()` stores it in `dshModels` and `getAvailableModels()` sources the selector from it. The Volces route is deliberately scoped to 3 ids (`deepseek-v4-pro`, `deepseek-v4-flash`, `glm-5.2`) to keep the selector frozen; LiteLLM models are discovered from the proxy's `/v1/models` (short timeout, warn + skip on unreachable). No LLM keys → empty providers (dormant), chat non-functional while static + REST still serve (graceful degrade, Task 3.6).

Model switching: dsh bakes the model into the `initialize` handshake and exposes no stock `setModel`/reload RPC, so a live model switch = `dshBridge.restart({ provider, model })` (fresh child; dsh persists sessions by id so the conversation resumes from disk). Switching is rejected while the agent is streaming (`isStreaming`), same as before.

**MCP tools invariant (changed):** dsh **auto-allows** every tool declared by the profile's plugins, so `server.js` passes NO `tools` allowlist to the session shim (the pi path needed `[...mcpToolNames]` or the SDK filtered tools out — that gotcha is gone). Tool naming stays `mcp__<server>__<tool>` so nothing that references tool names breaks.

## OpenSpec workflow

This repo is spec-driven via OpenSpec. Capabilities are specified in `openspec/specs/<capability>/spec.md` (Requirements + Scenarios). Work happens as **changes** in `openspec/changes/<name>/` containing `proposal.md`, `design.md`, `tasks.md`, and `specs/<capability>/spec.md` (delta specs). Completed changes are archived to `openspec/changes/archive/YYYY-MM-DD-<name>/`.

The `/opsx:*` slash commands (`.claude/commands/opsx/`) and `.claude/skills/openspec-*` skills wrap the `openspec` CLI:

- `/opsx:explore` — think/investigate; read-only, never implement.
- `/opsx:propose <name-or-desc>` — scaffold a change + generate proposal/design/tasks/specs artifacts.
- `/opsx:apply [name]` — implement tasks from a change, ticking `- [ ]` → `- [x]` in `tasks.md`.
- `/opsx:sync [name]` — merge a change's delta specs into the main `openspec/specs/` specs.
- `/opsx:archive [name]` — move a completed change to `archive/` (syncs specs first if asked).

Useful CLI calls: `openspec list`, `openspec status --change "<name>" --json`, `openspec instructions <artifact-id> --change "<name>" --json`. The JSON output gives resolved paths (`planningHome`, `changeRoot`, `artifactPaths`) — use those rather than assuming repo-relative paths.

The `.pi/` directory mirrors `.claude/` (`prompts/`, `skills/`) for the pi-agent's own use; it is not part of the application runtime.

## Conventions worth preserving

- **Graceful degradation**: every external dependency (LiteLLM, OpenConnector, each MCP server) is optional. A missing/unreachable dependency logs a warning and the server continues. Preserve this when adding integrations.
- **Tokens never reach the browser**: server-held credentials stay server-side; proxy routes forward only documented request fields, never arbitrary client body keys or headers.
- **Atomic persistence**: `documents.js` writes its manifest via temp-file + rename. Follow the same pattern for any crash-sensitive registry.
- **Event-driven UI**: new agent capabilities should flow through `broadcast()` as typed WS events and render as collapsible blocks in `public/app.js`, matching the existing `tool_*` / `skill_use` / `documents_status` pattern.
