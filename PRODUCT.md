# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the product's owner-developer: Platform is a personal, daily AI assistant. It is used in two situations — locally in the browser via `npm start` (full stack at `localhost:3000`) or `npm run web:dev` (Vite :5173 against the backend), and as the packaged Electron desktop app for everyday use. The job: chat with a capable agent runtime, retrieve over the user's own documents, and manage models/extensions/actions from one place.

## Product Purpose

Platform is a browser-based AI assistant built on the DeepSeek Harness (dsh) runtime. It exists to give the owner one self-contained assistant that streams dsh agent chat (thinking, tools, skills), answers over first-party documents via local RAG, and manages the surrounding stack (LLM providers, MCP extensions, OpenConnector, scheduled jobs) from a single web UI. Success means the owner relies on it daily as the primary assistant.

## Positioning

The bundled all-local stack: one launcher brings up the complete assistant — dsh runtime, LiteLLM gateway, OpenConnector, and first-party documents RAG — with zero cloud setup, and the packaged desktop app carries the same stack. This rests on two mechanisms a hosted chat product cannot truthfully copy: the depth of the dsh agent runtime (skills, tools, persistent sessions, model routing), and first-party docs RAG (LlamaIndex + PageIndex + local SQLite) over the user's own document corpus.

## Operating Context

- **Run modes:** `npm start` (headless launcher: server.js + bundled LiteLLM + OpenConnector children), `npm run web:dev` (Vite HMR), Electron desktop (`npm run start:electron`; distributed as arm64/x64 `.dmg` and Windows `.exe`).
- **Surfaces (routes):** `/chat` (default) and `/chat/:sessionId`, `/documents` (Knowledge), `/dashboard` (system status), `/extensions`, `/agents` (Agents & Apps catalog), `/openconnector`, `/litellm`.
- **Configuration:** `.env` in dev, `userData/settings.json` in the packaged desktop app; every optional component degrades gracefully — the server always starts.
- **Data:** local SQLite under `PLATFORM_DATA_DIR` (sessions, chat history, documents index, cron, extension/MCP config).
- **Auth:** optional; default open access, or `forward_auth` behind a proxy (oauth2-proxy → Logto).

## Capabilities and Constraints

Confirmed capabilities: streaming dsh agent chat with thinking/tool/skill rendering; model and agent selection; documents RAG ingestion (PDF, Markdown, plain text, web URLs); OpenConnector reverse proxy with tokens kept server-side; LiteLLM provider management; MCP extension runtime management; agents/apps catalog with cloud refresh; scheduled jobs (cron); session list and chat-history persistence; system status dashboard.

Confirmed constraints:

- **Chinese-first copy** — zh-CN is the primary product language; en/es/fr/ja are secondary. All UI strings flow through the checked locale files (`npm run check:locales` gates the build).
- **Desktop app parity** — the Electron app is a first-class surface; browser and desktop render the same web UI and neither may regress the other.
- One dsh session serves all connected clients; the WS message contract in `openspec/specs/` is binding.

Undecided: the stated long-term goal of an "openclaw-like" assistant for a special industry remains a direction, not a current constraint — today the product stays general-purpose and no design decision should be made for that pivot yet.

## Brand Commitments

Product name: **Platform** (repo `fd-craw-private`, FindData Technology). README is Chinese-first with an English appendix; versioned releases (v1.3.0) ship via GitHub Actions. No logo, identity assets, or voice guide exist yet — none is binding.

## Evidence on Hand

- Working codebase v1.3.0: Express + WS backend (`server.js` et al.), React 19 + Vite + Tailwind v4 + shadcn/ui frontend (`web/`).
- Documentation: `README.md` (zh + en), `CLAUDE.md` (architecture), 40+ OpenSpec capability specs under `openspec/specs/`, Playwright e2e suites under `e2e/`.
- Absences future work must not fabricate: no logos or brand assets, no product screenshots, no testimonials, customers, benchmarks, or pricing.

## Product Principles

1. **Local-first, always-runs.** The full stack boots from one launcher, and every optional component degrades gracefully rather than blocking startup.
2. **Chat is the center.** The chat surface is the product; every panel exists to feed it (models, documents, actions, extensions, status).
3. **Chinese-first, locale-checked.** zh-CN leads; every user-facing string lives in the checked locale files, never inline.
4. **One UI, two homes.** Browser and desktop are the same product; parity is a constraint, not a nicety.
5. **Secrets stay server-side.** API keys and OpenConnector tokens never reach the browser.
