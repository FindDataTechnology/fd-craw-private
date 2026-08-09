# lawcraw

Browser-based chat interface around the `@earendil-works/pi-coding-agent` SDK, with an optional knowledge platform (WeKnora) and an OpenConnector SaaS-actions proxy.

## Dev quickstart

```bash
npm install        # backend + builds web/dist
npm start          # http://localhost:3000  (headless launcher)
npm run web:dev    # Vite on :5173 with HMR (backend must also run on :3000)
```

`npm start` runs the headless launcher (`scripts/start.js`), which reuses the desktop supervisor's shared primitives to bring up the project's **bundled local** LiteLLM (Python venv) and OpenConnector (Node/tsx) as localhost child processes when their `resources/` are built. It then starts `server.js`, injecting the resolved localhost URLs into its env. All three services are private to the project (no remote server).

- **Go local (default):** `.env` sets `LITELLM_BASE_URL=http://localhost:4000` and `OPENCONNECTOR_BASE_URL=http://localhost:3001` - the launcher spawns the project's internal LiteLLM on port 4000 and OpenConnector on port 3001. Build the resources once first (`npm run predist` - builds OpenConnector, the bundled standalone Node, and the Python/LiteLLM venv). Generated credentials + seeded `litellm.yaml` persist to `dev-settings.json` / `litellm.yaml` under `PLATFORM_DATA_DIR` (gitignored).
- **Stay remote:** set `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` to the remote URLs in `.env`; the launcher uses them and spawns nothing locally.
- **Nothing bundled:** the launcher degrades to running `server.js` alone.

See `CLAUDE.md` for the full architecture and configuration reference.

## Building installers / releases

`npm run dist` packages the Electron desktop app via `electron-builder` (`electron-builder.js` - a JS config that reads the bundle manifest, so deselected components are excluded from the installer): `.dmg` (mac arm64 + x64) and a `Setup .exe` (win x64).

**CI** (`.github/workflows/release.yml`) builds three on a 3-entry matrix (`macos-latest` arm64, `macos-latest` x64 via Rosetta, + `windows-latest` x64 - the bundled LiteLLM venv is host-specific, so the `.exe` must be built on Windows):

- **Cut a release:** push a `v*` tag (`git tag v1.0.0 && git push --tags`). Both installers are attached to a GitHub Release with auto-generated notes.
- **On-demand build:** run the workflow via `workflow_dispatch` (Actions tab -> "Run workflow"). Installers are uploaded as workflow artifacts (no release created).
- **Signing** is gated on Actions secrets (`CSC_LINK`/`CSC_KEY_PASSWORD` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for mac, `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` for win). With no secrets set, builds are **unsigned** (still succeed; Gatekeeper/SmartScreen warnings only).

`scripts/build-node.js` downloads the standalone Node matching `process.version`, so the bundled Node's ABI always matches the `npm ci` Node (required because `electron-builder.js` sets `npmRebuild: false`).

### Bundle manifest (`platform.bundle.json`)

`platform.bundle.json` (repo root, shipped inside the packaged app) is the single source of truth for which heavyweight services get **built and bundled** and which MCP servers / skills are **pre-installed** with what permission policy. All consumers resolve it through `resolveBundle()` in `bundle-manifest.js` — nobody parses the JSON directly. The default file selects everything, so a default build is byte-equivalent to the old always-bundle-all behavior.

Every key:

- **`components`** — per-component `{ include }` for `litellm`, `openconnector`, `postgres`. `include` is `true` | `false` | `"auto"` (`"auto"` is only valid for `postgres` and resolves to "included iff litellm is included" — the bundled LiteLLM stores its DB in the bundled Postgres). Deselecting a component skips its build (`predist`), excludes it from the installer (`electron-builder.js` `extraResources`), and at runtime treats it as absent — the existing graceful-degradation path. External `*_BASE_URL` settings still work for deselected components (the manifest governs *bundling*, not remote access).
- **`mcpServers`** — `{ "<name>": { command|url, args?, headers?, enabled? } }` MCP servers pre-installed on first run with `origin: "bundled"`; `enabled` seeds the extension's enable state. mcp.json wins name collisions (operator config overrides the packaged default).
- **`skills`** — array of skill names under `skills/` marked as bundled in the API (`origin: "bundled"`). File skills are not DB rows.
- **`permissions`** — per-extension policy keyed `"mcp:<name>"` / `"skill:<name>"`, each `{ allow?: string[], deny?: string[], locked?: boolean }`. `locked: true` makes the entry immutable via the API (DELETE / edit / disable → 400). `allow`/`deny` are stored now and enforced by a follow-up change.

**Override without editing the file:** `PLATFORM_BUNDLE_COMPONENTS=all | none | "openconnector,litellm"` (comma list selects exactly those; `postgres` auto-includes with `litellm`). Useful for CI and for lean local installs (`PLATFORM_BUNDLE_COMPONENTS=openconnector npm install` builds only node + OpenConnector). `PLATFORM_BUNDLE_MANIFEST=/abs/path.json` overrides the manifest file location (tests).

**Error model:** an invalid manifest (bad JSON, unknown component/key, malformed permission key) fails the **build scripts** and causes the **runtime** to log a clear error and fall back to the all-components default — a corrupt manifest never prevents the app from starting.

**CI:** the release workflow's `workflow_dispatch` takes a `components` input (same syntax), exported as `PLATFORM_BUNDLE_COMPONENTS`; lean dispatch builds upload artifacts with a `-lean` suffix. See `CLAUDE.md`.

## Knowledge Platform (WeKnora)

The Knowledge panel embeds [WeKnora](https://github.com/Tencent/WeKnora) — an open-source knowledge platform from Tencent with RAG, agents, and auto-wiki capabilities. WeKnora is deployed separately (typically via Docker) and connected to Platform via a reverse proxy.

### Deploying WeKnora

```bash
# Clone WeKnora
git clone https://github.com/Tencent/WeKnora.git
cd WeKnora

# Start with Docker Compose (Postgres + Redis + WeKnora)
docker compose up -d

# WeKnora serves on http://localhost:8080 by default
```

See the [WeKnora documentation](https://github.com/Tencent/WeKnora) for full deployment instructions.

### Configuring Platform

Set `WEKNORA_BASE_URL` and `WEKNORA_API_KEY` in `.env`:

```bash
WEKNORA_BASE_URL=http://localhost:8080
WEKNORA_API_KEY=your-weknora-api-key
```

When set, the Knowledge panel appears in the sidebar and embeds WeKnora's native web UI via `/weknora-web`. Leave empty to disable.

### Migration from documents.js

The previous knowledge module (`documents.js`, PageIndex-based) has been replaced by WeKnora. Users with existing `documents-store/` data must re-ingest their documents into WeKnora (no automatic migration path).
