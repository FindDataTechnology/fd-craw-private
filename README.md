# lawcraw

Browser-based chat interface around the `@earendil-works/pi-coding-agent` SDK, with an optional LlamaIndex document RAG and an OpenConnector SaaS-actions proxy.

## Dev quickstart

```bash
npm install        # backend + builds web/dist
npm start          # http://localhost:3000  (headless launcher)
npm run web:dev    # Vite on :5173 with HMR (backend must also run on :3000)
```

`npm start` runs the headless launcher (`scripts/start.js`), which reuses the desktop supervisor's shared primitives to bring up the project's **bundled local** LiteLLM (Python venv) and OpenConnector (Node/tsx) as localhost child processes when their `resources/` are built. It then starts `server.js`, injecting the resolved localhost URLs into its env. All three services are private to the project (no remote server).

- **Go local (default):** `.env` sets `LITELLM_BASE_URL=http://localhost:4000` and `OPENCONNECTOR_BASE_URL=http://localhost:3001` - the launcher spawns the project's internal LiteLLM on port 4000 and OpenConnector on port 3001. Build the resources once first (`npm run predist`, or `node scripts/build-openconnector.js && sh scripts/build-python-litellm.sh`). Generated credentials + seeded `litellm.yaml` persist to `dev-settings.json` / `litellm.yaml` under `PLATFORM_DATA_DIR` (gitignored).
- **Stay remote:** set `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` to the remote URLs in `.env`; the launcher uses them and spawns nothing locally.
- **Nothing bundled:** the launcher degrades to running `server.js` alone.

See `CLAUDE.md` for the full architecture and configuration reference.
