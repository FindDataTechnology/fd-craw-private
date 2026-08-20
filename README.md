# Platform

> **当前版本 v1.3.0** · 基于 `@earendil-works/pi-coding-agent` SDK 的浏览器聊天界面，可选接入知识平台（WeKnora）与 OpenConnector SaaS 动作代理。长期目标是面向特定行业的 "类 openclaw" 助手；当前代码是一个通用编程助手 Web 应用。

本文档默认使用**中文**，英文版见文末 [English](#english)。

---

## 目录

- [快速开始](#快速开始)
- [本地服务（npm start）](#本地服务npm-start)
- [配置](#配置)
- [架构概览](#架构概览)
- [如何添加 MCP 服务器](#如何添加-mcp-服务器)
- [如何添加技能（Skill）](#如何添加技能skill)
- [如何打包软件](#如何打包软件)
- [打包安装包 / 发布](#打包安装包--发布)
- [知识平台（WeKnora）](#知识平台weknora)

---

## 快速开始

```bash
npm install        # 安装后端依赖，并构建 web/dist
npm start          # http://localhost:3000（无头启动器）
npm run web:dev    # Vite 开发服务器 :5173，HMR（后端需同时在 :3000 运行）
```

`npm start` 运行无头启动器（`scripts/start.js`），复用桌面端 supervisor 的共享原语，在 `resources/` 已构建的前提下，把项目**内置的本地** LiteLLM（Python venv）和 OpenConnector（Node/tsx）作为 localhost 子进程拉起，再启动 `server.js` 并把解析出的 localhost URL 注入其环境。三个服务都私有于本工程（无远程服务器）。

> 直接 `node server.js` 只会跑后端，不会拉起 OC/LiteLLM 子进程；此时 OpenConnector / LiteLLM 面板会退回"未配置"占位态。

## 本地服务（npm start）

- **默认本地模式：** `.env` 里设 `LITELLM_BASE_URL=http://localhost:4000`、`OPENCONNECTOR_BASE_URL=http://localhost:3001`——启动器会在 4000 端口拉起内置 LiteLLM、3001 端口拉起内置 OpenConnector。先构建一次资源（`npm run predist`，会构建 OpenConnector、内置独立 Node、以及 Python/LiteLLM venv）。生成的凭据与种子 `litellm.yaml` 持久化到 `PLATFORM_DATA_DIR` 下的 `dev-settings.json` / `litellm.yaml`（已 gitignore）。
- **远程模式：** 在 `.env` 里把 `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` 设为远程 URL，启动器直接使用，不拉起任何本地进程。
- **未打包：** 启动器退化为仅运行 `server.js`。

完整架构与配置参考见 `CLAUDE.md`。

## 配置

所有敏感/环境相关配置都在 **`.env`**（已 gitignore）与 **`mcp.json`**（已 gitignore）中，模板见 `mcp.example.json`。缺失可选配置时服务优雅降级——始终能启动。

| 变量 | 作用 |
|---|---|
| `VOLCES_API_KEY` / `VOLCES_BASE_URL` | 硬编码默认提供商（火山引擎 / Volces Coding）。`server.js` 内置了回退 API key，可用 env 覆盖。 |
| `LITELLM_BASE_URL` / `LITELLM_API_KEY` | 注册 `pi-provider-litellm` 扩展为额外提供商。任一未设则跳过 litellm。设成 localhost URL 时 `npm start` 会拉起内置 LiteLLM；设成远程 URL 则走远程代理。 |
| `OPENCONNECTOR_BASE_URL` (+ `OPENCONNECTOR_RUNTIME_TOKEN`, `OPENCONNECTOR_ADMIN_TOKEN`) | 启用 OpenConnector 面板、MCP 注册与内嵌原生 Web UI（`/oc-web`）。未设 = 完全禁用。 |
| `WEKNORA_BASE_URL` / `WEKNORA_API_KEY` | 启用知识面板（WeKnora，独立部署，通常 Docker）。设成 WeKnora URL + API key 后，`/weknora-web` 反向代理会内嵌其原生 UI。未设 = 禁用。 |
| `PORT` / `HOST` | 监听地址（默认 `3000` / `localhost`）。 |
| `PLATFORM_DATA_DIR` | 所有磁盘存储（SQLite、会话、cron）的根目录。桌面打包版由 supervisor 设为 `app.getPath('userData')`。 |
| `AUTH_MODE` | 可选登录。设为 `forward_auth` 时信任反代注入的 `X-Forwarded-Email` / `X-Forwarded-Groups`（Caddy forward_auth → oauth2-proxy → Logto），缺失即 401。未设 = 开放访问（默认）。**信任边界：开启即断言服务只经 forward-auth 代理可达——必须绑 localhost 或加防火墙，否则身份头可被伪造。** |
| `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` | Agent/应用目录的云端 JSON（与本地 `agents.json` 按 id 合并，云端优先），每 N 秒刷新（默认 60）。拉取失败保留上次结果。 |
| `NANGO_SECRET_KEY` | `nango-connect` 类型应用条目铸造 connect session 所用的服务端 Nango 密钥（绝不发往浏览器）。 |

### 开启登录（forward-auth 部署）

`AUTH_MODE=forward_auth` 时，服务信任反代注入的身份头。Caddy 参考配置（oauth2-proxy → Logto OIDC，完整链路见 `openspec/changes/add-forward-auth-agent-catalog/design.md`）：

```caddy
paas.example.com {
	handle /oauth2/* { reverse_proxy 127.0.0.1:4180 { header_up X-Real-IP {remote_host} } }
	handle {
		forward_auth 127.0.0.1:4180 {
			uri /oauth2/auth
			header_up X-Real-IP {remote_host}
			copy_headers X-Forwarded-Email X-Forwarded-Groups
			@error status 401
			handle_response @error { redir * /oauth2/start?rd={scheme}://{host}{uri} }
		}
		reverse_proxy 127.0.0.1:3000
	}
}
```

Agent/应用目录模板见 `agents.example.json`（本地 `agents.json` + 云端 `AGENTS_CONFIG_URL`，按 id 合并、云端优先）。

## 架构概览

- **`server.js`** — 编排器。单个 Express + `ws` WebSocketServer；启动时连接 MCP、注册提供商与技能、创建一个模块级 agent `session`，并把 agent 事件经 `broadcast()` 转发给所有 WS 客户端（一个会话服务所有客户端，非每连接一个）。
- **`mcp-bridge.js`** — MCP → pi 工具桥。pi SDK 无原生 MCP 支持，此模块连接 `mcp.json` 里的每个 server（stdio 或 http/sse），把每个 MCP 工具包装成 pi `ToolDefinition`，工具名命名空间为 `mcp__<server>__<tool>`。**失败的 server 仅记日志并跳过，绝不中止启动。**
- **`weknora.js` / `open-connector.js`** — 知识平台 / SaaS 动作代理的 token 注入反向代理。**token 始终留在服务端，浏览器不可见。**
- **`chat-history.js`** — 只读聊天持久化（`chat-history-store/<sessionId>.json`，原子 temp+rename）。
- **`electron/`** — 桌面 supervisor（Electron 主进程），只做进程监督（启动/健康检查/重启/停止），不跑业务逻辑。
- **`web/`** — 唯一前端（Vite + React 19 + TypeScript + Tailwind v4 + shadcn + react-router-dom），支持 i18n（`zh-CN` / `en` / `es` / `fr` / `ja`）。路由：`/chat`（默认）、`/dashboard`、`/documents`、`/extensions`、`/openconnector`、`/litellm`（启用 litellm 时显示）。
- **`skills/`** — 本地技能（`SKILL.md`，YAML frontmatter + 正文），经 `additionalSkillPaths` 加载，聊天里以 `/skill:<name> <args>` 调用。

---

## 如何添加 MCP 服务器

MCP 服务器**无需改代码**，只需配置文件。两种形态：

1. 若尚无 `mcp.json`，复制 `mcp.example.json` → `mcp.json`（已 gitignore）。
2. 在 `mcpServers` 下加一项：
   - **stdio**（拉起本地进程）：`command` + `args`（+ 可选 `env`）
   - **http**（远程 Streamable HTTP/SSE）：`url` + 可选 `headers`

```json
{
  "mcpServers": {
    "my-stdio-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": { "SOME_VAR": "value" }
    },
    "my-http-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

3. 重启 server。`mcp-bridge.js` 会自动连接每个 server、列出工具，并以 `mcp__<server>__<tool>` 暴露；工具名会动态加入 agent 的 `tools` 白名单（`server.js` 里的 `[...mcpToolNames]`）。连接失败的 server 被跳过，不影响启动。

> **注意：** OpenConnector 会在启动时根据 `OPENCONNECTOR_BASE_URL` 自动注册，通常无需手动加到 `mcp.json`。

## 如何添加技能（Skill）

技能是 `skills/<name>/SKILL.md` 文件。创建一个目录：

```markdown
---
name: my-skill
description: 一句话说明它做什么、何时使用。
---

# My Skill

正文：调用 `/skill:my-skill <args>` 时 agent 展开并执行的指令。
```

重启 server 后自动加载。在聊天里用 `/skill:my-skill <args>` 调用——`server.js` 解析命令、广播 `skill_use` 事件、剥离 frontmatter 后把正文转发给 agent。

模板见 `skills/example-skill/SKILL.md`。

### 打包（随安装包预装）MCP 与技能

除了运行时用 `mcp.json` / `skills/` 添加，还可以让**最终用户首次运行即获得**这些扩展——用仓库根目录的打包清单 `platform.bundle.json`（唯一事实来源，所有消费方都经 `bundle-manifest.js` 的 `resolveBundle()` 读取）：

```json
{
  "components": { "litellm": { "include": true }, "openconnector": { "include": true }, "postgres": { "include": "auto" } },
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"], "enabled": true }
  },
  "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill"],
  "permissions": { "mcp:memory": { "locked": true } }
}
```

- **`components`** — 选中的重量级服务（`litellm` / `openconnector` / `postgres`）会被**构建并打包**进安装包；`postgres` 用 `"auto"`（仅在 litellm 被选时打包）。
- **`mcpServers`** — 首次运行时以 `origin: "bundled"` 预装的 MCP server，`enabled` 播种启用状态。`mcp.json` 同名项优先（运维配置覆盖打包默认）。
- **`skills`** — `skills/` 下标记为 `origin: "bundled"` 的技能名。
- **`permissions`** — `"mcp:<name>"` / `"skill:<name>"` 的 `{ allow?, deny?, locked? }`；`locked: true` 使该扩展无法经 API 删除/编辑/禁用。

无需编辑文件即可覆盖：`PLATFORM_BUNDLE_COMPONENTS=all|none|"openconnector,litellm"`；`PLATFORM_BUNDLE_MANIFEST=/abs/path.json` 换清单文件（测试用）。

> ⚠️ 离线安装的坑：`command` 型 stdio server（如 `npx` 包）会在**最终用户**首次连接时从 npm registry 下载，真离线环境无 registry 可用。自包含打包请改用 `url`/http server，或把 server 的 JS 构建进 `resources/` 并让 `command` 指向随应用一起分发的二进制。

完整的分步指南与示例见 **[`docs/packaging-extensions.md`](docs/packaging-extensions.md)**。

---

## 如何打包软件

```bash
npm run predist   # 按解析出的组件集构建内置资源（OpenConnector、独立 Node、Python/LiteLLM venv）
npm run dist      # electron-builder → 安装包（mac .dmg / win .exe）
npm run start:electron  # 桌面端开发运行（supervisor 给 server.js 分配动态端口）
```

产出物：`dist/Platform-<version>-arm64.dmg`（mac）、`Platform Setup <version>.exe`（win x64）。

- **组件选择：** `platform.bundle.json` 的 `components` 决定哪些服务被构建+打包；`PLATFORM_BUNDLE_COMPONENTS=openconnector npm install` 只构建 Node + OpenConnector（精简本地安装）。
- **清单校验：** 无效清单（坏 JSON、未知组件/键、错误权限键）会让构建脚本失败，运行时记错误日志并回退到"全组件"默认——损坏清单绝不会让应用起不来。
- **内置 Node：** `scripts/build-node.js` 下载与 `process.version` 匹配的独立 Node，保证内置 Node 的 ABI 与跑 `npm ci` 的 Node 一致（因为 `electron-builder.js` 设了 `npmRebuild: false`）。

## 打包安装包 / 发布

**CI**（`.github/workflows/release.yml`）在 3 项矩阵上构建（`macos-latest` arm64、`macos-latest` x64 via Rosetta、`windows-latest` x64——内置 LiteLLM venv 与宿主机解释器绑定，所以 `.exe` 必须在 Windows 上构建）：

- **发布：** 推 `v*` tag（`git tag v1.0.0 && git push --tags`），两个安装包以自动生成的 notes 附加到 GitHub Release。
- **按需构建：** 经 `workflow_dispatch`（Actions 页 → "Run workflow"）触发，安装包上传为 workflow artifacts（不建 release）。
- **签名** 由 Actions secrets 控制（mac `CSC_LINK`/`CSC_KEY_PASSWORD` + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`；win `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`）。未设 secrets 时构建**不签名**（仍成功，仅 Gatekeeper/SmartScreen 警告）。

## 知识平台（WeKnora）

知识面板内嵌 [WeKnora](https://github.com/Tencent/WeKnora)（腾讯开源的 RAG/agent/自动 wiki 知识平台），独立部署（通常 Docker），经反向代理接入 Platform。

```bash
git clone https://github.com/Tencent/WeKnora.git
cd WeKnora
docker compose up -d          # Postgres + Redis + WeKnora，默认 http://localhost:8080
```

在 `.env` 设 `WEKNORA_BASE_URL` 与 `WEKNORA_API_KEY` 后，知识面板出现在侧边栏并内嵌 WeKnora 原生 UI。留空则禁用。旧 `documents.js`（PageIndex）模块已被 WeKnora 取代，已有 `documents-store/` 数据需重新导入（无自动迁移路径）。

---

# English

> **Current version v1.3.0** — a browser-based chat interface around the `@earendil-works/pi-coding-agent` SDK, with an optional knowledge platform (WeKnora) and an OpenConnector SaaS-actions proxy. Long-term goal is an "openclaw-like" assistant for a special industry; the code today is a general-purpose coding-assistant web app.

## Quick start

```bash
npm install        # backend + builds web/dist
npm start          # http://localhost:3000  (headless launcher)
npm run web:dev    # Vite on :5173 with HMR (backend must also run on :3000)
```

`npm start` runs the headless launcher (`scripts/start.js`), reusing the desktop supervisor's shared primitives to bring up the **bundled local** LiteLLM (Python venv) and OpenConnector (Node/tsx) as localhost child processes when their `resources/` are built. It then starts `server.js`, injecting the resolved localhost URLs into its env. All three services are private to the project (no remote server).

- **Go local (default):** `.env` sets `LITELLM_BASE_URL=http://localhost:4000` and `OPENCONNECTOR_BASE_URL=http://localhost:3001` — the launcher spawns the internal LiteLLM on 4000 and OpenConnector on 3001. Build resources once first (`npm run predist`). Generated credentials + seeded `litellm.yaml` persist to `dev-settings.json` / `litellm.yaml` under `PLATFORM_DATA_DIR` (gitignored).
- **Stay remote:** set `LITELLM_BASE_URL` / `OPENCONNECTOR_BASE_URL` to remote URLs in `.env`; the launcher uses them and spawns nothing locally.
- **Nothing bundled:** the launcher degrades to running `server.js` alone.

## Configuration

Everything sensitive lives in **`.env`** and **`mcp.json`** (both gitignored; template is `mcp.example.json`). The server degrades gracefully when optional config is missing — it always starts.

| Variable | Purpose |
|---|---|
| `VOLCES_API_KEY` / `VOLCES_BASE_URL` | Hardcoded default provider (Volces Coding). Fallback key baked into `server.js`; override via env. |
| `LITELLM_BASE_URL` / `LITELLM_API_KEY` | Registers `pi-provider-litellm` as an extra provider. Either unset → litellm skipped. localhost URL → launcher spawns bundled LiteLLM; remote URL → remote proxy. |
| `OPENCONNECTOR_BASE_URL` (+ `OPENCONNECTOR_RUNTIME_TOKEN`, `OPENCONNECTOR_ADMIN_TOKEN`) | Enables the OpenConnector panel, MCP registration, and embedded native UI (`/oc-web`). Unset = disabled. |
| `WEKNORA_BASE_URL` / `WEKNORA_API_KEY` | Enables the Knowledge panel (WeKnora, deployed separately via Docker). |
| `PORT` / `HOST` | Bind address (default `3000` / `localhost`). |
| `PLATFORM_DATA_DIR` | Root for all on-disk stores (SQLite, sessions, cron). |
| `AUTH_MODE` | Optional login. `forward_auth` trusts proxy-injected `X-Forwarded-Email` / `X-Forwarded-Groups` (Caddy forward_auth → oauth2-proxy → Logto); missing header ⇒ 401. Unset = open access (default). **Trust boundary: enabling asserts the server is reachable ONLY through the forward-auth proxy — bind to localhost or firewall it.** |
| `AGENTS_CONFIG_URL` / `CATALOG_REFRESH_SECS` | Cloud JSON for the agent/app catalog (merged with local `agents.json` by id, cloud wins), refreshed every N seconds (default 60). Fetch failure keeps last-good. Template: `agents.example.json`. |
| `NANGO_SECRET_KEY` | Server-side Nango secret used to mint connect sessions for `nango-connect` app entries (never sent to the browser). |

### Enabling login (forward-auth deployment)

With `AUTH_MODE=forward_auth` the server trusts identity headers injected by the reverse proxy. Reference Caddy config (oauth2-proxy → Logto OIDC; full chain in `openspec/changes/add-forward-auth-agent-catalog/design.md`):

```caddy
paas.example.com {
	handle /oauth2/* { reverse_proxy 127.0.0.1:4180 { header_up X-Real-IP {remote_host} } }
	handle {
		forward_auth 127.0.0.1:4180 {
			uri /oauth2/auth
			header_up X-Real-IP {remote_host}
			copy_headers X-Forwarded-Email X-Forwarded-Groups
			@error status 401
			handle_response @error { redir * /oauth2/start?rd={scheme}://{host}{uri} }
		}
		reverse_proxy 127.0.0.1:3000
	}
}
```

## Architecture

- **`server.js`** — single Express + `ws` server; connects MCP, registers providers + skills, creates one module-scoped agent `session`, re-broadcasts agent events to all WS clients (one session serves all clients).
- **`mcp-bridge.js`** — MCP → pi tool bridge (pi SDK has no native MCP). Wraps each MCP tool as `mcp__<server>__<tool>`. **Failed servers are logged and skipped.**
- **`weknora.js` / `open-connector.js`** — token-injecting reverse proxies. **Tokens stay server-side.**
- **`chat-history.js`** — read-only chat persistence.
- **`electron/`** — desktop supervisor (process supervision only).
- **`web/`** — sole frontend (Vite + React 19 + TypeScript + Tailwind v4 + shadcn + react-router-dom), i18n (`zh-CN` / `en` / `es` / `fr` / `ja`). Routes: `/chat` (default), `/dashboard`, `/documents`, `/extensions`, `/openconnector`, `/litellm` (shown when litellm is enabled).
- **`skills/`** — local skills (`SKILL.md`, YAML frontmatter + body), invoked as `/skill:<name> <args>`.

## How to add an MCP server

No code changes — config only. Two shapes:

```json
{
  "mcpServers": {
    "my-stdio-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": { "SOME_VAR": "value" }
    },
    "my-http-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

1. If `mcp.json` doesn't exist, copy `mcp.example.json` → `mcp.json`.
2. Add an entry under `mcpServers` (stdio: `command` + `args`; http: `url` + optional `headers`).
3. Restart. `mcp-bridge.js` auto-connects, lists tools, and exposes them as `mcp__<server>__<tool>`; names are added to the agent's `tools` allowlist dynamically. Failed servers are skipped.

> OpenConnector is auto-registered from `OPENCONNECTOR_BASE_URL` at startup — normally don't add it manually.

## How to add a skill

```markdown
---
name: my-skill
description: One-line summary of what it does and when to use it.
---

# My Skill

Body — expanded and followed when invoked as `/skill:my-skill <args>`.
```

Put it in `skills/<name>/SKILL.md`, restart, and invoke as `/skill:my-skill <args>`. Template: `skills/example-skill/SKILL.md`.

### Bundling MCP + skills into installers

Pre-install MCP servers and ship skills so end users get them on first run, via the bundle manifest `platform.bundle.json` (single source of truth, read through `resolveBundle()` in `bundle-manifest.js`):

```json
{
  "components": { "litellm": { "include": true }, "openconnector": { "include": true }, "postgres": { "include": "auto" } },
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"], "enabled": true }
  },
  "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill"],
  "permissions": { "mcp:memory": { "locked": true } }
}
```

- **`components`** — heavyweight services to build + bundle (`litellm` / `openconnector` / `postgres`); `postgres` uses `"auto"`.
- **`mcpServers`** — MCP servers pre-installed on first run (`origin: "bundled"`, `enabled` seeds state). `mcp.json` wins name collisions.
- **`skills`** — skill names under `skills/` marked `origin: "bundled"`.
- **`permissions`** — `"mcp:<name>"` / `"skill:<name>"` with `{ allow?, deny?, locked? }`; `locked: true` blocks API mutation.

Override without editing: `PLATFORM_BUNDLE_COMPONENTS=all|none|"openconnector,litellm"`; `PLATFORM_BUNDLE_MANIFEST=/abs/path.json`.

> ⚠️ Offline gotcha: a `command`-based stdio server (e.g. an `npx` package) downloads from npm on the *end user's* first connect. For self-contained packaging use a `url` server or bundle the server binary into `resources/`.

Full step-by-step guide with worked examples: **[`docs/packaging-extensions.md`](docs/packaging-extensions.md)**.

## How to package the software

```bash
npm run predist   # build bundled resources for the resolved component set
npm run dist      # electron-builder → installers (mac .dmg / win .exe)
npm run start:electron  # desktop dev run
```

Outputs: `dist/Platform-<version>-arm64.dmg` (mac) / `Platform Setup <version>.exe` (win x64).

## Building installers / releases

**CI** (`.github/workflows/release.yml`) builds on a 3-entry matrix (`macos-latest` arm64, `macos-latest` x64 via Rosetta, `windows-latest` x64 — the bundled LiteLLM venv is host-specific, so the `.exe` must build on Windows):

- **Release:** push a `v*` tag (`git tag v1.0.0 && git push --tags`).
- **On-demand:** `workflow_dispatch` (Actions → "Run workflow").
- **Signing** gated on Actions secrets; unsigned builds still succeed (warnings only).

## Knowledge Platform (WeKnora)

The Knowledge panel embeds [WeKnora](https://github.com/Tencent/WeKnora). Deploy it separately (Docker), then set `WEKNORA_BASE_URL` + `WEKNORA_API_KEY` in `.env`. The previous `documents.js` module has been replaced by WeKnora; existing `documents-store/` data must be re-ingested (no auto migration).
