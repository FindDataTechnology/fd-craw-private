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
import { connectMcpServers, connectServers, closeMcpClients } from "./mcp-bridge.js";
import multer from "multer";
import {
  initStore,
  addDocument,
  listDocuments,
  getDocumentContent,
  removeDocument,
  queryCollection,
  typeForFilename,
  SUPPORTED_EXTS,
} from "./documents.js";
import { fetchLitellmModels } from "./litellm-models.js";
import * as collections from "./collections.js";
import * as chatHistory from "./chat-history.js";
import * as openConnector from "./open-connector.js";
import * as db from "./db.js";
import * as migrate from "./migrate.js";
import * as cron from "./cron.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";

// ── Custom provider config (Volces / 火山引擎) ────────────────────────────────

const VOLCES_API_KEY = process.env.VOLCES_API_KEY || "REDACTED_VOLCES_API_KEY";
const VOLCES_BASE_URL = process.env.VOLCES_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3";

// Document collection (LlamaIndex.TS) model. Defaults to the same family used for
// chat; override with DOCUMENTS_MODEL. Must be a model id registered on the Volces
// provider above.
const DOCUMENTS_MODEL = process.env.DOCUMENTS_MODEL || "deepseek-v4-pro";

// Default chat model. When set, the agent session starts on this model id.
// Otherwise the server prefers the first LiteLLM model (when LiteLLM is configured)
// and falls back to the first Volces model. See resolveDefaultModel().
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "";

// ── LiteLLM proxy config (consumed by pi-provider-litellm) ───────────────────
// The extension reads LITELLM_BASE_URL / LITELLM_API_KEY from the environment
// (loaded from .env by dotenv/config above). When either is missing, the
// litellm provider is skipped so the server still starts Volces-only.
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL;
const LITELLM_API_KEY = process.env.LITELLM_API_KEY;
const litellmEnabled = Boolean(LITELLM_BASE_URL && LITELLM_API_KEY);
if (!litellmEnabled) {
  console.warn("[litellm] LITELLM_BASE_URL or LITELLM_API_KEY not set; skipping litellm provider");
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
const wss = new WebSocketServer({ server });

// Document collection: JSON bodies for text/url submissions; multipart file
// uploads are kept in memory (LlamaIndex readers read the buffer directly).
app.use(express.json());
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ── Agent session (module-scoped for WS handlers) ────────────────────────────

let session = null;
let isStreaming = false;
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
  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey("volces", VOLCES_API_KEY);
  modelRegistry = ModelRegistry.create(authStorage);

  // Connect MCP servers first so their tools are discovered before the session
  // is created. The tool names MUST be added to the `tools` allowlist below,
  // otherwise the SDK filters custom tools out (see agent-session _refreshToolRegistry).
  const mcp = await connectMcpServers(path.resolve("mcp.json"));
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

  mcpClients = mcpClientList;
  const mcpToolNames = mcpTools.map((t) => t.name);
  mcpToolCount = mcpToolNames.length;
  if (mcpToolNames.length) {
    console.log(`[mcp] Registering ${mcpToolNames.length} MCP tool(s): ${mcpToolNames.join(", ")}`);
  }

  // Native Volces chat provider. Registered only when LiteLLM is NOT
  // configured (see extensionFactories) so the agent stays LiteLLM-only when
  // LiteLLM is available. The documents RAG uses Volces directly via
  // initStore() and does NOT depend on this provider being registered.
  const volcesProviderFactory = (pi) => {
    pi.registerProvider("volces", {
      name: "Volces Coding",
      baseUrl: VOLCES_BASE_URL,
      apiKey: VOLCES_API_KEY,
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
  };

  loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    additionalSkillPaths: [path.resolve("skills")],
    // Register exactly one chat provider so the agent is single-sourced:
    //   - LiteLLM configured  -> LiteLLM extension only (LiteLLM-only by
    //     construction; native Volces chat models can never leak into the
    //     selector, the startup default, or runtime switching).
    //   - LiteLLM not configured -> Volces provider only (graceful fallback).
    extensionFactories: litellmEnabled ? [litellmExtension] : [volcesProviderFactory],
    systemPromptOverride: () => "You are a helpful coding assistant. Be concise.",
  });
  await loader.reload();

  defaultModel = resolveDefaultModel();
  if (defaultModel) {
    console.log(`[model] Default chat model: ${defaultModel.provider}/${defaultModel.id}`);
  } else {
    console.warn("[model] No default model resolved; falling back to SDK default");
  }

  // Use the SDK's persistent SessionManager (JSONL sessions under the sessions
  // store dir) instead of inMemory(), so conversations are auto-persisted and can
  // be resumed/switched. The store dir is owned by chat-history.js (overridable via
  // SESSIONS_STORE_DIR for E2E isolation).
  const result = await createAgentSession({
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    model: defaultModel,
    resourceLoader: loader,
    tools: ["read", "bash", "grep", "find", "ls", ...mcpToolNames],
    customTools: mcpTools,
    sessionManager: SessionManager.create(process.cwd(), chatHistory.getSessionsDir()),
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
  broadcast({ type: "session_loaded", id, title: "New chat", messages: [] });
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

wss.on("connection", (ws) => {
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
          // Mirror the user prompt into the SQLite project database.
          chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);

          try {
            if (isStreaming) {
              await session.prompt(text, { streamingBehavior: "steer" });
            } else {
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
        const removed = await cron.removeJob(data.jobId);
        ws.send(JSON.stringify({ type: "cron_removed", jobId: data.jobId, success: removed }));
        break;
      }

      case "cron_pause": {
        const paused = await cron.pauseJob(data.jobId);
        ws.send(JSON.stringify({ type: "cron_paused", jobId: data.jobId, success: paused }));
        break;
      }

      case "cron_resume": {
        const resumed = await cron.resumeJob(data.jobId);
        ws.send(JSON.stringify({ type: "cron_resumed", jobId: data.jobId, success: resumed }));
        break;
      }

      case "cron_list": {
        ws.send(JSON.stringify({ type: "cron_jobs", jobs: cron.listJobs() }));
        break;
      }

      case "cron_run": {
        const ran = await cron.runJobNow(data.jobId);
        ws.send(JSON.stringify({ type: "cron_run_started", jobId: data.jobId, success: ran }));
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
          const result = await switchToSession(data.id);
          broadcast({
            type: "session_loaded",
            id: result.id,
            title: result.title,
            messages: result.messages,
          });
          broadcast({ type: "session_changed", id: result.id });
          const sessions = await chatHistory.listSessions();
          broadcast({ type: "sessions", sessions, current: result.id });
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
app.get(/^\/(?!api\/|oc-web|litellm-web|assets\/|v1\/).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

// ── Server config (e.g. LiteLLM management UI link) ──────────────────────────
app.get("/api/config", (_req, res) => {
  res.json({
    litellmEnabled,
    openconnectorEnabled: openConnector.openConnectorEnabled,
    litellmManagementUrl: LITELLM_BASE_URL ? `${LITELLM_BASE_URL}/ui` : null,
    documentsEnabled: db.isDbReady(),
  });
});

// Local bundled LiteLLM master key, so the user can sign into the management UI
// (the bundled proxy's master_key is auto-generated server-side). Exposed ONLY
// when LiteLLM is local (localhost) - for a remote proxy the user has their own
// credentials and this returns null (no key reaches the browser in that case).
app.get("/api/litellm/credentials", (_req, res) => {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(LITELLM_BASE_URL || "");
  res.json({ masterKey: isLocal ? (LITELLM_API_KEY || null) : null });
});

// ── Supervisor / system status (for the Dashboard view) ──────────────────────
// Returns NON-SECRET system status only. Never includes API keys or tokens.
// In dev (node server.js) returns this server's own self-status. In the packaged
// Electron app the Electron main process can override this via IPC (future); for
// now it returns the same self-status which is sufficient for the dashboard.
app.get("/api/supervisor/status", (_req, res) => {
  const docs = listDocuments();
  const docByStatus = docs.reduce((acc, d) => {
    acc[d.status] = (acc[d.status] || 0) + 1;
    return acc;
  }, {});
  const colls = db.isDbReady() ? collections.listCollections() : [];
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
    documentCount: docs.length,
    documentByStatus: docByStatus,
    collectionCount: colls.length,
    mcpToolCount,
    uptimeMs: process.uptime() * 1000,
  });
});

// ── Document collection endpoints ────────────────────────────────────────────
// LlamaIndex framework + PageIndex indexing, persisted to the SQLite project
// database. Mirrors the former /api/knowledge/* surface. Multipart file uploads
// (PDF / Markdown) use multer memory storage; text/url arrive as JSON. Status
// flows to clients via documents_status WS events broadcast by the documents
// module. Disabled (503) when the project database is unavailable.

app.post("/api/documents", upload.single("file"), async (req, res) => {
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
  }
  try {
    let input;
    if (req.file) {
      const type = typeForFilename(req.file.originalname);
      if (!type) {
        return res.status(415).json({
          error: `Unsupported file type. Supported extensions: ${SUPPORTED_EXTS.join(", ")}`,
        });
      }
      input = {
        type,
        name: req.file.originalname,
        buffer: req.file.buffer,
      };
    } else {
      const { type, content, url, name } = req.body || {};
      if (type !== "text" && type !== "url") {
        return res
          .status(400)
          .json({ error: "Invalid type; upload a file or set type to text|url" });
      }
      if (type === "text" && !content) {
        return res.status(400).json({ error: "Missing content" });
      }
      if (type === "url" && !url) {
        return res.status(400).json({ error: "Missing url" });
      }
      input = { type, content, url, name };
    }
    const result = await addDocument(input);
    res.json(result);
  } catch (err) {
    console.error("[documents] add error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/documents", (req, res) => {
  res.json({ documents: listDocuments() });
});

app.get("/api/documents/:id", async (req, res) => {
  try {
    const content = await getDocumentContent(req.params.id);
    if (content === null) return res.status(404).json({ error: "Not found" });
    res.json({ content });
  } catch (err) {
    console.error("[documents] content error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/documents/:id", async (req, res) => {
  const removed = await removeDocument(req.params.id);
  res.status(removed ? 200 : 404).json({ removed });
});

app.post("/api/documents/query", async (req, res) => {
  const query = (req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "Missing query" });
  if (!db.isDbReady()) {
    return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
  }
  try {
    const result = await queryCollection(query);
    res.json(result);
  } catch (err) {
    console.error("[documents] query error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Document collections endpoints ───────────────────────────────────────────
// Named groups of documents, persisted in the project SQLite database. Disabled
// (503) when the database is unavailable. Memberships cascade-delete with the
// parent document or collection (FK ON DELETE CASCADE).

function collectionsDisabled(res) {
  return res
    .status(503)
    .json({ error: "Collections are disabled (database unavailable)" });
}

app.get("/api/collections", (_req, res) => {
  if (!db.isDbReady()) return collectionsDisabled(res);
  res.json({ collections: collections.listCollections() });
});

app.post("/api/collections", (req, res) => {
  if (!db.isDbReady()) return collectionsDisabled(res);
  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Missing collection name" });
    }
    res.json({ collection: collections.createCollection({ name, description }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/collections/:id", (req, res) => {
  if (!db.isDbReady()) return collectionsDisabled(res);
  try {
    const { name, description } = req.body || {};
    const updated = collections.renameCollection(req.params.id, { name, description });
    res.json({ collection: updated });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/collections/:id", (req, res) => {
  if (!db.isDbReady()) return collectionsDisabled(res);
  collections.deleteCollection(req.params.id);
  res.json({ ok: true });
});

app.get("/api/collections/:id/documents", (req, res) => {
  if (!db.isDbReady()) return collectionsDisabled(res);
  try {
    res.json({ documents: collections.listMembers(req.params.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/collections/:id/documents", (req, res) => {
  if (!db.isDbReady()) return collectionsDisabled(res);
  try {
    const { documentId } = req.body || {};
    if (!documentId) return res.status(400).json({ error: "Missing documentId" });
    const collection = collections.addDocument(req.params.id, documentId);
    res.json({ collection });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete("/api/collections/:id/documents/:docId", (req, res) => {
  if (!db.isDbReady()) return collectionsDisabled(res);
  collections.removeDocument(req.params.id, req.params.docId);
  res.json({ ok: true });
});

app.post("/api/collections/:id/query", async (req, res) => {
  if (!db.isDbReady()) return collectionsDisabled(res);
  const query = (req.body?.query || "").trim();
  if (!query) return res.status(400).json({ error: "Missing query" });
  try {
    const result = await collections.queryCollection(req.params.id, query);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
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

    // Forwarded headers: drop client Authorization + hop-by-hop; keep content-type.
    const ct = req.headers["content-type"];
    const reqHeaders = {};
    if (ct) reqHeaders["content-type"] = ct;
    const token = getToken(upstream);
    if (token) reqHeaders.authorization = `Bearer ${token}`;

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
    const buf = Buffer.from(await upstreamRes.arrayBuffer());

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
  // LiteLLM-specific admin roots never conflict with the app or OpenConnector,
  // so proxy them to LiteLLM whenever LiteLLM is configured (keeps the
  // management UI's API reachable when accessed through the /litellm-web proxy
  // or directly).
  app.all("/key/*", litellmWebProxy);
  app.all("/spend/*", litellmWebProxy);
  app.all("/model/*", litellmWebProxy);
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
// Open the SQLite project database (chat, documents, index, preferences) before
// feature init. Degrades gracefully: if it cannot open, dbReady stays false and
// the server continues (chat in-memory, documents disabled).
await db.initDb();
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
await initStore({
  baseUrl: VOLCES_BASE_URL,
  apiKey: VOLCES_API_KEY,
  model: DOCUMENTS_MODEL,
  broadcast,
});

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
  await closeMcpClients(mcpClients);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
