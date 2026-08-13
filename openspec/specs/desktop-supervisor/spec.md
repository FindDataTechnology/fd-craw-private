# desktop-supervisor Specification

## Purpose
TBD - the desktop-supervisor capability governs the Electron main process that supervises bundled child processes (server.js, OpenConnector, LiteLLM, Postgres). The shared, Electron-agnostic `supervisor/` package owns the orchestration: descriptor registry, ordered startup with dependency readiness, health checking, automatic restart, ordered shutdown, status inspection, log capture, graceful degradation of optional servers, and port management. The manifest-gated descriptor resolution is covered under this spec; additional requirements are tracked under separate capabilities (e.g. local-services-launcher).

## Requirements

### Requirement: Manifest-gated bundled service descriptors
The supervisor SHALL generate a bundled-spawn descriptor for LiteLLM, OpenConnector, or Postgres only when the component is both selected in the resolved bundle manifest AND its bundled resources are present on disk AND no external URL (`*_BASE_URL` / `DATABASE_URL`) overrides it. A component excluded from the manifest SHALL be treated exactly as if its bundled resources were absent, falling through to the external-URL descriptor path (enabled only when an external URL is configured). External-URL operation SHALL remain available regardless of manifest selection.

#### Scenario: deselected component does not spawn
- **WHEN** the bundle manifest excludes OpenConnector and bundled OpenConnector resources exist on disk
- **THEN** the supervisor SHALL NOT spawn OpenConnector
- **AND** the OpenConnector descriptor resolves to disabled unless `OPENCONNECTOR_BASE_URL` is an external URL

#### Scenario: external URL still works for a deselected component
- **WHEN** the bundle manifest excludes LiteLLM and `LITELLM_BASE_URL=https://litellm.example.com` is set
- **THEN** the supervisor SHALL health-check the external LiteLLM URL without spawning any local process

#### Scenario: selected component with resources spawns as before
- **WHEN** the bundle manifest selects LiteLLM, bundled resources are present, and no external URL is set
- **THEN** the supervisor spawns the bundled LiteLLM exactly as it does today

### Requirement: Server descriptor registry
The supervisor SHALL manage a registry of server descriptors. Each descriptor SHALL declare the server's id, runtime kind (`node` / `python` / `http-external`), start command, working directory, environment, transport (`http-port` or `stdio-rpc`), health-check probe, dependency list, and whether the server is optional.

#### Scenario: App launches with the default servers
- **WHEN** the Electron app starts
- **THEN** the supervisor loads descriptors for `server.js`, `pi-agent`, `postgres`, `litellm`, and `openconnector`
- **AND** begins orchestrating them according to their declared dependencies

### Requirement: Ordered startup with dependency readiness
The supervisor SHALL start servers in dependency order and SHALL wait for each server's health check to pass before starting servers that depend on it.

#### Scenario: bundled sidecars warm up before server.js
- **WHEN** the app starts with bundled OpenConnector and LiteLLM resources
- **THEN** the supervisor starts `postgres`/`litellm`/`openconnector` first and waits for each dependent server's health check to pass
- **BEFORE** `server.js` finishes startup against the spawned sidecar URLs

#### Scenario: external servers are health-checked, not spawned
- **WHEN** `litellm` and `openconnector` are configured as `http-external` (URLs only)
- **THEN** the supervisor polls their health endpoints
- **AND** does NOT spawn a process for them
- **AND** marks them green or red without blocking app launch when they are optional

### Requirement: Health checking per transport
The supervisor SHALL health-check each running server on an interval using a transport-appropriate probe: an HTTP `GET` for `http-port` / `http-external` servers, and a TCP connection for descriptors that declare a `tcp` health kind (e.g. bundled Postgres).

#### Scenario: HTTP server health
- **WHEN** `server.js` is running on its assigned port
- **THEN** the supervisor periodically issues an HTTP health request and marks it healthy on a 2xx response

#### Scenario: TCP server health
- **WHEN** bundled Postgres is running on its assigned port
- **THEN** the supervisor marks it healthy when a TCP connection to the port succeeds

### Requirement: Automatic restart on unexpected failure
The supervisor SHALL restart a server process if it exits unexpectedly, subject to a backoff policy, and SHALL NOT restart a server that exited because the app is shutting down.

#### Scenario: crashed server self-heals
- **WHEN** a spawned server process exits unexpectedly
- **THEN** the supervisor restarts it after a backoff delay
- **AND** the window and other servers remain unaffected

#### Scenario: no restart during shutdown
- **WHEN** the user quits the app
- **THEN** the supervisor stops all servers without triggering restart logic

### Requirement: Ordered shutdown
The supervisor SHALL stop servers in reverse dependency order on app quit, terminating each child process gracefully and then forcibly after a timeout.

#### Scenario: shutdown order
- **WHEN** the app quits
- **THEN** the supervisor stops the spawned servers in reverse startup order, terminating each child process gracefully and then forcibly after a timeout

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
- **THEN** it passes the resolved `LITELLM_BASE_URL` and `OPENCONNECTOR_BASE_URL` into `server.js`'s environment when those sidecars are bundled
- **AND** `server.js` discovers the spawned sidecars via those URLs
