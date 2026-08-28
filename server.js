import 'dotenv/config';
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import multer from "multer";
import * as chatHistory from "./chat-history.js";
import * as openConnector from "./open-connector.js";
import * as documents from "./documents.js";
import * as collections from "./collections.js";
import * as db from "./db.js";
import * as migrate from "./migrate.js";
import * as cron from "./cron.js";
import * as extensionStore from "./extension-store.js";
import * as skillMaterialize from "./skill-materialize.js";
import * as workdirStore from "./workdir-store.js";
import * as catalog from "./catalog.js";
import { resolveBundleSafe } from "./bundle-manifest.js";
import { createAppContext } from "./server/context.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";

// ── Optional forward-auth (AUTH_MODE=forward_auth) ───────────────────────────
// Identity = proxy-injected X-Forwarded-Email / X-Forwarded-Groups headers
// (Caddy forward_auth → oauth2-proxy → Logto). TRUST BOUNDARY: enabling this
// asserts the server is reachable ONLY through the forward-auth proxy — bind
// to localhost / firewall it, otherwise these headers are attacker-controlled.

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

// Forward-auth gate: when enabled, every HTTP request needs a proxy-injected
// identity; attaches req.user = { email, groups } for downstream handlers.
app.use((req, res, next) => {
  if (!ctx.authEnabled) return next();
  const user = userFromHeaders(req.headers);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  req.user = user;
  next();
});

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

// Expand @doc:<id> reference tokens into the ingested document's source text so
// the agent sees the attachment content in context (design D4). Mirrors how
// /skill: tokens are expanded before session.prompt(). Unknown/missing ids are
// replaced with a short note so the prompt stays coherent. No new dependency —
// reuses documents.getDocumentContent (the same path /api/documents/:id serves).
async function expandDocRefs(text) {
  if (!text.includes("@doc:")) return text;
  const refs = [...text.matchAll(/@doc:([A-Za-z0-9_-]+)/g)];
  if (!refs.length) return text;
  let out = text;
  for (const m of refs) {
    const id = m[1];
    let body;
    try { body = await documents.getDocumentContent(id); }
    catch (e) { console.warn(`[doc] @doc:${id} lookup failed: ${e.message}`); }
    const snippet = body && body.trim()
      ? body.trim().slice(0, 12000)
      : `(document ${id} is unavailable or empty)`;
    out = out.replaceAll(m[0], `\n\n--- attached document ${id} ---\n${snippet}\n--- end document ${id} ---\n`);
  }
  return out;
}

// Scan the project skills/ dir (dir bundles `<name>/SKILL.md` + flat `<name>.md`)
// for [{name, description, filePath}]. list_skills + /skill: expansion source
// the same dir the skill-filesystem plugin's customSkillDirs points at (Task 5.3).
// ponytail: regex frontmatter parse + no caching (4 files, called rarely); a
// multi-line/quoted description or a hot list_skills path needs a real parser + cache.
function getFileSkills(dir = path.resolve("skills")) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const skills = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    const filePath = st.isDirectory() ? path.join(full, "SKILL.md") : (entry.endsWith(".md") ? full : null);
    if (!filePath) continue;
    let raw;
    try { raw = readFileSync(filePath, "utf8"); } catch { continue; }
    const block = raw.match(/^---[\s\S]*?---/)?.[0];
    if (!block) continue;
    const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name) continue;
    skills.push({ name, description: desc || "", filePath });
  }
  return skills;
}

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
    onEvent: handleDshEvent,
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

// dsh → WS event-translation map (Task 2). The dsh runtime emits an append-only
// session event log as `session.event` notifications plus `session.status`
// lifecycle notifications; this maps them onto the frozen WS protocol the React
// frontend already speaks.
//   turn/start          → agent_start (isStreaming already set at dispatch)
//   assistant/chunk     → text / thinking / (error capture on finish error)
//   assistant/message   → chat-history record (assistant turn persistence)
//   tool/call           → tool_start
//   tool/result         → tool_end
//   turn/end (error)    → error
//   session.status idle → finishTurn (done + sessions refresh)
// dsh has no partial-tool-result event, so tool_update is unmapped. Unmapped
// notifications log at debug (DSH_DEBUG) and never drop the turn.
function handleDshEvent(notif) {
  const { method, params } = notif || {};
  if (method === "session.status") {
    if (params?.status === "idle") ctx.finishTurn();
    return;
  }
  if (method !== "session.event") {
    if (process.env.DSH_DEBUG)
      console.debug("[dsh] notification:", method, JSON.stringify(params)?.slice(0, 200));
    return;
  }
  const ev = params?.event;
  if (!ev) return;
  if (process.env.DSH_DEBUG) console.log("[dsh-debug] event:", ev.type, JSON.stringify(ev.data)?.slice(0, 600));
  switch (ev.type) {
    case "turn/start":
      // One agent_start per turn. isStreaming was already set synchronously at
      // prompt dispatch (see the WS prompt handler) so a concurrent prompt
      // observes it; re-affirm here idempotently.
      ctx.isStreaming = true;
      ctx.dshTurnError = null;
      ctx.dshToolNames.clear();
      ctx.broadcast({ type: "agent_start" });
      break;
    case "assistant/chunk": {
      const chunk = ev.data?.chunk;
      if (!chunk) break;
      if (chunk.type === "text-delta" && chunk.text) {
        ctx.broadcast({ type: "text", delta: chunk.text });
      } else if (chunk.type === "reasoning-delta" && chunk.text) {
        ctx.broadcast({ type: "thinking", delta: chunk.text });
      } else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
        // Capture the LLM failure; broadcast on turn/end (the turn-completion
        // signal), then session.status idle → finishTurn → done.
        ctx.dshTurnError = chunk.reason.failure?.message || "LLM request failed";
      }
      break;
    }
    case "assistant/message": {
      // Mirror the assistant's final text into the SQLite project database
      // (on assistant/message). Only records when text was produced.
      const blocks = ev.data?.message?.content;
      if (Array.isArray(blocks)) {
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        if (text) chatHistory.recordMessage(chatHistory.currentSessionId(), "assistant", text);
      }
      break;
    }
    case "tool/call":
      ctx.dshToolNames.set(ev.data.callId, ev.data.name);
      ctx.broadcast({
        type: "tool_start",
        toolCallId: ev.data.callId,
        name: ev.data.name,
        // dsh carries raw JSON string arguments; parse to match the WS contract.
        args: (() => { try { return JSON.parse(ev.data.arguments); } catch { return ev.data.arguments; } })(),
      });
      break;
    case "tool/result": {
      const callId =
        ev.data?.message?.source?.callId ?? ev.data?.message?.content?.[0]?.toolCallId;
      const resultBlocks = ev.data?.message?.content?.[0]?.content;
      const resultText = Array.isArray(resultBlocks)
        ? resultBlocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null
        : null;
      ctx.broadcast({
        type: "tool_end",
        toolCallId: callId,
        name: ctx.dshToolNames.get(callId) ?? undefined,
        result: resultText,
        isError: !!ev.data?.error || !!ev.data?.message?.content?.[0]?.isError,
      });
      break;
    }
    case "turn/end":
      if (ev.data?.reason?.kind === "error" && ctx.dshTurnError) {
        ctx.broadcast({ type: "error", message: ctx.dshTurnError });
      }
      ctx.dshTurnError = null;
      break;
    default:
      if (process.env.DSH_DEBUG) console.debug("[dsh] unmapped event:", ev.type);
      break;
  }
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
        const cmd = parseCommand(text);

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
          const skills = getFileSkills();
          const skill = skills.find((s) => s.name === cmd.name);
          let promptText = text;
          if (skill) {
            try {
              promptText = await expandSkillContent(skill, cmd.args);
            } catch (err) {
              console.warn(`[skill] Failed to expand "${cmd.name}": ${err.message}`);
            }
          }
          // Expand @doc:<id> attachment references (design D4).
          promptText = await expandDocRefs(promptText);

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
            await streamRemoteChat(entry, await expandDocRefs(text));
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
          const promptWithDocs = await expandDocRefs(text);
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
        const skills = getFileSkills()
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

// ── Documents REST API routes (local PageIndex + LlamaIndex) ───────────────
// Ingests PDF, Markdown, text, URL, DOCX, XLSX, PPTX, CSV, HTML. Indexes
// via PageIndex through LlamaIndex.TS framework with SQLite persistence.
// Status transitions broadcast as documents_status WS events.

app.post("/api/documents", ctx.upload.single("file"), async (req, res) => {
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

app.get("/api/documents", (_req, res) => {
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
//                   `/dashboard`, each of which serves the same page; the
//                   vanilla client opens the matching tab from the URL path
//                   on load.
// The React app's Vite `base` is `/chat/`, so its assets self-reference as
// `/chat/assets/...` — no conflict with legacy `/assets/...` from OpenConnector.
const webDist = path.resolve("web/dist");
app.use(express.static(webDist));
// SPA fallback: any GET that isn't an API route, proxy path, or static asset
// serves index.html so the client router handles it. /v1/* is excluded so the
// OpenConnector /v1 reverse-proxy routes - registered below - are not shadowed
// by this fallback (which would serve index.html for the embedded SPA's API
// calls).
app.get(/^\/(?!api\/|oc-web|external\/|assets\/|v1\/|v2\/|ui|key\/|spend\/|model\/|sso\/|login|logout|user\/|get_image|get_favicon|get\/).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

// Identity introspection: lets the frontend render login state without
// inspecting headers. email/groups are null when auth is off.
app.get("/api/auth/me", (req, res) => {
  res.json({
    mode: ctx.AUTH_MODE,
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
  if (ctx.authEnabled && !req.user?.groups?.includes("admin")) {
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
  if (!ctx.authEnabled || !req.user?.email) {
    return res.status(400).json({ error: "Connect requires ctx.AUTH_MODE=forward_auth" });
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

// ── Server config (e.g. openconnector / documents state) ──────────────────────
app.get("/api/config", (_req, res) => {
  res.json({
    openconnectorEnabled: openConnector.openConnectorEnabled,
    documentsEnabled: db.isDbReady(),
  });
});

// Refresh the dsh model list at runtime (design D3 / spike 2). Re-runs
// writeLlmProfile; dsh-settings-file hot-reloads the llm-pi-ai: section so new
// models reach the adapter without a restart. The active model is untouched.
// Admin-gated under forward-auth (a config mutation).
app.post("/api/models/refresh", async (req, res) => {
  if (ctx.authEnabled && !req.user?.groups?.includes("admin")) {
    return res.status(403).json({ error: "Admin group required" });
  }
  try {
    const models = await refreshDshModels();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// After a provider add/edit/delete: refresh the credentials file + the
// llm-pi-ai profile. Both are Chokidar-watched by dsh (settings-file +
// credentials-local), so the new route and key hot-reload with no dsh
// restart — the same path /api/models/refresh relies on. Then update
// dshModels and broadcast so the sidebar/model chip and the Models page
// pick up the new model ids immediately.
async function reloadLlmProviders() {
  const dshProfile = await import("./dsh-profile.js");
  await dshProfile.ensureCredentialsStore();
  const { models } = await dshProfile.writeLlmProfile();
  ctx.dshModels = models;
  ctx.broadcast({ type: "models", models: await getAvailableModels() });
}

// In-process write mutex: serialize provider/credential mutations so two
// concurrent UI edits can't race on llm-providers.json / settings.yaml. A
// competing request is rejected with a 409 immediately (not queued), per the
// llm-model-management spec.
class BusyError extends Error {
  constructor() { super("another edit in progress"); this.code = "busy"; }
}
let llmWriteInProgress = false;
async function withLlmWriteLock(fn) {
  if (llmWriteInProgress) throw new BusyError();
  llmWriteInProgress = true;
  try {
    return await fn();
  } finally {
    llmWriteInProgress = false;
  }
}

function requireAdmin(req, res) {
  if (ctx.authEnabled && !req.user?.groups?.includes("admin")) {
    res.status(403).json({ error: "Admin group required" });
    return false;
  }
  return true;
}

// ── LLM provider management (Models page) ────────────────────────────────────

app.get("/api/llm/providers", async (_req, res) => {
  try {
    const llmProviders = await import("./llm-providers.js");
    // The env-generated Volces route is the reserved, always-present provider.
    const envProviders = process.env.LLM_API_KEY?.trim()
      ? [{
          id: "volces",
          name: "Volces",
          baseUrl: process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3",
          type: "openai-completions",
          hasKey: true,
          reserved: true,
          models: ctx.dshModels.filter((m) => m.provider === "volces").map((m) => m.id),
          lastTest: null,
        }]
      : [];
    res.json({ providers: [...envProviders, ...llmProviders.listUserProviders()] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/llm/providers", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const llmProviders = await import("./llm-providers.js");
    const record = await withLlmWriteLock(async () => {
      const created = llmProviders.createProvider(req.body || {});
      await reloadLlmProviders();
      return created;
    });
    res.status(201).json({ provider: record });
  } catch (err) {
    const status =
      err?.code === "busy" ? 409 :
      err?.code === "duplicate" ? 409 :
      err?.code === "invalid" ? 400 : 500;
    res.status(status).json({ error: err.message, code: err?.code });
  }
});

app.put("/api/llm/providers/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const llmProviders = await import("./llm-providers.js");
    const record = await withLlmWriteLock(async () => {
      const updated = llmProviders.updateProvider(req.params.id, req.body || {});
      await reloadLlmProviders();
      return updated;
    });
    res.json({ provider: record });
  } catch (err) {
    const status =
      err?.code === "busy" ? 409 :
      err?.code === "not_found" ? 404 :
      err?.code === "duplicate" ? 409 :
      err?.code === "invalid" ? 400 : 500;
    res.status(status).json({ error: err.message, code: err?.code });
  }
});

app.delete("/api/llm/providers/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const llmProviders = await import("./llm-providers.js");
    await withLlmWriteLock(async () => {
      llmProviders.deleteProvider(req.params.id);
      await reloadLlmProviders();
    });
    res.json({ ok: true });
  } catch (err) {
    const status =
      err?.code === "busy" ? 409 :
      err?.code === "not_found" ? 404 :
      err?.code === "only_provider" ? 409 :
      err?.code === "invalid" ? 400 : 500;
    res.status(status).json({ error: err.message, code: err?.code });
  }
});

app.post("/api/llm/providers/:id/test", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const llmProviders = await import("./llm-providers.js");
    const result = await llmProviders.testProvider(req.params.id);
    res.json(result);
  } catch (err) {
    const status =
      err?.code === "not_found" ? 404 :
      err?.code === "invalid" ? 400 : 500;
    res.status(status).json({ error: err.message, code: err?.code });
  }
});

app.get("/api/llm/default", async (_req, res) => {
  try {
    const llmProviders = await import("./llm-providers.js");
    const saved = llmProviders.getDefault();
    res.json({
      providerId: saved.providerId,
      modelId: saved.modelId || ctx.defaultModel?.id || null,
      activeModelId: ctx.session?.model?.id || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/llm/default", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const llmProviders = await import("./llm-providers.js");
    const { modelId, providerId } = req.body || {};
    const target = ctx.dshModels.find((m) => m.id === modelId);
    if (!target) return res.status(400).json({ error: `Unknown model: ${modelId}` });
    const saved = llmProviders.setDefault({ modelId, providerId: providerId || target.provider });
    ctx.defaultModel = { id: target.id, provider: target.provider, name: target.name || target.id };
    ctx.broadcast({ type: "model_changed", id: target.id });
    res.json({ providerId: saved.providerId, modelId: saved.modelId });
  } catch (err) {
    res.status(err?.code === "invalid" ? 400 : 500).json({ error: err.message, code: err?.code });
  }
});

// ── Supervisor / system status (for the Dashboard view) ──────────────────────
// Returns NON-SECRET system status only. Never includes API keys or tokens.
// In dev (node server.js) returns this server's own self-status. In the packaged
// Electron app the Electron main process can override this via IPC (future); for
// now it returns the same self-status which is sufficient for the dashboard.
app.get("/api/supervisor/status", (_req, res) => {
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
        id: "openconnector",
        name: "OpenConnector runtime",
        kind: openConnector.openConnectorEnabled ? "http-external" : "disabled",
        state: openConnector.openConnectorEnabled ? "healthy" : "disabled",
        url: openConnector.getRuntimeBase() || null,
      },
    ],
    provider: ctx.defaultModel ? ctx.defaultModel.provider : null,
    currentModel: ctx.defaultModel ? ctx.defaultModel.id : null,
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
    ctx.broadcast({ type: "extensions_changed", resource: "mcp", action: "added", name });
    res.json(server);
    ctx.dshUpdateMcp?.().catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
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
      // dsh owns MCP connections via the profile; rewrite the watched patch so
      // cordis HMR hot-swaps dsh-mcp-client (no restart on the primary path).
      ctx.dshUpdateMcp?.().catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
      ctx.broadcast({ type: "extensions_changed", resource: "mcp", action: "updated", name });
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
  extensionStore.removeMcpServer(name);
  ctx.broadcast({ type: "extensions_changed", resource: "mcp", action: "removed", name });
  res.json({ ok: true });
  ctx.dshUpdateMcp?.().catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
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
  // broadcast + respond immediately; update (dsh hot-swap) in background.
  ctx.broadcast({ type: "extensions_changed", resource: "mcp", action: "toggled", name, enabled });
  res.json(updated);
  ctx.dshUpdateMcp?.().catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
});

// List all skills (file-based + custom from database).
// File skills are not DB rows; their extension metadata is derived from the
// bundle manifest: names in manifest `skills` are "bundled" and take
// locked/permissions from the manifest's permissions map ("skill:<name>").
app.get("/api/extensions/skills", async (_req, res) => {
  const fileSkills = getFileSkills().map((s) => {
    const bundled = ctx.bundle.skills.includes(s.name);
    const policy = bundled ? ctx.splitPolicy(ctx.bundle.permissions[`skill:${s.name}`]) : { locked: false, permissions: null };
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
    // Materialize as SKILL.md so dsh-skill-filesystem hot-loads it (no restart).
    try { skillMaterialize.writeSkill(skill); } catch (e) { console.warn(`[skills] materialize write failed for "${name}": ${e.message}`); }
    ctx.broadcast({ type: "extensions_changed", resource: "skill", action: "added", name });
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
  const updatePolicy = ctx.bundle.skills.includes(name)
    ? ctx.splitPolicy(ctx.bundle.permissions[`skill:${name}`])
    : { locked: false };
  if (updatePolicy.locked) {
    return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be modified` });
  }
  const skill = extensionStore.getCustomSkill(name);
  if (!skill) {
    return res.status(404).json({ error: `Skill "${name}" not found` });
  }
  const updated = extensionStore.updateCustomSkill(name, { description, content, enabled });
  // Rewrite the materialized SKILL.md (atomic temp+rename) so the watcher
  // hot-reloads the new content; enabled=false removes the file instead.
  try { skillMaterialize.writeSkill(updated); } catch (e) { console.warn(`[skills] materialize rewrite failed for "${name}": ${e.message}`); }
  ctx.broadcast({ type: "extensions_changed", resource: "skill", action: "updated", name });
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
  const deletePolicy = ctx.bundle.skills.includes(name)
    ? ctx.splitPolicy(ctx.bundle.permissions[`skill:${name}`])
    : { locked: false };
  if (deletePolicy.locked) {
    return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be removed` });
  }
  const skill = extensionStore.getCustomSkill(name);
  if (!skill) {
    return res.status(404).json({ error: `Skill "${name}" not found` });
  }
  extensionStore.removeCustomSkill(name);
  // Remove the materialized SKILL.md so the watcher hot-unloads it.
  try { skillMaterialize.removeSkill(name); } catch (e) { console.warn(`[skills] materialize remove failed for "${name}": ${e.message}`); }
  ctx.broadcast({ type: "extensions_changed", resource: "skill", action: "removed", name });
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
  const togglePolicy = ctx.bundle.skills.includes(name)
    ? ctx.splitPolicy(ctx.bundle.permissions[`skill:${name}`])
    : { locked: false };
  if (togglePolicy.locked) {
    return res.status(400).json({ error: `Skill "${name}" is locked (bundled) and cannot be disabled` });
  }
  const skill = extensionStore.getCustomSkill(name);
  if (!skill) {
    return res.status(404).json({ error: `Skill "${name}" not found` });
  }
  const updated = extensionStore.toggleCustomSkill(name, enabled);
  // enabled → write SKILL.md (hot-load); disabled → remove it (hot-unload).
  try { enabled ? skillMaterialize.writeSkill(updated) : skillMaterialize.removeSkill(name); }
  catch (e) { console.warn(`[skills] materialize toggle failed for "${name}": ${e.message}`); }
  ctx.broadcast({ type: "extensions_changed", resource: "skill", action: "toggled", name, enabled });
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
    const sess = await chatHistory.getSession(req.params.id);
    if (!sess) return res.status(404).json({ error: "Not found" });
    res.json(sess);
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

// Hard-delete a session by id. 409 if the id is the currently-active session
// (caller must switch first). 404 if the id does not exist. On success, the
// refreshed `sessions` list is broadcast to all WS clients so the sidebar row
// disappears without a manual refetch.
app.delete("/api/chat-history/sessions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await chatHistory.deleteSession(id);
    res.json({ ok: true });
    chatHistory
      .listSessions()
      .then((sessions) =>
        ctx.broadcast({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
      )
      .catch((e) => console.error("[chat-history] list after delete failed:", e.message));
  } catch (err) {
    if (err?.code === "active") return res.status(409).json({ error: err.message });
    if (err?.code === "not_found") return res.status(404).json({ error: err.message });
    console.error("[chat-history] delete error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Rename a session's title. 400 on validation (empty / overlong / control
// chars); 404 if the id is unknown. Broadcasts a `session_renamed` event to
// all WS clients so every open UI updates in lockstep.
app.patch("/api/chat-history/sessions/:id", express.json(), async (req, res) => {
  const { id } = req.params;
  try {
    const title = chatHistory.setTitle(id, req.body?.title);
    res.json({ id, title });
    ctx.broadcast({ type: "session_renamed", id, title });
  } catch (err) {
    if (err?.code === "not_found") return res.status(404).json({ error: err.message, code: err.code });
    if (err?.code === "empty" || err?.code === "too_long" || err?.code === "control_chars") {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error("[chat-history] rename error:", err.message);
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
// (/oc-web) and external-service apps (/external/:appId).
function createWebProxy({ prefix, getBase, getToken, label = "Upstream" }) {
  const pathRe = new RegExp(`^${prefix}`);
  return async function webProxy(req, res) {
    const base = getBase();
    // Derive the upstream path (incl. query) from the original URL.
    let upstream = req.originalUrl.replace(pathRe, "");
    if (upstream === "") upstream = "/";
    const url = base + upstream;

    // Forwarded headers: keep content-type. For Authorization: any client-
    // supplied header is forwarded (so upstream session tokens, virtual keys,
    // etc. work end-to-end); when absent, the server-held token is injected
    // (e.g. OC dashboard's /user/info, the agent's /v1/mcp). This keeps the
    // server-held credential off the wire when a per-request token is provided.
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

// ── External-service proxy (NEW API-style embedded apps) ──────────────────────
// Embeds external-service apps from the catalog (agents.json) behind a
// token-injecting reverse proxy at /external/:appId. Mirrors the /oc-web
// pattern: a server-held token is injected into the upstream request, the
// browser never sees the upstream URL or its credentials. The app's catalog
// entry determines whether to embed in an iframe (embedded !== false) or
// open in a new tab.
//
// Per-app credentials resolution:
//   - `apiKeyEnv` → process.env[apiKeyEnv] (preferred; never reaches the client)
//   - `apiKey`    → literal value (NOT serialized to the client; only available
//                    here on the server where the catalog is read at startup)
//   - missing     → no Authorization header sent (public upstream)
//
// Authenticated by the same forward-auth gate as the rest of the app; the
// embedded page lives on a same-origin /external/:appId path so the iframe
// inherits the session cookie when applicable.
const externalServiceApp = (id) => catalog.getExternalServices().find((a) => a.id === id);
function buildExternalServiceProxy(appId) {
  const app = externalServiceApp(appId);
  if (!app) return null;
  // Resolve the bearer token server-side. catalog.js never serializes apiKey/
  // apiKeyEnv to the client (spec D5 — tokens never reach the browser), so this
  // lookup runs on the server and never leaks to the client.
  const apiKey =
    (app.apiKeyEnv && process.env[app.apiKeyEnv]) ||
    app.apiKey ||
    null;
  return createWebProxy({
    prefix: `/external/${app.id}`,
    getBase: () => app.url,
    getToken: () => apiKey,
    label: app.name || app.id,
  });
}

// Register a /external/:appId proxy for every external-service in the catalog.
// Catch-all registration AFTER the app's own /api/* routes (so those win on
// conflict) and AFTER the OC roots (/v1/*, /api/*, /assets/*) so OC's
// /v1/* and /api/* own their paths when both services are configured.
// Unknown /external/:appId values 404 — agents.json's getExternalServices() is
// the only source of truth, so a stale link in the browser fails fast.
for (const app of catalog.getExternalServices()) {
  const proxy = buildExternalServiceProxy(app.id);
  if (proxy) {
    app.all(`/external/${app.id}`, proxy);
    app.all(`/external/${app.id}/*`, proxy);
  }
}

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
