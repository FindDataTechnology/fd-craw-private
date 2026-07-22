# web/

React chat surface for the Platform. This directory is a self-contained Vite +
React + TypeScript workspace; the Node backend under the repo root is untouched
by the migration.

- **Purpose**: the sole frontend for the Platform - a React SPA (Vite + React 19
  + TypeScript + Tailwind v4 + shadcn-style primitives + `react-router-dom`)
  hosting every view. Markdown rendering, code highlighting, and turns that
  visually group thinking / tool / skill blocks under the assistant that
  produced them. The legacy vanilla `public/` directory has been retired.
- **Routes**: `/chat` (default), `/documents`, `/dashboard`, `/history`,
  `/openconnector`, `/litellm`. OpenConnector + LiteLLM are third-party
  projects embedded as `<iframe>` wrappers around the `/oc-web` and
  `/litellm-web` same-origin proxies. Documents, Dashboard, and Chat History
  are first-party React pages.
- **Page structure**: `src/pages/` (`ChatPage`, `DocumentsPage`,
  `DashboardPage`, `ChatHistoryPage`, `EmbeddedServicePages`). State lives in
  `src/hooks/` zustand stores (`useChatStore`, `useDocumentsStore`); API
  clients in `src/lib/`. The sidebar (`src/components/Sidebar.tsx`) uses
  `<NavLink>` for in-app navigation so the WebSocket stays connected across
  views.
- **Spec**: `openspec/changes/port-views-react-bundle-dmg/`.

## Getting started

```bash
# From the repo root
npm install          # postinstall builds web/ into web/dist/ automatically
npm start            # serves both /chat (React) and / (legacy vanilla)
```

Then open <http://localhost:3000/chat/>.

### Working on the frontend

Iterate against Vite's dev server so edits hot-reload:

```bash
npm run web:dev
# Vite on http://localhost:5173/chat/
# The Node backend must ALSO be running on :3000; the dev server proxies
# /api and /oc-web to it and connects WebSocket directly to :3000.
```

### Skipping the build

CI or contributors who don't want the postinstall to trigger the frontend build:

```bash
PLATFORM_SKIP_WEB_BUILD=1 npm install
```

If `web/dist/index.html` already exists, `npm install` won't rebuild it either.

## Layout

```
web/
├── package.json           # frontend-only deps
├── vite.config.ts         # base: /chat/, dev proxy
├── tsconfig.json          # strict, noUncheckedIndexedAccess
├── components.json        # shadcn CLI config (if we need it later)
├── index.html             # Vite entry
└── src/
    ├── main.tsx           # ReactDOM root
    ├── App.tsx            # shell: sidebar + chat + composer
    ├── styles/globals.css # Tailwind v4 @theme tokens
    ├── lib/utils.ts       # cn() (shadcn convention)
    ├── types/ws.ts        # WebSocket message types (source of truth)
    ├── hooks/
    │   ├── useChatStore.ts     # Zustand store, one reducer per WS type
    │   └── useWebSocket.ts     # connection + reconnect
    └── components/
        ├── Sidebar.tsx
        ├── Chat.tsx
        ├── UserTurn.tsx
        ├── AssistantTurn.tsx
        ├── ThinkingBlock.tsx
        ├── ToolBlock.tsx
        ├── SkillBlock.tsx
        ├── Markdown.tsx        # react-markdown + shiki (lazy)
        ├── Composer.tsx
        └── Toast.tsx
```

## Adding a shadcn component

The `components.json` config makes the CLI Just Work:

```bash
cd web
npx shadcn@latest add dialog
# → drops web/src/components/ui/dialog.tsx
```

Components are source-in-repo — we own them, no runtime shadcn dep to bump.

## Bundle notes

Shiki is the biggest single dependency. To keep it bounded we import from
`shiki/core` and explicit `@shikijs/langs/*` grammars — the default `shiki`
entry point would pull in every language the package ships (~15 MB). If a new
fenced language is needed, add it to `LANGS` in `src/components/Markdown.tsx`.

## Contracts we preserve

- The WebSocket at `ws://<host>/` handles the same message set the vanilla
  frontend used (`prompt`, `list_models`, `set_model`, `list_skills`,
  `list_sessions`, `switch_session`, `new_session`; server pushes `user`,
  `agent_start`, `text`, `thinking`, `tool_*`, `skill_use`, `command_use`,
  `sessions`, `session_loaded`, `models`, `current_model`, `model_changed`,
  `skills`, `done`, `error`, plus dashboard/cron/documents events).
- REST endpoints under `/api/*` are unchanged.
- Non-chat views still ship from `public/` — clicking the sidebar's Documents /
  OpenConnector / Dashboard tabs navigates to `/` (legacy vanilla).
