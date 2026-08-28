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
import { registerAuth } from "./server/auth.js";
import { registerDocumentRoutes } from "./server/routes/documents.js";
import { registerMiscRoutes, registerStaticAndFallback } from "./server/routes/misc.js";
import { registerLlmRoutes } from "./server/routes/llm.js";
import { registerExtensionRoutes } from "./server/routes/extensions.js";
import { registerChatHistoryRoutes } from "./server/routes/chat-history.js";
import { registerOpenConnectorRoutes } from "./server/routes/openconnector.js";
import { attachDshEvents } from "./server/dsh-events.js";
import { attachAgentSession } from "./server/agent-session.js";
import { attachWebSocket } from "./server/ws.js";

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
// Agent-session state machine (model/agent switching, session ops, commands).
attachAgentSession(ctx);
// WebSocket upgrade gate + connection handler.
attachWebSocket(ctx);

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
      ...ctx.splitPolicy(ctx.bundle.permissions[`mcp:${name}`]),
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
    console.warn("[documents] LLM_API_KEY not set; documents RAG indexing/query calls will fail at call time");
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
