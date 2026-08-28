import 'dotenv/config';
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import multer from "multer";
import * as chatHistory from "./chat-history.js";
import * as openConnector from "./open-connector.js";
import * as documents from "./documents.js";
import * as db from "./db.js";
import * as migrate from "./migrate.js";
import * as cron from "./cron.js";
import * as extensionStore from "./extension-store.js";
import * as workdirStore from "./workdir-store.js";
import * as catalog from "./catalog.js";
import { resolveBundleSafe } from "./bundle-manifest.js";
import { createAppContext } from "./server/context.js";
import { userFromHeaders, registerAuth } from "./server/auth.js";
import * as skills from "./server/skills.js";
import { registerDocumentRoutes } from "./server/routes/documents.js";
import { registerMiscRoutes, registerStaticAndFallback } from "./server/routes/misc.js";
import { registerLlmRoutes } from "./server/routes/llm.js";
import { registerExtensionRoutes } from "./server/routes/extensions.js";
import { registerChatHistoryRoutes } from "./server/routes/chat-history.js";
import { registerOpenConnectorRoutes } from "./server/routes/openconnector.js";
import { attachDshEvents } from "./server/dsh-events.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";

// ── Optional forward-auth (AUTH_MODE=forward_auth) ───────────────────────────
// Identity = proxy-injected X-Forwarded-Email / X-Forwarded-Groups headers
// (Caddy forward_auth → oauth2-proxy → Logto). TRUST BOUNDARY: enabling this
// asserts the server is reachable ONLY through the forward-auth proxy — bind
// to localhost / firewall it, otherwise these headers are attacker-controlled.

// ── Custom provider config (Volces / 火山引擎) ────────────────────────────────

// Volces (火山引擎) chat provider is optional: an unset LLM_API_KEY means the
// provider is not registered and the server starts with no chat provider (chat
// non-functional, logged), mirroring the LiteLLM graceful-degrade convention.
// The documents RAG reads LLM_API_KEY separately via initStore().

// Default chat model. When set, the dsh session starts on this model id;
// otherwise the first declared profile model is used. See initDshAgent().

// LiteLLM proxy removed — dsh-llm manages LLM natively via settings.yaml +
// .credentials.yaml hot-reload (no child process, no management-UI reverse
// proxy). The dsh LLM profile (dsh-profile.js writeLlmProfile, loaded from .env
// by dotenv/config above) now writes only the Volces route; chat falls back to
// the Volces gateway (when LLM_API_KEY is set) or starts with no chat provider
// (logged, graceful degrade).

// ── Bundle manifest (packaged component selection + pre-installed extensions) ─
// Resolved once at startup. In the packaged app platform.bundle.json sits next
// to this file (Resources/app/); in dev it is the repo root. resolveBundleSafe
// never throws — a corrupt manifest falls back to all-components defaults.
const bundle = resolveBundleSafe();

const app = express();
const server = http.createServer(app);
// noServer + manual handleUpgrade so WS upgrades pass the same forward-auth
// gate as HTTP requests (missing identity ⇒ handshake rejected with 401).
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (ctx.authEnabled && !userFromHeaders(req.headers)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// Shared application context: config + services + agent-session state.
// Every handler below reads/writes through ctx (see server/context.js).
const ctx = createAppContext({
  PORT,
  HOST,
  AUTH_MODE: process.env.AUTH_MODE || "none",
  LLM_API_KEY: process.env.LLM_API_KEY?.trim(),
  LLM_BASE_URL: process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3",
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || "",
  bundle,
});
ctx.app = app;
ctx.server = server;
ctx.wss = wss;
ctx.upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Document collection: JSON bodies for text/url submissions; multipart file
// uploads are kept in memory (LlamaIndex readers read the buffer directly).
app.use(express.json());

// Forward-auth HTTP gate + ctx.requireAdmin (WS upgrade gate below).
registerAuth(ctx);

// Route registration. Order is semantic: app /api routes first, then the
// static SPA + deep-link fallback, then the OpenConnector catch-all proxies
// (/assets|/v1|/api) and /external/:appId — exactly the pre-split order.
registerDocumentRoutes(ctx);
registerMiscRoutes(ctx);
registerLlmRoutes(ctx);
registerExtensionRoutes(ctx);
registerChatHistoryRoutes(ctx);
registerStaticAndFallback(ctx);
registerOpenConnectorRoutes(ctx);

// dsh → WS event translation (attaches ctx.handleDshEvent + ctx.finishTurn).
attachDshEvents(ctx);

// ── Agent session ────────────────────────────────────────────────────────────

// Seed startup MCP configs into the extensions DB so the UI "Installed" tab
// shows them. INSERT OR IGNORE preserves user edits. Origins: mcp.json entries
// stay "user" (operator config); OpenConnector and manifest mcpServers entries
// are pre-installed by the package ("bundled"). Manifest entries take
// locked/permissions from the permissions map ("mcp:<name>" → { allow, deny,
// locked }). Seeding lives here (not in bootstrap/first-run.js) because
// better-sqlite3 only loads under the Node that runs server.js — the Electron
// main process has a different ABI.
// ponytail: shared by the dsh bridge + extension REST routes (design D4 —
// host-side config sources unchanged); writeMcpPatch reads the DB but does not
// seed it, so the seeding must happen here before the patch is written.
function seedStartupMcpConfigs(mcpJsonServers, ocMcpConfig) {
  if (!db.isDbReady()) return;
  for (const [name, config] of Object.entries(mcpJsonServers)) {
    extensionStore.seedMcpServer({ name, config, enabled: true });
  }
  if (ocMcpConfig) {
    const policy = ctx.splitPolicy(ctx.bundle.permissions["mcp:open-connector"]);
    extensionStore.seedMcpServer({
      name: "open-connector",
      config: ocMcpConfig,
      enabled: true,
      origin: ctx.bundle.components.openconnector ? "bundled" : "user",
      ...policy,
    });
  }
  for (const [name, entry] of Object.entries(ctx.bundle.mcpServers)) {
    const { enabled = true, ...config } = entry;
    extensionStore.seedMcpServer({
      name,
      config,
      enabled,
      origin: "bundled",
      ...splitPolicy(ctx.bundle.permissions[`mcp:${name}`]),
    });
  }
}

// ── dsh runtime path ──────────────────────────────────────────────────────────
// Spawns the dsh subprocess via dsh-bridge.js and presents a minimal session
// shim to the WS handler/cron so the rest of server.js is runtime-agnostic.
// Task 2 fills handleDshEvent with the full dsh→WS event-translation map; for
// now it only emits `done` on turn completion (the 1.5 round-trip placeholder).
async function initDshAgent() {
  const { DshBridge } = await import("./dsh-bridge.js");
  const { writeLlmProfile, writeMcpPatch, writeSkillsPatch, ensureCredentialsStore, buildScrubbedEnv } = await import("./dsh-profile.js");

  // Write the dsh llm-adapter profile BEFORE spawning dsh so the runtime
  // loads the Volces routes at initialize. The generator's declared
  // list IS the dsh model list (no stock listModels RPC); server.js sources
  // the selector from it (Task 3.3). Empty list = dormant (Task 3.6).
  const { models } = await writeLlmProfile();
  ctx.dshModels = models;

  // Seed the dsh-credentials-local store from process.env (design D3) and build
  // a scrubbed child env so the file is the winning key-resolution layer.
  try { await ensureCredentialsStore(); } catch (e) { console.warn(`[dsh] credentials store init failed: ${e?.message || e}`); }
  const dshChildEnv = buildScrubbedEnv();

  // Seed startup MCP configs into the extensions DB so the UI "Installed" tab
  // shows them (source=startup). writeMcpPatch reads mcp.json directly for the
  // runtime patch but does NOT seed the DB — seeding is UI-only (Task 4.1).
  let dshMcpJson = {};
  try { dshMcpJson = JSON.parse(await readFile(path.resolve("mcp.json"), "utf8")).mcpServers || {}; } catch {}
  const dshOcMcp = openConnector.buildMcpServerConfig();
  seedStartupMcpConfigs(dshMcpJson, dshOcMcp);

  // Write the dsh-mcp-client patch overlay (one loader entry per MCP server
  // from mcp.json + DB + OpenConnector /mcp). The bridge passes it via --patch;
  // null = no servers configured, flag omitted (Task 4.1/4.2).
  const mcpPatchPath = await writeMcpPatch();

  // Write the skill-filesystem config override (customSkillDirs) so dsh
  // discovers the project's skills/ dir AND the DB-custom-skill materialization
  // dir. The materialization dir is rebuilt from the DB first (design D2): DB
  // skills become <name>/SKILL.md files dsh-skill-filesystem Chokidar-watches,
  // so they hot-reload at runtime on CRUD (no restart).
  let skillMaterializeDir = null;
  try {
    const { rebuildFromDb, writeSkill, MATERIALIZE_DIR } = await import("./skill-materialize.js");
    if (db.isDbReady()) {
      const { failures } = rebuildFromDb(extensionStore.listCustomSkills);
      // Reconciliation pass: retry rows that failed the first write once,
      // then drop still-dirty rows from the materialized set (the DB remains
      // the durable store; the next CRUD or restart re-attempts them).
      if (failures.length) {
        const rows = extensionStore.listCustomSkills().filter((s) => failures.includes(s.name));
        const stillDirty = [];
        for (const s of rows) {
          try { if (!writeSkill(s)) stillDirty.push(s.name); }
          catch (e) { stillDirty.push(s.name); console.warn(`[skills] retry failed for "${s.name}": ${e.message}`); }
        }
        if (stillDirty.length) console.warn(`[skills] materialization still dirty after retry: ${stillDirty.join(", ")}`);
      }
    }
    skillMaterializeDir = MATERIALIZE_DIR;
  } catch (e) {
    console.warn(`[skills] materialization dir unavailable: ${e?.message || e}`);
  }
  const skillsDirs = [path.resolve("skills")];
  if (skillMaterializeDir) skillsDirs.push(skillMaterializeDir);
  const skillsPatchPath = writeSkillsPatch(skillsDirs);

  // Default model: persisted Models-page pointer wins, else DEFAULT_MODEL env if
  // declared, else first declared model.
  let provider = "deepseek-official";
  let model = "deepseek-v4-flash";
  if (ctx.dshModels.length) {
    const llmProviders = await import("./llm-providers.js");
    const saved = llmProviders.getDefault();
    const pick =
      (saved.modelId && ctx.dshModels.find((m) => m.id === saved.modelId)) ||
      (ctx.DEFAULT_MODEL && ctx.dshModels.find((m) => m.id === ctx.DEFAULT_MODEL)) ||
      ctx.dshModels[0];
    provider = pick.provider;
    model = pick.id;
  } else {
    console.warn("[dsh] no LLM keys configured; chat non-functional (static + REST still served)");
  }

  ctx.dshSessionId = "platform-" + randomUUID();
  ctx.dshBridge = new DshBridge({
    provider,
    model,
    onEvent: ctx.handleDshEvent,
    mcpPatchPath,
    skillsPatchPath,
    env: dshChildEnv,
  });
  await ctx.dshBridge.start();
  // MCP live-reload (design D1): the REST routes mutate the DB then call this to
  // rewrite mcp.patch.yml in place — cordis-plugin-include/hmr watches that file
  // (confirmed by source inspection; see design Open Question 1) and hot-swaps
  // dsh-mcp-client (disconnect/reconnect the affected server, no process restart).
  // Single-flight mutex + debounce serialize overlapping mutations; restart() is
  // the documented fallback (PLATFORM_MCP_HOTSWAP=0, or hot-swap never settles).
  let mcpChain = Promise.resolve();
  const hotswapEnabled = process.env.PLATFORM_MCP_HOTSWAP !== "0";
  const HOTSWAP_SETTLE_MS = Number(process.env.PLATFORM_MCP_HOTSWAP_SETTLE_MS || 800);
  ctx.dshUpdateMcp = () => {
    const run = mcpChain.then(async () => {
      const patchPath = await writeMcpPatch();
      if (hotswapEnabled && patchPath) {
        // The patch file was rewritten atomically (temp+rename inside
        // writeMcpPatch); cordis' Chokidar watcher fires refresh() → dsh-mcp-client
        // hot-swaps. No RPC confirms the swap, so settle on a fixed delay — dsh's
        // own debounce is ~100ms; the server-side settle covers reconnect + initial
        // tools/list. ponytail: no confirmation signal exists in the dsh SDK
        // protocol; a settle delay is the simplest bound that lets "applying…" clear.
        await new Promise((r) => setTimeout(r, HOTSWAP_SETTLE_MS));
        return;
      }
      // Fallback: hot-swap disabled or no servers (empty patch). Restart re-spawns
      // the child with the new --patch; dsh persists sessions by id so the
      // conversation resumes from disk. Serialized behind mcpChain, so concurrent
      // mutations can't overlap-corrupt the restart.
      if (patchPath !== undefined) await ctx.dshBridge.restart({ mcpPatchPath: patchPath });
    });
    mcpChain = run.then(() => {}, () => {});
    return run;
  };
  // Session shim: dsh prompt resolves immediately with the message id; the
  // turn plays out as notifications. isStreaming is set here synchronously
  // (host-side streaming guard) so a concurrent prompt observes it.
  // model.id mirrors the broadcast shape (unprefixed id) so current_model on
  // connect matches what the selector sends (Task 3.4).
  // ponytail: dsh has no SessionManager; expose the minimum shape chat-history
  // needs (getSessionId/currentSessionId + no-op buildSessionContext) so the
  // sidebar reflects the live dsh session as current. recordMessage still
  // mirrors to SQLite; getSessionFile returns null (no JSONL under dsh).
  const dshSm = {
    getSessionId: () => ctx.dshSessionId,
    getSessionFile: () => null,
    buildSessionContext: () => ({ messages: [] }),
    newSession: () => { ctx.dshSessionId = "platform-" + randomUUID(); },
    setSessionId: (id) => { ctx.dshSessionId = id; },
    setSessionFile: () => {},
  };
  chatHistory.setSessionManager(dshSm);
  chatHistory.setDshBridge(ctx.dshBridge);
  ctx.session = {
    prompt: async (text) => {
      ctx.isStreaming = true;
      await ctx.dshBridge.prompt(ctx.dshSessionId, [{ type: "text", text }]);
    },
    model: { id: model },
    sessionManager: dshSm,
  };
  ctx.defaultModel = { id: model, provider, name: model };
  console.log(`[dsh] runtime ready (provider=${provider} model=${model})`);
}



// Start a new chat session: create a fresh SDK session and reset the agent's
// in-memory messages. Rejected while streaming to avoid switching mid-turn.
async function createNewSession() {
  if (ctx.isStreaming) throw new Error("Cannot start a new chat while the agent is responding");
  ctx.session.sessionManager.newSession();
  // ponytail: dsh has no in-memory message state to reset — newSession() (shim)
  // already minted a fresh dshSessionId; the next prompt carries it.
  return chatHistory.currentSessionId();
}

// Switch the live agent to an existing session by id: point the session manager at
// that file and reload the agent's in-memory messages from it so the conversation
// continues with full context. Rejected while streaming.
async function switchToSession(id) {
  if (ctx.isStreaming) throw new Error("Cannot switch chat while the agent is responding");
  const currentId = chatHistory.currentSessionId();
  // ponytail: dsh has no in-memory message state to resync — switching the
  // session id is enough; the next prompt carries the new id, and chat-history
  // serves the sidebar's message list from SQLite.
  if (id !== currentId) ctx.session.sessionManager.setSessionId(id);
  // Read the resumed transcript from SQLite so session_loaded carries the real
  // turns into the view (dsh keeps no in-memory message state to resync).
  const sess = await chatHistory.getSession(id);
  return { id, title: sess?.title || "Chat", messages: sess?.messages || [] };
}

// ── Command + model/session helpers (used by the prompt dispatcher) ──────────

// The model list shown to clients. The profile generator's declared list IS the
// model list (no stock listModels RPC). Sourced once at initDshAgent from
// writeLlmProfile().
async function getAvailableModels() {
  return ctx.dshModels.map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider }));
}

// Refresh the model list at runtime (design D3 / spike 2). Re-runs writeLlmProfile
// so settings.yaml is rewritten; dsh-settings-file hot-reloads the
// llm-pi-ai: section and dsh-llm-pi-ai's onChange re-registers the adapter
// routes + model directory live (no restart). dshModels is updated from the
// fresh declared list and clients are told to refetch.
// ponytail: the active model is left as-is; a switch to a newly-appeared model
// still goes through switchModelTo (which restarts — the per-session model is an
// initialize arg, a genuine ceiling). This only refreshes the *selector*.
let dshProfileMod = null;
async function refreshDshModels() {
  if (!dshProfileMod) dshProfileMod = await import("./dsh-profile.js");
  const { models } = await dshProfileMod.writeLlmProfile();
  const before = ctx.dshModels.map((m) => m.id).join(",");
  ctx.dshModels = models;
  const after = ctx.dshModels.map((m) => m.id).join(",");
  if (before !== after) console.log(`[dsh] model list refreshed: ${after || "(none)"}`);
  ctx.broadcast({ type: "models", models: await getAvailableModels() });
  return ctx.dshModels.map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider }));
}

// Switch the active model by id, enforcing the streaming guard. Sends any error
// to the requesting client and returns true on success. Shared by the
// `set_model` WS handler and the `/model` command.
async function switchModelTo(id, ws) {
  if (ctx.isStreaming) {
    ws.send(JSON.stringify({ type: "error", message: "Cannot switch model while the agent is responding" }));
    return false;
  }
  // ponytail: no stock setModel RPC, so a live switch restarts the bridge with
  // the new provider/model baked into initialize. This drops the child's
  // in-memory session state (v1 ceiling); a non-disruptive switch needs a
  // custom dsh RPC. Unknown model → "Unknown model" error.
  const target = ctx.dshModels.find((m) => m.id === id);
  if (!target) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown model: ${id}` }));
    return false;
  }
  if (ctx.session?.model?.id === id) return true;
  try {
    await ctx.dshBridge.restart({ provider: target.provider, model: target.id });
    ctx.session.model = { id: target.id };
    ctx.defaultModel = { id: target.id, provider: target.provider, name: target.name || target.id };
    ctx.broadcast({ type: "model_changed", id });
    return true;
  } catch (err) {
    console.error("[dsh] model switch failed:", err.message);
    ws.send(JSON.stringify({ type: "error", message: err.message }));
    return false;
  }
}

// ── Catalog agent switching (mirrors the model-selection messages) ───────────

// Agents the agent switcher offers: the local dsh session plus visible
// chat-mode remote agents (link agents are external pages, not chat targets).
function switchableAgents(user) {
  return catalog
    .getCatalogFor(user ?? null)
    .agents.filter((a) => a.type === "agent-local" || (a.type === "agent-remote" && a.mode === "chat"));
}

// Switch the active catalog agent by id. Same contract as switchModelTo:
// rejected while streaming, errors go to the requesting client only.
function switchAgentTo(id, ws) {
  if (ctx.isStreaming) {
    ws.send(JSON.stringify({ type: "error", message: "Cannot switch agent while the agent is responding" }));
    return false;
  }
  const target = switchableAgents(ws.user).find((a) => a.id === id);
  if (!target) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${id}` }));
    return false;
  }
  if (id === ctx.currentAgentId) return true;
  ctx.currentAgentId = id;
  ctx.broadcast({ type: "agent_changed", id });
  return true;
}

// Fork a prompt to a remote OpenAI-compat endpoint: POST <baseUrl>/chat/completions
// with stream:true and translate SSE deltas into the existing text events, so the
// frontend renders remote agents exactly like the local one. v1 ceiling: remote
// turns are broadcast-only (no chat-history persistence) and one at a time — a
// prompt while a remote turn is streaming is rejected instead of steered.
async function streamRemoteChat(entry, text) {
  ctx.isStreaming = true; // set synchronously (same contract as the local prompt path)
  ctx.broadcast({ type: "agent_start" });
  // Persist the user turn to the SQLite mirror (design D6) — closes the v1
  // ceiling where remote turns were broadcast-only and a browser close/reopen
  // left a dangling user message with no reply.
  chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);
  let assistantText = "";
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
        if (delta) {
          assistantText += delta;
          ctx.broadcast({ type: "text", delta });
        }
      }
    }
  } catch (err) {
    console.error(`Remote agent '${entry.id}' error:`, err.message);
    ctx.broadcast({ type: "error", message: err.message });
  } finally {
    // Persist the assistant's final aggregated text (design D6).
    if (assistantText) chatHistory.recordMessage(chatHistory.currentSessionId(), "assistant", assistantText);
    ctx.finishTurn();
  }
}

// Handle `/model [id]`: with no id, report the current model + available models;
// with an id, switch (via switchModelTo) and emit a command_use block describing the result.
async function handleModelCommand(args, ws) {
  const id = (args || "").trim();
  const current = ctx.session?.model?.id || "(none)";
  if (!id) {
    const models = await getAvailableModels();
    const modelList = models.map((m) => `  ${m.id}${m.id === current ? " (active)" : ""}`).join("\n");
    ctx.broadcast({
      type: "command_use",
      name: "model",
      args: "",
      message: `Current model: ${current}\n\nAvailable models (${models.length}):\n${modelList}`,
    });
    return;
  }
  const ok = await switchModelTo(id, ws);
  ctx.broadcast({
    type: "command_use",
    name: "model",
    args: id,
    message: ok ? `Model switched to ${id}` : `Could not switch model to ${id}`,
  });
}

// Create a new session and broadcast the session_changed/session_loaded/sessions
// sequence. Shared by the `new_session` WS handler, the `/new` command, and the
// REST new-session route. Errors propagate to the caller.
// Interim wiring: these move to server/agent-session.js in a later step.
ctx.getAvailableModels = getAvailableModels;
ctx.refreshDshModels = refreshDshModels;
ctx.startNewSession = startNewSession;

async function startNewSession() {
  const id = await createNewSession();
  ctx.broadcast({ type: "session_changed", id });
  ctx.broadcast({ type: "session_loaded", id, title: "New chat", messages: [], workdir: null });
  const sessions = await chatHistory.listSessions();
  ctx.broadcast({ type: "sessions", sessions, current: id });
  return id;
}

// Handle `/new`: start a new session, then emit a command_use block (after the
// session_loaded clear so the block renders in the fresh chat).
async function handleNewCommand(ws) {
  try {
    await startNewSession();
    ctx.broadcast({ type: "command_use", name: "new", args: "", message: "Started a new chat" });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }
}

// ── WebSocket handling ───────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {
  // Identity is fixed at upgrade time (v1 ceiling: no re-auth mid-connection).
  ws.user = ctx.authEnabled ? userFromHeaders(req.headers) : null;
  ctx.clients.add(ws);
  console.log(`Client connected (${ctx.clients.size} total)`);

  // Tell the client which model is currently active so the dropdown can sync.
  const currentModelId = ctx.session?.model?.id || null;
  ws.send(JSON.stringify({ type: "current_model", id: currentModelId }));
  // Sync the agent switcher: active catalog agent + switchable agent list.
  ws.send(JSON.stringify({ type: "current_agent", id: ctx.currentAgentId }));
  ws.send(JSON.stringify({ type: "agents", agents: switchableAgents(ws.user) }));
  // Send the chat session list + current session so the sidebar syncs on connect.
  if (ctx.session) {
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

        // Parse a leading slash-command (/skill, /model, /new, …) if present.
        const cmd = skills.parseCommand(text);

        if (cmd && cmd.command === "skill") {
          // Skill invocation: emit a skill_use block and suppress the raw
          // /skill:... text from being echoed as a normal user message.
          ctx.broadcast({ type: "skill_use", name: cmd.name, args: cmd.args });
          // Mirror the user's skill invocation into the SQLite project database.
          chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);

          // Manually expand the skill content and send that to the agent. This
          // does not rely on session.prompt() expanding slash commands.
          // Scan the skills/ dir (same dir the skill-filesystem plugin's
          // customSkillDirs points at, Task 5.3).
          const fileSkills = skills.getFileSkills();
          const skill = fileSkills.find((s) => s.name === cmd.name);
          let promptText = text;
          if (skill) {
            try {
              promptText = await skills.expandSkillContent(skill, cmd.args);
            } catch (err) {
              console.warn(`[skill] Failed to expand "${cmd.name}": ${err.message}`);
            }
          }
          // Expand @doc:<id> attachment references (design D4).
          promptText = await skills.expandDocRefs(ctx, promptText);

          // No steer mechanism through the bridge; reject concurrent prompts
          // host-side (Task 2.7) rather than queueing a second turn.
          if (ctx.isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }

          // Set in-flight synchronously (before the first await) so a concurrent
          // prompt is rejected. agent_start sets it again later (idempotent).
          ctx.isStreaming = true;
          try {
            await ctx.session.prompt(promptText);
          } catch (err) {
            console.error("Agent error:", err.message);
            ctx.broadcast({ type: "error", message: err.message });
            // Finish the turn (reset streaming, emit done, refresh sessions) so a
            // failed turn does not wedge the UI or block model-switch/new-session.
            ctx.finishTurn();
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
          ctx.broadcast({ type: "user", text });

          // Remote-agent fork: when a chat-mode catalog agent is active, stream
          // from its OpenAI-compat endpoint instead of the local session. The
          // user message is echoed above; streamRemoteChat persists both the
          // user and assistant turns to chat-history (design D6).
          if (ctx.currentAgentId !== "local") {
            if (ctx.isStreaming) {
              ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
              break;
            }
            const entry = catalog.getAgentEntry(ctx.currentAgentId);
            if (!entry) {
              // Catalog changed under us (entry removed / no longer visible).
              ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${ctx.currentAgentId}` }));
              break;
            }
            // Expand @doc:<id> attachment references for the remote agent too.
            await streamRemoteChat(entry, await skills.expandDocRefs(ctx, text));
            break;
          }

          // No steer mechanism through the bridge; reject concurrent prompts
          // host-side (Task 2.7) rather than queueing a second turn.
          if (ctx.isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }

          // Mirror the user prompt into the SQLite project database.
          chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);

          // Set in-flight synchronously (before the first await) so a concurrent
          // prompt is rejected. agent_start sets it again later (idempotent).
          ctx.isStreaming = true;
          // Expand @doc:<id> attachment references into the document content the
          // agent sees (design D4); the user message above keeps the raw refs.
          const promptWithDocs = await skills.expandDocRefs(ctx, text);
          try {
            await ctx.session.prompt(promptWithDocs);
          } catch (err) {
            console.error("Agent error:", err.message);
            ctx.broadcast({ type: "error", message: err.message });
            // Finish the turn (reset streaming, emit done, refresh sessions) so a
            // failed turn does not wedge the UI or block model-switch/new-session.
            ctx.finishTurn();
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
        const fileSkills = skills.getFileSkills()
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
        ws.send(JSON.stringify({ type: "skills", skills: fileSkills }));
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
          const result = await switchToSession(data.id);
          ctx.broadcast({
            type: "session_loaded",
            id: result.id,
            title: result.title,
            messages: result.messages,
          });
          ctx.broadcast({ type: "session_changed", id: result.id });
          const sessions = await chatHistory.listSessions();
          ctx.broadcast({ type: "sessions", sessions, current: result.id });
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "rename_session": {
        try {
          const title = chatHistory.setTitle(data.id, data.title);
          ctx.broadcast({ type: "session_renamed", id: data.id, title });
        } catch (err) {
          if (err?.code) {
            ws.send(JSON.stringify({ type: "rename_session_error", code: err.code, message: err.message }));
          } else {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    ctx.clients.delete(ws);
    console.log(`Client disconnected (${ctx.clients.size} total)`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    ctx.clients.delete(ws);
  });
});







// ── Start ────────────────────────────────────────────────────────────────────
// BOOT-ORDER INVARIANTS (behavioral contract, see the split-server-monolith
// spec): initChatHistory resolves the sessions store dir BEFORE initDshAgent
// (the session shim reads it); db.initDb opens BEFORE documents.initStore and
// BEFORE runLegacyMigrations; documents.initStore's restart reconciliation
// runs BEFORE migrate's legacy import enqueues re-indexing; initDshAgent
// completes before anything prompts; listen() is LAST. Parallelizing any of
// this is a semantic change (planned deliberately in optimize-hot-paths).

openConnector.initOpenConnector();
// initChatHistory must run before initDshAgent so the sessions store dir is
// resolved before the session shim reads it via chatHistory.getSessionsDir().
await chatHistory.initChatHistory();
await workdirStore.initWorkdirStore();
// Open the SQLite project database (chat, documents, index, preferences) before
// feature init. Degrades gracefully: if it cannot open, dbReady stays false and
// the server continues (chat in-memory, documents disabled).
await db.initDb();
// Initialize document store (PageIndex indexing, LlamaIndex framework)
if (db.isDbReady()) {
  if (!ctx.LLM_API_KEY) {
    console.warn("[documents] ctx.LLM_API_KEY not set; documents RAG indexing/query calls will fail at call time");
  }
  await documents.initStore({
    baseUrl: ctx.LLM_BASE_URL,
    apiKey: ctx.LLM_API_KEY,
    model: documents.DOCUMENTS_MODEL,
    broadcast: ctx.broadcast,
  });
}
await initDshAgent();
// One-time import of legacy file stores (documents-store/, sessions-store/,
// chat-history-store/) into the SQLite database. Runs only on a fresh database;
// idempotent; never deletes the legacy stores. migrate.js reads both legacy
// chat formats directly with stdlib fs (no SDK dependency).
await migrate.runLegacyMigrations();

await catalog.initCatalog({ broadcast: ctx.broadcast });

// Initialize cron module
await cron.initCron({
  broadcast: ctx.broadcast,
  sessionPrompt: async (prompt) => {
    if (ctx.session) {
      return ctx.session.prompt(prompt);
    }
  },
  isStreaming: () => ctx.isStreaming,
});

server.listen(PORT, HOST, () => {
  console.log(`Platform running at http://${HOST}:${PORT}`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  cron.shutdown();
  catalog.stopCatalog();
  try {
    await ctx.dshBridge?.shutdown();
  } catch (err) {
    console.error("[shutdown] dsh bridge failed:", err.message);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
