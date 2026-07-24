# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`Platform` — a browser-based chat interface around the `@earendil-works/pi-coding-agent` SDK. The project's stated long-term goal is an "openclaw-like" assistant targeting a special industry, but the code today is a general-purpose coding-assistant web app: an Express + WebSocket server that hosts a single pi agent session, streams its events to vanilla-JS frontend clients, and adds two optional capabilities — a LlamaIndex-backed document collection (RAG) and an OpenConnector proxy (1000+ SaaS actions via MCP).

This is a **greenfield, ESM** Node project (`"type": "module"`). The backend remains buildless plain JavaScript — no transpiler, no bundler, no test runner, no linter configured. The **frontend chat surface is being ported to React** under `web/` (Vite + TypeScript + Tailwind v4 + shadcn/ui — see `web/README.md` and `openspec/changes/redesign-chat-ui-react-shadcn/`); other frontend views (Documents, OpenConnector, Dashboard, LiteLLM) remain vanilla JS under `public/` until their own migration changes.

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

**Local services (`npm start`):** the launcher reuses the desktop supervisor's shared primitives (`supervisor/`) to bring up the bundled LiteLLM (Python venv) and OpenConnector (Node/tsx) as localhost child processes on the ports parsed from their .env URLs (LiteLLM 4000, OpenConnector 3001 by default), injecting `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` into `server.js`'s env. Build the resources first with `npm run predist` (runs `scripts/build-openconnector.js`, then `scripts/build-node.js` which downloads the standalone Node matching `process.version` into `resources/node/` - required for the supervisor to spawn child servers, and so the bundled Node ABI matches the prebuilt native addons - then `scripts/build-python-litellm.js`, then `scripts/verify-bundle.js`); the OC build generates `resources/openconnector/src/providers/registry.generated.ts` (the action catalog) which must be present at runtime. Set `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` to localhost URLs in `.env` (e.g. `http://localhost:4000`, `http://localhost:3001`) to run the project's internal services on those ports; set a non-localhost URL to use a remote server instead. Generated credentials + seeded `litellm.yaml` persist to `dev-settings.json` / `litellm.yaml` under `PLATFORM_DATA_DIR` (CWD-relative when unset), gitignored. When resources are absent or external URLs are set, the launcher degrades to running `server.js` alone.

To run the web server with a different port: `PORT=8080 npm start`. To run the desktop app: `npm run start:electron` (the supervisor assigns server.js a dynamic free port and loads `http://localhost:<port>` in the window). `npm run dist` produces `dist/Platform-<version>-arm64.dmg` (mac) / `Platform Setup <version>.exe` (win).

**CI release (`.github/workflows/release.yml`):** builds both installers on a two-runner matrix - `macos-latest` (arm64) and `windows-latest` (x64); the bundled LiteLLM venv is host-interpreter-specific so the `.exe` must be built on Windows (no cross-compile). Push a `v*` tag to cut a GitHub Release with the `.dmg` + `.exe` attached; `workflow_dispatch` builds on demand and uploads artifacts without releasing. Code signing + notarization are gated on Actions secrets - `CSC_LINK`/`CSC_KEY_PASSWORD` (mac signing), `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` (mac notarize via built-in `mac.notarize`), `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (win); when absent the build still succeeds unsigned (Gatekeeper/SmartScreen warnings only). `scripts/build-node.js` reads `process.version`, so the bundled standalone Node's ABI always matches the Node that ran `npm ci` (required because `npmRebuild: false`).

The `openspec` CLI (v1.4.1, `@fission-ai/openspec`, installed globally) drives spec-driven development — see **OpenSpec workflow** below.

## Configuration (all optional, all env-driven)

Everything sensitive or environment-specific lives in **`.env`** (gitignored) and **`mcp.json`** (gitignored). `mcp.example.json` is the template. The server degrades gracefully when optional config is missing — it always starts.

- `VOLCES_API_KEY` / `VOLCES_BASE_URL` — the hardcoded default provider (火山引擎/Volces Coding). A fallback API key is baked into `server.js`; override via env.
- `LITELLM_BASE_URL` / `LITELLM_API_KEY` — registers the `pi-provider-litellm` extension as an extra provider. If either is unset, litellm is skipped (server starts Volces-only). Under `npm start`, setting this to a localhost URL (e.g. `http://localhost:4000`) makes the launcher spawn the **bundled local LiteLLM** on that port (see Local services above); set a non-localhost URL to use a remote proxy.
- `OPENCONNECTOR_BASE_URL` (+ `OPENCONNECTOR_RUNTIME_TOKEN`, `OPENCONNECTOR_ADMIN_TOKEN`) — enables the OpenConnector panel, MCP registration, and the embedded native web UI at `/oc-web`. Unset = fully disabled. Under `npm start`, setting this to a localhost URL (e.g. `http://localhost:3001`) makes the launcher spawn the **bundled local OpenConnector** on that port; set a non-localhost URL to use a remote runtime.
- `DOCUMENTS_MODEL` — model id used for document indexing/retrieval (default `deepseek-v4-pro`); must be a model registered on the Volces provider.
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

`asar: false` because the standalone Node cannot read inside an asar archive. `npmRebuild: false` because native addons run under the bundled Node's ABI. Spec: `openspec/specs/desktop-supervisor/`. Build: `npm run start:electron` (dev), `npm run dist` -> `dist/Platform-<ver>-arm64.dmg` (mac arm64) or a Windows x64 `.exe`. The bundled-resource build (`scripts/build-openconnector.js`, `scripts/build-python-litellm.js`) is cross-platform Node and runs on both macOS and Windows; build the `.exe` on a Windows host so the Windows python-build-standalone + venv (`venv/Scripts/litellm.exe`) are produced. `supervisor/descriptors.js` resolves the platform-correct python/venv binary paths.

### server.js — the orchestrator
Single Express app + `ws` WebSocketServer. At startup it: (1) connects MCP servers, (2) registers providers + skills on a pi `DefaultResourceLoader`, (3) creates one module-scoped agent `session`, (4) subscribes to agent events and re-broadcasts them to all WS clients via `broadcast()`. One agent session serves all connected clients (it is **not** per-connection). REST routes under `/api/documents/*`, `/api/chat-history/*`, and `/api/openconnector/*` are mounted alongside static file serving of `public/`. When OpenConnector is enabled, a token-injecting reverse proxy at `/oc-web` (plus root-level `/assets/*`, `/v1/*`, and a `/api/*` catch-all registered after the app's own `/api/*` routes) embeds the runtime's native management UI in a same-origin iframe.

WS message protocol (client→server): `prompt`, `list_models`, `set_model`, `list_skills`. (server→client): `user`, `agent_start`, `text`, `thinking`, `tool_start/update/end`, `skill_use`, `models`, `current_model`, `model_changed`, `skills`, `documents_status`, `done`, `error`. See `openspec/specs/{model-selection,skill-invocation,tool-use-rendering}/spec.md` for the contractual behavior.

### mcp-bridge.js — MCP → pi tool bridge
The pi SDK has **no native MCP support**, so this module connects to each server in `mcp.json` (stdio via `command`/`args`, or http/sse via `url`/`headers`), calls `listTools()`, and wraps each MCP tool as a pi `ToolDefinition` whose `execute()` proxies to `callTool()`. Tool names are namespaced `mcp__<server>__<tool>`. For http servers it tries Streamable HTTP first, then falls back to legacy SSE. `connectServers()` is the reusable primitive; `connectMcpServers()` reads `mcp.json` and delegates. **Failed servers are logged and skipped — they never abort agent startup.**

### documents.js — LlamaIndex document RAG
Ingests PDF / Markdown / text / URL, indexes each with LlamaIndex.TS (`SummaryIndex`) configured against the server's OpenAI-compatible Volces provider, and persists each index under `documents-store/<id>/` plus an atomic `manifest.json`. Indexing runs in a **serialized queue** (one doc at a time) with per-doc failure isolation; status transitions (`queued`/`indexing`/`ready`/`error`) are broadcast as `documents_status` WS events. Retrieval (`queryCollection`) queries each ready doc's `SummaryIndex` and synthesizes a single answer (via `llm-chat.js`) with source names.

Non-obvious behaviors (documented in-file):
- LlamaIndex.TS's `SummaryIndex` requires an `embedModel` at indexing time even though retrieval is not similarity-based. A no-op `BaseEmbedding` subclass (`NoopEmbedding`) satisfies this without an embedding endpoint (Volces is chat-only). Swap for `OpenAIEmbedding` + `VectorStoreIndex` if embeddings become available.
- Sets `process.env.OPENAI_BASE_URL`/`OPENAI_API_KEY` at init (LlamaIndex's OpenAI client falls back to `api.openai.com` otherwise).
- On restart, any doc left `queued`/`indexing` is marked `error` (its in-memory payload is gone and cannot resume).
- URL ingestion has SSRF protection (`isPrivateHost`) and a 2 MB / 15 s fetch cap; `manifest.json` is written atomically (temp + rename).

### chat-history.js — read-only chat persistence
Persists each chat session as `chat-history-store/<sessionId>.json` (atomic temp+rename). The server tracks one in-memory "current" session (single shared agent) and appends the user turn on `prompt` and the assistant's final text on `done`. `/api/chat-history/sessions` lists metadata (title derived from the first user message); `/api/chat-history/sessions/:id` returns full messages for read-only viewing. No resume into the live agent.

### open-connector.js — SaaS-actions proxy
Thin HTTP client for an **externally-run** OpenConnector runtime (a Composio alternative; https://github.com/oomol-lab/open-connector). This module does NOT embed the gateway — it only proxies the browser-facing `/api/openconnector/*` routes to the runtime's `/v1/*` (runtime token) and `/api/*` (admin token) endpoints, and builds the MCP server config that registers the runtime's `/mcp` endpoint with the agent (so the agent gets `list_apps`/`search_actions`/`get_action_guide`/`execute_action`). **Tokens stay server-side; the browser never sees them and cannot override them.** The `/api/openconnector/config` route is always mounted (so the UI can detect enabled/disabled); the rest mount only when enabled. `getRuntimeBase()` + `tokenForPath()` expose the base URL and per-path token selection so `server.js` can mount the `/oc-web` reverse proxy of the runtime's native web UI.

### web/ - React SPA (sole frontend)
Vite + React 19 + TypeScript + Tailwind v4 + shadcn-style primitives + `react-router-dom`. The **sole frontend** - the legacy vanilla `public/` directory has been deleted. `server.js` serves `web/dist/` at `/` with a SPA fallback so the client router handles deep links. Vite `base` is `/`.

Routes: `/chat` (default), `/documents`, `/dashboard`, `/history`, `/openconnector`, `/litellm`. The sidebar uses `<NavLink>` for in-app navigation (no page reload, WebSocket stays connected). OpenConnector + LiteLLM are third-party projects with their own native UIs - the React pages are thin `<iframe>` wrappers around the `/oc-web` and `/litellm-web` same-origin proxies (tokens injected server-side, never reach the renderer). Documents, Dashboard, and Chat History are first-party React pages. WebSocket + REST contracts are unchanged - the React app talks to the same `ws://<host>/` and `/api/*` endpoints.

Dev: `npm run web:dev` (Vite on :5173, proxies `/api` + `/oc-web` + `/litellm-web` to :3000; backend must also run). Prod: `npm run web:build` -> `web/dist/`, served by `server.js` at `/`. See `web/README.md` for layout and dev workflow.

### web/ — React chat surface (in progress)
                   #   / and all routes -> React SPA from web/dist/ (client-side router)

### skills/ — local skills
Markdown `SKILL.md` files (YAML frontmatter `name`/`description` + body). Loaded into the agent via `additionalSkillPaths: [path.resolve("skills")]`. Invoked from the chat as `/skill:<name> <args>`; `server.js` parses this, broadcasts a `skill_use` event, and **manually expands** the skill body (stripping frontmatter) before forwarding to `session.prompt()` — it does not rely on the SDK's slash-command expansion. `skills/example-skill/` is a template.

## Provider & model registration

Providers are registered in `server.js`'s `extensionFactories`. `EXPOSED_PROVIDERS` (`Set`) is the single source of truth for which providers appear in the model selector — it is deliberately scoped (not "all providers") to avoid duplicate model IDs that exist across built-in providers. When adding a new provider: register it in `extensionFactories`, add its name to `EXPOSED_PROVIDERS`, and ensure its API key is wired through `authStorage.setRuntimeApiKey()` or env. Model switching is rejected while the agent is streaming (`isStreaming`).

**Gotcha:** any MCP tool name registered must also be added to the `tools` allowlist array passed to `createAgentSession`, or the SDK filters it out. The code does this dynamically via `[...mcpToolNames]`.

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
