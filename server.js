import 'dotenv/config';
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import multer from "multer";
import compression from "compression";
import * as chatHistory from "./chat-history.js";
import * as documents from "./documents.js";
import * as db from "./db.js";
import * as trace from "./server/trace.js";
import * as bots from "./server/bots.js";
import * as migrate from "./migrate.js";
import * as cron from "./cron.js";
import * as extensionStore from "./extension-store.js";
import * as catalog from "./catalog.js";
import { initRegistryBridge, stopRegistryBridge } from "./registry-bridge.js";
import { resolveBundleSafe } from "./bundle-manifest.js";
import { createAppContext } from "./server/context.js";
import { registerAuth, normalizeAuthPath } from "./server/auth.js";
import { createLogtoAuth } from "./server/logto-auth.js";
import { resolveSessionSecret } from "./server/session.js";
import { registerDocumentRoutes } from "./server/routes/documents.js";
import { registerMiscRoutes, registerStaticAndFallback } from "./server/routes/misc.js";
import { registerLlmRoutes } from "./server/routes/llm.js";
import { registerExtensionRoutes } from "./server/routes/extensions.js";
import { registerChatHistoryRoutes } from "./server/routes/chat-history.js";
import { registerTraceRoutes } from "./server/routes/trace.js";
import { registerUserBindingRoutes } from "./server/routes/user-bindings.js";
import { registerFileRoutes } from "./server/routes/files.js";
import { registerBotRoutes, WEBHOOK_PREFIX } from "./server/routes/bots.js";
import { registerExternalServiceRoutes } from "./server/routes/external-services.js";
import { attachDshEvents } from "./server/dsh-events.js";
import { attachRuntimeBindings } from "./server/runtime-bindings.js";
import { attachAgentSession } from "./server/agent-session.js";
import { attachWebSocket } from "./server/ws.js";

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "localhost";
const MCP_CONFIG_PATH = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

// ── Optional forward-auth (AUTH_MODE=forward_auth) ───────────────────────────
// Identity = proxy-injected X-Forwarded-Email / X-Forwarded-Groups headers
// (Caddy forward_auth → oauth2-proxy → Logto). TRUST BOUNDARY: enabling this
// asserts the server is reachable ONLY through the forward-auth proxy — bind
// to localhost / firewall it, otherwise these headers are attacker-controlled.

// ── Custom provider config (Volces / 火山引擎) ────────────────────────────────

// Volces (火山引擎) chat provider is optional: an unset LLM_API_KEY means the
// provider is not registered and the server starts with no chat provider (chat
// non-functional, logged) — the project's graceful-degrade convention.
// The document library no longer consumes any LLM provider config (local
// extraction only); LLM_API_KEY here feeds chat exclusively.

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
  SSO_ENABLED: process.env.SSO_ENABLED === "true",
  // Hosted-cell mode. Set by the cloud gateway's spawner, never by a human:
  // it turns on the active identity-trust gate in server/auth.js (see
  // CLOUD_MODE / CELL_GATEWAY_SECRET in .env.example).
  CLOUD_MODE: process.env.CLOUD_MODE === "1" || process.env.CLOUD_MODE === "true",
  CELL_GATEWAY_SECRET: process.env.CELL_GATEWAY_SECRET || "",
  AUTH_LOGIN_PATH: normalizeAuthPath(process.env.AUTH_LOGIN_PATH, "/oauth2/start"),
  AUTH_LOGOUT_PATH: normalizeAuthPath(process.env.AUTH_LOGOUT_PATH, "/oauth2/sign_out"),
  PAAS_BASE_URL: process.env.PAAS_BASE_URL || "",
  LOGTO_ENDPOINT: process.env.LOGTO_ENDPOINT || "",
  LOGTO_APP_ID: process.env.LOGTO_APP_ID || "",
  LOGTO_APP_SECRET: process.env.LOGTO_APP_SECRET || "",
  LOGTO_CLIENT_TYPE: process.env.LOGTO_CLIENT_TYPE || "confidential",
  LOGTO_END_SESSION: process.env.LOGTO_END_SESSION || "false",
  SESSION_TTL_HRS: process.env.SESSION_TTL_HRS || "24",
  resolveSessionSecret: () => resolveSessionSecret({ env: process.env }),
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
// Bot webhooks are excluded: they need the RAW request bytes (WeCom/WeChat send
// XML, and every platform signs the body exactly as sent), so they mount their
// own express.raw parser. Consuming the stream here would leave them with an
// empty body and break signature verification.
const jsonBodyParser = express.json();
app.use((req, res, next) =>
  req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next),
);
// HTTP compression for static assets + API JSON (the entry chunk ships ~600KB
// raw). Must mount before express.static (registered in routes/misc.js).
app.use(compression());

// Forward-auth/Logto HTTP gate + ctx.requireAdmin (WS upgrade gate below).
ctx.logtoAuth = await createLogtoAuth(ctx);
ctx.logtoAuth?.register(app);
registerAuth(ctx);

// Route registration. Order is semantic: app /api routes first, then the
// static SPA + deep-link fallback and /external/:appId.
registerDocumentRoutes(ctx);
registerMiscRoutes(ctx);
registerLlmRoutes(ctx);
registerExtensionRoutes(ctx);
registerChatHistoryRoutes(ctx);
registerTraceRoutes(ctx);
registerUserBindingRoutes(ctx);
registerBotRoutes(ctx);
// Preview drawer file serving — mounted with the other /api routes, BEFORE the
// static SPA fallback, so the catch-all cannot shadow /api/files.
registerFileRoutes(ctx);
registerStaticAndFallback(ctx);
registerExternalServiceRoutes(ctx);

// dsh → WS event translation (attaches ctx.handleDshEvent + ctx.finishTurn).
attachDshEvents(ctx);
attachRuntimeBindings(ctx);
// Agent-session state machine (model/agent switching, session ops, commands).
attachAgentSession(ctx);
// WebSocket upgrade gate + connection handler.
attachWebSocket(ctx);

// ── Agent session ────────────────────────────────────────────────────────────

// Seed startup MCP configs into the extensions DB so the UI "Installed" tab
// shows them. INSERT OR IGNORE preserves user edits. Origins: mcp.json entries
// stay "user" (operator config); manifest mcpServers entries are pre-installed
// by the package ("bundled"). Manifest entries take
// locked/permissions from the permissions map ("mcp:<name>" → { allow, deny,
// locked }). Seeding lives here (not in bootstrap/first-run.js) because
// better-sqlite3 only loads under the Node that runs server.js — the Electron
// main process has a different ABI.
// ponytail: shared by the dsh bridge + extension REST routes (design D4 —
// host-side config sources unchanged); writeMcpPatch reads the DB but does not
// seed it, so the seeding must happen here before the patch is written.
function seedStartupMcpConfigs(mcpJsonServers) {
  if (!db.isDbReady()) return;
  for (const [name, config] of Object.entries(mcpJsonServers)) {
    extensionStore.seedMcpServer({ name, config, enabled: true });
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
  const { writeLlmProfile, writeMcpPatch, writeSkillsPatch, writePresetsPatch, writePermissionsPatch, ensureCredentialsStore, ensureDshHome, buildScrubbedEnv } = await import("./dsh-profile.js");

  // Scaffold $DSH_HOME if it is fresh — a hosted cell's per-user home always
  // is, and dsh refuses to boot a profile that was never materialized.
  ensureDshHome();

  // Hosted cells only: the spawner passes the cell's user, whose saved bindings
  // ARE this runtime's configuration. Empty in dev/desktop, where the shared
  // runtime keeps its global default and its overlay-apply path.
  const cellEmail = ctx.CLOUD_MODE ? String(process.env.CELL_USER_EMAIL || "") : "";
  const cellUser = cellEmail && db.isDbReady() ? cellEmail : "";

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
  try { dshMcpJson = JSON.parse(await readFile(MCP_CONFIG_PATH, "utf8")).mcpServers || {}; } catch {}
  seedStartupMcpConfigs(dshMcpJson);

  // Write the dsh-mcp-client patch overlay (one loader entry per MCP server
  // from mcp.json + DB). The bridge passes it via --patch;
  // null = no servers configured, flag omitted (Task 4.1/4.2).
  // In a cell the user's saved MCP availability is THE availability (there is
  // no shared runtime for it to be an overlay on), so it is folded into the
  // boot patch rather than left to apply on some later request.
  const cellMcpOverlay = cellUser ? db.getUserMcpBindings(cellUser) : null;
  const mcpPatchPath = await writeMcpPatch({ mcpOverlay: cellMcpOverlay });

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

  // Write the preset-roster patch overlay (agent-presets roster + preset
  // bridge plugin). Null = unresolvable shipped preset root; the bridge then
  // spawns without the overlay and the picker stays empty (graceful degrade).
  const presetsPatchPath = await writePresetsPatch();
  // The permission-mode overlay swaps the bridge row to the subclass that
  // also serves permissions/list + permissions/set (add-permission-mode-
  // selector). Static; always written — an absent permission service inside
  // the child degrades to an empty roster (picker hidden, chat unaffected).
  const permissionsPatchPath = await writePermissionsPatch();
  // The selected agent mode is a persisted user preference (agent.preset);
  // `standard` until a DB row exists.
  ctx.currentPreset = ctx.db.getPreference("agent.preset") || "standard";

  // Default model: in a cell the user's saved binding wins (it IS this
  // runtime's configuration); otherwise the persisted Models-page pointer,
  // else DEFAULT_MODEL env if declared, else the first declared model.
  let provider = "deepseek-official";
  let model = "deepseek-v4-flash";
  if (ctx.dshModels.length) {
    const llmProviders = await import("./llm-providers.js");
    const saved = llmProviders.getDefault();
    const bound = cellUser ? db.getUserModelBinding(cellUser) : null;
    const boundModel = bound && ctx.dshModels.find((m) => m.id === bound.id && m.provider === bound.provider);
    const pick =
      boundModel ||
      (saved.modelId && ctx.dshModels.find((m) => m.id === saved.modelId)) ||
      (ctx.DEFAULT_MODEL && ctx.dshModels.find((m) => m.id === ctx.DEFAULT_MODEL)) ||
      ctx.dshModels[0];
    provider = pick.provider;
    model = pick.id;
    if (boundModel) console.log(`[dsh] cell binding: starting on ${provider}/${model}`);
    // Restore the persisted thinking level, but only if this model still
    // declares it (writeLlmProfile already projected it into settings.yaml).
    const savedEffort = ctx.db.getPreference(`llm.effort.${provider}`) || null;
    ctx.currentEffort = savedEffort && (pick.reasoningEfforts || []).includes(savedEffort) ? savedEffort : null;
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
    presetsPatchPath,
    permissionsPatchPath,
    agentPreset: ctx.currentPreset,
    env: dshChildEnv,
  });
  await ctx.dshBridge.start();
  // Warm the preset roster cache so the ready sync can answer list_presets
  // without a second bridge round-trip (best-effort: empty roster on failure).
  await ctx.getAgentPresets();
  // Same for the permission roster — the connect-time current_permission push
  // needs nothing, but the first list_permissions answer is then immediate.
  ctx.getPermissionPresets().catch(() => {});
  // MCP live-reload (design D1): the REST routes mutate the DB then call this to
  // rewrite mcp.patch.yml in place — cordis-plugin-include/hmr watches that file
  // (confirmed by source inspection; see design Open Question 1) and hot-swaps
  // dsh-mcp-client (disconnect/reconnect the affected server, no process restart).
  // Single-flight mutex + debounce serialize overlapping mutations; restart() is
  // the documented fallback (PLATFORM_MCP_HOTSWAP=0, or hot-swap never settles).
  const hotswapEnabled = process.env.PLATFORM_MCP_HOTSWAP !== "0";
  const HOTSWAP_SETTLE_MS = Number(process.env.PLATFORM_MCP_HOTSWAP_SETTLE_MS || 800);
  ctx.dshUpdateMcp = (mcpOverlay) => {
    const update = async () => {
      const patchPath = await writeMcpPatch({ mcpOverlay });
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
    };
    // Profile application already owns the mutation lock. Running directly here
    // avoids queuing an MCP update behind itself while preserving one chain for
    // ordinary global and personal mutations.
    if (ctx.runtimeApplying?.()) return update();
    const run = ctx.runtimeMutationChain.then(update);
    ctx.runtimeMutationChain = run.then(() => {}, () => {});
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
  // Session rows record the preset selected when their first message lands,
  // so a resumed session's header label names the mode it started under.
  chatHistory.setPresetSource(() => ctx.currentPreset);
  // …and the runtime workspace they ran in, so the sidebar groups sessions
  // by workspace. Stamped once per session; later switches never re-group.
  chatHistory.setWorkspaceSource(() => ctx.listWorkspaces?.().current ?? null);
  ctx.session = {
    prompt: async (text) => {
      ctx.isStreaming = true;
      const messageId = await ctx.dshBridge.prompt(ctx.dshSessionId, [{ type: "text", text }]);
      // Trace: the durable message id keys this turn's trace rows.
      ctx.dshCurrentTurnId = messageId;
      trace.bindTurn(messageId);
    },
    model: { id: model, provider },
    sessionManager: dshSm,
  };
  ctx.defaultModel = { id: model, provider, name: model };
  ctx.runtimeModel = { id: model, provider, name: model };
  console.log(`[dsh] runtime ready (provider=${provider} model=${model})`);
}



// ── Start (listen-first) ─────────────────────────────────────────────────────
// The port listens IMMEDIATELY: static assets, /api/ready and non-agent
// endpoints answer while background init proceeds. Agent-dependent features
// (WS chat commands, /api/llm/*) answer an explicit initializing error until
// ctx.ready.dsh flips, then connected clients get the ready sync payload.
//
// BOOT INVARIANTS (deliberate ordering — see optimize-hot-paths design D1):
//   1. initChatHistory resolves the sessions store dir BEFORE initDshAgent
//      (the session shim reads it).
//   2. db.initDb opens BEFORE documents.initStore AND BEFORE
//      runLegacyMigrations.
//   3. documents.initStore and initDshAgent run CONCURRENTLY after (2) —
//      they share no state — but BOTH complete BEFORE migrate.
//   4. documents.initStore's restart reconciliation still runs BEFORE
//      migrate's legacy import (same relative order as the sequential boot).
//   5. migrate, catalog.initCatalog and cron.initCron run concurrently after
//      the dsh agent is ready (none can be prompted before then).
server.listen(PORT, HOST, () => {
  console.log(`Platform listening at http://${HOST}:${PORT} (agent init in background)`);
});

await chatHistory.initChatHistory();
// Open the SQLite project database (chat, documents, index, preferences) before
// feature init. Degrades gracefully: if it cannot open, dbReady stays false and
// the server continues (chat in-memory, documents disabled).
await db.initDb();

// Documents (local-extraction library) and the dsh agent both depend only on
// the db being open — run them concurrently.
const documentsInit = (async () => {
  if (!db.isDbReady()) return;
  await documents.initStore({ broadcast: ctx.broadcast });
})();
const dshInit = initDshAgent();
await Promise.all([documentsInit, dshInit]);
await trace.initTrace();

// Agent is live: flip readiness and sync any client that connected mid-boot.
ctx.ready.dsh = true;
ctx.onDshReady?.();

// Chat-platform bots. Starts after the bridge so a polled message never
// arrives before there is an agent to answer it; inert with no bots configured.
bots.initBots(ctx);

// One-time import of legacy file stores (documents-store/, sessions-store/,
// chat-history-store/) into the SQLite database. Runs only on a fresh database;
// idempotent; never deletes the legacy stores. migrate.js reads both legacy
// chat formats directly with stdlib fs (no SDK dependency).
// catalog.initCatalog resolves on the LOCAL catalog (cloud + registry merge
// async); cron reads its jobs file and starts timers. The registry bridge
// resolves immediately (its first fetch runs in the background, TTL keeps the
// snapshot warm); disabled entirely without MARKET_REGISTRY_URL/REGISTRY_URL.
initRegistryBridge({ broadcast: ctx.broadcast });
await Promise.all([
  migrate.runLegacyMigrations(),
  catalog.initCatalog({ broadcast: ctx.broadcast }),
  cron.initCron({
    broadcast: ctx.broadcast,
    sessionPrompt: async (prompt) => {
      if (ctx.session) {
        return ctx.session.prompt(prompt);
      }
    },
    isStreaming: () => ctx.isStreaming,
  }),
]);
console.log("Platform fully initialized");

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  cron.shutdown();
  bots.stopAll();
  catalog.stopCatalog();
  stopRegistryBridge();
  await trace.shutdownTrace();
  try {
    await ctx.dshBridge?.shutdown();
  } catch (err) {
    console.error("[shutdown] dsh bridge failed:", err.message);
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
