# lawcraw

Browser-based chat interface around the `@earendil-works/pi-coding-agent` SDK, with an optional LlamaIndex document RAG and an OpenConnector SaaS-actions proxy.

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

`npm run dist` packages the Electron desktop app via `electron-builder` (`electron-builder.yml`): `.dmg` (mac arm64 + x64) and a `Setup .exe` (win x64).

**CI** (`.github/workflows/release.yml`) builds three on a 3-entry matrix (`macos-latest` arm64, `macos-latest` x64 via Rosetta, + `windows-latest` x64 - the bundled LiteLLM venv is host-specific, so the `.exe` must be built on Windows):

- **Cut a release:** push a `v*` tag (`git tag v1.0.0 && git push --tags`). Both installers are attached to a GitHub Release with auto-generated notes.
- **On-demand build:** run the workflow via `workflow_dispatch` (Actions tab -> "Run workflow"). Installers are uploaded as workflow artifacts (no release created).
- **Signing** is gated on Actions secrets (`CSC_LINK`/`CSC_KEY_PASSWORD` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for mac, `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` for win). With no secrets set, builds are **unsigned** (still succeed; Gatekeeper/SmartScreen warnings only).

`scripts/build-node.js` downloads the standalone Node matching `process.version`, so the bundled Node's ABI always matches the `npm ci` Node (required because `electron-builder.yml` sets `npmRebuild: false`).
