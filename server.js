import 'dotenv/config';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import litellmExtension from "pi-provider-litellm";
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { connectMcpServers, connectServers, closeMcpClients, connectSingleServer, disconnectSingleServer } from "./mcp-bridge.js";
import multer from "multer";
import { fetchLitellmModels } from "./litellm-models.js";
import * as chatHistory from "./chat-history.js";
import * as openConnector from "./open-connector.js";
import * as documents from "./documents.js";
import * as collections from "./collections.js";
import * as db from "./db.js";
import * as migrate from "./migrate.js";
import * as cron from "./cron.js";
import * as extensionStore from "./extension-store.js";
import * as workdirStore from "./workdir-store.js";
import * as catalog from "./catalog.js";
import { resolveBundleSafe } from "./bundle-manifest.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";

// ── Optional forward-auth (AUTH_MODE=forward_auth) ───────────────────────────
// Identity = proxy-injected X-Forwarded-Email / X-Forwarded-Groups headers
// (Caddy forward_auth → oauth2-proxy → Logto). TRUST BOUNDARY: enabling this
// asserts the server is reachable ONLY through the forward-auth proxy — bind
// to localhost / firewall it, otherwise these headers are attacker-controlled.
const AUTH_MODE = process.env.AUTH_MODE || "none";
const authEnabled = AUTH_MODE === "forward_auth";

function userFromHeaders(headers) {
  const email = headers["x-forwarded-email"];
  if (!email) return null;
  const groups = String(headers["x-forwarded-groups"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { email: String(email), groups };
}

// ── Custom provider config (Volces / 火山引擎) ────────────────────────────────

// Volces (火山引擎) chat provider is optional: an unset LLM_API_KEY means the
// provider is not registered and the server starts with no chat provider (chat
// non-functional, logged), mirroring the LiteLLM graceful-degrade convention.
// The documents RAG reads LLM_API_KEY separately via initStore().
const LLM_API_KEY = process.env.LLM_API_KEY?.trim();
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3";
const volcesEnabled = Boolean(LLM_API_KEY);

// Default chat model. When set, the agent session starts on this model id.
// Otherwise the server prefers the first LiteLLM model (when LiteLLM is configured)
// and falls back to the first Volces model. See resolveDefaultModel().
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "";

// ── LiteLLM proxy config (consumed by pi-provider-litellm) ───────────────────
// The extension reads LITELLM_BASE_URL / LITELLM_API_KEY from the environment
// (loaded from .env by dotenv/config above). When either is missing, the
// litellm provider is skipped so the server falls back to Volces (when
// LLM_API_KEY is set) or starts with no chat provider (logged).
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL?.trim();
const LITELLM_API_KEY = process.env.LITELLM_API_KEY?.trim();
const litellmEnabled = Boolean(LITELLM_BASE_URL && LITELLM_API_KEY);
if (!litellmEnabled) {
  console.warn("[litellm] LITELLM_BASE_URL or LITELLM_API_KEY not set; skipping litellm provider");
}

// ── Bundle manifest (packaged component selection + pre-installed extensions) ─
// Resolved once at startup. In the packaged app platform.bundle.json sits next
// to this file (Resources/app/); in dev it is the repo root. resolveBundleSafe
// never throws — a corrupt manifest falls back to all-components defaults.
const bundle = resolveBundleSafe();

// Split a manifest permissions policy ("mcp:<name>"/"skill:<name>" →
// { allow?, deny?, locked? }) into the extensions-DB columns: the locked flag
// plus the stored permissions JSON ({ allow?, deny? } — locked has its own column).
function splitPolicy(policy) {
  if (!policy) return { locked: false, permissions: null };
  const { allow, deny } = policy;
  const permissions =
    allow || deny ? { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } : null;
  return { locked: policy.locked === true, permissions };
}

// Returns true if a model is LiteLLM-routed: it has configured auth and is not
// the native Volces provider. The LiteLLM extension registers its models under
// upstream provider names (deepseek, volcengine, openrouter, …) - NOT a single
// "litellm" provider - so a `provider === "litellm"` check never matches them.
// When LiteLLM is enabled only the LiteLLM extension is registered, so every
// authed model is LiteLLM-routed; when it is not enabled only Volces is
// registered, so this returns false for all models.
function isLitellmModel(m) {
  return hasAuth(m) && m.provider !== "volces";
}

const app = express();
const server = http.createServer(app);
// noServer + manual handleUpgrade so WS upgrades pass the same forward-auth
// gate as HTTP requests (missing identity ⇒ handshake rejected with 401).
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (authEnabled && !userFromHeaders(req.headers)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Document collection: JSON bodies for text/url submissions; multipart file
// uploads are kept in memory (LlamaIndex readers read the buffer directly).
app.use(express.json());

// Forward-auth gate: when enabled, every HTTP request needs a proxy-injected
// identity; attaches req.user = { email, groups } for downstream handlers.
app.use((req, res, next) => {
  if (!authEnabled) return next();
  const user = userFromHeaders(req.headers);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  req.user = user;
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Agent session (module-scoped for WS handlers) ────────────────────────────

let session = null;
let isStreaming = false;
// Active catalog agent: "local" = the pi session above; any other id = a
// catalog agent-remote (chat mode) entry that prompts are forked to.
let currentAgentId = "local";
// True once any text_delta has been streamed during the current agent turn.
// Used by the agent_end handler to avoid re-broadcasting the full assistant
// text (which would duplicate what streaming already delivered), while still
// emitting it once as a fallback for non-streaming model responses.
let streamedTextThisTurn = false;
let modelRegistry = null;
let loader = null;
let mcpClients = [];
// Count of MCP tools registered with the agent (set after connectServers).
let mcpToolCount = 0;
// The model the agent session starts on (set during async init; read by the
// /api/supervisor/status route).
let defaultModel = null;
// Agent-building primitives cached by initAgent once and reused whenever the
// session is rebuilt for a different working directory (SDK fixes cwd at
// session creation, so switching folders means recreating the session).
let agentAuthStorage = null;
let agentMcpTools = [];
let agentMcpToolNames = [];
let agentProviderFactory = null;

// Models eligible for the selector/default/switching: those with configured
// auth. Because exactly one chat provider is registered (LiteLLM extension OR
// Volces - see extensionFactories), this naturally scopes to LiteLLM-only when
// LiteLLM is configured and Volces-only when it is not, with no provider
// allowlist needed. Unconfigured built-in providers (no API key) are excluded.
function hasAuth(m) {
  return modelRegistry?.hasConfiguredAuth?.(m) ?? false;
}


// Resolve the model the agent session starts on (passed explicitly to
// createAgentSession so LiteLLM is the default rather than the SDK's opaque
// "first available" heuristic). Order: DEFAULT_MODEL env -> first LiteLLM
// model (if enabled) -> first model with configured auth (Volces, when LiteLLM
// is not configured). When LiteLLM is enabled but no LiteLLM-routed model is
// resolvable (proxy unreachable at startup and the extension registered
// nothing), return null and log - do NOT silently fall back to Volces.
function resolveDefaultModel() {
  const available = modelRegistry?.getAvailable() ?? [];
  if (DEFAULT_MODEL) {
    const m = available.find((x) => x.id === DEFAULT_MODEL && hasAuth(x));
    if (m) return m;
    console.warn(`[model] DEFAULT_MODEL '${DEFAULT_MODEL}' not found among configured models`);
  }
  if (litellmEnabled) {
    const litellmModel = available.filter(hasAuth).find(isLitellmModel);
    if (litellmModel) return litellmModel;
    console.warn(
      "[model] LiteLLM enabled but no LiteLLM-routed model resolvable; not falling back to Volces"
    );
    return null;
  }
  return available.filter(hasAuth)[0];
}

const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

// Dashboard update throttling (max once every 2 seconds)
let dashboardUpdateTimer = null;
let pendingDashboardUpdate = false;

function throttleDashboardUpdate() {
  if (dashboardUpdateTimer) {
    pendingDashboardUpdate = true;
    return;
  }
  broadcast({ type: "dashboard_update", state: cron.getDashboardState() });
  dashboardUpdateTimer = setTimeout(() => {
    dashboardUpdateTimer = null;
    if (pendingDashboardUpdate) {
      pendingDashboardUpdate = false;
      throttleDashboardUpdate();
    }
  }, 2000);
}

// Mark the current agent turn finished: reset the streaming flag, broadcast
// `done` (which re-enables the UI / model selector and finalizes tool blocks),
// and refresh the sidebar session list. Idempotent per turn - it no-ops if the
// turn is already finished - so it is safe to call from both the `agent_end`
// event handler and the `prompt()` catch on failure, without risking a double
// `done`. This is what unblocks model-switching / new-session creation after a
// failed turn and keeps the sidebar in sync.
function finishTurn() {
  if (!isStreaming) return;
  isStreaming = false;
  broadcast({ type: "done" });
  chatHistory
    .listSessions()
    .then((sessions) =>
      broadcast({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
    )
    .catch((e) => console.error("[chat-history] list after done failed:", e.message));
}

// ── Skill helpers ────────────────────────────────────────────────────────────

// Parse a leading slash-command from a prompt. Returns one of:
//   { command: "skill", name, args }   - /skill:<name> [args]
//   { command: "model", args }          - /model [id]
//   { command: "new" | "clear" | "help", args: "" }
//   { command: null }                   - a "/…" token that is NOT a recognised
//                                         command (caller lets it fall through to
//                                         the agent as a normal prompt)
//   null                                - not a slash-command at all
// `/clear` and `/help` are client-handled (the UI should not forward them); if
// they reach the server they are treated as no-ops.
function parseCommand(text) {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const skillMatch = t.match(/^\/skill:([^\s]+)(?:[\s]+([\s\S]*))?$/);
  if (skillMatch) {
    return { command: "skill", name: skillMatch[1], args: (skillMatch[2] || "").trim() };
  }
  const modelMatch = t.match(/^\/model(?:[\s]+([\s\S]*))?$/i);
  if (modelMatch) {
    return { command: "model", args: (modelMatch[1] || "").trim() };
  }
  const simpleMatch = t.match(/^\/(new|clear|help)\b/i);
  if (simpleMatch) {
    return { command: simpleMatch[1].toLowerCase(), args: "" };
  }
  return { command: null };
}

// Read a SKILL.md file, strip YAML frontmatter, and combine with the user's args.
async function expandSkillContent(skill, args) {
  const raw = await readFile(skill.filePath, "utf8");
  const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
  const argSection = args ? `\n\n## Arguments\n${args}` : "";
  return `${body}${argSection}`;
}

// ── Agent session ────────────────────────────────────────────────────────────

async function initAgent() {
  agentAuthStorage = AuthStorage.create();
  agentAuthStorage.setRuntimeApiKey("volces", LLM_API_KEY);
  modelRegistry = ModelRegistry.create(agentAuthStorage);

  // Connect MCP servers first so their tools are discovered before the session
  // is created. The tool names MUST be added to the `tools` allowlist below,
  // otherwise the SDK filters custom tools out (see agent-session _refreshToolRegistry).
  //
  // read mcp.json once, connect via connectServers, then seed configs
  // into the extensions DB so the UI "Installed" tab shows them.
  let mcpJsonServers = {};
  try {
    const raw = await readFile(path.resolve("mcp.json"), "utf8");
    mcpJsonServers = JSON.parse(raw).mcpServers || {};
  } catch { /* no mcp.json or parse error — MCP disabled */ }

  // Bundle-manifest mcpServers are the packager's pre-installed MCPs: connect
  // the enabled ones here (before session creation, so their tools join the
  // session allowlist) and seed them below. `enabled` is seed metadata, not
  // part of the MCP client config — strip it. mcp.json wins name collisions
  // (operator config overrides the packaged default).
  const manifestServers = Object.fromEntries(
    Object.entries(bundle.mcpServers)
      .filter(([, entry]) => entry.enabled !== false)
      .map(([name, entry]) => {
        const { enabled, ...config } = entry;
        return [name, config];
      })
  );
  const mcp = await connectServers({ mcpServers: { ...manifestServers, ...mcpJsonServers } });
  let mcpTools = mcp.tools;
  let mcpClientList = mcp.clients;

  // When OpenConnector is enabled, register its runtime /mcp endpoint as an
  // additional MCP server so the agent can call list_apps / search_actions /
  // get_action_guide / execute_action (and thus any connected provider's
  // Actions). connectServers skips a failed connect without blocking the rest
  // of MCP/agent startup, so an unreachable runtime is non-fatal.
  const ocMcpConfig = openConnector.buildMcpServerConfig();
  if (ocMcpConfig) {
    // OC starts in parallel with server.js (bundled local mode), so its /mcp
    // endpoint may not be ready on the first attempt. Retry for ~30s before
    // giving up; connectServers skips a failed connect without blocking the rest
    // of agent startup, so an unreachable runtime is still non-fatal.
    const ocMcp = await connectServers(
      { mcpServers: { "open-connector": ocMcpConfig } },
      { retries: 20, intervalMs: 1500 }
    );
    mcpTools = mcpTools.concat(ocMcp.tools);
    mcpClientList = mcpClientList.concat(ocMcp.clients);
  }

  // auto-seed startup MCP configs into extensions DB so the UI
  // "Installed" tab shows them. INSERT OR IGNORE preserves user edits.
  // Origins: mcp.json entries stay "user" (operator config); OpenConnector and
  // manifest mcpServers entries are pre-installed by the package ("bundled").
  // Manifest entries take locked/permissions from the permissions map
  // ("mcp:<name>" → { allow, deny, locked }). Seeding lives here (not in
  // bootstrap/first-run.js) because better-sqlite3 only loads under the Node
  // that runs server.js — the Electron main process has a different ABI.
  if (db.isDbReady()) {
    for (const [name, config] of Object.entries(mcpJsonServers)) {
      extensionStore.seedMcpServer({ name, config, enabled: true });
    }
    if (ocMcpConfig) {
      const policy = splitPolicy(bundle.permissions["mcp:open-connector"]);
      extensionStore.seedMcpServer({
        name: "open-connector",
        config: ocMcpConfig,
        enabled: true,
        origin: bundle.components.openconnector ? "bundled" : "user",
        ...policy,
      });
    }
    for (const [name, entry] of Object.entries(bundle.mcpServers)) {
      const { enabled = true, ...config } = entry;
      extensionStore.seedMcpServer({
        name,
        config,
        enabled,
        origin: "bundled",
        ...splitPolicy(bundle.permissions[`mcp:${name}`]),
      });
    }
  }

  mcpClients = mcpClientList;
  agentMcpTools = mcpTools;
  agentMcpToolNames = mcpTools.map((t) => t.name);
  mcpToolCount = agentMcpToolNames.length;
  if (agentMcpToolNames.length) {
    console.log(`[mcp] Registering ${agentMcpToolNames.length} MCP tool(s): ${agentMcpToolNames.join(", ")}`);
  }

  // Native Volces chat provider. Built only when LLM_API_KEY is set AND
  // LiteLLM is NOT configured (see extensionFactories), so the agent stays
  // LiteLLM-only when LiteLLM is available and degrades to no chat provider
  // when neither is configured. The documents RAG uses Volces directly via
  // initStore() and does NOT depend on this provider being registered.
  agentProviderFactory = volcesEnabled ? (pi) => {
    pi.registerProvider("volces", {
      name: "Volces Coding",
      baseUrl: LLM_BASE_URL,
      apiKey: LLM_API_KEY,
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
        {
          id: "glm-5.2",
          name: "GLM 5.2",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    });
  } : null;

  // Build the initial session bound to the server's CWD (no workdir picked yet).
  await buildAndBindSession(process.cwd());
}

// Build a fresh agent session bound to `cwd` and wire up event subscription.
// The SDK fixes the working directory at session creation (cwd is private with
// no setter), so switching folders means rebuilding the session. One-time
// primitives (auth, MCP tools, provider factory) are cached by initAgent and
// reused across rebuilds; only the loader + session are recreated.
async function buildAndBindSession(cwd) {
  loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalSkillPaths: [path.resolve("skills")],
    // Register at most one chat provider so the agent is single-sourced:
    //   - LiteLLM configured  -> LiteLLM extension only (LiteLLM-only by
    //     construction; native Volces chat models can never leak into the
    //     selector, the startup default, or runtime switching).
    //   - LiteLLM not configured, Volces key set -> Volces provider only.
    //   - Neither configured -> no chat provider (server starts; chat logged
    //     as non-functional until a key is provisioned).
    extensionFactories: litellmEnabled ? [litellmExtension] : (volcesEnabled ? [agentProviderFactory] : []),
    systemPromptOverride: () => "You are a helpful coding assistant. Be concise.",
  });
  await loader.reload();

  // The LiteLLM extension registers models WITHOUT a `baseUrl`, but the SDK's
  // provider-attribution check calls `model.baseUrl.includes(...)` (no optional
  // chaining) and crashes on undefined -> "Cannot read properties of undefined
  // (reading 'includes')". Backfill baseUrl on LiteLLM-routed models so the
  // check is safe (the value is the local proxy, never an openrouter/nvidia host).
  if (litellmEnabled) {
    for (const m of modelRegistry?.getAvailable() ?? []) {
      if (m.baseUrl === undefined) m.baseUrl = LITELLM_BASE_URL;
    }
  }

  if (!defaultModel) {
    defaultModel = resolveDefaultModel();
    if (defaultModel) {
      console.log(`[model] Default chat model: ${defaultModel.provider}/${defaultModel.id}`);
    } else {
      console.warn("[model] No default model resolved; falling back to SDK default");
    }
  }

  // Use the SDK's persistent SessionManager (JSONL sessions under the sessions
  // store dir) instead of inMemory(), so conversations are auto-persisted and can
  // be resumed/switched. The store dir is owned by chat-history.js (overridable via
  // SESSIONS_STORE_DIR for E2E isolation). The cwd binds the agent's bash/file
  // operations to the selected working directory.
  const result = await createAgentSession({
    thinkingLevel: "off",
    authStorage: agentAuthStorage,
    modelRegistry,
    model: defaultModel,
    resourceLoader: loader,
    tools: ["read", "bash", "grep", "find", "ls", ...agentMcpToolNames],
    customTools: agentMcpTools,
    sessionManager: SessionManager.create(cwd, chatHistory.getSessionsDir()),
    settingsManager: SettingsManager.inMemory(),
  });

  session = result.session;
  // Let the chat-history adapter read/switch the live session manager.
  chatHistory.setSessionManager(session.sessionManager);

  // Subscribe to agent events and broadcast to all clients
  session.subscribe((event) => {
    switch (event.type) {
      case "message_start": {
        if (event.message?.role === "assistant") {
          broadcast({ type: "agent_start" });
        }
        break;
      }
      case "message_end": {
        const msg = event.message;
        if (msg?.role === "assistant" && msg.content) {
          for (const block of msg.content) {
            if (block.type === "thinking" && block.thinking) {
              broadcast({ type: "thinking", delta: block.thinking });
            }
            // Assistant text is delivered via streaming text_delta in
            // message_update (with a one-shot fallback in agent_end when
            // nothing streamed), so it is intentionally NOT echoed here -
            // re-emitting the full text on message_end would duplicate the
            // streamed message in the UI.
            // tool_use / tool_result are handled via tool_execution_* events
            // below with full input/output detail, so they are intentionally
            // not echoed here to avoid duplicate tool blocks.
          }
        }
        break;
      }
      case "message_update": {
        const msg = event.assistantMessageEvent;
        if (msg?.type === "text_delta" && msg.delta) {
          streamedTextThisTurn = true;
          broadcast({ type: "text", delta: msg.delta });
        } else if (msg?.type === "thinking_delta" && msg.delta) {
          broadcast({ type: "thinking", delta: msg.delta });
        }
        break;
      }
      case "tool_execution_start":
        broadcast({
          type: "tool_start",
          toolCallId: event.toolCallId,
          name: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        broadcast({
          type: "tool_update",
          toolCallId: event.toolCallId,
          name: event.toolName,
          partialResult: event.partialResult,
        });
        break;
      case "tool_execution_end":
        broadcast({
          type: "tool_end",
          toolCallId: event.toolCallId,
          name: event.toolName,
          result: event.result,
          isError: event.isError,
        });
        break;
      case "agent_start":
        // Idempotent: isStreaming is now set synchronously at prompt dispatch
        // (see the prompt handler) so a concurrent prompt observes it and
        // steers instead of racing a second turn on the shared session.
        isStreaming = true;
        streamedTextThisTurn = false;
        break;
      case "agent_end":
        if (event.messages) {
          const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
          if (lastAssistant?.content) {
            // Fallback: if no text was streamed this turn (e.g. a non-streaming
            // model response), emit the final assistant text once here so it
            // still appears in the UI. When text WAS streamed, emitting it again
            // would duplicate the already-rendered message.
            if (!streamedTextThisTurn) {
              for (const block of lastAssistant.content) {
                if (block.type === "text" && block.text) {
                  broadcast({ type: "text", delta: block.text });
                }
              }
            }
            // The SDK persists the assistant turn to the session file on
            // message_end; no manual append is needed.
            // Mirror the assistant's final text into the SQLite project database.
            const assistantText = chatHistory.extractMessageText(lastAssistant);
            if (assistantText) {
              chatHistory.recordMessage(chatHistory.currentSessionId(), "assistant", assistantText);
            }
          }
          const errorMsg = session.agent?.state?.errorMessage;
          if (errorMsg) {
            broadcast({ type: "error", message: errorMsg });
          }
        }
        // finishTurn() resets streaming state, broadcasts `done` (re-enabling the
        // UI), and refreshes the sidebar session list. Idempotent per turn.
        finishTurn();
        break;
    }
  });

  console.log(`Agent ready (model: ${session.model?.id || "auto"})`);
}

// ── Chat session switching (mutates the live agent) ──────────────────────────

// Rebuild the agent session bound to a new working directory. The SDK fixes cwd
// at session creation (no runtime setter), so switching the workdir requires
// recreating the session. The current conversation is preserved by repointing
// the new SessionManager at the existing session file and reloading messages.
// Rejected while streaming to avoid rebuilding mid-turn.
async function rebuildAgentForWorkdir(workdir) {
  if (isStreaming) throw new Error("Cannot change working directory while the agent is responding");
  if (!workdir) throw new Error("No working directory provided");
  const prevSessionFile = session?.sessionManager?.getSessionFile?.() ?? null;

  await buildAndBindSession(workdir);

  // Repoint the fresh session manager at the previous conversation (if any) so
  // the user keeps their history; otherwise it stays on the brand-new session.
  if (prevSessionFile) {
    try {
      session.sessionManager.setSessionFile(prevSessionFile);
      session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
    } catch (err) {
      console.warn("[workdir] could not restore previous session:", err.message);
    }
  }
  console.log(`[workdir] Agent rebuilt with cwd: ${workdir}`);
  return workdir;
}

// Start a new chat session: create a fresh SDK session and reset the agent's
// in-memory messages. Rejected while streaming to avoid switching mid-turn.
async function createNewSession() {
  if (isStreaming) throw new Error("Cannot start a new chat while the agent is responding");
  session.sessionManager.newSession();
  // newSession() changes the session manager's target but leaves the agent's
  // in-memory messages stale; reload from the (now empty) session so the next
  // turn starts clean.
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  return chatHistory.currentSessionId();
}

// Switch the live agent to an existing session by id: point the session manager at
// that file and reload the agent's in-memory messages from it so the conversation
// continues with full context. Rejected while streaming.
async function switchToSession(id) {
  if (isStreaming) throw new Error("Cannot switch chat while the agent is responding");
  const currentId = chatHistory.currentSessionId();
  const sessionPath = id === currentId ? null : await chatHistory.getSessionPath(id);
  if (!sessionPath && id !== currentId) {
    throw new Error(`Unknown session: ${id}`);
  }
  if (sessionPath) {
    session.sessionManager.setSessionFile(sessionPath);
  }
  const ctx = session.sessionManager.buildSessionContext();
  // Re-sync the agent's in-memory messages to the loaded session. setSessionFile()
  // alone does NOT update agent.state.messages (only createAgentSession does, at
  // creation), so without this the model would serve the previous session's context.
  session.agent.state.messages = ctx.messages;
  const sessions = await chatHistory.listSessions();
  const meta = sessions.find((s) => s.id === id) || {};
  return { id, title: meta.title || "Chat", messages: chatHistory.messagesForClient(ctx.messages) };
}

// ── Command + model/session helpers (used by the prompt dispatcher) ──────────

// The model list shown to clients. When LiteLLM is configured, source it live
// from the proxy's OpenAI-compatible /v1/models endpoint (authoritative;
// reflects admin-UI changes without a restart). On fetch failure/timeout, fall
// back to the SDK registry's configured-auth models. When LiteLLM is not
// configured, use the registry directly. Deduplicates by id.
async function getAvailableModels() {
  let models;
  if (litellmEnabled) {
    const litellmModels = await fetchLitellmModels({
      baseUrl: LITELLM_BASE_URL,
      apiKey: LITELLM_API_KEY,
    });
    if (litellmModels && litellmModels.length) {
      models = litellmModels;
    } else {
      // LiteLLM /v1/models unavailable. The registry is LiteLLM-only (only the
      // LiteLLM extension is registered), so this fallback never exposes
      // native Volces models. If the extension also registered nothing (proxy
      // down at startup), the selector shows no models rather than Volces.
      models = (modelRegistry?.getAvailable() ?? []).filter(hasAuth);
      if (models.length === 0) {
        console.warn(
          "[model] LiteLLM /v1/models unavailable and no LiteLLM-routed models in registry; returning empty model list"
        );
      } else {
        console.warn("[model] LiteLLM /v1/models unavailable; falling back to registry LiteLLM models");
      }
    }
  } else {
    models = (modelRegistry?.getAvailable() ?? []).filter(hasAuth);
  }
  return models
    .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)
    .map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider || "litellm" }));
}

// Switch the active model by id, enforcing the streaming guard. Sends any error
// to the requesting client and returns true on success. Shared by the
// `set_model` WS handler and the `/model` command. If LiteLLM is enabled and the
// id is not in the registry, the model may have been added to the proxy after
// startup; reload the loader once to re-discover it before giving up.
async function switchModelTo(id, ws) {
  if (isStreaming) {
    ws.send(JSON.stringify({ type: "error", message: "Cannot switch model while the agent is responding" }));
    return false;
  }
  const findInRegistry = () => {
    // When LiteLLM is enabled the registry is LiteLLM-only (only the LiteLLM
    // extension is registered), so native Volces ids can never match here and
    // a switch to a Volces model is rejected as "Unknown model".
    const available = (modelRegistry?.getAvailable() ?? []).filter(hasAuth);
    // Exact match first
    let target = available.find((m) => m.id === id);
    if (target) return target;
    // Try matching with any provider prefix
    target = available.find((m) => m.id.endsWith(`/${id}`));
    if (target) return target;
    // Try fuzzy matching: id contains the model name segment (handles
    // "volc-coding-deepseek-v4-pro" matching "deepseek-v4-pro" or "deepseek-v4-pro"
    // matching "deepseek/deepseek-v4-pro")
    const normalize = (s) => s.replace(/^.*\//, "").toLowerCase();
    const idNormalized = normalize(id);
    target = available.find((m) => normalize(m.id) === idNormalized);
    if (target) return target;
    // Last resort: contains partial match
    target = available.find((m) =>
      normalize(m.id).includes(idNormalized) || idNormalized.includes(normalize(m.id))
    );
    return target;
  };
  // Check if already the current model (idempotent behavior)
  const currentModelId = session?.model?.id || "";
  const isAlreadyCurrent =
    currentModelId === id ||
    currentModelId.endsWith(`/${id}`) ||
    (currentModelId.startsWith("litellm/") && currentModelId.slice(8) === id);
  if (isAlreadyCurrent) {
    return true;
  }
  let target = findInRegistry();
  if (!target && litellmEnabled && loader) {
    try {
      await loader.reload();
      target = findInRegistry();
    } catch (err) {
      console.warn("[model] reload to discover new model failed:", err.message);
    }
  }
  if (!target) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown model: ${id}` }));
    return false;
  }
  try {
    await session.setModel(target);
    // Broadcast the original id the client requested (from the dropdown),
    // not the registry's internal id. This ensures the client's model
    // selector shows a value that matches the dropdown options.
    broadcast({ type: "model_changed", id });
    return true;
  } catch (err) {
    console.error("setModel error:", err.message);
    ws.send(JSON.stringify({ type: "error", message: err.message }));
    return false;
  }
}

// ── Catalog agent switching (mirrors the model-selection messages) ───────────

// Agents the agent switcher offers: the local pi session plus visible
// chat-mode remote agents (link agents are external pages, not chat targets).
function switchableAgents(user) {
  return catalog
    .getCatalogFor(user ?? null)
    .agents.filter((a) => a.type === "agent-local" || (a.type === "agent-remote" && a.mode === "chat"));
}

// Switch the active catalog agent by id. Same contract as switchModelTo:
// rejected while streaming, errors go to the requesting client only.
function switchAgentTo(id, ws) {
  if (isStreaming) {
    ws.send(JSON.stringify({ type: "error", message: "Cannot switch agent while the agent is responding" }));
    return false;
  }
  const target = switchableAgents(ws.user).find((a) => a.id === id);
  if (!target) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${id}` }));
    return false;
  }
  if (id === currentAgentId) return true;
  currentAgentId = id;
  broadcast({ type: "agent_changed", id });
  return true;
}

// Fork a prompt to a remote OpenAI-compat endpoint: POST <baseUrl>/chat/completions
// with stream:true and translate SSE deltas into the existing text events, so the
// frontend renders remote agents exactly like the local one. v1 ceiling: remote
// turns are broadcast-only (no chat-history persistence) and one at a time — a
// prompt while a remote turn is streaming is rejected instead of steered.
async function streamRemoteChat(entry, text) {
  isStreaming = true; // set synchronously (same contract as the local prompt path)
  broadcast({ type: "agent_start" });
  try {
    const headers = { "Content-Type": "application/json" };
    if (entry.apiKey) headers.Authorization = `Bearer ${entry.apiKey}`;
    const r = await fetch(`${entry.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: entry.model, messages: [{ role: "user", content: text }], stream: true }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!r.ok) throw new Error(`${entry.id} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        let delta;
        try {
          delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        } catch {
          continue; // ponytail: skip malformed SSE lines rather than kill the stream
        }
        if (delta) broadcast({ type: "text", delta });
      }
    }
  } catch (err) {
    console.error(`Remote agent '${entry.id}' error:`, err.message);
    broadcast({ type: "error", message: err.message });
  } finally {
    finishTurn();
  }
}

// Handle `/model [id]`: with no id, report the current model + available models;
// with an id, switch (via switchModelTo) and emit a command_use block describing the result.
async function handleModelCommand(args, ws) {
  const id = (args || "").trim();
  const current = session?.model?.id || "(none)";
  if (!id) {
    const models = await getAvailableModels();
    const modelList = models.map((m) => `  ${m.id}${m.id === current ? " (active)" : ""}`).join("\n");
    broadcast({
      type: "command_use",
      name: "model",
      args: "",
      message: `Current model: ${current}\n\nAvailable models (${models.length}):\n${modelList}`,
    });
    return;
  }
  const ok = await switchModelTo(id, ws);
  broadcast({
    type: "command_use",
    name: "model",
    args: id,
    message: ok ? `Model switched to ${id}` : `Could not switch model to ${id}`,
  });
}

// Create a new session and broadcast the session_changed/session_loaded/sessions
// sequence. Shared by the `new_session` WS handler, the `/new` command, and the
// REST new-session route. Errors propagate to the caller.
async function startNewSession() {
  const id = await createNewSession();
  broadcast({ type: "session_changed", id });
  broadcast({ type: "session_loaded", id, title: "New chat", messages: [], workdir: null });
  const sessions = await chatHistory.listSessions();
  broadcast({ type: "sessions", sessions, current: id });
  return id;
}

// Handle `/new`: start a new session, then emit a command_use block (after the
// session_loaded clear so the block renders in the fresh chat).
async function handleNewCommand(ws) {
  try {
    await startNewSession();
    broadcast({ type: "command_use", name: "new", args: "", message: "Started a new chat" });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }
}

// ── WebSocket handling ───────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  // Identity is fixed at upgrade time (v1 ceiling: no re-auth mid-connection).
  ws.user = authEnabled ? userFromHeaders(req.headers) : null;
  clients.add(ws);
  console.log(`Client connected (${clients.size} total)`);

  // Tell the client which model is currently active so the dropdown can sync.
  // Broadcast the unprefixed id for litellm models to match what
  // getAvailableModels sends to the model selector.
  const currentModelId = session?.model?.id || null;
  const broadcastId =
    currentModelId && currentModelId.startsWith("litellm/")
      ? currentModelId.slice(8) // "litellm/".length = 8
      : currentModelId;
  ws.send(JSON.stringify({ type: "current_model", id: broadcastId }));
  // Sync the agent switcher: active catalog agent + switchable agent list.
  ws.send(JSON.stringify({ type: "current_agent", id: currentAgentId }));
  ws.send(JSON.stringify({ type: "agents", agents: switchableAgents(ws.user) }));
  // Send the chat session list + current session so the sidebar syncs on connect.
  if (session) {
    chatHistory
      .listSessions()
      .then((sessions) =>
        ws.send(
          JSON.stringify({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
        )
      )
      .catch((e) => console.error("[chat-history] list on connect failed:", e.message));
    // Send the current session's workdir so the sidebar shows it on connect.
    const curId = chatHistory.currentSessionId();
    if (curId) {
      workdirStore.getWorkdir(curId).then((wd) => {
        if (wd) ws.send(JSON.stringify({ type: "workdir", path: wd }));
      }).catch((e) => console.error("[workdir] getWorkdir on connect failed:", e.message));
    }
  }
  // Send initial dashboard state on connect
  ws.send(JSON.stringify({ type: "dashboard_update", state: cron.getDashboardState() }));


  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (data.type) {
      case "prompt": {
        const text = data.text?.trim();
        if (!text) return;

        // The SDK persists the user turn to the session file; no manual append.
        const cmd = parseCommand(text);

        if (cmd && cmd.command === "skill") {
          // Skill invocation: emit a skill_use block and suppress the raw
          // /skill:... text from being echoed as a normal user message.
          broadcast({ type: "skill_use", name: cmd.name, args: cmd.args });
          // Mirror the user's skill invocation into the SQLite project database.
          chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);

          // Manually expand the skill content and send that to the agent. This
          // does not rely on session.prompt() expanding slash commands.
          const skills = loader?.getSkills().skills ?? [];
          const skill = skills.find((s) => s.name === cmd.name);
          let promptText = text;
          if (skill) {
            try {
              promptText = await expandSkillContent(skill, cmd.args);
            } catch (err) {
              console.warn(`[skill] Failed to expand "${cmd.name}": ${err.message}`);
            }
          }

          try {
            if (isStreaming) {
              await session.prompt(promptText, { streamingBehavior: "steer" });
            } else {
              // Set in-flight synchronously (before the first await) so a
              // concurrent prompt observes it and steers instead of racing a
              // second turn on the shared session. agent_start sets it again
              // later (idempotent).
              isStreaming = true;
              await session.prompt(promptText);
            }
          } catch (err) {
            console.error("Agent error:", err.message);
            broadcast({ type: "error", message: err.message });
            // Finish the turn (reset streaming, emit done, refresh sessions) so a
            // failed turn does not wedge the UI or block model-switch/new-session.
            finishTurn();
          }
        } else if (cmd && cmd.command === "model") {
          await handleModelCommand(cmd.args, ws);
        } else if (cmd && cmd.command === "new") {
          await handleNewCommand(ws);
        } else if (cmd && (cmd.command === "clear" || cmd.command === "help")) {
          // Client-handled commands; the UI should not forward them. Ignore.
          return;
        } else {
          // Normal prompt (includes unknown "/…" commands that fall through):
          // echo the user message and forward.
          broadcast({ type: "user", text });

          // Remote-agent fork: when a chat-mode catalog agent is active, stream
          // from its OpenAI-compat endpoint instead of the local session. The
          // user message is echoed above but NOT recorded — remote turns are
          // not persisted into chat-history (v1 ceiling).
          if (currentAgentId !== "local") {
            if (isStreaming) {
              ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
              break;
            }
            const entry = catalog.getAgentEntry(currentAgentId);
            if (!entry) {
              // Catalog changed under us (entry removed / no longer visible).
              ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${currentAgentId}` }));
              break;
            }
            await streamRemoteChat(entry, text);
            break;
          }

          // Mirror the user prompt into the SQLite project database.
          chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);

          try {
            if (isStreaming) {
              await session.prompt(text, { streamingBehavior: "steer" });
            } else {
              // Set in-flight synchronously (before the first await) so a
              // concurrent prompt observes it and steers instead of racing a
              // second turn on the shared session. agent_start sets it again
              // later (idempotent).
              isStreaming = true;
              await session.prompt(text);
            }
          } catch (err) {
            console.error("Agent error:", err.message);
            broadcast({ type: "error", message: err.message });
            // Finish the turn (reset streaming, emit done, refresh sessions) so a
            // failed turn does not wedge the UI or block model-switch/new-session.
            finishTurn();
          }
        }
        break;
      }

      case "list_models": {
        const models = await getAvailableModels();
        ws.send(JSON.stringify({ type: "models", models }));
        break;
      }

      case "set_model": {
        await switchModelTo(data.id, ws);
        break;
      }

      case "list_agents": {
        ws.send(JSON.stringify({ type: "agents", agents: switchableAgents(ws.user) }));
        break;
      }

      case "set_agent": {
        switchAgentTo(data.id, ws);
        break;
      }

      case "list_skills": {
        const COMPUTER_USE_ENABLED = process.env.ENABLE_COMPUTER_USE === "true";
        const skills = (loader?.getSkills().skills ?? [])
          .filter((s) => {
            if (!COMPUTER_USE_ENABLED && s.name.startsWith("computer-")) {
              return false;
            }
            return true;
          })
          .map((s) => ({
            name: s.name,
            description: s.description,
          }));
        ws.send(JSON.stringify({ type: "skills", skills }));
        break;
      }

      case "cron_add": {
        try {
          const job = await cron.addJob({ cron: data.cron, when: data.when, prompt: data.prompt });
          ws.send(JSON.stringify({ type: "cron_added", job }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_remove": {
        try {
          const removed = await cron.removeJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_removed", jobId: data.jobId, success: removed }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_pause": {
        try {
          const paused = await cron.pauseJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_paused", jobId: data.jobId, success: paused }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_resume": {
        try {
          const resumed = await cron.resumeJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_resumed", jobId: data.jobId, success: resumed }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_list": {
        ws.send(JSON.stringify({ type: "cron_jobs", jobs: cron.listJobs() }));
        break;
      }

      case "cron_run": {
        try {
          const ran = await cron.runJobNow(data.jobId);
          ws.send(JSON.stringify({ type: "cron_run_started", jobId: data.jobId, success: ran }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "dashboard_state": {
        ws.send(JSON.stringify({ type: "dashboard_state", state: cron.getDashboardState() }));
        break;
      }

      case "list_sessions": {
        const sessions = await chatHistory.listSessions();
        ws.send(
          JSON.stringify({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
        );
        break;
      }

      case "new_session": {
        try {
          await startNewSession();
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "switch_session": {
        try {
          // If the target session has a different workdir than the current agent
          // cwd, rebuild the agent bound to that workdir first (the SDK fixes cwd
          // at session creation). Otherwise just repoint the session manager.
          const targetWorkdir = await workdirStore.getWorkdir(data.id);
          const currentCwd = session?.sessionManager?.getCwd?.() ?? process.cwd();
          if (targetWorkdir && targetWorkdir !== currentCwd) {
            await rebuildAgentForWorkdir(targetWorkdir);
          }
          const result = await switchToSession(data.id);
          const workdir = targetWorkdir ?? null;
          broadcast({
            type: "session_loaded",
            id: result.id,
            title: result.title,
            messages: result.messages,
            workdir,
          });
          broadcast({ type: "session_changed", id: result.id });
          if (workdir) broadcast({ type: "workdir", path: workdir });
          const sessions = await chatHistory.listSessions();
          broadcast({ type: "sessions", sessions, current: result.id });
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "set_workdir": {
        try {
          const workdir = data.path;
          if (!workdir) throw new Error("No working directory provided");
          // Rebuild the agent bound to the new cwd, then persist the workdir for
          // the current session so it is restored on switch-back.
          await rebuildAgentForWorkdir(workdir);
          const sessionId = chatHistory.currentSessionId();
          if (sessionId) await workdirStore.setWorkdir(sessionId, workdir);
          broadcast({ type: "workdir", path: workdir });
          broadcast({
            type: "command_use",
            name: "workdir",
            args: workdir,
            message: `Working directory set to ${workdir}`,
          });
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size} total)`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    clients.delete(ws);
  });
});

// ── Documents REST API routes (local PageIndex + LlamaIndex) ───────────────
// Ingests PDF, Markdown, text, URL, DOCX, XLSX, PPTX, CSV, HTML. Indexes
// via PageIndex through LlamaIndex.TS framework with SQLite persistence.
// Status transitions broadcast as documents_status WS events.

app.post("/api/documents", upload.single("file"), async (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
  }
  try {
    const { id, name, type } = req.body;
    if (!req.file && !type) {
      return res.status(400).json({ error: "Missing file or type" });
    }

    const result = await documents.addDocument({
      id,
      name: req.file ? req.file.originalname : name,
      type: req.file ? documents.typeForFilename(req.file.originalname) : type,
      buffer: req.file?.buffer,
      content: req.body.content,
      url: req.body.url,
    });

    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/api/documents", (req, res) => {
  res.json({ documents: documents.listDocuments() });
});

app.get("/api/documents/:id", async (req, res) => {
  try {
    const content = await documents.getDocumentContent(req.params.id);
    if (content === null) return res.status(404).json({ error: "Not found" });
    res.json({ content });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/documents/:id", async (req, res) => {
  const removed = await documents.removeDocument(req.params.id);
  res.status(removed ? 200 : 404).json({ removed });
});

app.post("/api/documents/query", async (req, res) => {
  const query = (req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "Missing query" });
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
  }
  try {
    const result = await documents.queryCollection(query);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Collections REST API routes (named document groups) ───────────────────
// Collections allow organizing documents into named groups for scoped querying.

app.get("/api/collections", (_req, res) => {
  res.json({ collections: collections.listCollections() });
});

app.post("/api/collections", async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });
  try {
    const collection = await collections.createCollection({ name, description });
    res.json(collection);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.patch("/api/collections/:id", async (req, res) => {
  const { name, description } = req.body;
  try {
    const collection = await collections.renameCollection(req.params.id, { name, description });
    res.json(collection);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/collections/:id", async (req, res) => {
  await collections.deleteCollection(req.params.id);
  res.json({ ok: true });
});

app.get("/api/collections/:id/documents", async (req, res) => {
  try {
    const docs = await collections.listCollectionDocuments(req.params.id);
    res.json({ documents: docs });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/collections/:id/documents", async (req, res) => {
  const { documentId } = req.body;
  if (!documentId) return res.status(400).json({ error: "Missing documentId" });
  try {
    await collections.addDocumentToCollection(req.params.id, documentId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/collections/:id/documents/:documentId", async (req, res) => {
  await collections.removeDocumentFromCollection(req.params.id, req.params.documentId);
  res.json({ ok: true });
});

app.post("/api/collections/:id/query", async (req, res) => {
  const query = (req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "Missing query" });
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
  }
  try {
    const result = await collections.queryCollection(req.params.id, query);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Static files ─────────────────────────────────────────────────────────────
//
// Two frontends coexist during the React migration (see openspec change
// `redesign-chat-ui-react-shadcn`):
//   - `web/dist/` — built React chat SPA. Mounted under `/chat/` and is now the
//                   default: `/` redirects here.
//   - `public/`  — legacy vanilla frontend, retained for the not-yet-ported
//                   views. Reached via `/documents`, `/openconnector`,
//                   `/dashboard`, `/litellm`, each of which serves the same
//                   page; the vanilla client opens the matching tab from the
//                   URL path on load.
// The React app's Vite `base` is `/chat/`, so its assets self-reference as
// `/chat/assets/...` — no conflict with legacy `/assets/...` from OpenConnector.
const webDist = path.resolve("web/dist");
app.use(express.static(webDist));
// SPA fallback: any GET that isn't an API route, proxy path, or static asset
// serves index.html so the client router handles it. /v1/* is excluded so the
// OpenConnector (and LiteLLM) /v1 reverse-proxy routes - registered below - are
// not shadowed by this fallback (which would serve index.html for the embedded
// SPA's API calls).
app.get(/^\/(?!api\/|oc-web|litellm-web|assets\/|v1\/|v2\/|ui|key\/|spend\/|model\/|models|sso\/|login|logout|user\/|get_image|get_favicon|get\/|litellm-asset-prefix\/).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

// Identity introspection: lets the frontend render login state without
// inspecting headers. email/groups are null when auth is off.
app.get("/api/auth/me", (req, res) => {
  res.json({
    mode: AUTH_MODE,
    email: req.user?.email ?? null,
    groups: req.user?.groups ?? null,
  });
});

// ── Agent & app catalog (agents.json + AGENTS_CONFIG_URL, see catalog.js) ────
// GET is role-filtered + redacted per requesting user; POST refresh is
// admin-gated when auth is on, open to any client when auth is off.
app.get("/api/catalog", (req, res) => {
  res.json(catalog.getCatalogFor(req.user ?? null));
});

app.post("/api/catalog/refresh", async (req, res) => {
  if (authEnabled && !req.user?.groups?.includes("admin")) {
    return res.status(403).json({ error: "Admin group required" });
  }
  try {
    res.json(await catalog.refresh(req.user ?? null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Nango connect broker (nango-connect app entries) ─────────────────────────
// Mirrors connect-app/server.mjs: mint a connect session tagged to the
// requesting user (org = email domain) so Nango isolates their connections,
// and hand back the Connect UI URL. Requires forward-auth — there is no
// identity to tag otherwise. The Nango secret stays server-side.
app.post("/api/apps/:id/connect", async (req, res) => {
  if (!authEnabled || !req.user?.email) {
    return res.status(400).json({ error: "Connect requires AUTH_MODE=forward_auth" });
  }
  const entry = catalog.getAppEntry(req.params.id);
  if (!entry || entry.kind !== "nango-connect") {
    return res.status(404).json({ error: `Unknown nango-connect app: ${req.params.id}` });
  }
  const secret = process.env.NANGO_SECRET_KEY;
  if (!secret) return res.status(500).json({ error: "NANGO_SECRET_KEY not set" });
  const email = req.user.email;
  try {
    const r = await fetch(`${entry.nangoUrl.replace(/\/+$/, "")}/connect/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        tags: { end_user_id: email, end_user_email: email, organization_id: email.split("@")[1] },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Nango HTTP ${r.status}`);
    const data = await r.json();
    const ui = (entry.connectUiUrl || entry.nangoUrl).replace(/\/+$/, "");
    const api = encodeURIComponent((entry.apiUrl || entry.nangoUrl).replace(/\/+$/, ""));
    res.json({ url: `${ui}/?session_token=${data.token}&apiURL=${api}` });
  } catch (err) {
    console.error(`[apps] connect session for '${req.params.id}' failed:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── Server config (e.g. LiteLLM management UI link) ──────────────────────────
app.get("/api/config", (_req, res) => {
  res.json({
    litellmEnabled,
    openconnectorEnabled: openConnector.openConnectorEnabled,
    documentsEnabled: db.isDbReady(),
    litellmManagementUrl: LITELLM_BASE_URL ? `${LITELLM_BASE_URL}/ui` : null,
  });
});

// Local bundled LiteLLM master key, so the user can sign into the management UI
// (the bundled proxy's master_key is auto-generated server-side). Exposed ONLY
// when LiteLLM is local (localhost) - for a remote proxy the user has their own
// credentials and this returns null (no key reaches the browser in that case).
app.get("/api/litellm/credentials", (_req, res) => {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(LITELLM_BASE_URL || "");
  // apiBaseUrl is non-secret (already derivable from litellmManagementUrl) and lets the
  // user call ${apiBaseUrl}/v1/... directly with the master key as bearer. masterKey
  // stays gated on the local-proxy case; both are null for a remote proxy.
  res.json({
    masterKey: isLocal ? (LITELLM_API_KEY || null) : null,
    apiBaseUrl: isLocal ? (LITELLM_BASE_URL || null) : null,
  });
});

// ── Supervisor / system status (for the Dashboard view) ──────────────────────
// Returns NON-SECRET system status only. Never includes API keys or tokens.
// In dev (node server.js) returns this server's own self-status. In the packaged
// Electron app the Electron main process can override this via IPC (future); for
// now it returns the same self-status which is sufficient for the dashboard.
app.get("/api/supervisor/status", (_req, res) => {
  const docByStatus = {};
  res.json({
    servers: [
      {
        id: "server-js",
        name: "Platform backend",
        kind: "node",
        state: "healthy",
        pid: process.pid,
        port: PORT,
        url: `http://localhost:${PORT}`,
      },
      {
        id: "litellm",
        name: "LiteLLM gateway",
        kind: litellmEnabled ? "http-external" : "disabled",
        state: litellmEnabled ? "healthy" : "disabled",
        url: LITELLM_BASE_URL || null,
      },
      {
        id: "openconnector",
        name: "OpenConnector runtime",
        kind: openConnector.openConnectorEnabled ? "http-external" : "disabled",
        state: openConnector.openConnectorEnabled ? "healthy" : "disabled",
        url: openConnector.getRuntimeBase() || null,
      },
    ],
    provider: defaultModel ? defaultModel.provider : null,
    currentModel: defaultModel ? defaultModel.id : null,
    mcpToolCount,
    uptimeMs: process.uptime() * 1000,
  });
});

// ── User preferences endpoints (single-user, key/value) ──────────────────────
// Stored in the SQLite project database. No authentication; no multi-tenancy.

app.get("/api/preferences", (_req, res) => {
  res.json({ preferences: db.isDbReady() ? db.getAllPreferences() : {} });
});

// Upsert one preference: { key, value }. Idempotent on key.
app.put("/api/preferences", (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Preferences are disabled (database unavailable)" });
  }
  const { key, value } = req.body || {};
  if (!key || typeof value === "undefined") {
    return res.status(400).json({ error: "Missing key or value" });
  }
  db.setPreference(key, value);
  res.json({ ok: true });
});

// ── Extensions management API (MCP servers + custom skills) ──────────────────

// List all MCP server configurations (from database).
app.get("/api/extensions/mcp", (_req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const servers = extensionStore.listMcpServers();
  res.json({ servers });
});

// Add a new MCP server configuration.
app.post("/api/extensions/mcp", async (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const { name, config, enabled } = req.body || {};
  if (!name || !config) {
    return res.status(400).json({ error: "Missing name or config" });
  }
  try {
    const server = extensionStore.addMcpServer({ name, config, enabled });
    // broadcast immediately so the UI refreshes right away, then
    // connect in the background. The connection attempt can take up to 10s
    // (timeout); we don't want to block the UI on it. The config is already
    // saved; the connection is best-effort.
    broadcast({ type: "extensions_changed", resource: "mcp", action: "added", name });
    res.json(server);
    if (server.enabled) {
      connectSingleServer(name, config).then(({ tools, client }) => {
        mcpClients.push(client);
        broadcast({ type: "extensions_changed", resource: "mcp", action: "added", name });
      }).catch((err) => {
        console.warn(`[extensions] Failed to connect new MCP server "${name}": ${err.message} (config saved, not connected)`);
      });
    }
  } catch (err) {
    if (err.message?.includes("UNIQUE constraint")) {
      return res.status(409).json({ error: `MCP server "${name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

// Update an MCP server configuration.
app.put("/api/extensions/mcp/:name", async (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const { name } = req.params;
  const { config, enabled } = req.body || {};
  try {
    const oldServer = extensionStore.getMcpServer(name);
    if (!oldServer) {
      return res.status(404).json({ error: `MCP server "${name}" not found` });
    }
    if (oldServer.locked) {
      return res.status(400).json({ error: `MCP server "${name}" is locked (bundled) and cannot be updated` });
    }
    const server = extensionStore.updateMcpServer(name, { config, enabled });
    // Hot-reload: disconnect old, connect new if config changed or enabled changed.
    const configChanged = config && JSON.stringify(config) !== JSON.stringify(oldServer.config);
    const enabledChanged = enabled !== undefined && enabled !== oldServer.enabled;
    if (configChanged || enabledChanged) {
      // Disconnect old.
      const { clients: updatedClients } = await disconnectSingleServer(name, mcpClients);
      mcpClients = updatedClients;
      // Connect new if enabled.
      if (server.enabled && config) {
        try {
          const { tools, client } = await connectSingleServer(name, config);
          mcpClients.push(client);
        } catch (err) {
          console.warn(`[extensions] Failed to reconnect MCP server "${name}": ${err.message}`);
          // Roll back to old config.
          extensionStore.updateMcpServer(name, { config: oldServer.config, enabled: oldServer.enabled });
          return res.status(500).json({ error: `Failed to reconnect: ${err.message}` });
        }
      }
      broadcast({ type: "extensions_changed", resource: "mcp", action: "updated", name });
    }
    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove an MCP server configuration.
app.delete("/api/extensions/mcp/:name", async (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const { name } = req.params;
  const server = extensionStore.getMcpServer(name);
  if (!server) {
    return res.status(404).json({ error: `MCP server "${name}" not found` });
  }
  if (server.locked) {
    return res.status(400).json({ error: `MCP server "${name}" is locked (bundled) and cannot be removed` });
  }
  // Disconnect if connected.
  const { clients: updatedClients } = await disconnectSingleServer(name, mcpClients);
  mcpClients = updatedClients;
  extensionStore.removeMcpServer(name);
  broadcast({ type: "extensions_changed", resource: "mcp", action: "removed", name });
  res.json({ ok: true });
});

// Enable or disable an MCP server.
app.patch("/api/extensions/mcp/:name/enable", async (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const { name } = req.params;
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "Missing enabled (boolean)" });
  }
  const server = extensionStore.getMcpServer(name);
  if (!server) {
    return res.status(404).json({ error: `MCP server "${name}" not found` });
  }
  if (server.locked) {
    return res.status(400).json({ error: `MCP server "${name}" is locked (bundled) and cannot be disabled` });
  }
  const updated = extensionStore.toggleMcpServer(name, enabled);
  // broadcast + respond immediately; connect/disconnect in background.
  broadcast({ type: "extensions_changed", resource: "mcp", action: "toggled", name, enabled });
  res.json(updated);
  if (enabled && !server.enabled) {
    // Enabling: connect in background.
    connectSingleServer(name, server.config).then(({ tools, client }) => {
      mcpClients.push(client);
    }).catch((err) => {
      console.warn(`[extensions] Failed to enable MCP server "${name}": ${err.message}`);
    });
  } else if (!enabled && server.enabled) {
    // Disabling: disconnect in background.
    disconnectSingleServer(name, mcpClients).then(({ clients: updatedClients }) => {
      mcpClients = updatedClients;
    }).catch((err) => {
      console.warn(`[extensions] Failed to disable MCP server "${name}": ${err.message}`);
    });
  } else {
    broadcast({ type: "extensions_changed", resource: "mcp", action: "toggled", name, enabled });
  }
});

// List all skills (file-based + custom from database).
// File skills are not DB rows; their extension metadata is derived from the
// bundle manifest: names in manifest `skills` are "bundled" and take
// locked/permissions from the manifest's permissions map ("skill:<name>").
app.get("/api/extensions/skills", async (_req, res) => {
  const fileSkills = (loader?.getSkills().skills ?? []).map((s) => {
    const bundled = bundle.skills.includes(s.name);
    const policy = bundled ? splitPolicy(bundle.permissions[`skill:${s.name}`]) : { locked: false, permissions: null };
    return {
      name: s.name,
      description: s.description,
      source: "file",
      enabled: true,
      origin: bundled ? "bundled" : "file",
      locked: policy.locked,
      permissions: policy.permissions,
    };
  });
  const customSkills = db.isDbReady()
    ? extensionStore.listCustomSkills().map((s) => ({
        name: s.name,
        description: s.description,
        source: "database",
        enabled: s.enabled,
        origin: "user",
        locked: false,
        permissions: null,
      }))
    : [];
  res.json({ skills: [...fileSkills, ...customSkills] });
});

// Add a new custom skill.
app.post("/api/extensions/skills", (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const { name, description, content, enabled } = req.body || {};
  if (!name || !content) {
    return res.status(400).json({ error: "Missing name or content" });
  }
  try {
    const skill = extensionStore.addCustomSkill({ name, description, content, enabled });
    broadcast({ type: "extensions_changed", resource: "skill", action: "added", name });
    res.json(skill);
  } catch (err) {
    if (err.message?.includes("UNIQUE constraint")) {
      return res.status(409).json({ error: `Skill "${name}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

// Update a custom skill.
app.put("/api/extensions/skills/:name", (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const { name } = req.params;
  const { description, content, enabled } = req.body || {};
  // Locked bundled skills are immutable (D6) — the manifest lock wins over
  // any DB row sharing the name.
  const updatePolicy = bundle.skills.includes(name)
    ? splitPolicy(bundle.permissions[`skill:${name}`])
    : { locked: false };
  if (updatePolicy.locked) {
    return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be modified` });
  }
  const skill = extensionStore.getCustomSkill(name);
  if (!skill) {
    return res.status(404).json({ error: `Skill "${name}" not found` });
  }
  const updated = extensionStore.updateCustomSkill(name, { description, content, enabled });
  broadcast({ type: "extensions_changed", resource: "skill", action: "updated", name });
  res.json(updated);
});

// Remove a custom skill.
app.delete("/api/extensions/skills/:name", (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const { name } = req.params;
  // A name listed in the bundle manifest's skills is bundled; its lock policy
  // wins over any DB row with the same name (locked ⇒ immutable, D6).
  const deletePolicy = bundle.skills.includes(name)
    ? splitPolicy(bundle.permissions[`skill:${name}`])
    : { locked: false };
  if (deletePolicy.locked) {
    return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be removed` });
  }
  const skill = extensionStore.getCustomSkill(name);
  if (!skill) {
    return res.status(404).json({ error: `Skill "${name}" not found` });
  }
  extensionStore.removeCustomSkill(name);
  broadcast({ type: "extensions_changed", resource: "skill", action: "removed", name });
  res.json({ ok: true });
});

// Enable or disable a custom skill.
app.patch("/api/extensions/skills/:name/enable", (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Extensions management is disabled (database unavailable)" });
  }
  const { name } = req.params;
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "Missing enabled (boolean)" });
  }
  // Locked bundled skills cannot be disabled (D6). Lock state comes from the
  // manifest, not the DB — file skills are never custom_skills rows.
  const togglePolicy = bundle.skills.includes(name)
    ? splitPolicy(bundle.permissions[`skill:${name}`])
    : { locked: false };
  if (togglePolicy.locked) {
    return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be disabled` });
  }
  const skill = extensionStore.getCustomSkill(name);
  if (!skill) {
    return res.status(404).json({ error: `Skill "${name}" not found` });
  }
  const updated = extensionStore.toggleCustomSkill(name, enabled);
  broadcast({ type: "extensions_changed", resource: "skill", action: "toggled", name, enabled });
  res.json(updated);
});

// Get the market catalog (MCP servers + skills).
app.get("/api/extensions/market", async (_req, res) => {
  try {
    const catalog = await extensionStore.getMarketCatalog();
    res.json(catalog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Chat history endpoints ───────────────────────────────────────────────────
// Sessions are persisted to disk; the UI lists and views them read-only.

app.get("/api/chat-history/sessions", async (_req, res) => {
  try {
    res.json({ sessions: await chatHistory.listSessions(), current: chatHistory.currentSessionId() });
  } catch (err) {
    console.error("[chat-history] list error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/chat-history/sessions/:id", async (req, res) => {
  try {
    const session = await chatHistory.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    res.json(session);
  } catch (err) {
    console.error("[chat-history] get error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/chat-history/sessions", async (_req, res) => {
  try {
    const id = await startNewSession();
    res.json({ id });
  } catch (err) {
    console.error("[chat-history] new error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── OpenConnector endpoints ──────────────────────────────────────────────────
// The runtime/admin tokens stay server-side; the browser only ever talks to
// these /api/openconnector/* routes (never to the runtime URL directly). The
// config route is always mounted so the UI can detect enabled/disabled state;
// the runtime-proxying routes are mounted only when OpenConnector is enabled.

// Run an OpenConnector proxy call and surface the runtime envelope (or its
// error) to the client without crashing the server. Client-supplied auth
// headers/body fields are never forwarded - open-connector.js sends only the
// server-held tokens and the documented request fields.
async function runOpenConnector(fn, res) {
  try {
    res.json(await fn());
  } catch (err) {
    const status = err?.status || 500;
    const body = err?.envelope || { success: false, error: err.message };
    res.status(status).json(body);
  }
}

app.get("/api/openconnector/config", (_req, res) => {
  res.json(openConnector.getPublicConfig());
});

// ── OpenConnector native web UI reverse proxy ────────────────────────────────
// Forwards /oc-web and /oc-web/* to the runtime's own web UI, injecting the
// server-held token (admin for the UI + /api/*, runtime for /v1/* + /mcp) and
// stripping any client-supplied Authorization. The browser loads it in a
// same-origin iframe so the runtime URL and tokens never reach the client.
// Generic token-injecting reverse proxy for embedding an external web UI
// same-origin in an <iframe>. Forwards method/body/query to getBase() + the
// upstream path, injects `Authorization: Bearer <getToken(upstream)>`, strips
// any client-supplied Authorization, injects a <base href="<prefix>/"> tag into
// HTML so relative assets resolve under the proxy prefix, rewrites Location
// redirects to stay under <prefix>, and drops content-encoding/length (Node's
// fetch decompresses the body; express recomputes length). Used by OpenConnector
// (/oc-web) and LiteLLM (/litellm-web).
function createWebProxy({ prefix, getBase, getToken, label = "Upstream" }) {
  const pathRe = new RegExp(`^${prefix}`);
  return async function webProxy(req, res) {
    const base = getBase();
    // Derive the upstream path (incl. query) from the original URL.
    let upstream = req.originalUrl.replace(pathRe, "");
    if (upstream === "") upstream = "/";
    const url = base + upstream;

    // Forwarded headers: keep content-type. For Authorization: the embedded
    // LiteLLM dashboard extracts a virtual key from its session JWT and sends it
    // as Bearer - forward that so /user/info etc. authenticate as the session
    // user (the master_key returns user_id=null). When no client Authorization
    // is present (e.g. the app's own server-side calls, or the OC dashboard),
    // inject the server-held token.
    const ct = req.headers["content-type"];
    const reqHeaders = {};
    if (ct) reqHeaders["content-type"] = ct;
    if (req.headers.authorization) {
      reqHeaders.authorization = req.headers.authorization;
    } else {
      const token = getToken(upstream);
      if (token) reqHeaders.authorization = `Bearer ${token}`;
    }

    // Body forwarding: JSON bodies were parsed by express.json -> stringify; other
    // content types (multipart, form) are read raw from the stream (express.json
    // did not consume them).
    let body;
    const hasBody = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
    if (hasBody) {
      const isJson = (ct || "").includes("application/json");
      if (isJson && req.body !== undefined) {
        body = JSON.stringify(req.body);
      } else if (!isJson) {
        const chunks = [];
        await new Promise((resolve, reject) => {
          req.on("data", (c) => chunks.push(c));
          req.on("end", resolve);
          req.on("error", reject);
        });
        body = Buffer.concat(chunks);
      }
    }

    let upstreamRes;
    try {
      upstreamRes = await fetch(url, {
        method: req.method,
        headers: reqHeaders,
        body,
        redirect: "manual",
      });
    } catch (err) {
      return res.status(502).send(`${label} unreachable: ${err.message}`);
    }

    res.status(upstreamRes.status);
    const respType = upstreamRes.headers.get("content-type") || "";
    if (respType) res.setHeader("content-type", respType);
    // Rewrite a Location redirect so it stays under <prefix>.
    const loc = upstreamRes.headers.get("location");
    if (loc) {
      try {
        const u = new URL(loc, base);
        res.setHeader("location", `${prefix}${u.pathname}${u.search}`);
      } catch {
        res.setHeader("location", loc);
      }
    }

    // content-encoding/content-length are intentionally NOT forwarded: Node's
    // fetch decompresses the body, so forwarding them would corrupt it. express
    // recomputes content-length from the bytes sent.
    let buf;
    try {
      buf = Buffer.from(await upstreamRes.arrayBuffer());
    } catch (err) {
      return res.status(502).send(`${label} response read failed: ${err.message}`);
    }

    // Inject a <base> tag into HTML so the UI's relative assets resolve under
    // <prefix> (mitigates absolute asset paths missing the proxy prefix).
    if (respType.includes("text/html")) {
      let html = buf.toString("utf8");
      const baseTag = `<base href="${prefix}/">`;
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/(<head[^>]*>)/i, `$1${baseTag}`);
      } else {
        html = baseTag + html;
      }
      return res.type("text/html").send(html);
    }

    res.send(buf);
  };
}

const openConnectorWebProxy = createWebProxy({
  prefix: "/oc-web",
  getBase: () => openConnector.getRuntimeBase(),
  getToken: (upstream) => openConnector.tokenForPath(upstream),
  label: "OpenConnector runtime",
});

// LiteLLM management UI proxy. Always authenticates with the server-held
// LITELLM_API_KEY; mounted only when LiteLLM is configured (see below).
const litellmWebProxy = createWebProxy({
  prefix: "/litellm-web",
  getBase: () => LITELLM_BASE_URL,
  getToken: () => LITELLM_API_KEY,
  label: "LiteLLM",
});

// Forward /ui/* -> LiteLLM /ui/* verbatim (the dashboard's basePath is /ui, so its
// absolute /ui/_next/... asset refs must reach LiteLLM's /ui/_next/...). Unlike
// createWebProxy this does NOT strip the prefix and does NOT inject a <base> tag
// (the dashboard has its own basePath). Token-injected same as the other proxies.
//
// Auto-login: the dashboard's client-side auth gate reads the `token` cookie
// (set by POST /login) and redirects to /sso/key/generate if absent. Since we
// already hold the master key, we fetch that JWT once and Set-Cookie it on the
// /ui response so the user never sees the login form.
let litellmUiToken = null;
let litellmUiUserId = null;
let litellmUiTokenPromise = null;
async function getLitellmUiToken() {
  if (litellmUiToken) return litellmUiToken;
  if (litellmUiTokenPromise) return litellmUiTokenPromise;
  litellmUiTokenPromise = (async () => {
    try {
      const r = await fetch(`${LITELLM_BASE_URL}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: "admin", password: LITELLM_API_KEY }).toString(),
        redirect: "manual",
      });
      const setCookie = r.headers.get("set-cookie") || "";
      const m = setCookie.match(/token=([^;]+)/);
      if (m) {
        litellmUiToken = m[1];
        // Extract user_id from the JWT payload for the ?userID= redirect target.
        try {
          const payload = litellmUiToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
          if (decoded.user_id) litellmUiUserId = decoded.user_id;
        } catch { /* leave null; falls back to default_user_id */ }
      } else {
        console.warn("[litellm] auto-login: no token cookie in /login response");
      }
    } catch (err) {
      console.warn("[litellm] auto-login failed:", err.message);
    }
    litellmUiTokenPromise = null;
    return litellmUiToken;
  })();
  return litellmUiTokenPromise;
}

async function proxyLitellmUi(req, res) {
  // Auto-login (idempotent): the dashboard requires BOTH a `token` session cookie
  // AND a `?userID=` query param. Without userID the app clears the cookie and
  // bounces to /sso/key/generate. So EVERY /ui entry lacking ?userID= redirects to
  // /ui/?userID=<userID> - a full 303 (Set-Cookie + Location) when no token cookie
  // is present, or a plain 302 (Location only) when the cookie is already set.
  // This prevents rapid re-navigations from landing on the login page.
  const parsed = (() => { try { return new URL(req.originalUrl, "http://x"); } catch { return null; } })();
  const isUiEntry = req.method === "GET" && parsed && /^\/ui\/?$/.test(parsed.pathname);
  const hasUserId = Boolean(parsed && parsed.searchParams.has("userID"));
  if (isUiEntry && !hasUserId && LITELLM_API_KEY) {
    const token = await getLitellmUiToken();
    if (token) {
      const hasTokenCookie = /(^|;\s*)token=/.test(req.headers.cookie || "");
      const userID = encodeURIComponent(litellmUiUserId || "default_user_id");
      res.status(hasTokenCookie ? 302 : 303);
      if (!hasTokenCookie) res.setHeader("Set-Cookie", `token=${token}; Path=/; SameSite=Lax`);
      res.setHeader("Location", `/ui/?userID=${userID}`);
      return res.end();
    }
  }
  const url = LITELLM_BASE_URL + req.originalUrl;
  const ct = req.headers["content-type"];
  const reqHeaders = {};
  if (ct) reqHeaders["content-type"] = ct;
  // Forward the dashboard's virtual-key Authorization (extracted from its session
  // JWT) when present; else inject the master key. Same rationale as createWebProxy.
  if (req.headers.authorization) {
    reqHeaders.authorization = req.headers.authorization;
  } else if (LITELLM_API_KEY) {
    reqHeaders.authorization = `Bearer ${LITELLM_API_KEY}`;
  }
  // Forward the client's token cookie so LiteLLM endpoints that read the session
  // cookie (not just the Bearer header) authenticate correctly.
  if (req.headers.cookie) reqHeaders.cookie = req.headers.cookie;
  let body;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const isJson = (ct || "").includes("application/json");
    if (isJson && req.body !== undefined) {
      body = JSON.stringify(req.body);
    } else if (!isJson) {
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on("data", (c) => chunks.push(c));
        req.on("end", resolve);
        req.on("error", reject);
      });
      body = Buffer.concat(chunks);
    }
  }
  let upstreamRes;
  try {
    upstreamRes = await fetch(url, { method: req.method, headers: reqHeaders, body, redirect: "manual" });
  } catch (err) {
    return res.status(502).send(`LiteLLM UI unreachable: ${err.message}`);
  }
  res.status(upstreamRes.status);
  const respType = upstreamRes.headers.get("content-type") || "";
  if (respType) res.setHeader("content-type", respType);
  const loc = upstreamRes.headers.get("location");
  if (loc) {
    try { const u = new URL(loc, LITELLM_BASE_URL); res.setHeader("location", u.pathname + u.search); }
    catch { res.setHeader("location", loc); }
  }
  try {
    res.send(Buffer.from(await upstreamRes.arrayBuffer()));
  } catch (err) {
    res.status(502).send(`LiteLLM UI response read failed: ${err.message}`);
  }
}

if (openConnector.openConnectorEnabled) {
  // Embed the runtime's native web UI behind a token-injecting proxy.
  app.all("/oc-web", openConnectorWebProxy);
  app.all("/oc-web/*", openConnectorWebProxy);

  app.get("/api/openconnector/health", async (_req, res) =>
    runOpenConnector(() => openConnector.getHealth(), res));

  app.get("/api/openconnector/providers", async (_req, res) =>
    runOpenConnector(() => openConnector.getProviders(), res));

  app.get("/api/openconnector/actions", async (req, res) =>
    runOpenConnector(() => openConnector.getActions({ service: req.query.service }), res));

  // Declared before /:actionId so "search" is not captured as an action id.
  app.get("/api/openconnector/actions/search", async (req, res) =>
    runOpenConnector(() => openConnector.searchActions(req.query.q), res));

  app.get("/api/openconnector/actions/:actionId", async (req, res) =>
    runOpenConnector(() => openConnector.getAction(req.params.actionId), res));

  app.get("/api/openconnector/actions/:actionId/guide", async (req, res) => {
    try {
      const md = await openConnector.getActionGuide(req.params.actionId);
      res.type("text/markdown").send(md);
    } catch (err) {
      const body = err?.envelope || { success: false, error: err.message };
      res.status(err?.status || 500).json(body);
    }
  });

  app.get("/api/openconnector/connections", async (_req, res) =>
    runOpenConnector(() => openConnector.getConnections(), res));

  app.put("/api/openconnector/connections/:service", async (req, res) => {
    const { authType, values, connectionName } = req.body || {};
    runOpenConnector(
      () => openConnector.putConnection(req.params.service, { authType, values, connectionName }),
      res
    );
  });

  app.delete("/api/openconnector/connections/:service", async (req, res) =>
    runOpenConnector(() => openConnector.deleteConnection(req.params.service), res));

  app.post("/api/openconnector/actions/:actionId/execute", async (req, res) => {
    const { input, alias } = req.body || {};
    runOpenConnector(() => openConnector.executeAction(req.params.actionId, { input, alias }), res);
  });

  app.get("/api/openconnector/runs", async (_req, res) =>
    runOpenConnector(() => openConnector.getRuns(), res));

  // The embedded SPA (loaded via /oc-web) makes same-origin absolute requests
  // for its Vite assets and runtime API (/assets/*, /v1/*, /api/*). Proxy those
  // at the root too, so the UI is fully functional without rebuilding it with a
  // base path. Registered AFTER the app's own /api/* routes above so they take
  // precedence. Tokens are still injected server-side; the browser never sees
  // the runtime URL.
  app.all("/assets/*", openConnectorWebProxy);
  app.all("/v1/*", openConnectorWebProxy);
  app.all("/api/*", openConnectorWebProxy);
}

// ── LiteLLM management UI reverse proxy (mirrors /oc-web) ────────────────────
// Embeds the LiteLLM proxy's management UI behind a token-injecting proxy at
// /litellm-web so the server-held LITELLM_API_KEY never reaches the browser.
// The LiteLLM UI is a SPA that issues same-origin absolute requests for its API
// (/v1/*, /key/*, /spend/*, /model/*, /api/*); those roots are proxied at the
// server root ONLY when OpenConnector is not enabled (OpenConnector owns /v1/*
// and /api/* when it is enabled). The /api/* catch-all is registered after the
// app's own /api/* routes so those take precedence. When both are enabled the
// LiteLLM view surfaces a fallback "open in new tab" link (see app.js).
if (litellmEnabled) {
  app.all("/litellm-web", litellmWebProxy);
  app.all("/litellm-web/*", litellmWebProxy);
  // Dashboard SPA assets (loaded by the embedded iframe src=/litellm-web/ui).
  app.all("/ui", proxyLitellmUi);
  app.all("/ui/*", proxyLitellmUi);
  // LiteLLM dashboard Next.js assets are served at /litellm-asset-prefix/_next/...
  // (the dashboard's assetPrefix). Forward verbatim - litellmWebProxy's /litellm-web
  // prefix doesn't match, so originalUrl is passed through untouched to LiteLLM.
  app.all("/litellm-asset-prefix/*", litellmWebProxy);
  // LiteLLM-specific admin roots never conflict with the app or OpenConnector,
  // so proxy them to LiteLLM whenever LiteLLM is configured (keeps the
  // management UI's API reachable when accessed through the /litellm-web proxy
  // or directly).
  app.all("/key/*", litellmWebProxy);
  app.all("/spend/*", litellmWebProxy);
  app.all("/model/*", litellmWebProxy);
  app.all("/models", litellmWebProxy);
  app.all("/models/*", litellmWebProxy);
  app.all("/user/*", litellmWebProxy);
  app.all("/get_image", litellmWebProxy);
  app.all("/get_favicon", litellmWebProxy);
  // LiteLLM v2 admin API + the /get/* data roots (e.g. /get/litellm_model_cost_map)
  // are used by the dashboard's Models page; proxy them so they return LiteLLM JSON
  // instead of falling through to the SPA catch-all (which serves index.html and
  // leaves the Models table empty).
  app.all("/v2/*", litellmWebProxy);
  app.all("/get/*", litellmWebProxy);
  // LiteLLM dashboard auth flow: /ui/ redirects to /sso/key/generate (login).
  // Proxy it so the redirect stays on the LiteLLM backend instead of falling
  // through to the SPA catch-all (which would route the iframe to /chat).
  app.all("/sso/*", litellmWebProxy);
  // /login is the form-submit target (fallback if the auto-login token expires).
  app.all("/login", litellmWebProxy);
  app.all("/logout", litellmWebProxy);
  // /v1/* and /api/* are contested with OpenConnector (and the app's own /api/*
  // routes), so proxy them to LiteLLM only when OpenConnector is not enabled;
  // otherwise the LiteLLM view surfaces a fallback "open in new tab" link.
  if (!openConnector.openConnectorEnabled) {
    app.all("/v1/*", litellmWebProxy);
    app.all("/api/*", litellmWebProxy);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

openConnector.initOpenConnector();
// initChatHistory must run before initAgent so the sessions store dir is resolved
// before the persistent SessionManager reads it via chatHistory.getSessionsDir().
await chatHistory.initChatHistory();
await workdirStore.initWorkdirStore();
// Open the SQLite project database (chat, documents, index, preferences) before
// feature init. Degrades gracefully: if it cannot open, dbReady stays false and
// the server continues (chat in-memory, documents disabled).
await db.initDb();
// Initialize document store (PageIndex indexing, LlamaIndex framework)
if (db.isDbReady()) {
  if (!LLM_API_KEY) {
    console.warn("[documents] LLM_API_KEY not set; documents RAG indexing/query calls will fail at call time");
  }
  await documents.initStore({
    baseUrl: LLM_BASE_URL,
    apiKey: LLM_API_KEY,
    model: documents.DOCUMENTS_MODEL,
    broadcast,
  });
}
await initAgent();
// One-time best-effort import of legacy chat-history-store/* into the SDK session
// store (runs only when the session store is empty). Per-session failures are
// logged and skipped by the adapter.
await chatHistory.importLegacySessions();
// One-time import of legacy file stores (documents-store/, sessions-store/) into
// the SQLite database. Runs only on a fresh database; idempotent; never deletes
// the legacy stores. Runs after importLegacySessions so chat-history-store data
// flows through the SDK store into SQLite.
await migrate.runLegacyMigrations();

await catalog.initCatalog({ broadcast });

// Initialize cron module
await cron.initCron({
  broadcast,
  sessionPrompt: async (prompt) => {
    if (session) {
      return session.prompt(prompt);
    }
  },
  isStreaming: () => isStreaming,
});

server.listen(PORT, HOST, () => {
  console.log(`Platform running at http://${HOST}:${PORT}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  cron.shutdown();
  catalog.stopCatalog();
  try {
    await closeMcpClients(mcpClients);
  } catch (err) {
    console.error("[shutdown] closeMcpClients failed:", err.message);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
