# agent-catalog Specification

## Purpose
Defines how the platform serves its agent and app catalog — merging local `agents.json`, the cloud `AGENTS_CONFIG_URL` document, and registry agent entries into one role-filtered, secret-redacted entry list — and how selection works across the Agents & Apps page and the chat control strip: the built-in local runtime, remote `chat` entries served locally through generated persona presets (remote fork only as a fallback), `link` entries, and bound `app` entries via the Nango connect broker.

## Requirements

### Requirement: Catalog entry types

The catalog SHALL accept entries of three types: `agent-local` (the built-in agent session, now backed by the dsh runtime instead of the pi session), `agent-remote` (an external agent reached over an OpenAI-compatible HTTP API, with `mode` either `chat` or `link`), and `app` (a third-party bound application, with `kind` either `link` or `nango-connect`). Every entry SHALL have a unique `id`, MAY declare `roles` (a list of group names restricting visibility) and a display `name`.

#### Scenario: Built-in agent is always present

- **WHEN** the catalog is served
- **THEN** the built-in `agent-local` entry represents the dsh-backed agent session, and selecting it behaves exactly as before this change (prompts route to the dsh runtime via the bridge)

#### Scenario: Invalid entries are skipped

- **WHEN** a catalog source contains an entry with an unknown `type`, a duplicate `id`, or a `chat`-mode `agent-remote` missing `baseUrl` or `model`
- **THEN** the server logs a warning, drops that entry, and serves the rest of the catalog

### Requirement: Dual-source configuration with cloud precedence
The catalog SHALL merge three optional sources: a local `agents.json` file (sibling of `mcp.json`, gitignored), a cloud JSON document fetched from `AGENTS_CONFIG_URL` (same schema, top-level `agents` and `apps` arrays), and agent entries from the configured mcp-gateway-registry (`GET /api/agents`, using the market registry env vars). Registry agent entries SHALL be adapted to `agent-remote` entries in `link` mode (external URL) unless the registry entry declares an OpenAI-compatible endpoint, in which case `chat` mode applies with `baseUrl` and `model` mapped and the key resolved from an env var reference. Registry group membership SHALL map to the catalog entry's `roles` (no groups ⇒ visible to everyone). On `id` collision the later source SHALL win, in the order built-in → registry → `agents.json` → cloud: local overrides remote, and the cloud remains the live control plane even for ids first defined elsewhere. When the registry or cloud fetch fails, the server SHALL keep serving the last successfully fetched entries and log a warning.

#### Scenario: Cloud entry overrides local
- **WHEN** `agents.json` defines an entry with id `junior` and the cloud document defines an entry with the same id
- **THEN** the merged catalog contains the cloud version of `junior`

#### Scenario: Cloud outage does not clear the catalog
- **WHEN** `AGENTS_CONFIG_URL` becomes unreachable after a successful fetch
- **THEN** the catalog keeps the last good cloud entries and the server logs a warning instead of dropping them

#### Scenario: Registry entry is shadowed by any local definition
- **WHEN** the registry defines an agent with id `junior` and `agents.json` also defines `junior`
- **THEN** the merged catalog contains the `agents.json` version of `junior`
- **AND** a cloud entry with the same id still wins over both

#### Scenario: Registry groups gate visibility
- **WHEN** a registry agent belongs to registry group `team-a` and the requesting user's groups do not include `team-a`
- **THEN** the entry SHALL be mapped with `roles: ["team-a"]` and SHALL NOT appear in that user's `GET /api/catalog`

#### Scenario: Registry outage does not clear the catalog
- **WHEN** the registry becomes unreachable after a successful fetch
- **THEN** the catalog keeps the last-good registry entries and the server logs a warning instead of dropping them

### Requirement: Periodic refresh with live propagation
The server SHALL re-fetch the cloud document AND the registry agents every `CATALOG_REFRESH_SECS` seconds (default 60) and on `POST /api/catalog/refresh`. When the merged catalog changes, the server SHALL broadcast a `catalog_changed` event over WebSocket; clients react by refetching `GET /api/catalog`.

#### Scenario: Cloud edit reaches connected clients
- **WHEN** an entry is added to the cloud document and the next refresh runs
- **THEN** all connected WebSocket clients receive `catalog_changed` and a subsequent `GET /api/catalog` includes the new entry

#### Scenario: Registry agent reaches connected clients
- **WHEN** an agent is registered in the registry and the next refresh runs
- **THEN** all connected WebSocket clients receive `catalog_changed` and a subsequent `GET /api/catalog` includes the new entry for users whose groups permit it

#### Scenario: Manual refresh
- **WHEN** `POST /api/catalog/refresh` is called by a user whose groups include `admin` (by any client when auth is off)
- **THEN** the cloud document and registry agents are re-fetched immediately and the response returns the refreshed, redacted catalog

### Requirement: Role-based visibility

An entry with a non-empty `roles` array SHALL be included in `GET /api/catalog` only when the requesting user's groups intersect the entry's `roles`. Entries with empty or absent `roles` SHALL be visible to everyone. When authentication is off, the requester is the machine owner and all entries SHALL be visible — matching the auth-off owner semantics of administrator gating and market visibility filtering (a deployment with no identities has no one to exclude).

#### Scenario: Role-gated entry hidden from plain users

- **WHEN** a user with groups `["dev"]` requests the catalog and an entry declares `roles: ["admin"]`
- **THEN** that entry is absent from the response

#### Scenario: Auth-off requester sees role-gated entries

- **WHEN** authentication is off and the catalog contains entries declaring `roles`
- **THEN** those entries are present in the response, because the requester is the machine owner

### Requirement: Secret redaction

Client-facing catalog payloads SHALL NOT include API keys or tokens. Remote-agent entries reference secrets by `apiKeyEnv` (a server environment variable name) resolved server-side at call time; a literal `apiKey` in a source document, if used, SHALL be stripped from every client response along with the Nango secret.

#### Scenario: Catalog response carries no secrets

- **WHEN** any client calls `GET /api/catalog`
- **THEN** no entry in the response contains `apiKey`, a resolved key value, or `NANGO_SECRET_KEY`

### Requirement: Agent selection and remote chat streaming

The WebSocket protocol SHALL gain `set_agent` (client→server) and `agents` / `current_agent` / `agent_changed` (server→client), mirroring the model-selection messages.

While the active agent is a `chat`-mode `agent-remote`, the turn SHALL be served by the LOCAL runtime when the deployment has generated a persona preset for that entry (see the new requirement below) — the entry's identity becomes the session's persona and the turn keeps the local runtime's tools (MCP servers, skills) and session history. Only when no persona preset exists for the entry SHALL a `prompt` be forwarded to the entry's OpenAI-compatible `/chat/completions` endpoint with `stream: true`; that fork SHALL replay the session's mirrored turns (most recent first up to a bounded count) plus a system message naming the entry, so a remote turn is not a standalone question. In both cases SSE deltas are re-broadcast as the existing `text` events, completion as `done`, and failures as `error`. Agent switching SHALL be rejected while a prompt is streaming.

#### Scenario: Chatting with a locally-served agent

- **WHEN** the user selects a `chat`-mode remote agent the deployment serves locally and sends two prompts in one session
- **THEN** both turns run on the local runtime — the second sees the first, and tools the deployment composed (MCP servers, skills) are available — with the entry's name/description as the persona

#### Scenario: Chatting with a remote agent

- **WHEN** no persona preset exists for the selected entry and the user sends a prompt
- **THEN** streamed completions render in the chat UI through the existing `text` events and finish with `done`, with no frontend changes beyond agent selection

#### Scenario: Forked remote agent keeps the conversation

- **WHEN** the user sends a second prompt to a forked remote agent in the same session
- **THEN** the request carries the session's prior turns (bounded) so the entry can follow up on what it already said

#### Scenario: Remote failure surfaces as error

- **WHEN** the remote endpoint returns an error or the stream aborts mid-flight
- **THEN** the client receives an `error` event and the server returns to the non-streaming state

#### Scenario: Switch blocked mid-stream

- **WHEN** a `set_agent` message arrives while a prompt is streaming
- **THEN** the switch is rejected, mirroring `set_model` behavior

### Requirement: Catalog chat agents are served with local persona presets

Every `chat`-mode `agent-remote` catalog entry SHALL be served by the local runtime through a generated agent preset: the deployment SHALL compose one preset per entry from the shipped `standard` agent-plane composition, replacing only the persona row's text with a persona derived from the entry (its `persona` field when present, else its `name`/`description`/`tags`), and SHALL write it into the preset roster's user root so the existing roster/picker/switch machinery applies it. Generated presets SHALL carry a marker file so hand-authored user presets are never overwritten or pruned, SHALL be pruned when their entry leaves the catalog, SHALL NOT shadow a shipped preset id, and SHALL be regenerated (with an idle-runtime restart) whenever the merged catalog changes. An entry MAY declare `local: false` to stay a remote service instead: it gets no preset and its turns fork as before. The persisted agent-preset preference SHALL be validated against the presets the deployment can actually mount before the runtime spawns, falling back to the deployment default so a stale id can never fail session creation.

#### Scenario: A pack agent keeps the platform's capabilities

- **WHEN** the user selects a vertical-pack agent and asks a question in its domain
- **THEN** the turn runs on the local runtime with the pack's persona, the deployment's MCP servers and skills available, and the session's prior turns in context

#### Scenario: Selecting the agent is a preset switch

- **WHEN** the user selects a locally-served catalog agent while the runtime is idle
- **THEN** the runtime restarts with that preset (the same path as a model or preset switch), `agent_changed` lands after the switch, and the session header names the agent; a switch requested while a turn streams is rejected

#### Scenario: Switching back to the built-in agent

- **WHEN** the user selects the built-in `local` agent
- **THEN** the deployment's own persisted preset is restored, dropping the pack persona

#### Scenario: Departed entry leaves no broken selection

- **WHEN** a catalog entry that had a generated preset disappears from the catalog
- **THEN** its preset directory is pruned, the selection falls back to the built-in agent, and clients are told through `agent_changed`

### Requirement: Link agents

A `link`-mode `agent-remote` entry carries a `url`; the Agents page SHALL present it as an external link, and PAAS SHALL NOT proxy or embed it.

#### Scenario: Link agent on the page

- **WHEN** the catalog contains a `link`-mode remote agent
- **THEN** the Agents & Apps page shows it as a link that opens its `url` in a new tab

### Requirement: App entries and the Nango connect broker

`app` entries of `kind: "link"` carry a `url` opened externally. Entries of `kind: "nango-connect"` declare `nangoUrl`, `connectUiUrl`, and `apiUrl`; `POST /api/apps/:id/connect` SHALL mint a Nango connect session server-side using the server-held `NANGO_SECRET_KEY` (POST `<nangoUrl>/connect/sessions` with tags `end_user_id` / `end_user_email` / `organization_id` derived from the requesting user's email) and return the Connect UI URL with `session_token` and `apiURL` query params. The endpoint SHALL return an error when authentication is off, since there is no identity to tag.

#### Scenario: Bound-app connect flow

- **WHEN** an authenticated user triggers connect on a `nango-connect` entry
- **THEN** they are redirected to the Connect UI with a freshly minted session token whose tags carry their email, and the Nango secret never appears in any client-visible payload

#### Scenario: Broker unavailable without auth

- **WHEN** `AUTH_MODE` is off and `POST /api/apps/:id/connect` is called
- **THEN** the server responds with an error explaining the flow requires login

### Requirement: v1 shared-session ceiling

In v1 the local agent remains one shared session for all clients — now a single shared dsh runtime subprocess, not a per-connection or per-user dsh session. Remote-agent chats are broadcast to all connected clients and are not persisted into chat-history, and there is no per-user isolation of sessions or documents. This ceiling SHALL be documented rather than silently discovered.

#### Scenario: Remote chat visibility

- **WHEN** two clients are connected and one chats with a remote agent
- **THEN** both clients see the streamed `text` events, consistent with the existing shared-session broadcast model

### Requirement: Agents & Apps page is a top-level route with sub-tabs
The `/agents` route SHALL be a top-level page (replacing the legacy location; no parent shell). The page SHALL render two sub-tabs: **Agents** and **Apps**, with a stable `?tab=apps|agents` query parameter for deep-linking. The Agents sub-tab SHALL list `agent-local` and `agent-remote` entries. The Apps sub-tab SHALL list `app` entries (link, nango-connect, external-service). Sub-tab selection SHALL persist in the URL. On initial load with no query parameter, the Agents sub-tab SHALL be active.

#### Scenario: default to Agents sub-tab
- **WHEN** the user navigates to `/agents` with no query parameter
- **THEN** the Agents sub-tab SHALL be active and the Agents section SHALL be visible

#### Scenario: deep-link to Apps
- **WHEN** the user navigates to `/agents?tab=apps`
- **THEN** the Apps sub-tab SHALL be active and only app entries SHALL be visible
- **AND** the URL SHALL retain the query parameter after switching tabs

### Requirement: Catalog schema is unchanged by the agents page relocation
The agents page relocation to `/agents` (with Agents + Apps sub-tabs) SHALL only change the rendering surface; the entry schema, fetching, merge, role filter, and Nango broker SHALL be preserved unchanged.

#### Scenario: catalog behavior is preserved
- **WHEN** the catalog is served
- **THEN** all three entry types SHALL be returned in `GET /api/catalog` exactly as before
- **AND** the Agents sub-tab SHALL show `agent-local` and `agent-remote` entries
- **AND** the Apps sub-tab SHALL show `app` entries
