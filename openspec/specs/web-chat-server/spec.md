# web-chat-server Specification

## Purpose
TBD - created by archiving change build-pi-web-chat. Update Purpose after archive.
## Requirements
### Requirement: Server creates and manages a pi agent session
The server SHALL create a single pi `AgentSession` on startup using the pi SDK with in-memory session management and read-only tools. When no chat provider (Volces or LiteLLM) is configured, the server SHALL still create the session and start successfully (chat non-functional, logged) rather than exiting — see "Server degrades gracefully when no chat provider is configured".

#### Scenario: Server starts successfully
- **WHEN** the server starts with a valid API key configured
- **THEN** an `AgentSession` is created with `read`, `bash`, `grep`, `find`, `ls` tools and `SessionManager.inMemory()`

### Requirement: Server accepts user prompts via WebSocket
The server SHALL accept JSON messages of type `prompt` over WebSocket and forward them to the pi agent session.

#### Scenario: User sends a prompt
- **WHEN** a WebSocket client sends `{ "type": "prompt", "text": "List files" }`
- **THEN** the server calls `session.prompt("List files")` and streams the response back

#### Scenario: User sends prompt while agent is streaming
- **WHEN** a WebSocket client sends a prompt while the agent is already processing
- **THEN** the server SHALL queue the prompt using `steer` behavior

### Requirement: Server streams agent text responses
The server SHALL subscribe to pi session events and forward `text_delta` events as WebSocket messages to the client.

#### Scenario: Agent generates text
- **WHEN** the agent generates a text response
- **THEN** the server SHALL send `{ "type": "text", "delta": "<partial text>" }` messages for each delta

#### Scenario: Agent finishes responding
- **WHEN** the agent completes its response
- **THEN** the server SHALL send `{ "type": "done" }`

### Requirement: Server streams tool execution events
The server SHALL forward `tool_execution_start` and `tool_execution_end` events to the client.

#### Scenario: Agent runs a tool
- **WHEN** the agent starts executing a tool
- **THEN** the server SHALL send `{ "type": "tool_start", "name": "<tool name>" }`
- **AND** when the tool finishes, send `{ "type": "tool_end", "name": "<tool name>", "isError": <boolean> }`

### Requirement: Server serves static frontend files
The server SHALL serve the `web/dist/` directory (SPA, built by Vite) as static files at the root path with a SPA fallback for deep links, with HTTP compression enabled for compressible static assets.

#### Scenario: Browser requests the page
- **WHEN** a browser navigates to `http://localhost:3000`
- **THEN** the server SHALL return the React SPA entry `web/dist/index.html`

#### Scenario: compressible asset is requested
- **WHEN** a client requests a large text-based asset (e.g. the app entry chunk) with `Accept-Encoding` allowing gzip/br
- **THEN** the server SHALL return the asset content-compressed rather than uncompressed

### Requirement: Server degrades gracefully when no chat provider is configured
The server SHALL start successfully when no chat provider (Volces or LiteLLM) is configured. When `VOLCES_API_KEY` is unset, the Volces provider SHALL NOT be registered. When neither Volces nor LiteLLM is configured, the `extensionFactories` array SHALL be empty, the agent session SHALL still be created (model resolves to the SDK default / `null`), and the server SHALL log a warning that chat is non-functional. The documents RAG SHALL log a warning when it initializes without a Volces key, because indexing/query calls will fail at call time rather than at startup.

#### Scenario: server starts with no chat provider
- **WHEN** the server starts with `VOLCES_API_KEY` unset and LiteLLM not configured
- **THEN** the server SHALL NOT exit
- **AND** SHALL log a warning that no chat provider is configured
- **AND** the agent session SHALL be created with an empty `extensionFactories` array

#### Scenario: documents RAG warns when no Volces key
- **WHEN** the documents store initializes with `VOLCES_API_KEY` unset
- **THEN** the server SHALL log a warning that documents RAG indexing/query calls will fail at call time

### Requirement: No secrets are baked into source
The server SHALL NOT ship a functional API key as a fallback default in source. Provider API keys SHALL be read from environment variables (or, in the packaged app, from `settings.json`); an unset key SHALL resolve to `undefined`, never to a baked-in credential. The `VOLCES_API_KEY` line SHALL use optional chaining (`process.env.VOLCES_API_KEY?.trim()`), and provider registration SHALL be gated on a `volcesEnabled` boolean derived from the resolved key.

#### Scenario: unset key resolves to undefined
- **WHEN** `VOLCES_API_KEY` is unset in the environment
- **THEN** the resolved key SHALL be `undefined`
- **AND** no fallback credential SHALL be substituted from source
- **AND** the Volces provider SHALL NOT be registered

### Requirement: Asynchronous errors are surfaced, not leaked as unhandled rejections
Every asynchronous WebSocket message handler SHALL catch its own promise rejections and emit an `{ type: "error", message }` message to the originating client rather than leaking an unhandled promise rejection. The cron mutation handlers (`cron_remove`, `cron_pause`, `cron_resume`, `cron_run`) SHALL each wrap their async work in `try/catch`, mirroring `cron_add`. The connect-time `workdirStore.getWorkdir()` promise SHALL have a rejection handler that logs. The `shutdown()` path SHALL wrap the `closeMcpClients` await in `try/catch` so a rejection does not prevent `process.exit(0)`. The reverse-proxy response reads in `createWebProxy` and `proxyLitellmUi` SHALL wrap `await upstreamRes.arrayBuffer()` in `try/catch` and return HTTP 502 on failure.

#### Scenario: a cron handler error is surfaced to the client
- **WHEN** a `cron_remove`, `cron_pause`, `cron_resume`, or `cron_run` handler throws
- **THEN** the server SHALL emit `{ type: "error", message }` to the originating WebSocket client
- **AND** SHALL NOT leak an unhandled promise rejection

#### Scenario: shutdown completes despite closeMcpClients failure
- **WHEN** `closeMcpClients` rejects during shutdown
- **THEN** the server SHALL log the error and SHALL still exit

#### Scenario: proxy response-read failure returns 502
- **WHEN** `await upstreamRes.arrayBuffer()` rejects in `createWebProxy` or `proxyLitellmUi`
- **THEN** the server SHALL respond with HTTP 502 and a message describing the read failure

### Requirement: Server decomposition preserves the external contract
The backend SHALL remain launchable via `node server.js` with the same HTTP route surface (paths, methods, status codes), the same WebSocket message protocol, the same middleware ordering semantics (forward-auth gate before handlers, static + SPA fallback registered last), and the same boot/initialization ordering as the pre-decomposition monolith. Internal code organization into `server/` modules SHALL NOT introduce observable behavior changes.

#### Scenario: e2e suite passes unchanged after extraction
- **WHEN** the full offline e2e `fast` project runs against the decomposed server
- **THEN** all tests that passed pre-decomposition SHALL pass post-decomposition without modification to specs or the frontend

#### Scenario: entrypoint and middleware order are stable
- **WHEN** the server starts via `node server.js` (dev) or the supervisor/packaged launcher
- **THEN** static assets and SPA fallback SHALL remain served after all `/api` routes
- **AND** WebSocket upgrades SHALL pass through the same identity gate as HTTP requests when forward-auth is enabled

#### Scenario: boot initialization ordering is preserved
- **WHEN** the server initializes (db, documents store, dsh agent, legacy migrations, catalog, cron)
- **THEN** initialization SHALL occur in the same relative order as before decomposition, in particular documents-store init before legacy migrations run

### Requirement: Server listens before background initialization completes
The server SHALL accept TCP connections and serve static files and non-agent endpoints within ~1 second of process start, before dsh agent startup, legacy migrations, catalog loading, and cron initialization complete. Initialization groups with no ordering dependency SHALL run concurrently. Endpoints and WebSocket commands that require the dsh agent SHALL respond with an explicit initializing error (HTTP 503 / WS error event) until the agent is ready, and clients SHALL be notified when it becomes ready.

#### Scenario: static assets answer during cold start
- **WHEN** the server process has just started and the dsh agent is still handshaking
- **THEN** an HTTP request for the SPA entry SHALL succeed without waiting for agent readiness

#### Scenario: chat command during initialization
- **WHEN** a client sends a `prompt` WebSocket command before the dsh agent is ready
- **THEN** the server SHALL respond with an initializing error instead of crashing or hanging
- **AND** the server SHALL emit a readiness event to connected clients once the agent is available

#### Scenario: catalog cloud fetch does not block readiness
- **WHEN** the remote agents catalog URL is slow or unreachable (up to its 10s timeout)
- **THEN** the server SHALL already be listening and serving the local catalog
- **AND** cloud catalog entries SHALL merge in when the fetch completes

