# litellm-web Specification

## Purpose
TBD - created by archiving change chat-commands-and-session-fixes. Update Purpose after archive.
## Requirements
### Requirement: Server reverse-proxies the LiteLLM management UI with token injection
When LiteLLM is configured (`LITELLM_BASE_URL` and `LITELLM_API_KEY` set), the server SHALL mount a reverse proxy that forwards the LiteLLM dashboard (served at `/ui` and `/ui/*`) and its root-level API/asset paths to the configured LiteLLM base URL, forwarding the request method, body, and query string. The proxy SHALL forward the client's `Authorization` header when present (the embedded dashboard extracts a virtual key from its session JWT and sends it as a Bearer token; this is required so `/user/info` authenticates as the session user rather than returning `user_id: null`). When the client sends no `Authorization` (e.g. the application's own server-side calls), the proxy SHALL authenticate to LiteLLM using the server-held `LITELLM_API_KEY` as a bearer token. The proxy SHALL forward the client's `token` session cookie so endpoints that read the cookie authenticate correctly. The proxy SHALL constrain upstream requests to the configured LiteLLM base URL. Content-encoding and content-length SHALL NOT be forwarded (Node's fetch decompresses the body; express recomputes length).

#### Scenario: dashboard's virtual-key Authorization is forwarded
- **WHEN** the embedded LiteLLM dashboard sends a request to `/user/info` with `Authorization: Bearer <virtual_key>` (extracted from its session JWT)
- **THEN** the server SHALL forward that `Authorization` header to LiteLLM
- **AND** LiteLLM SHALL authenticate as the session user (non-null `user_id`)

#### Scenario: server-held key injected when no client Authorization
- **WHEN** the application makes a server-side call to a LiteLLM proxied path with no client `Authorization` header
- **THEN** the server SHALL authenticate to LiteLLM using the server-held `LITELLM_API_KEY`

#### Scenario: token cookie forwarded
- **WHEN** the embedded dashboard sends a request with a `token` session cookie
- **THEN** the server SHALL forward the cookie to LiteLLM

### Requirement: LiteLLM SPA absolute API paths are proxied at the root
Because the LiteLLM management UI is a SPA that issues same-origin absolute requests for its API and assets, the server SHALL proxy the SPA's non-conflicting roots (`/ui` and `/ui/*` verbatim, `/key/*`, `/spend/*`, `/model/*`, `/models`, `/user/*`, `/v2/*`, `/get/*`, `/get_image`, `/get_favicon`, `/sso/*`, `/login`, `/logout`, `/litellm-asset-prefix/*`) at the server root to the LiteLLM base URL whenever LiteLLM is configured, and the contested roots (`/v1/*` and a `/api/*` catch-all) ONLY when the OpenConnector module is not enabled. The `/api/*` catch-all SHALL be registered after the application's own `/api/*` routes so those take precedence. These paths SHALL also be excluded from the application's SPA catch-all (which would otherwise serve the React app's `index.html` and break dashboard hydration); the `/ui` exclusion SHALL match any path beginning with `/ui` (including `/ui.txt?_rsc=` Next.js RSC probes) so they reach LiteLLM rather than the SPA.

#### Scenario: non-conflicting root proxied whenever LiteLLM is configured
- **WHEN** the embedded LiteLLM UI requests an absolute path such as `/key/info`, `/model/info`, `/v2/model/info`, `/user/info`, `/models`, `/get/litellm_model_cost_map`, or `/get_image`
- **THEN** the server SHALL proxy it to the LiteLLM base URL, whether or not OpenConnector is enabled

#### Scenario: dashboard Models page populates through the proxy
- **WHEN** the embedded dashboard's Models view fetches `/v2/model/info` and `/get/litellm_model_cost_map`
- **THEN** the server SHALL proxy them to LiteLLM and return JSON (not the React app's `index.html`)
- **AND** the Models table SHALL render the configured models

#### Scenario: Next.js RSC probe does not hit the SPA catch-all
- **WHEN** the embedded dashboard requests `/ui.txt?_rsc=<token>`
- **THEN** the server SHALL proxy it to LiteLLM (which returns 404) rather than serving the React app's `index.html`

#### Scenario: contested root proxied only when OpenConnector is disabled
- **WHEN** the embedded LiteLLM UI requests `/v1/models` and OpenConnector is disabled
- **THEN** the server SHALL proxy it to the LiteLLM base URL

#### Scenario: app's own API routes take precedence over the catch-all
- **WHEN** the browser requests `/api/documents` or `/api/config`
- **THEN** the server SHALL route it to the application's own handler, not the LiteLLM proxy

### Requirement: LiteLLM web proxy degrades gracefully
When LiteLLM is not configured, the server SHALL NOT mount the `/litellm-web` proxy and the LiteLLM sidebar entry SHALL be absent. When LiteLLM is configured but unreachable, the proxy SHALL surface a clear error without crashing the server.

#### Scenario: LiteLLM not configured
- **WHEN** `LITELLM_BASE_URL` or `LITELLM_API_KEY` is unset
- **THEN** the server SHALL start without mounting `/litellm-web`
- **AND** the LiteLLM sidebar entry SHALL NOT be rendered

#### Scenario: LiteLLM unreachable during a proxied request
- **WHEN** LiteLLM is unreachable while proxying a `/litellm-web` request
- **THEN** the server SHALL return an error response to the browser
- **AND** SHALL NOT crash or abort other requests

### Requirement: Server exposes LiteLLM-enabled state to the client
The server SHALL include a boolean `litellmEnabled` field in the `/api/config` JSON response indicating whether LiteLLM is configured (`LITELLM_BASE_URL` and `LITELLM_API_KEY` both set). The server SHALL also include `litellmManagementUrl` (the LiteLLM management UI URL, `${LITELLM_BASE_URL}/ui`) when LiteLLM is configured, and `null` otherwise. The client SHALL use `litellmEnabled` to decide whether to render the LiteLLM sidebar entry and view.

#### Scenario: LiteLLM configured
- **WHEN** the client requests `/api/config` and LiteLLM is configured
- **THEN** the response SHALL include `litellmEnabled: true` and a non-null `litellmManagementUrl`

#### Scenario: LiteLLM not configured
- **WHEN** the client requests `/api/config` and LiteLLM is not configured
- **THEN** the response SHALL include `litellmEnabled: false` and `litellmManagementUrl: null`

### Requirement: LiteLLM view embeds the management UI with server-side auto-login
The LiteLLM sidebar entry SHALL switch the main content area to a view that embeds the LiteLLM management dashboard in a same-origin `<iframe>` whose `src` is `/ui`. The server SHALL auto-login the embedded session: when the iframe requests `/ui` (or `/ui/`) with no `token` cookie, the server SHALL POST `/login` to LiteLLM with username `admin` and the server-held `LITELLM_API_KEY`, cache the returned session JWT, and return a 303 response with `Set-Cookie: token=<JWT>` and `Location: /ui/?userID=<userID>`. The `<userID>` SHALL be read from the cached JWT's `user_id` claim. The UI SHALL NOT render a master-key bar or any sign-in credential affordance; the user SHALL NOT be required to manually authenticate to the embedded dashboard.

#### Scenario: first visit auto-logs in
- **WHEN** the user activates the LiteLLM view with no prior `token` cookie
- **THEN** the server SHALL return a 303 that sets the `token` cookie and redirects to `/ui/?userID=<userID>`
- **AND** the iframe SHALL load the authenticated dashboard without a login form

#### Scenario: no master-key bar is rendered
- **WHEN** the LiteLLM view is displayed
- **THEN** the UI SHALL NOT render a master-key bar, credential display, or copy-to-clipboard affordance above the iframe

### Requirement: Auto-login is idempotent across navigations
The server SHALL ensure that every navigation to `/ui` or `/ui/` that lacks a `?userID=` query parameter redirects to `/ui/?userID=<userID>` before serving the dashboard, regardless of prior cookie state. When a `token` cookie is already present, the server SHALL issue a 302 redirect to `/ui/?userID=<userID>` (without re-performing the `/login` POST). When no `token` cookie is present, the server SHALL perform the full auto-login 303. This prevents the dashboard from clearing the cookie and bouncing to the login page on re-navigation.

#### Scenario: re-navigation with existing cookie stays authenticated
- **WHEN** the user activates the LiteLLM view again while a `token` cookie is already set and the request URL lacks `?userID=`
- **THEN** the server SHALL redirect to `/ui/?userID=<userID>` (302)
- **AND** the iframe SHALL load the authenticated dashboard, NOT the login page

#### Scenario: rapid repeated activations never show the login page
- **WHEN** the user clicks the LiteLLM nav entry repeatedly in quick succession
- **THEN** the iframe SHALL always land on the authenticated dashboard
- **AND** SHALL NOT show the `/sso/key/generate` login page

### Requirement: Embedded dashboard renders all management views identically to standalone
The embedded LiteLLM dashboard SHALL render every management view (Virtual Keys, Models, Usage, Teams, etc.) identically to the standalone dashboard accessed directly at the LiteLLM base URL. The proxy SHALL NOT cause any management view to fail to render, show empty content, or make fewer API requests than the standalone dashboard. In particular, the Models view (navigated via the dashboard's `?page=models` query-param nav) SHALL render the models list with "All Models" / "Add Model" / model rows, matching the standalone dashboard.

#### Scenario: Models view renders through the proxy
- **WHEN** the user clicks the Models nav in the embedded dashboard
- **THEN** the Models view SHALL render the models list (e.g. "All Models", "Add Model")
- **AND** the view SHALL match the standalone dashboard's Models view rendered at the LiteLLM base URL directly

### Requirement: Server surfaces a reachable LiteLLM API base URL for direct API use
When LiteLLM is configured and running locally (`LITELLM_BASE_URL` points at `localhost` or `127.0.0.1`), the server SHALL include the live `LITELLM_BASE_URL` - the actually-running proxy's base, including its dynamic port - as `apiBaseUrl` in the `/api/litellm/credentials` JSON response, alongside the `masterKey`. The `apiBaseUrl` SHALL reflect the proxy the server is currently configured against (not a stale `.env` value), so a client can call `${apiBaseUrl}/v1/...` authenticated with the bearer `masterKey`. The base URL is not a secret and is already derivable from `litellmManagementUrl`; the `masterKey` SHALL continue to be gated on the local-proxy condition. When LiteLLM is configured against a non-local (remote) URL, `apiBaseUrl` SHALL be `null` and `masterKey` SHALL remain `null` (no key or reachable-local-URL is surfaced).

#### Scenario: local LiteLLM exposes the API base URL
- **WHEN** the client requests `/api/litellm/credentials` and LiteLLM is configured against a local URL
- **THEN** the response SHALL include `apiBaseUrl` set to the live `LITELLM_BASE_URL` including the dynamic port
- **AND** SHALL include `masterKey` set to the server-held `LITELLM_API_KEY`

#### Scenario: remote LiteLLM does not expose the API base URL or key
- **WHEN** the client requests `/api/litellm/credentials` and LiteLLM is configured against a non-local URL
- **THEN** the response SHALL include `apiBaseUrl: null` and `masterKey: null`

### Requirement: LiteLLM view displays the API base URL and master key
The LiteLLM view SHALL display the `apiBaseUrl` and `masterKey` (when non-null) as copyable fields alongside the open-in-new-tab management dashboard link, so the user can access the LiteLLM API directly. When both are null (remote proxy), the view SHALL show the sign-in hint without the copyable fields. The dashboard link SHALL continue to open `litellmManagementUrl` in a new tab; no iframe SHALL be embedded for the LiteLLM dashboard.

#### Scenario: local LiteLLM view shows the API URL and key
- **WHEN** the user opens the LiteLLM view and LiteLLM is configured against a local URL
- **THEN** the view SHALL render copyable `apiBaseUrl` and `masterKey` fields
- **AND** SHALL render the open-in-new-tab dashboard link to `litellmManagementUrl`

#### Scenario: remote LiteLLM view omits the copyable fields
- **WHEN** the user opens the LiteLLM view and LiteLLM is configured against a non-local URL
- **THEN** the view SHALL NOT render the copyable `apiBaseUrl`/`masterKey` fields
- **AND** SHALL render the dashboard link and a sign-in hint

