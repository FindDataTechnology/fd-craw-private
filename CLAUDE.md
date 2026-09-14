# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`Platform` — a browser-based chat interface built on the **DeepSeek Harness (dsh)** runtime. The project's stated long-term goal is an "openclaw-like" assistant targeting a special industry, but the code today is a general-purpose coding-assistant web app: an Express + WebSocket server that spawns a dsh runtime as a stdio JSON-RPC child process, translates dsh events onto the existing WebSocket contract for React frontend clients, and adds one optional capability — a first-party documents RAG (LlamaIndex + PageIndex + SQLite, Volces-backed). The earlier `@earendil-works/pi-coding-agent` SDK has been removed (see the `migrate-pi-to-dsh` OpenSpec change); dsh is now the sole agent runtime.

**The project deploys exactly one server process: `server.js`.** dsh ships first-party plugins that cover both LLM routing (`dsh-llm`, driven by `$DSH_HOME/settings.yaml`) and MCP/SaaS connectors (`@deepseek-ai/dsh-mcp-client`), so there is no LLM proxy and no connector gateway to bundle, build, or supervise. A customer who wants such a service installs and runs it themselves and points the app at its URL — either as an MCP server in `mcp.json`, or as an `external-service` entry in the agent/app catalog.

This is a **greenfield, ESM** Node project (`"type": "module"`). The backend remains buildless plain JavaScript — no transpiler, no bundler, no test runner, no linter configured. The **frontend is React** under `web/` (Vite + TypeScript + Tailwind v4 + shadcn/ui — see `web/README.md`). Routes: `/chat` (default), `/chat/:sessionId`, `/knowledge` (Documents), `/dashboard`, `/mcp` + `/skills` (Extensions), `/models`, `/trace`, `/agents` (Agents & Apps catalog), `/bots`, `/external/:appId` (catalog-declared embedded apps).

## Commands

```bash
npm install        # installs backend + runs postinstall that installs & builds web/
npm start          # headless launcher (scripts/start.js) - supervises server.js;
                   #   serves http://localhost:3000 (PORT/HOST env overridable).
npm run web:dev    # Vite dev server on :5173 with HMR (backend must ALSO run on :3000)
npm run web:build  # rebuild web/dist without touching backend deps
```

Set `PLATFORM_SKIP_WEB_BUILD=1` to skip the postinstall frontend build (CI, or when iterating with `web:dev`).

**Local services (`npm start`):** the launcher reuses the desktop supervisor's shared primitives (`supervisor/`) — health checks, restart-on-crash, ordered shutdown, log capture — but there is exactly one process to supervise: `server.js`, pinned to `PORT` (default 3000) so the Vite dev proxy and the WS client keep working. `supervisor/descriptors.js` returns that single descriptor; there are no sidecars. Build the packaging resources with `npm run predist` (runs `scripts/build-node.js`, which downloads the standalone Node matching `process.version` into `resources/node/` — required so the supervisor can spawn `server.js` on a Node whose ABI matches the prebuilt native addons — then `scripts/verify-bundle.js`, which asserts that Node is present and warns when macOS signing credentials are absent). `resources/` contains only `node/`; nothing else is bundled. `platform.bundle.json` (resolved through `resolveBundle()` in `bundle-manifest.js`, the single source of truth) declares only what ships *inside* the app — `mcpServers`, `skills`, `permissions` — not which services to build.

To run the web server with a different port: `PORT=8080 npm start`. To run the desktop app: `npm run start:electron` (the supervisor assigns server.js a dynamic free port and loads `http://localhost:<port>` in the window). `npm run dist` produces `dist/Platform-<version>-arm64.dmg` (mac) / `Platform Setup <version>.exe` (win).

**CI release (`.github/workflows/release.yml`):** builds three installers on a 3-entry matrix - `macos-latest` arm64, `macos-latest` x64 (via Rosetta on the arm64 host - `setup-node architecture: x64` so native addons compile for the x64 ABI), and `windows-latest` x64; the `.exe` is built on a Windows host (no cross-compile). Push a `v*` tag to cut a GitHub Release with the `.dmg` (arm64 + x64) + `.exe` attached; `workflow_dispatch` builds on demand and uploads artifacts without releasing. `resources/` is cached per OS + arch, keyed on `package.json` + the build scripts, with no cross-arch restore fallback (an arm64 cache restored into the x64 job would ship arm64 binaries in an x64 dmg). The electron-builder config is `electron-builder.js` (JS, not a yml). Code signing + notarization are gated on Actions secrets - `CSC_LINK`/`CSC_KEY_PASSWORD` (mac signing), `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` (mac notarize via built-in `mac.notarize`), `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (win); when absent the build still succeeds unsigned (Gatekeeper/SmartScreen warnings only). `scripts/build-node.js` reads `process.version`, so the bundled standalone Node's ABI always matches the Node that ran `npm ci` (required because `npmRebuild: false`).

The `openspec` CLI (v1.4.1, `@fission-ai/openspec`, installed globally) drives spec-driven development — see **OpenSpec workflow** below.

## Starting the app ("open web")

When the user says **"open web"** (or "open the app" / "start the app" / equivalent), start the app with `npm start` — **not** `node server.js`. `npm start` (`scripts/start.js`) runs `server.js` under the supervisor, which loads `.env` with override, injects the resolved config into the child's env, health-checks `/api/config`, restarts it on crash, and captures its logs. `node server.js` skips all of that and reads whatever the ambient shell env happens to hold, so prefer the launcher. Every panel — Chat, Dashboard, Knowledge (Documents), Extensions, Models, Agents — is first-party and served by that one process; the Knowledge panel needs only `VOLCES_API_KEY` set (see Configuration below).

Steps:
1. Stop anything already holding :3000 (e.g. a leftover `node server.js`) first.
2. `npm start` in the background.
3. Wait for the `Platform running at http://localhost:3000` line.
4. `open http://localhost:3000`.

## Configuration (all optional, all env-driven)

Everything sensitive or environment-specific lives in **`.env`** (gitignored) and **`mcp.json`** (gitignored). `mcp.example.json` is the template. The server degrades gracefully when optional config is missing — it always starts.

- `VOLCES_API_KEY` / `VOLCES_BASE_URL` — the hardcoded default provider (火山引擎/Volces Coding). A fallback API key is baked into `server.js`; override via env.
- `AUTH_MODE` — `none` (default) or `forward_auth`. With `forward_auth`, every HTTP request and WS upgrade requires a proxy-injected `X-Forwarded-Email` header (identity from `X-Forwarded-Email`/`X-Forwarded-Groups`; Caddy `forward_auth` → oauth2-proxy → Logto upstream). **Trust boundary:** enabling it asserts the server is reachable ONLY through the auth proxy (bind localhost / firewall) — otherwise those headers are attacker-controlled. Adds `GET /api/auth/me` and gates `POST /api/catalog/refresh` on the `admin` group.
- `SSO_ENABLED` — `true` adds an optional sign-in entry when `AUTH_MODE=none` (ignored under `forward_auth`). Identity is read from the same proxy headers but stored on `req.ssoUser` / `ws.identity` — **never** on `req.user`, so route authorization, catalog role filtering and admin gating are unchanged and anonymous access keeps working. Signed-in users get a per-email preference (migration v12: `user_model_bindings`, `user_mcp_bindings`) recording their model and an MCP availability overlay over globally-administered servers; it is applied only while the shared runtime is idle (streaming defers it to pending, drained on `finishTurn`). **Not multi-tenant isolation** — chat, sessions, documents and the single dsh runtime stay shared; signing out never resets the runtime. Deployment requirement: the proxy must pass anonymous requests through (a hard `forward_auth` redirects before the UI renders) and the app must remain unreachable except through that proxy, else the email header is attacker-controlled. See `server/runtime-bindings.js` + `server/routes/user-bindings.js`.
- `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` / `NANGO_SECRET_KEY` — agent & app catalog config (see catalog.js below). `NANGO_SECRET_KEY` backs the connect-session broker; it never reaches the browser.
- `DOCUMENTS_MODEL` — the model id used for documents RAG indexing + retrieval (default `deepseek-v4-pro`; must be a model registered on the configured provider). The Knowledge (Documents) panel ingests PDF/Markdown/plain-text/web-URL files and stores them in the SQLite project DB via `documents.js` (LlamaIndex + PageIndex). Requires `VOLCES_API_KEY`; without it the documents RAG indexing/query calls fail at call time.
- `PORT` / `HOST` — bind address (default `3000` / `localhost`).
- `PLATFORM_DATA_DIR` - root for all on-disk stores (SQLite, sessions, cron, `uploads/`). Unset in dev (stores stay relative to CWD); the Electron supervisor sets this to `app.getPath('userData')` when packaged so state lands in a per-user, update-safe directory (the macOS bundle is read-only). See `paths.js`.
- **Optional external file-preview service** — the preview drawer renders images/PDF/text/CSV/markdown/HTML/`.docx` in the browser; every other type falls back to download. To add long-tail formats (legacy Office, media, archives), declare a catalog `external-service` app tagged `file-preview` (e.g. KKFileView at `?url=<file-url>`); the drawer then embeds it through the existing `/external/:appId` proxy. Three operator facts: the service **fetches the file itself** by URL, so it must be able to reach the app's `/api/files` route (in dev with the service in Docker, use the host address — `host.docker.internal` or the LAN IP — not the container's `localhost`); under `AUTH_MODE=forward_auth` that server-side fetch carries no identity header, so the route must be reachable without it (exclude `/api/files` at the proxy or run the service with the app's headers); and this tier applies **only to the server deployment** — the desktop build ships one supervised process with no sidecars, so it is simply absent there and previews degrade to download. Configured or not, an unrenderable type never surfaces an error.
- In the **packaged Electron app**, end users cannot edit `.env`; the same knobs are read from `app.getPath('userData')/settings.json` (`electron/config/settings.js`), which the supervisor injects into the `server.js` child's env. Settings.json takes precedence over inherited env.

## Architecture

### electron/ - desktop supervisor (Electron main process)
The Electron main process (`electron/main.js`) runs NO app logic - it is a process supervisor (`electron/supervisor/`: descriptors, lifecycle, health, ports, process, logs, status) that starts, health-checks, restarts, and stops the backend as an independent child process, then opens a `BrowserWindow` at `http://localhost:<port>` only after `server.js` is healthy. The supervisor abstraction is deliberately kept even though it manages a single process — health probing, restart-on-crash, ordered shutdown and log capture are all still load-bearing.

| Component | Runtime | Description | Where it lives |
|---|---|---|---|
| `server-js` | Node (bundled) | Platform backend — the only supervised process | `resources/node/` ships the standalone Node it runs on |

`asar: false` because the standalone Node cannot read inside an asar archive. `npmRebuild: false` because native addons run under the bundled Node's ABI. Spec: `openspec/specs/desktop-supervisor/`. Build: `npm run start:electron` (dev), `npm run dist` -> `dist/Platform-<ver>-{arm64,x64}.dmg` (mac) or a Windows x64 `.exe`. `scripts/build-node.js` is cross-platform Node and runs on both macOS and Windows; build the `.exe` on a Windows host. `supervisor/descriptors.js` resolves the platform-correct binary paths.

### server.js — the orchestrator
Single Express app + `ws` WebSocketServer. At startup it: (1) writes the dsh profile's LLM routes + MCP/skills patches (`dsh-profile.js`), (2) spawns a dsh child (`dsh-bridge.js`) via the `@deepseek-ai/dsh-sdk-client` `HarnessClient` and performs the `initialize` handshake, (3) subscribes to dsh notifications and re-broadcasts them to all WS clients via `broadcast()` through a `handleDshEvent` translation map. One dsh session serves all connected clients (it is **not** per-connection). REST routes under `/api/documents/*` and `/api/chat-history/*` are mounted alongside static file serving of `web/dist/`; `GET /api/config` reports `{ documentsEnabled }` and doubles as the supervisor's health probe. `registerExternalServiceRoutes(ctx)` mounts the catalog-driven `/external/:appId` reverse proxies **after** the app's own `/api/*` routes so those win on conflict.

WS message protocol (client→server): `prompt`, `list_models`, `set_model`, `list_skills`, `list_agents`, `set_agent`. (server→client): `user`, `agent_start`, `text`, `thinking`, `tool_start/update/end`, `skill_use`, `models`, `current_model`, `model_changed`, `agents`, `current_agent`, `agent_changed`, `catalog_changed`, `skills`, `documents_status`, `done`, `error`. See `openspec/specs/{model-selection,skill-invocation,tool-use-rendering}/spec.md` for the contractual behavior.

### MCP servers — dsh-mcp-client profile plugin (was mcp-bridge.js)
The pi path's hand-rolled `mcp-bridge.js` (connect each `mcp.json` server, wrap every MCP tool as a pi `ToolDefinition`) is **deleted** — dsh ships a first-party `@deepseek-ai/dsh-mcp-client` plugin that does this natively. This plugin is also why the project no longer bundles a SaaS-actions gateway: any connector the user wants is just another MCP server entry. `dsh-profile.js`'s `writeMcpPatch()` is the seam: it gathers MCP server configs from `mcp.json` + the SQLite MCP-config table (DB overrides on name collision; a DB-disabled row drops its entry), maps each to a `dsh-mcp-client` cordis loader entry, and writes a `--patch` overlay so the user's `cordis.patch.yml` stays untouched. Tool naming is `mcp__<serverName>__<rawName>` — identical to the old mcp-bridge.js convention, so the migration is invisible to anything that references tool names. `failOnStartupError:false` on every entry preserves **graceful degradation** (a failed server is logged and skipped, never aborts startup); the plugin's built-in reconnect (500ms→30s backoff) covers a remote server that is slow to come up. Runtime add/remove/enable/disable (the `/api/extensions/mcp*` REST routes) regenerate the patch + `dshBridge.restart({mcpPatchPath})` — dsh has no stock reload-profile RPC, and it persists sessions by id so the restart resumes the conversation from disk.

### documents.js — first-party documents RAG (Knowledge panel)
First-party document management module (LlamaIndex.TS framework + the `pageindex` indexing layer via `pageindex-bridge.js`, persisted to the SQLite project DB `db.js`). Ingests PDF, Markdown, plain text, and web-page/URL sources; indexing runs in a serialized queue with per-document failure isolation, and status transitions broadcast as `documents_status` WS events. Query (reasoning-based retrieval over the PageIndex trees) is delegated to `pageindex-bridge.js`. Backed by the configured provider (`VOLCES_API_KEY`; `DOCUMENTS_MODEL`, default `deepseek-v4-pro`). No separate deployment needed — this replaced the earlier WeKnora integration.

### chat-history.js — read-only chat persistence
Persists each chat session as `chat-history-store/<sessionId>.json` (atomic temp+rename). The server tracks one in-memory "current" session (single shared agent) and appends the user turn on `prompt` and the assistant's final text on `done`. `/api/chat-history/sessions` lists metadata (title derived from the first user message); `/api/chat-history/sessions/:id` returns full messages for read-only viewing. No resume into the live agent.

### server/routes/external-services.js — embedded external apps
Registers a token-injecting reverse proxy at `/external/:appId` for every `external-service` entry in the catalog (`agents.json` / the cloud doc). This is how a self-hosted third-party web UI — the user's own LLM proxy dashboard, connector gateway, admin console, whatever — gets embedded same-origin in an iframe without the browser ever learning the upstream URL or its credentials. The proxy forwards method/body/query to the entry's `url`, injects `Authorization: Bearer <token>` resolved server-side from `apiKeyEnv` (preferred) or a literal `apiKey`, **strips any client-supplied Authorization override**, injects `<base href="/external/<id>/">` into HTML so relative assets resolve under the prefix, rewrites `Location` redirects to stay under the prefix, and drops `content-encoding`/`content-length` (Node's fetch already decompressed the body). Routes are registered **after** the app's own `/api/*` routes; an unknown `:appId` 404s, since `catalog.getExternalServices()` is the only source of truth. `catalog.js` never serializes `apiKey`/`apiKeyEnv` to the client, so the credential lookup happens server-side only.

### server/routes/files.js — read-only file serving for the preview drawer
`GET /api/files?root=<workspace|uploads>&path=<relative>` is the first route that returns arbitrary file bytes to the browser, so its safety properties are the feature. It resolves the path against an allowlist of two roots — the agent workspace (`dshBridge.getCwd()`) and `uploads/` (under `PLATFORM_DATA_DIR`) — then checks containment **twice**: lexically (so `..` is a `403` even when the escaped path does not exist) and on the `fs.realpath` result (so an in-root symlink pointing out is a `403`). Absolute paths, an unknown root, and NUL bytes are refused; a missing file is `404`; nothing is ever written. Content the browser would execute in this origin is never served inline: only a safe-type allowlist (raster images, SVG with a `Content-Security-Policy: sandbox` header, PDF, plain text) gets `inline` + a conservative type; everything else gets `attachment` + `application/octet-stream` — which also forces an uploaded `.html` to download rather than execute against the app origin. `saveUploadFile()` is the write path into `uploads/` (no HTTP surface yet; composer attachments still index for RAG, a non-goal here). The matching client is `web/src/components/preview/PreviewDrawer.tsx` (lazy chunk, opened from a `ToolBlock` path, an assistant link, or the header's local-file picker). Anything that renders authored markup — HTML, `docx` (mammoth) output, the external preview service — goes in a sandboxed iframe **without** `allow-same-origin`, so previewed content cannot reach the app's origin, storage, or socket.

### catalog.js — agent & app catalog (dual-source)
Serves `GET /api/catalog` (the `/agents` page + chat agent switcher). Two sources — local `agents.json` (gitignored; `agents.example.json` is the template) and cloud `AGENTS_CONFIG_URL` — are merged by id with **cloud winning**; entries with unknown type / duplicate id / missing required fields are dropped with a warning; a failed cloud fetch keeps the last-good doc. Refreshed every `CATALOG_REFRESH_SECS` (default 60, `0` disables the timer) and via admin-gated `POST /api/catalog/refresh`; a content change broadcasts `catalog_changed` so clients refetch. `GET /api/catalog` is role-filtered (entry `roles[]` must intersect the user's groups when auth is on) and the serializer whitelists display fields only — `apiKey`/`apiKeyEnv` never reach the browser; the remote key is resolved server-side at call time from `apiKey` or `apiKeyEnv`. Chat-mode `agent-remote` entries stream via `streamRemoteChat()` in `server.js` (POST `<baseUrl>/chat/completions`, SSE → `text` events); when one is active, prompts fork away from the local dsh session. `kind: "nango-connect"` app entries use `POST /api/apps/:id/connect` (a server-side broker that mints a Nango connect session tagged `end_user_id` = the requesting user's email with `NANGO_SECRET_KEY` never reaching the browser; 400 when auth is off). **v1 ceilings:** remote turns are broadcast-only (not persisted to chat-history) and one at a time; WS identity is fixed at upgrade; one `NANGO_SECRET_KEY` per deployment; no catalog-editing UI (edit `agents.json` or the cloud doc).

### web/ - React SPA (sole frontend)
Vite + React 19 + TypeScript + Tailwind v4 + shadcn-style primitives + `react-router-dom`. The **sole frontend** - the legacy vanilla `public/` directory has been deleted. `server.js` serves `web/dist/` at `/` with a SPA fallback so the client router handles deep links. Vite `base` is `/`.

Routes: `/chat` (default), `/chat/:sessionId`, `/knowledge` (Documents), `/dashboard`, `/mcp` + `/skills` (Extensions), `/models`, `/trace` + `/trace/:turnId`, `/agents` (Agents & Apps catalog page), `/bots`, `/external/:appId`. Legacy paths (`/documents`, `/extensions`, `/extensions/mcp`, `/extensions/skills`) redirect to their current homes. The sidebar uses `<NavLink>` for in-app navigation (no page reload, WebSocket stays connected). Every page is first-party React except `/external/:appId`, which is a thin `<iframe>` wrapper around the same-origin `/external/<id>` proxy for a catalog-declared external app (tokens injected server-side, never reach the renderer). WebSocket + REST contracts are unchanged - the React app talks to the same `ws://<host>/` and `/api/*` endpoints.

Dev: `npm run web:dev` (Vite on :5173, proxies `/api` + `/external` to :3000; backend must also run). Prod: `npm run web:build` -> `web/dist/`, served by `server.js` at `/`. See `web/README.md` for layout and dev workflow.

### skills/ — local skills
Markdown `SKILL.md` files (YAML frontmatter `name`/`description` + body). Loaded into the agent via `additionalSkillPaths: [path.resolve("skills")]`. Invoked from the chat as `/skill:<name> <args>`; `server.js` parses this, broadcasts a `skill_use` event, and **manually expands** the skill body (stripping frontmatter) before forwarding to `session.prompt()` — it does not rely on the SDK's slash-command expansion. `skills/example-skill/` is a template.

## Provider & model registration

Under dsh there are **no `extensionFactories` / `EXPOSED_PROVIDERS` / `authStorage`** — the pi SDK's in-process provider registration is gone, and so is any notion of an LLM proxy sitting in front of the gateway. Instead, `dsh-profile.js` is the single source of truth: `writeLlmProfile()` reads the host's `LLM_API_KEY`/`LLM_BASE_URL` (the Volces gateway) from env and writes an OpenAI-compatible (`openai-completions`) `llm-pi-ai:` providers section to `$DSH_HOME/settings.yaml`, which the dsh-llm plugin live-reloads (alongside `.credentials.yaml`). The generator's declared model list IS the dsh model list (dsh has no stock `listModels` RPC) — `initDshAgent()` stores it in `dshModels` and `getAvailableModels()` sources the selector from it, so the selector is frozen to exactly what `dsh-profile.js` declares. No LLM keys → empty providers (dormant), chat non-functional while static + REST still serve (graceful degrade, Task 3.6).

Model switching: dsh bakes the model into the `initialize` handshake and exposes no stock `setModel`/reload RPC, so a live model switch = `dshBridge.restart({ provider, model })` (fresh child; dsh persists sessions by id so the conversation resumes from disk). Switching is rejected while the agent is streaming (`isStreaming`), same as before.

### Agent presets (agent modes) — dsh-agent-presets roster + preset bridge

dsh composes each session's agent capabilities from an **agent preset** (four shipped modes: `standard`/`code`/`minimal`/`cordis` under the installed `@deepseek-ai/dsh` package's `config/agent-presets/`, plus user-authored dirs under `~/.dsh/.agent-presets`). The platform profile composes the roster via a third generated `--patch` overlay: `dsh-profile.js`'s `writePresetsPatch()` copies `dsh-profile-template/platform-preset-bridge.js` into the profile dir (the loader resolves a relative plugin name beside the profile's `cordis.yml`) and writes `$DSH_HOME/profiles/<name>/presets.patch.yml`, which (1) **disables** the stock `sdk-jsonrpc-server` row (a non-insert patch cannot change a row's plugin `name` — it's a mismatch guard, not an override — and re-inserting the same id fails the boot with `duplicate loader entry id`), and (2) inserts the `agent-presets` roster row (default `standard`, shipped root at `trust: system`) plus the bridge under a fresh `platform-sdk-server` row. The bridge subclasses `HarnessSdkJsonRpcServer`: `initialize` accepts `agentPreset`, session creation mounts the preset pre-publication via the agent factory's `setup(agentCtx)` hook (a broken/unknown preset fails session creation instead of publishing a half-composed agent), and a `presets/list` RPC serves the roster to the web. `dsh-sdk-protocol` is a PRIVATE dep of `dsh-sdk-jsonrpc-server`, so the bridge resolves the transport through that package's real location via `createRequire(import.meta.resolve(...))`. The shipped preset root is resolved from a repo-local dsh install or the flat module fallback (`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh`); unresolvable → the whole overlay is skipped with a warning (picker stays empty, chat unaffected).

Preset switching rides the restart path exactly like model/workspace switches (`dshBridge.restart({ agentPreset })` → fresh child `initialize({ agentPreset })`) and applies to the NEXT (blank) session only — dsh refuses to recompose a session that has produced turns. So the picker lives on the chat welcome state only and an active session shows a read-only header label. The choice persists as the `agent.preset` preference; each session row stamps `agent_preset` at creation (db migration v9) so a resumed session's label resolves. WS: `list_presets`/`set_preset` client→server, `presets` + `current_preset` server→client; the streaming guard matches `set_model`, and a rejected switch leaves the previous preset reported as current.

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

## Rendering charts in chat

When the user asks for a chart, plot, or graph, answer with a fenced code block tagged `echarts` whose body is an ECharts option object as JSON — nothing else in the fence:

````
```echarts
{ "xAxis": { "type": "category", "data": ["a","b"] },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "data": [1, 2] }] }
```
````

The chat renders that block as a live chart (`web/src/components/EChart.tsx`, dispatched from `CodeRenderer` in `web/src/components/Markdown.tsx`). Bar, line, pie and scatter are registered; use one of those series types. The body must be a single JSON object — a fence that isn't valid JSON renders as an ordinary code block instead, so a half-streamed fence upgrades to a chart once it completes. Tooltip `formatter`/`extraCssText` are stripped before rendering (they are an HTML sink), so don't rely on them.

## Conventions worth preserving

- **Graceful degradation**: every external dependency (each MCP server, each catalog `external-service`, the cloud catalog fetch) is optional. A missing/unreachable dependency logs a warning and the server continues. Preserve this when adding integrations.
- **Tokens never reach the browser**: server-held credentials stay server-side; proxy routes forward only documented request fields, never arbitrary client body keys or headers.
- **Atomic persistence**: `documents.js` writes its manifest via temp-file + rename. Follow the same pattern for any crash-sensitive registry.
- **Event-driven UI**: new agent capabilities should flow through `broadcast()` as typed WS events and render as collapsible blocks in `public/app.js`, matching the existing `tool_*` / `skill_use` / `documents_status` pattern.
