# Platform

[![CI](https://github.com/FindDataTechnology/fd-craw-private/actions/workflows/ci.yml/badge.svg)](https://github.com/FindDataTechnology/fd-craw-private/actions/workflows/ci.yml)

> **当前版本 v1.3.0** · 基于 DeepSeek Harness (dsh) 运行时构建的浏览器聊天界面，内置第一方知识 RAG（Documents）。

本文档默认使用**中文**，英文版见文末 [English](#english)。

---

## 目录

- [快速开始](#快速开始)
- [启动方式（npm start）](#启动方式npm-start)
- [配置](#配置)
- [架构概览](#架构概览)
- [如何添加 MCP 服务器](#如何添加-mcp-服务器)
- [如何添加技能（Skill）](#如何添加技能skill)
- [如何打包软件](#如何打包软件)
- [安装与发布](#安装与发布)
- [DeepSeek Harness (dsh)](#deepseek-harness-dsh)

---

## 快速开始

```bash
npm install        # 安装后端依赖，并构建 web/dist
npm start          # http://localhost:3000（无头启动器）
npm run web:dev    # Vite 开发服务器 :5173，HMR（后端需同时在 :3000 运行）
```

`npm start` 运行无头启动器（`scripts/start.js`），由 supervisor 托管 `server.js` 这唯一一个子进程——负责加载 `.env`、健康检查、崩溃重启与日志采集。LLM 路由由 dsh 自带的 `dsh-llm` 插件（`settings.yaml` + `.credentials.yaml` 热重载）负责，SaaS 连接器由 `dsh-mcp-client` 插件负责，因此项目不再打包或部署任何额外的网关/代理服务。

> 直接 `node server.js` 也能跑起后端，但会跳过 supervisor 的配置注入与守护；日常开发请用 `npm start`。

### 打包前先构建资源

```bash
npm run predist   # 下载与当前 Node 版本匹配的独立 Node 到 resources/node/
npm run dist      # 然后才能打包安装程序
```

---

## 启动方式（npm start）

启动器只管理 `server.js` 一个进程：

- **端口：** 固定 `PORT`（默认 3000），保证 Vite 开发代理（:5173 → :3000）与 WS 客户端可用。
- **健康检查：** 探测 `/api/config`，未就绪不放行。
- **优雅降级：** 缺失的可选配置只记录警告，服务始终能启动。

如果你想接入自建的 LLM 代理或 SaaS 连接器网关，自行部署后按 MCP 服务器（`mcp.json`）或目录里的 `external-service` 条目接入即可。

完整架构参考见 `CLAUDE.md`。

---

## 配置

所有敏感/环境相关配置都在 **`.env`**（已 gitignore）与 **`mcp.json`**（已 gitignore）中，模板见 `mcp.example.json`。缺失可选配置时服务优雅降级——始终能启动。

| 变量 | 作用 |
|---|---|
| `LLM_API_KEY` / `LLM_BASE_URL` | 默认 LLM 提供商（OpenAI 兼容网关）。`server.js` 内置回退 key。 |
| `DEFAULT_MODEL` | 默认聊天模型（须是 `dsh-profile.js` 声明的模型 id 之一）。 |
| `PORT` / `HOST` | 监听地址（默认 `3000` / `localhost`）。 |
| `PLATFORM_DATA_DIR` | 磁盘存储根目录（SQLite、会话等）。 |
| `AUTH_MODE` | 登录模式：未设为开放访问，`forward_auth` 信任反代身份头，`logto` 使用 Logto OIDC 登录。 |
| `PAAS_BASE_URL` | Logto 回调的公开地址；未设时从请求 `Host` 推导。 |
| `SESSION_SECRET` | 会话签名密钥；未设时自动生成并持久化到 `PLATFORM_DATA_DIR/auth/session-secret`。 |
| `SESSION_TTL_HRS` | 会话 TTL（默认 24 小时），活跃会话会自动滑动续期。 |
| `LOGTO_ENDPOINT` / `LOGTO_APP_ID` / `LOGTO_APP_SECRET` | Logto OIDC 配置；Web 使用 confidential client，桌面使用 public/PKCE client。 |
| `LOGTO_CLIENT_TYPE` | `confidential`（默认）或 `public`；桌面设为 `public`。 |
| `LOGTO_END_SESSION` | 设为 `true` 时登出跳转到 Logto end-session。 |
| `DESKTOP_SERVER_PORT` | 桌面固定端口（默认 47600），用于注册 `http://127.0.0.1:47600/auth/callback`。 |
| `SSO_ENABLED` | 仅 `AUTH_MODE=none` 时生效：叠加**可选**登录入口（未登录仍可匿名使用）。登录后按规范化 SSO 邮箱记住个人模型与 MCP 可用开关，在共享 runtime 空闲时应用。**不是多租户隔离**——聊天/会话/文档/runtime 仍共享。要求反代允许匿名请求到达本服务，且本服务只能经由该反代访问（身份头否则可被伪造）。 |
| `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` | Agent/应用目录云端 JSON，每 N 秒刷新（默认 60）。 |
| `NANGO_SECRET_KEY` | Nango connect session 密钥（服务端用，不发往浏览器）。 |
| `DOCUMENTS_MODEL` | Documents RAG 模型（默认 `deepseek-v4-pro`）。 |
| `MARKET_REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` | 接入自建 [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)：把 registry 里的 MCP 服务器、技能（安装时拉取内容）、Agent 拉进扩展市场与 Agent 目录。组可见性用本地 `registry-groups.json`（已 gitignore）映射；未配置 URL 时仅用内置目录。 |

想接入自建的 LLM 代理或 SaaS 连接器网关？自行部署后，按 MCP 服务器（`mcp.json`）或目录里的 `external-service` 条目接入即可——项目本身不再附带这两类服务。

### Logto 登录配置

Logto 控制台需要注册两个应用，并启用 organizations / organization roles 进入 ID token：

1. Web confidential client：redirect URI 为 `https://<host>/auth/callback`，配置 `AUTH_MODE=logto`、`LOGTO_ENDPOINT`、`LOGTO_APP_ID`、`LOGTO_APP_SECRET`。
2. Desktop public client：redirect URI 为 `http://127.0.0.1:47600/auth/callback`，打包设置使用 `LOGTO_CLIENT_TYPE=public`、`DESKTOP_SERVER_PORT=47600`、`SESSION_TTL_HRS=720`。桌面安装包不包含 client secret，使用 PKCE S256。

打包后的桌面端从 `app.getPath("userData")/settings.json` 注入配置。至少提供 Logto 租户端点和 public client id；不要把 `LOGTO_APP_SECRET` 写入桌面设置：

```json
{
  "AUTH_MODE": "logto",
  "LOGTO_ENDPOINT": "https://<logto-tenant>",
  "LOGTO_APP_ID": "<desktop-public-client-id>",
  "LOGTO_CLIENT_TYPE": "public",
  "SESSION_TTL_HRS": "720",
  "DESKTOP_SERVER_PORT": "47600"
}
```

`AUTH_MODE=logto` 不支持离线首次登录：启动时必须能访问 Logto discovery/JWKS，否则后端无法完成启动；已有未过期会话在进程存活期间仍可使用，但新登录、回调和 end-session 仍需要网络。需要开放访问时，取消 `AUTH_MODE`。

组织名会映射为 group；`organization_roles` 的角色短名也会加入 group，例如 `finddata:admin` → `admin`。请在 Logto 应用的 ID token 中启用 `organizations` 和 `organization_roles`（或等价自定义 claims），并允许授权请求使用的 organizations scope。Platform 只读取这两个 claim 名称；需要管理员权限时，角色短名必须精确为 `admin`，因为目录和后台管理门禁按该名称匹配。回滚时取消 `AUTH_MODE` 即可恢复开放访问，已签发的 cookie 不再生效于认证流程。

### 托管部署（cell 运行约定）

云部署把每个用户放进一个独立的 **cell**：一个 `server.js` 进程 + 它自己的 dsh 运行时 + 它自己的数据目录。cell 之间不共享任何可变状态，隔离由进程边界保证，而不是靠应用内部的多租户逻辑；桌面版和 `npm start` 就是这个模型的单 cell 形态。

每个 cell 的环境变量矩阵（`PLATFORM_DATA_DIR`、`DSH_HOME`、`MCP_CONFIG_PATH`、`PORT`、`HOST`、`AUTH_MODE=forward_auth`、`CLOUD_MODE=1`、`CELL_GATEWAY_SECRET`）和两条硬性规则——只监听回环地址，以及 cell 数据目录必须在本地磁盘上（所有存储都是 SQLite + WAL，放在 NFS 上会损坏）——见 `.env.example` 的 "Hosted cells" 一节，那里也给出了手工启动两个 cell 的完整命令。

---

## 架构概览

- **`server.js`** — Express + WebSocket 编排器；启动 dsh 进程、翻译事件、广播给客户端。
- **`dsh-bridge.js`** — dsh 运行时桥接（stdio JSON-RPC 子进程）。
- **`dsh-profile.js`** — 写 dsh profile（`settings.yaml`、MCP patch、skills patch）。
- **`documents.js`** — 第一方文档 RAG（LlamaIndex.TS + PageIndex + SQLite）。
- **`chat-history.js`** — 只读聊天持久化（每个 turn 镜像到 SQLite）。
- **`server/routes/external-services.js`** — 目录中 `external-service` 应用的 `/external/:appId` 反向代理。**token 留在服务端**。
- **`electron/`** — 桌面 supervisor（进程管理，不跑业务逻辑）。
- **`web/`** — 唯一前端（Vite + React 19 + TypeScript + Tailwind v4 + shadcn）。路由：`/chat`、`/knowledge`、`/dashboard`、`/mcp`、`/skills`、`/models`、`/trace`、`/agents`、`/bots`、`/external/:appId`。
- **`skills/`** — 本地技能（`SKILL.md`），用 `/skill:<name>` 调用。

---

## 如何添加 MCP 服务器

无需改代码，编辑 `mcp.json`（复制 `mcp.example.json` 创建）：

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "remote-http": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

重启 server 后自动连接，工具名格式：`mcp__<serverName>__<toolName>`。

完整的分步指南：[`docs/packaging-extensions.md`](docs/packaging-extensions.md)。

---

## 如何添加技能（Skill）

在 `skills/<name>/SKILL.md` 创建一个文件：

```markdown
---
name: my-skill
description: 一句话描述功能。
---

# My Skill

正文内容，被调用时展开执行。
```

重启后自动加载，用 `/skill:my-skill <args>` 调用。模板见 `skills/example-skill/SKILL.md`。

---

## 如何打包软件

```bash
npm run predist   # 构建打包资源（独立 Node）
npm run dist      # electron-builder → .dmg (mac) / .exe (win)
npm run start:electron  # 桌面开发模式
```

输出：`dist/Platform-<version>-arm64.dmg`（mac）、`Platform Setup <version>.exe`（win x64）。

---

## 安装与发布

**CI**（`.github/workflows/release.yml`）在 3 项矩阵上构建：

- **发布：** 推 `v*` tag（如 `git tag v1.0.0 && git push --tags`）。
- **按需构建：** Actions → "Run workflow"。
- **签名：** 由 GitHub secrets 控制（无则不签名，仍成功）。

---

## DeepSeek Harness (dsh)

Platform 现在基于 **DeepSeek Harness (dsh)**，一个 subprocess 运行时，通过 stdio JSON-RPC 运行 dsh CLI。

- **核心变化：** 从 `@earendil-works/pi-coding-agent SDK` 迁移到 dsh。
- **session 模型：** dsh 在磁盘持久化会话；内存中不再保留消息（`buildSessionContext()` 返回空数组），所以 `chat-history.js` 必须从 SQLite 读取历史记录。
- **MCP 集成：** `dsh-mcp-client` 插件自动允许所有声明的工具，无需手动 allowlist。
- **模型切换：** dsh 在 `initialize` 握手时固化模型；切换需要重启 session (`dshBridge.restart`)。

更多细节见 [`openspec/specs/model-selection/`](openspec/specs/model-selection/) 与 [`openspec/specs/dsh-runtime-bridge/`](openspec/specs/dsh-runtime-bridge/)。

---

# English

> **Current version v1.3.0** — a browser-based chat interface built on the **DeepSeek Harness (dsh)** runtime, with first-party document RAG (Documents).

## Quick start

```bash
npm install        # backend + builds web/dist
npm start          # http://localhost:3000 (headless launcher)
npm run web:dev    # Vite on :5173 with HMR (backend must also run on :3000)
```

`npm start` runs the headless launcher (`scripts/start.js`), which supervises a single child process — `server.js` — handling `.env` loading, health checks, restart-on-crash and log capture. LLM routing is handled natively by the bundled `dsh-llm` plugin (`settings.yaml` + `.credentials.yaml` hot-reload) and SaaS connectors by `dsh-mcp-client`, so the project bundles and deploys no additional gateway or proxy service.

> Running `node server.js` directly also works, but skips the supervisor's config injection and supervision. Use `npm start` for day-to-day work.

### Build resources before packaging

```bash
npm run predist   # download the standalone Node matching your Node version into resources/node/
npm run dist      # then package the installers
```

---

## Configuration

Everything sensitive lives in **`.env`** and **`mcp.json`** (both gitignored; template is `mcp.example.json`). The server degrades gracefully when optional config is missing — it always starts.

| Variable | Purpose |
|---|---|
| `LLM_API_KEY` / `LLM_BASE_URL` | Default LLM provider (OpenAI-compatible gateway). Fallback key baked into `server.js`. |
| `DEFAULT_MODEL` | Default chat model (must be one of the model ids declared in `dsh-profile.js`). |
| `PORT` / `HOST` | Bind address (default `3000` / `localhost`). |
| `PLATFORM_DATA_DIR` | Root for all on-disk stores (SQLite, sessions, cron). |
| `AUTH_MODE` | Login mode: unset for open access, `forward_auth` for trusted proxy headers, or `logto` for Logto OIDC login. |
| `PAAS_BASE_URL` | Public callback base URL for Logto; derived from request `Host` when unset. |
| `SESSION_SECRET` | Session signing secret; auto-generated and persisted under `PLATFORM_DATA_DIR/auth/session-secret` when unset. |
| `SESSION_TTL_HRS` | Session TTL (default 24 hours), with sliding renewal for active sessions. |
| `LOGTO_ENDPOINT` / `LOGTO_APP_ID` / `LOGTO_APP_SECRET` | Logto OIDC settings; web uses a confidential client and desktop uses a public/PKCE client. |
| `LOGTO_CLIENT_TYPE` | `confidential` (default) or `public`; set to `public` for desktop. |
| `LOGTO_END_SESSION` | Set to `true` to chain logout through Logto end-session. |
| `DESKTOP_SERVER_PORT` | Desktop fixed port (default 47600) for `http://127.0.0.1:47600/auth/callback`. |
| `SSO_ENABLED` | Only meaningful with `AUTH_MODE=none`: layers an **optional** sign-in entry on top of open access (anonymous use keeps working). Once signed in, a per-email preference records the user's model and MCP availability overlay, applied when the shared runtime is idle. **Not multi-tenant isolation** — chat, sessions, documents and the runtime stay shared. Requires the proxy to let anonymous requests reach the app while still injecting identity for signed-in ones, and the app must be reachable only through that proxy (the identity header is otherwise forgeable). |
| `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` | Cloud JSON for agent/app catalog, refreshed every N seconds (default 60). |
| `NANGO_SECRET_KEY` | Server-side Nango secret for connect sessions (never sent to browser). |
| `DOCUMENTS_MODEL` | Documents RAG model (default `deepseek-v4-pro`). |
| `MARKET_REGISTRY_URL` / `MARKET_REGISTRY_TOKEN` | Wire in a self-hosted [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry): its MCP servers, skills (content fetched at install time), and agents appear in the extension market and agent catalog. Group visibility comes from a local `registry-groups.json` (gitignored); without a URL only the bundled catalog is used. |

Want a self-hosted LLM proxy or a SaaS-connector gateway? Run it yourself and wire it in as an MCP server (`mcp.json`) or as an `external-service` entry in the catalog — the project no longer ships either one.

### Logto login configuration

Register two applications in the Logto console and enable organizations / organization roles in ID tokens:

1. Web confidential client: redirect URI `https://<host>/auth/callback`, with `AUTH_MODE=logto`, `LOGTO_ENDPOINT`, `LOGTO_APP_ID`, and `LOGTO_APP_SECRET`.
2. Desktop public client: redirect URI `http://127.0.0.1:47600/auth/callback`, with `LOGTO_CLIENT_TYPE=public`, `DESKTOP_SERVER_PORT=47600`, and `SESSION_TTL_HRS=720`. The desktop installer contains no client secret and uses PKCE S256.

The packaged desktop app injects backend configuration from `app.getPath("userData")/settings.json`. At minimum, provide the Logto tenant endpoint and public client id; never put `LOGTO_APP_SECRET` in desktop settings:

```json
{
  "AUTH_MODE": "logto",
  "LOGTO_ENDPOINT": "https://<logto-tenant>",
  "LOGTO_APP_ID": "<desktop-public-client-id>",
  "LOGTO_CLIENT_TYPE": "public",
  "SESSION_TTL_HRS": "720",
  "DESKTOP_SERVER_PORT": "47600"
}
```

`AUTH_MODE=logto` does not support a first login while offline: Logto discovery and JWKS must be reachable during startup or the backend will not start. An existing unexpired session remains usable while the process is running, but new logins, callbacks, and end-session redirects still require the network. Unset `AUTH_MODE` to restore open access.

Organization names become groups; role short names from `organization_roles` are added too, so `finddata:admin` maps to `admin`. Enable `organizations` and `organization_roles` in the Logto application's ID token (or equivalent custom claims), and allow the organizations scope requested by Platform. Platform reads only those two claim names. Administrative access requires the exact role short name `admin`, because catalog filtering and the admin gate match that name. To roll back, unset `AUTH_MODE` to restore open access; issued cookies are no longer used by the auth flow.

### Hosted deployment (the cell run contract)

A cloud deployment puts each user in a separate **cell**: one `server.js` process, its own dsh runtime, its own data directory. No mutable state crosses cells, so isolation comes from the process boundary rather than from multi-tenant logic inside the app; the desktop app and `npm start` are the single-cell form of the same thing.

The per-cell env matrix (`PLATFORM_DATA_DIR`, `DSH_HOME`, `MCP_CONFIG_PATH`, `PORT`, `HOST`, `AUTH_MODE=forward_auth`, `CLOUD_MODE=1`, `CELL_GATEWAY_SECRET`) and the two hard rules — bind loopback only, and keep cell data on local disk because every store is SQLite + WAL and SQLite over NFS corrupts — are documented in the "Hosted cells" section of `.env.example`, together with a complete two-cell worked example.

---

## Architecture

- **`server.js`** — Express + WebSocket orchestrator; spawns dsh, translates events, broadcasts to clients.
- **`dsh-bridge.js`** — dsh runtime bridge (stdio JSON-RPC child process).
- **`dsh-profile.js`** — writes dsh profile (`settings.yaml`, MCP patch, skills patch).
- **`documents.js`** — first-party document RAG (LlamaIndex.TS + PageIndex + SQLite).
- **`chat-history.js`** — read-only chat persistence (mirrors each turn to SQLite).
- **`server/routes/external-services.js`** — `/external/:appId` reverse proxy for catalog `external-service` apps. **Tokens stay server-side.**
- **`electron/`** — desktop supervisor (process management only).
- **`web/`** — sole frontend (Vite + React 19 + TypeScript + Tailwind v4 + shadcn). Routes: `/chat`, `/knowledge`, `/dashboard`, `/mcp`, `/skills`, `/models`, `/trace`, `/agents`, `/bots`, `/external/:appId`.
- **`skills/`** — local skills (`SKILL.md`), invoked via `/skill:<name>`.

---

## How to add an MCP server

No code changes — edit `mcp.json` (copy `mcp.example.json` to create):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "remote-http": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

Restart server. Tools are exposed as `mcp__<serverName>__<toolName>`.

Full step-by-step guide: [`docs/packaging-extensions.md`](docs/packaging-extensions.md).

---

## How to add a skill

Create `skills/<name>/SKILL.md`:

```markdown
---
name: my-skill
description: One-line description.
---

# My Skill

Body content, expanded when invoked.
```

Restart and invoke via `/skill:my-skill <args>`. Template: `skills/example-skill/SKILL.md`.

---

## How to package the software

```bash
npm run predist   # build packaging resources (standalone Node)
npm run dist      # electron-builder → .dmg (mac) / .exe (win)
npm run start:electron  # desktop dev mode
```

Outputs: `dist/Platform-<version>-arm64.dmg` (mac), `Platform Setup <version>.exe` (win x64).

---

## Building installers / releases

**CI** (`.github/workflows/release.yml`) builds on a 3-entry matrix (`macos-latest` arm64, `macos-latest` x64, `windows-latest` x64):

- **Release:** push a `v*` tag (`git tag v1.0.0 && git push --tags`).
- **On-demand:** Actions → "Run workflow".
- **Signing:** gated on GitHub secrets; unsigned builds still succeed.

---

## DeepSeek Harness (dsh)

Platform now runs on **DeepSeek Harness (dsh)**, a subprocess runtime that executes the dsh CLI via stdio JSON-RPC.

- **Core change:** migrated from `@earendil-works/pi-coding-agent SDK` to dsh.
- **Session model:** dsh persists sessions on disk; memory no longer keeps messages (`buildSessionContext()` returns empty), so `chat-history.js` reads from SQLite.
- **MCP integration:** `dsh-mcp-client` plugin auto-allows all declared tools; no manual allowlist needed.
- **Model switching:** dsh locks the model at `initialize`; switching requires restarting the session (`dshBridge.restart`).

More details in [`openspec/specs/model-selection/`](openspec/specs/model-selection/) and [`openspec/specs/dsh-runtime-bridge/`](openspec/specs/dsh-runtime-bridge/).
