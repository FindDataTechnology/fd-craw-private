// open-connector.js
// Thin HTTP client + proxy for an externally-run OpenConnector runtime.
//
// OpenConnector (https://github.com/oomol-lab/open-connector) is an open-source
// connector gateway (a Composio alternative) that connects 1,000+ SaaS providers
// and exposes their Actions to agents through MCP, HTTP, and OpenAPI while
// keeping provider credentials inside its own runtime boundary.
//
// Prerequisite (documented, not automated): run an OpenConnector runtime
// separately first - e.g. clone the repo and `docker compose up`, which serves
// http://localhost:3000 - then connect a provider. Set OPENCONNECTOR_BASE_URL
// (and optionally the runtime/admin tokens) in .env to enable this module.
//
// This module does NOT embed or fork the gateway. It only:
//   - calls the runtime's HTTP API (/v1/* with the runtime token, /api/* with
//     the admin token) on behalf of the browser-facing /api/openconnector/* proxy
//     in server.js, so tokens never reach the browser;
//   - builds the MCP server config that registers the runtime's /mcp endpoint
//     with the agent (handled by mcp-bridge.js), so the agent can call the
//     discovery toolset (list_apps, search_actions, get_action_guide,
//     execute_action) and therefore any connected provider's Actions.
//
// All durable state (connections, credentials, runs) lives in the runtime; this
// module holds only the in-memory config read at startup.

const OPENCONNECTOR_BASE_URL = process.env.OPENCONNECTOR_BASE_URL || "";
const OPENCONNECTOR_RUNTIME_TOKEN = process.env.OPENCONNECTOR_RUNTIME_TOKEN || "";
const OPENCONNECTOR_ADMIN_TOKEN = process.env.OPENCONNECTOR_ADMIN_TOKEN || "";

// Trim a trailing slash so endpoint paths can be appended cleanly.
const baseUrl = OPENCONNECTOR_BASE_URL.trim().replace(/\/+$/, "");

// Enabled iff a base URL is configured. Computed at import so server.js can gate
// endpoint mounting and MCP registration without calling init first.
export const openConnectorEnabled = Boolean(baseUrl);

// Validate/log at startup (mirrors the LiteLLM provider pattern in server.js).
export function initOpenConnector() {
  if (!openConnectorEnabled) {
    console.warn("[open-connector] OPENCONNECTOR_BASE_URL not set; open-connector disabled");
    return false;
  }
  console.log(`[open-connector] Enabled (runtime: ${baseUrl})`);
  return true;
}

// Error carrying the runtime's HTTP status and (when available) its JSON
// envelope, so Express handlers can surface the runtime's own message to the UI.
export class OpenConnectorError extends Error {
  constructor(status, envelope) {
    super(envelope?.message || `OpenConnector request failed (${status})`);
    this.name = "OpenConnectorError";
    this.status = status;
    this.envelope = envelope;
  }
}

// Core fetch helper. `tokenType` selects which server-held token to send:
// "runtime" for /v1/* + /mcp, "admin" for /api/*. Client-supplied headers are
// never forwarded - the caller cannot override the token (see task 2.6). Any
// `headers` passed here are server-built (e.g. x-oo-connector-alias) and merged
// on top of the JSON content-type + auth header.
async function runtimeFetch(path, { method = "GET", body, tokenType = "runtime", headers = {} } = {}) {
  const url = `${baseUrl}${path}`;
  const reqHeaders = { "content-type": "application/json", ...headers };
  const token = tokenType === "admin" ? OPENCONNECTOR_ADMIN_TOKEN : OPENCONNECTOR_RUNTIME_TOKEN;
  if (token) reqHeaders.authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network/DNS/refused - the runtime is not reachable.
    throw new OpenConnectorError(503, { success: false, message: `runtime unreachable: ${err.message}` });
  }

  const text = await res.text();
  let envelope = null;
  try {
    envelope = text ? JSON.parse(text) : null;
  } catch {
    envelope = { success: false, message: text || res.statusText };
  }

  if (!res.ok || envelope?.success === false) {
    throw new OpenConnectorError(res.status, envelope || { success: false, message: res.statusText });
  }
  return envelope;
}

// ── Proxy helpers (each returns the runtime's { success, message, data, meta }) ─

export async function getHealth() {
  return runtimeFetch("/v1/health", { tokenType: "runtime" });
}

export async function getProviders() {
  return runtimeFetch("/api/providers", { tokenType: "admin" });
}

export async function getActions({ service } = {}) {
  const qs = service ? `?service=${encodeURIComponent(service)}` : "";
  return runtimeFetch(`/v1/actions${qs}`, { tokenType: "runtime" });
}

export async function searchActions(q) {
  return runtimeFetch(`/v1/actions/search?q=${encodeURIComponent(q || "")}`, { tokenType: "runtime" });
}

export async function getAction(actionId) {
  return runtimeFetch(`/v1/actions/${encodeURIComponent(actionId)}`, { tokenType: "runtime" });
}

// The agent guide is markdown, not a JSON envelope - fetch it directly.
export async function getActionGuide(actionId) {
  const url = `${baseUrl}/api/actions/${encodeURIComponent(actionId)}/agent.md`;
  const headers = {};
  if (OPENCONNECTOR_ADMIN_TOKEN) headers.authorization = `Bearer ${OPENCONNECTOR_ADMIN_TOKEN}`;
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new OpenConnectorError(503, { success: false, message: `runtime unreachable: ${err.message}` });
  }
  if (!res.ok) {
    throw new OpenConnectorError(res.status, { success: false, message: `guide fetch failed (${res.status})` });
  }
  return res.text();
}

export async function getConnections() {
  return runtimeFetch("/api/connections", { tokenType: "admin" });
}

// Only the documented fields are forwarded - never arbitrary body keys (task 2.6).
export async function putConnection(service, { authType, values, connectionName } = {}) {
  const body = { authType, values };
  if (connectionName) body.connectionName = connectionName;
  return runtimeFetch(`/api/connections/${encodeURIComponent(service)}`, {
    method: "PUT",
    body,
    tokenType: "admin",
  });
}

export async function deleteConnection(service) {
  return runtimeFetch(`/api/connections/${encodeURIComponent(service)}`, {
    method: "DELETE",
    // The runtime requires a valid JSON body even for DELETE (sends 400
    // "Request body must be valid JSON" otherwise), so send an empty object.
    body: {},
    tokenType: "admin",
  });
}

// Execute an Action. The connection alias is sent via the x-oo-connector-alias
// header (the runtime also accepts ?alias=, but the header is canonical).
export async function executeAction(actionId, { input, alias } = {}) {
  const headers = {};
  if (alias) headers["x-oo-connector-alias"] = alias;
  return runtimeFetch(`/v1/actions/${encodeURIComponent(actionId)}`, {
    method: "POST",
    body: { input: input ?? {} },
    tokenType: "runtime",
    headers,
  });
}

export async function getRuns() {
  return runtimeFetch("/api/runs", { tokenType: "admin" });
}

// ── Config exposed to the browser (NEVER includes tokens) ──────────────────────

export function getPublicConfig() {
  return { enabled: openConnectorEnabled, baseUrl: openConnectorEnabled ? baseUrl : null };
}

// ── MCP server config for the agent bridge ────────────────────────────────────
// Returns an http MCP server entry (consumed by mcp-bridge.js) pointing at the
// runtime's /mcp endpoint with the runtime token as a Bearer header, or null
// when the module is disabled.
export function buildMcpServerConfig() {
  if (!openConnectorEnabled) return null;
  const cfg = { url: `${baseUrl}/mcp` };
  if (OPENCONNECTOR_RUNTIME_TOKEN) {
    cfg.headers = { Authorization: `Bearer ${OPENCONNECTOR_RUNTIME_TOKEN}` };
  }
  return cfg;
}

// ── Native web UI reverse proxy support ──────────────────────────────────────
// Exposed so server.js can mount a token-injecting reverse proxy of the runtime's
// own web UI at /oc-web/*. The browser loads it in a same-origin iframe and never
// sees the runtime URL or the tokens.

export function getRuntimeBase() {
  return baseUrl;
}

// Pick the server-held token for a given upstream path: admin for the UI shell
// and /api/* (management surface), runtime for /v1/* and /mcp (action calls).
export function tokenForPath(upPath) {
  const p = (upPath || "").replace(/^\/+/, "");
  if (p.startsWith("v1") || p.startsWith("mcp")) {
    return OPENCONNECTOR_RUNTIME_TOKEN;
  }
  return OPENCONNECTOR_ADMIN_TOKEN;
}
