# End-to-end tests (Playwright)

Browser-driven E2E tests that boot the real server and drive the vanilla-JS UI.

## Run

```bash
npm install
npx playwright install chromium   # one-time; see "Proxy" below if it fails
npm run test:e2e         # fast suite (no LLM call)
npm run test:e2e:smoke   # full suite incl. the real chat-turn test (one LLM call)
```

## What it covers

- `app.spec.js` — app loads, sidebar navigation switches views.
- `documents.spec.js` — text and markdown upload → `ready`; view content; delete.
- `chat-history.spec.js` — new session appears as current; viewable read-only.
- `chat-turn.spec.js` (`@smoke`) — a real chat turn: assistant text rendered
  exactly once (no duplication) and persisted to chat history.

## How it works

`playwright.config.js` launches `node server.js` on port `3100` (override with
`E2E_PORT`) bound to `127.0.0.1`, using throwaway store directories under
`os.tmpdir()` (via the `CHAT_HISTORY_STORE_DIR` / `DOCUMENTS_STORE_DIR` env vars)
so your real `chat-history-store/` and `documents-store/` are never touched. The
server is shared across the suite (one agent session, matching production) and
tests run sequentially.

The `@smoke` chat-turn test lives in a separate Playwright project, excluded from
`npm run test:e2e`, so the default run is fast and offline. `npm run
test:e2e:smoke` runs both projects.

## Proxy

If `npx playwright install chromium` is blocked, route it through the local
proxy:

```bash
HTTP_PROXY=http://127.0.0.1:7892 HTTPS_PROXY=http://127.0.0.1:7892 npx playwright install chromium
```
