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
| `AUTH_MODE` | 可选登录。`forward_auth` 信任反代注入的身份头。未设 = 开放访问。 |
| `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` | Agent/应用目录云端 JSON，每 N 秒刷新（默认 60）。 |
| `NANGO_SECRET_KEY` | Nango connect session 密钥（服务端用，不发往浏览器）。 |
| `DOCUMENTS_MODEL` | Documents RAG 模型（默认 `deepseek-v4-pro`）。 |

想接入自建的 LLM 代理或 SaaS 连接器网关？自行部署后，按 MCP 服务器（`mcp.json`）或目录里的 `external-service` 条目接入即可——项目本身不再附带这两类服务。

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
| `AUTH_MODE` | Optional login. `forward_auth` trusts proxy-injected identity headers. Unset = open access. |
| `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` | Cloud JSON for agent/app catalog, refreshed every N seconds (default 60). |
| `NANGO_SECRET_KEY` | Server-side Nango secret for connect sessions (never sent to browser). |
| `DOCUMENTS_MODEL` | Documents RAG model (default `deepseek-v4-pro`). |

Want a self-hosted LLM proxy or a SaaS-connector gateway? Run it yourself and wire it in as an MCP server (`mcp.json`) or as an `external-service` entry in the catalog — the project no longer ships either one.

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
