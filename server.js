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

// Default chat model. When set, the dsh session starts on this model id;
// otherwise the first declared profile model is used. See initDshAgent().
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "";

// ── LiteLLM proxy config ─────────────────────────────────────────────────────
// LITELLM_BASE_URL / LITELLM_API_KEY feed two consumers: the dsh LLM profile
// (dsh-profile.js writeLlmProfile, loaded from .env by dotenv/config above) and
// the LiteLLM management-UI reverse proxy (/litellm-web, /ui, …). When either is
// missing the litellm route is skipped so the server falls back to the Volces
// gateway (when LLM_API_KEY is set) or starts with no chat provider (logged).
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
// Active catalog agent: "local" = the local dsh session; any other id = a
// catalog agent-remote (chat mode) entry that prompts are forked to.
let currentAgentId = "local";
// True once any text_delta has been streamed during the current agent turn.
// Used by the agent_end handler to avoid re-broadcasting the full assistant
// text (which would duplicate what streaming already delivered), while still
// emitting it once as a fallback for non-streaming model responses.
let streamedTextThisTurn = false;
// The model the agent session starts on (set during async init; read by the
// /api/supervisor/status route).
let defaultModel = null;
// dsh bridge + session id.
let dshBridge = null;
let dshSessionId = null;
// dsh MCP live-reload: REST routes mutate the DB, then call this to rewrite the
// watched mcp.patch.yml so cordis HMR hot-swaps dsh-mcp-client (no process restart).
// Falls back to restart() only when PLATFORM_MCP_HOTSWAP=0.
let dshUpdateMcp = null;
// Declared model list from the profile generator. Populated by initDshAgent
// from writeLlmProfile(); the generator's declared list IS the dsh model list —
// dsh exposes no stock listModels RPC, so server.js sources the selector from
// this (Task 3.3).
let dshModels = [];
// dsh→WS event-translation state (Task 2). dshToolNames carries callId→name from
// tool/call across to tool/result (which has no name); dshTurnError carries an
// assistant/chunk finish error to the turn/end error broadcast.
const dshToolNames = new Map();
let dshTurnError = null;

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

// ── dsh runtime path ──────────────────────────────────────────────────────────
// Spawns the dsh subprocess via dsh-bridge.js and presents a minimal session
// shim to the WS handler/cron so the rest of server.js is runtime-agnostic.
// Task 2 fills handleDshEvent with the full dsh→WS event-translation map; for
// now it only emits `done` on turn completion (the 1.5 round-trip placeholder).
async function initDshAgent() {
  const { DshBridge } = await import("./dsh-bridge.js");
  const { writeLlmProfile, writeMcpPatch, writeSkillsPatch, ensureCredentialsStore, buildScrubbedEnv } = await import("./dsh-profile.js");

  // Write the dsh llm-adapter profile BEFORE spawning dsh so the runtime
  // loads the Volces/LiteLLM routes at initialize. The generator's declared
  // list IS the dsh model list (no stock listModels RPC); server.js sources
  // the selector from it (Task 3.3). Empty list = dormant (Task 3.6).
  const { models } = await writeLlmProfile();
  dshModels = models;

  // Seed the dsh-credentials-local store from process.env (design D3) and build
  // a scrubbed child env so the file is the winning key-resolution layer.
  try { ensureCredentialsStore(); } catch (e) { console.warn(`[dsh] credentials store init failed: ${e?.message || e}`); }
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

  // Default model: DEFAULT_MODEL env if declared, else first declared model.
  let provider = "deepseek-official";
  let model = "deepseek-v4-flash";
  if (dshModels.length) {
    const pick =
      (DEFAULT_MODEL && dshModels.find((m) => m.id === DEFAULT_MODEL)) || dshModels[0];
    provider = pick.provider;
    model = pick.id;
  } else {
    console.warn("[dsh] no LLM keys configured; chat non-functional (static + REST still served)");
  }

  dshSessionId = "platform-" + randomUUID();
  dshBridge = new DshBridge({
    provider,
    model,
    onEvent: handleDshEvent,
    mcpPatchPath,
    skillsPatchPath,
    env: dshChildEnv,
  });
  await dshBridge.start();
  // MCP live-reload (design D1): the REST routes mutate the DB then call this to
  // rewrite mcp.patch.yml in place — cordis-plugin-include/hmr watches that file
  // (confirmed by source inspection; see design Open Question 1) and hot-swaps
  // dsh-mcp-client (disconnect/reconnect the affected server, no process restart).
  // Single-flight mutex + debounce serialize overlapping mutations; restart() is
  // the documented fallback (PLATFORM_MCP_HOTSWAP=0, or hot-swap never settles).
  let mcpChain = Promise.resolve();
  let mcpPending = false;
  const hotswapEnabled = process.env.PLATFORM_MCP_HOTSWAP !== "0";
  const HOTSWAP_SETTLE_MS = Number(process.env.PLATFORM_MCP_HOTSWAP_SETTLE_MS || 800);
  dshUpdateMcp = () => {
    mcpPending = true;
    const run = mcpChain.then(async () => {
      mcpPending = false;
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
      if (patchPath !== undefined) await dshBridge.restart({ mcpPatchPath: patchPath });
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
    getSessionId: () => dshSessionId,
    getSessionFile: () => null,
    buildSessionContext: () => ({ messages: [] }),
    newSession: () => { dshSessionId = "platform-" + randomUUID(); },
    setSessionId: (id) => { dshSessionId = id; },
    setSessionFile: () => {},
  };
  chatHistory.setSessionManager(dshSm);
  session = {
    prompt: async (text) => {
      isStreaming = true;
      await dshBridge.prompt(dshSessionId, [{ type: "text", text }]);
    },
    model: { id: model },
    sessionManager: dshSm,
  };
  defaultModel = { id: model, provider, name: model };
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
    if (params?.status === "idle") finishTurn();
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
      isStreaming = true;
      streamedTextThisTurn = false;
      dshTurnError = null;
      dshToolNames.clear();
      broadcast({ type: "agent_start" });
      break;
    case "assistant/chunk": {
      const chunk = ev.data?.chunk;
      if (!chunk) break;
      if (chunk.type === "text-delta" && chunk.text) {
        streamedTextThisTurn = true;
        broadcast({ type: "text", delta: chunk.text });
      } else if (chunk.type === "reasoning-delta" && chunk.text) {
        broadcast({ type: "thinking", delta: chunk.text });
      } else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
        // Capture the LLM failure; broadcast on turn/end (the turn-completion
        // signal), then session.status idle → finishTurn → done.
        dshTurnError = chunk.reason.failure?.message || "LLM request failed";
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
      dshToolNames.set(ev.data.callId, ev.data.name);
      broadcast({
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
      broadcast({
        type: "tool_end",
        toolCallId: callId,
        name: dshToolNames.get(callId) ?? undefined,
        result: resultText,
        isError: !!ev.data?.error || !!ev.data?.message?.content?.[0]?.isError,
      });
      break;
    }
    case "turn/end":
      if (ev.data?.reason?.kind === "error" && dshTurnError) {
        broadcast({ type: "error", message: dshTurnError });
      }
      dshTurnError = null;
      break;
    default:
      if (process.env.DSH_DEBUG) console.debug("[dsh] unmapped event:", ev.type);
      break;
  }
}


// Start a new chat session: create a fresh SDK session and reset the agent's
// in-memory messages. Rejected while streaming to avoid switching mid-turn.
async function createNewSession() {
  if (isStreaming) throw new Error("Cannot start a new chat while the agent is responding");
  session.sessionManager.newSession();
  // ponytail: dsh has no in-memory message state to reset — newSession() (shim)
  // already minted a fresh dshSessionId; the next prompt carries it.
  return chatHistory.currentSessionId();
}

// Switch the live agent to an existing session by id: point the session manager at
// that file and reload the agent's in-memory messages from it so the conversation
// continues with full context. Rejected while streaming.
async function switchToSession(id) {
  if (isStreaming) throw new Error("Cannot switch chat while the agent is responding");
  const currentId = chatHistory.currentSessionId();
  // ponytail: dsh has no in-memory message state to resync — switching the
  // session id is enough; the next prompt carries the new id, and chat-history
  // serves the sidebar's message list from SQLite.
  if (id !== currentId) session.sessionManager.setSessionId(id);
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
  return dshModels.map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider }));
}

// Refresh the model list at runtime (design D3 / spike 2). Re-runs writeLlmProfile
// so LiteLLM /v1/models is re-discovered and settings.yaml is rewritten; dsh-
// settings-file hot-reloads the llm-pi-ai: section and dsh-llm-pi-ai's onChange
// re-registers the adapter routes + model directory live (no restart). dshModels
// is updated from the fresh declared list and clients are told to refetch.
// ponytail: the active model is left as-is; a switch to a newly-appeared model
// still goes through switchModelTo (which restarts — the per-session model is an
// initialize arg, a genuine ceiling). This only refreshes the *selector*.
let dshProfileMod = null;
async function refreshDshModels() {
  if (!dshProfileMod) dshProfileMod = await import("./dsh-profile.js");
  const { models } = await dshProfileMod.writeLlmProfile();
  const before = dshModels.map((m) => m.id).join(",");
  dshModels = models;
  const after = dshModels.map((m) => m.id).join(",");
  if (before !== after) console.log(`[dsh] model list refreshed: ${after || "(none)"}`);
  broadcast({ type: "models", models: await getAvailableModels() });
  return dshModels.map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider }));
}

// Switch the active model by id, enforcing the streaming guard. Sends any error
// to the requesting client and returns true on success. Shared by the
// `set_model` WS handler and the `/model` command.
async function switchModelTo(id, ws) {
  if (isStreaming) {
    ws.send(JSON.stringify({ type: "error", message: "Cannot switch model while the agent is responding" }));
    return false;
  }
  // ponytail: no stock setModel RPC, so a live switch restarts the bridge with
  // the new provider/model baked into initialize. This drops the child's
  // in-memory session state (v1 ceiling); a non-disruptive switch needs a
  // custom dsh RPC. Unknown model → "Unknown model" error.
  const target = dshModels.find((m) => m.id === id);
  if (!target) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown model: ${id}` }));
    return false;
  }
  if (session?.model?.id === id) return true;
  try {
    await dshBridge.restart({ provider: target.provider, model: target.id });
    session.model = { id: target.id };
    defaultModel = { id: target.id, provider: target.provider, name: target.name || target.id };
    broadcast({ type: "model_changed", id });
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
          broadcast({ type: "text", delta });
        }
      }
    }
  } catch (err) {
    console.error(`Remote agent '${entry.id}' error:`, err.message);
    broadcast({ type: "error", message: err.message });
  } finally {
    // Persist the assistant's final aggregated text (design D6).
    if (assistantText) chatHistory.recordMessage(chatHistory.currentSessionId(), "assistant", assistantText);
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
          broadcast({ type: "skill_use", name: cmd.name, args: cmd.args });
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
          if (isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }

          // Set in-flight synchronously (before the first await) so a concurrent
          // prompt is rejected. agent_start sets it again later (idempotent).
          isStreaming = true;
          try {
            await session.prompt(promptText);
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
          // user message is echoed above; streamRemoteChat persists both the
          // user and assistant turns to chat-history (design D6).
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
            // Expand @doc:<id> attachment references for the remote agent too.
            await streamRemoteChat(entry, await expandDocRefs(text));
            break;
          }

          // No steer mechanism through the bridge; reject concurrent prompts
          // host-side (Task 2.7) rather than queueing a second turn.
          if (isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }

          // Mirror the user prompt into the SQLite project database.
          chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);

          // Set in-flight synchronously (before the first await) so a concurrent
          // prompt is rejected. agent_start sets it again later (idempotent).
          isStreaming = true;
          // Expand @doc:<id> attachment references into the document content the
          // agent sees (design D4); the user message above keeps the raw refs.
          const promptWithDocs = await expandDocRefs(text);
          try {
            await session.prompt(promptWithDocs);
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

// Refresh the dsh model list at runtime (design D3 / spike 2). Re-discovers
// LiteLLM models via writeLlmProfile; dsh-settings-file hot-reloads the
// llm-pi-ai: section so new models reach the adapter without a restart. The
// active model is untouched. Admin-gated under forward-auth (a config mutation).
app.post("/api/models/refresh", async (req, res) => {
  if (authEnabled && !req.user?.groups?.includes("admin")) {
    return res.status(403).json({ error: "Admin group required" });
  }
  try {
    const models = await refreshDshModels();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LiteLLM management-UI access info. The master key is NEVER sent to the
// browser (design D3 — tokens never reach the browser): local mode auto-logs
// into the /ui iframe via the server-set cookie (see the /litellm-web proxy +
// login below); remote mode uses the user's own credentials. apiBaseUrl is
// non-secret (already derivable from /api/config's litellmManagementUrl) and
// returned only when LiteLLM is local so the user knows the proxy address.
app.get("/api/litellm/credentials", (_req, res) => {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(LITELLM_BASE_URL || "");
  res.json({
    masterKey: null,
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
    dshUpdateMcp?.().catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
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
      dshUpdateMcp?.().catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
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
  extensionStore.removeMcpServer(name);
  broadcast({ type: "extensions_changed", resource: "mcp", action: "removed", name });
  res.json({ ok: true });
  dshUpdateMcp?.().catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
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
  broadcast({ type: "extensions_changed", resource: "mcp", action: "toggled", name, enabled });
  res.json(updated);
  dshUpdateMcp?.().catch((e) => console.warn(`[extensions] dsh MCP update failed: ${e.message}`));
});

// List all skills (file-based + custom from database).
// File skills are not DB rows; their extension metadata is derived from the
// bundle manifest: names in manifest `skills` are "bundled" and take
// locked/permissions from the manifest's permissions map ("skill:<name>").
app.get("/api/extensions/skills", async (_req, res) => {
  const fileSkills = getFileSkills().map((s) => {
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
    // Materialize as SKILL.md so dsh-skill-filesystem hot-loads it (no restart).
    try { skillMaterialize.writeSkill(skill); } catch (e) { console.warn(`[skills] materialize write failed for "${name}": ${e.message}`); }
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
  // Rewrite the materialized SKILL.md (atomic temp+rename) so the watcher
  // hot-reloads the new content; enabled=false removes the file instead.
  try { skillMaterialize.writeSkill(updated); } catch (e) { console.warn(`[skills] materialize rewrite failed for "${name}": ${e.message}`); }
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
  // Remove the materialized SKILL.md so the watcher hot-unloads it.
  try { skillMaterialize.removeSkill(name); } catch (e) { console.warn(`[skills] materialize remove failed for "${name}": ${e.message}`); }
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
  // enabled → write SKILL.md (hot-load); disabled → remove it (hot-unload).
  try { enabled ? skillMaterialize.writeSkill(updated) : skillMaterialize.removeSkill(name); }
  catch (e) { console.warn(`[skills] materialize toggle failed for "${name}": ${e.message}`); }
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
await initDshAgent();
// One-time import of legacy file stores (documents-store/, sessions-store/,
// chat-history-store/) into the SQLite database. Runs only on a fresh database;
// idempotent; never deletes the legacy stores. migrate.js reads both legacy
// chat formats directly with stdlib fs (no SDK dependency).
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
    await dshBridge?.shutdown();
  } catch (err) {
    console.error("[shutdown] dsh bridge failed:", err.message);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
