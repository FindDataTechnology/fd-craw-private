## ADDED Requirements

### Requirement: Server descriptor registry
The supervisor SHALL manage a registry of server descriptors. Each descriptor SHALL declare the server's id, runtime kind (`node` / `python` / `http-external`), start command, working directory, environment, transport (`http-port` or `stdio-rpc`), health-check probe, dependency list, and whether the server is optional. Descriptors for `openconnector` and `litellm` SHALL resolve at supervisor construction time to their **bundled** form (`kind: "node"` or `kind: "python"`, `start` populated) when their bundled resources are present on disk AND the user has not set an explicit external base URL for that service; otherwise they SHALL resolve to their **external** form (`kind: "http-external"`, `start: null`), preserving the existing behavior.

#### Scenario: App launches with the four default servers
- **WHEN** the Electron app starts
- **THEN** the supervisor loads descriptors for `server.js`, `pi-agent`, `litellm`, and `openconnector`
- **AND** begins orchestrating them according to their declared dependencies

#### Scenario: Bundled OpenConnector resources are present
- **WHEN** `resources/openconnector/dist/index.js` exists in the app bundle
- **AND** `settings.json` does not set `OPENCONNECTOR_BASE_URL` to an external URL
- **THEN** the `openconnector` descriptor resolves to `kind: "node"` with `start.cmd = <bundled node>` and `start.args = [<oc dist entry>]`
- **AND** the supervisor spawns the OpenConnector process on a free localhost port

#### Scenario: Bundled LiteLLM resources are present
- **WHEN** `resources/litellm/venv/bin/litellm` exists in the app bundle
- **AND** `resources/python/bin/python3` exists in the app bundle
- **AND** `settings.json` does not set `LITELLM_BASE_URL` to an external URL
- **THEN** the `litellm` descriptor resolves to `kind: "python"` with `start.cmd = <venv litellm>` and `start.args = ["--port", <freePort>, "--config", "<userData>/litellm.yaml"]`
- **AND** the supervisor spawns the LiteLLM process on a free localhost port

#### Scenario: External override wins over bundled resources
- **WHEN** bundled OpenConnector resources are present in the bundle
- **AND** the user has set `OPENCONNECTOR_BASE_URL=https://oc.example.com` in `settings.json`
- **THEN** the `openconnector` descriptor resolves to `kind: "http-external"` with that URL
- **AND** the supervisor health-checks the external service and does NOT spawn the bundled process

### Requirement: Ordered startup with dependency readiness
The supervisor SHALL start servers in dependency order and SHALL wait for each server's health check to pass before starting servers that depend on it. When bundled `litellm` and `openconnector` are spawned, they SHALL start in parallel with (not before) `server.js` — `server.js` SHALL treat them as optional and MUST NOT block on their readiness.

#### Scenario: pi-agent starts before server.js
- **WHEN** the app starts
- **THEN** the supervisor starts `pi-agent` and waits for its RPC health check to pass
- **BEFORE** starting `server.js`, which declares `pi-agent` as a dependency

#### Scenario: external servers are health-checked, not spawned
- **WHEN** `litellm` and `openconnector` are configured as `http-external` (URLs only)
- **THEN** the supervisor polls their health endpoints
- **AND** does NOT spawn a process for them
- **AND** marks them green or red without blocking app launch when they are optional

#### Scenario: bundled optional services do not block the window
- **WHEN** bundled `litellm` and `openconnector` are declared as spawned
- **AND** `server.js` becomes healthy before them
- **THEN** the Electron main process opens the window pointed at `server.js` immediately
- **AND** the bundled services continue starting in the background

## ADDED Requirements

### Requirement: Python runtime kind support
The supervisor SHALL support `kind: "python"` server descriptors, spawning them via the same `spawnServer` primitive used for `kind: "node"`. The descriptor's `start.cmd` SHALL point at an interpreter (typically a venv `bin/litellm` or `bin/python3`) that exists on disk when the descriptor is enabled.

#### Scenario: python descriptor spawn
- **WHEN** a `python` descriptor is enabled and its `start.cmd` path exists
- **THEN** the supervisor spawns the child with the given cmd/args/env
- **AND** captures its stdout/stderr into the log ring buffer
- **AND** health-checks it via HTTP on its assigned port

#### Scenario: python descriptor missing interpreter
- **WHEN** a `python` descriptor is enabled but `start.cmd` does not exist on disk
- **THEN** the supervisor marks the server `unhealthy` with a clear error
- **AND** does NOT crash the supervisor or block other servers

### Requirement: Free-port assignment for bundled optional servers
The supervisor SHALL assign a free localhost port to each bundled spawned server (`openconnector`, `litellm`) at launch, distinct from `server.js`'s port. The resolved URLs SHALL be injected into `server.js`'s environment as `OPENCONNECTOR_BASE_URL` and `LITELLM_BASE_URL` so `server.js` and its modules discover the bundled services identically to external ones.

#### Scenario: server.js receives bundled sibling URLs
- **WHEN** bundled OC and LiteLLM are spawned on ports X and Y
- **THEN** `server.js` starts with `OPENCONNECTOR_BASE_URL=http://127.0.0.1:X` and `LITELLM_BASE_URL=http://127.0.0.1:Y` in its environment
- **AND** its OpenConnector and LiteLLM integrations use those URLs with no code change

### Requirement: Automatic restart on unexpected failure
The supervisor SHALL restart a server process if it exits unexpectedly, subject to a backoff policy, and SHALL NOT restart a server that exited because the app is shutting down.

#### Scenario: agent crash self-heals
- **WHEN** the `pi-agent` process crashes unexpectedly
- **THEN** the supervisor restarts it after a backoff delay
- **AND** the window and `server.js` remain unaffected

#### Scenario: no restart during shutdown
- **WHEN** the user quits the app
- **THEN** the supervisor stops all servers without triggering restart logic

### Requirement: Ordered shutdown
The supervisor SHALL stop servers in reverse dependency order on app quit, terminating each child process gracefully and then forcibly after a timeout.

#### Scenario: shutdown order
- **WHEN** the app quits
- **THEN** the supervisor closes the window, then stops `server.js`, then `pi-agent`, then any bundled sidecars, in reverse startup order

### Requirement: Status inspection
The supervisor SHALL expose the live status of every server - id, state, pid, assigned port, last health result, restart count, and recent log lines - for display in the app.

#### Scenario: inspect server status
- **WHEN** the UI requests supervisor status
- **THEN** the supervisor returns each server's current state and its recent log lines

### Requirement: Log capture
The supervisor SHALL capture each child process's stdout and stderr into a per-server ring buffer and SHALL surface them through the status inspection API.

#### Scenario: child stderr captured
- **WHEN** a child server writes to stderr
- **THEN** the supervisor appends it to that server's log ring buffer
- **AND** it is retrievable via status inspection

### Requirement: Graceful degradation of optional servers
The supervisor SHALL allow the app to launch and `server.js` to start even when optional servers (`litellm`, `openconnector`) are unreachable or unconfigured, preserving the existing graceful-degradation contract.

#### Scenario: OpenConnector unreachable
- **WHEN** `openconnector` is enabled in settings but its health check fails
- **THEN** the supervisor marks it red
- **AND** `server.js` starts and hides the OpenConnector panel, as it does today

### Requirement: Port management for spawned servers
The supervisor SHALL assign a free localhost port to each spawned port-speaking server at launch and SHALL pass the resolved URLs of sibling servers into each child's environment.

#### Scenario: server.js receives sibling URLs
- **WHEN** the supervisor starts `server.js`
- **THEN** it passes `LITELLM_BASE_URL`, `OPENCONNECTOR_BASE_URL`, and the pi-agent RPC bridge URL into `server.js`'s environment

### Requirement: Shared supervisor primitives
The server-descriptor registry, process spawn/stop, HTTP health probing, restart-on-crash with backoff, ordered startup/shutdown, status inspection, and per-server log capture logic SHALL be provided by an Electron-agnostic shared module that takes `projectRoot`, `nodeBin`, `dataDir`, and `agentEnv` as inputs and does not depend on Electron APIs or `process.resourcesPath`. The desktop supervisor SHALL consume this shared module, preserving every existing `desktop-supervisor` scenario with no observable behavior change. The same shared module SHALL be reusable by the headless `local-services-launcher` so both entry points share one lifecycle implementation.

#### Scenario: desktop supervisor delegates to shared primitives
- **WHEN** the Electron app starts the supervisor
- **THEN** the supervisor constructs the shared `Supervisor` with bundle-resolved `nodeBin`, `projectRoot`, `dataDir`, and `agentEnv`
- **AND** ordered startup, health checking, restart-on-crash, ordered shutdown, status, and log capture behave exactly as before

#### Scenario: descriptor resolution is Electron-agnostic
- **WHEN** the shared descriptor resolver runs without `process.resourcesPath` (dev/headless mode)
- **THEN** it resolves bundled resources from `path.join(projectRoot, "resources")`
- **AND** chooses bundled-vs-external per service using the same rules as the packaged supervisor

#### Scenario: shared primitives serve the headless launcher
- **WHEN** the `local-services-launcher` constructs the shared `Supervisor` with dev-resolved parameters
- **THEN** it obtains identical lifecycle behavior (startup ordering, health, restart, shutdown, status, logs) to the desktop supervisor
- **AND** no supervisor lifecycle logic is duplicated
