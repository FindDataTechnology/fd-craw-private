// Shared application context — the single home for cross-cutting mutable
// state that used to live in module scope in server.js. Every server/*
// module receives `ctx` as its first parameter and closes over nothing
// global; only server.js (the composition root) constructs the context.
//
// State groups:
//   - config:        parsed once by server.js, passed into createAppContext
//   - services:      the root service singletons (db, chat-history, …)
//   - agent session: session/isStreaming/dshBridge/… — written by
//                    initDshAgent + agent-session.js, read by ws.js,
//                    dsh-events.js and the route modules
//   - clients:       connected WS sockets; broadcast() fans out to them

import path from "node:path";
import * as chatHistory from "../chat-history.js";
import * as documents from "../documents.js";
import * as collections from "../collections.js";
import * as db from "../db.js";
import * as migrate from "../migrate.js";
import * as cron from "../cron.js";
import * as extensionStore from "../extension-store.js";
import * as skillMaterialize from "../skill-materialize.js";
import * as workdirStore from "../workdir-store.js";
import * as catalog from "../catalog.js";

// Split a bundle-manifest permissions policy ("mcp:<name>"/"skill:<name>" →
// { allow?, deny?, locked? }) into the extensions-DB columns: the locked flag
// plus the stored permissions JSON ({ allow?, deny? } — locked has its own column).
export function splitPolicy(policy) {
  if (!policy) return { locked: false, permissions: null };
  const { allow, deny } = policy;
  const permissions =
    allow || deny ? { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } : null;
  return { locked: policy.locked === true, permissions };
}

// The web SPA build served at the repo root (express.static + SPA fallback).
export const WEB_DIST = path.resolve("web/dist");

export function createAppContext(config) {
  const ctx = {
    // ── Config (parsed in server.js, the composition root) ──────────────────
    ...config,
    // Derived: forward-auth gate enabled (see server/auth.js). Optional SSO is
    // an identity overlay only and never enables the hard auth gate.
    authMode: config.AUTH_MODE || "none",
    authEnabled: config.AUTH_MODE === "forward_auth" || config.AUTH_MODE === "logto",
    ssoEnabled: config.AUTH_MODE !== "forward_auth" && config.AUTH_MODE !== "logto" && config.SSO_ENABLED === true,
    // Bundle-manifest permissions splitter (extensions routes + MCP seeding).
    splitPolicy,

    // ── Service singletons ──────────────────────────────────────────────────
    chatHistory,
    documents,
    collections,
    db,
    migrate,
    cron,
    extensionStore,
    skillMaterialize,
    workdirStore,
    catalog,

    // Injected by server.js after express/http/wss are constructed.
    app: null,
    server: null,
    wss: null,
    upload: null,

    // ── Agent session state (see agent-session.js / initDshAgent) ───────────
    session: null,
    isStreaming: false,
    // Bumped after each session mutation so asynchronous session-list refreshes
    // from an older turn cannot overwrite the current sidebar state.
    sessionVersion: 0,
    // Active catalog agent: "local" = the local dsh session; any other id = a
    // catalog agent-remote (chat mode) entry that prompts are forked to.
    currentAgentId: "local",
    // The model the agent session starts on (set during async init; read by
    // the /api/supervisor/status route). This is the global default pointer,
    // not necessarily the model currently running for an optional SSO user.
    defaultModel: null,
    // Effective shared-runtime state. It is global because Platform has one dsh
    // child; personal ownership is intentionally not broadcast.
    runtimeModel: null,
    runtimeOwner: null,
    runtimeMcpOverlay: {},
    pendingBindings: new Map(),
    runtimeMutationChain: Promise.resolve(),
    // Active thinking level (null = the provider's default). Persisted per
    // provider in the prefs table; projected into settings.yaml by
    // dsh-profile.writeLlmProfile.
    currentEffort: null,
    // dsh bridge + session id.
    dshBridge: null,
    dshSessionId: null,
    // The selected dsh agent preset (agent mode). Persisted as the
    // `agent.preset` preference (read once the DB is ready in initDshAgent);
    // `standard` until then. Read by the WS preset handlers; applied to new
    // sessions through the bridge restart path.
    currentPreset: "standard",
    // The preset roster cache (`presets/list` from the bridge). Null until the
    // first successful fetch; the bridge itself caches per child generation,
    // so this is the last-seen copy for connect-time syncs.
    presetRoster: null,
    // The permission preset roster (composer control strip) + the current
    // session's effective preset, from the bridge's permissions/list
    // (add-permission-mode-selector). Null roster = not yet fetched; null
    // current = no session has pinned one yet (the bridge answers the
    // deployment default). Live switches arrive via the permission/preset
    // session-event translation in dsh-events.js.
    permissionOptions: [],
    currentPermission: null,
    // dsh MCP live-reload hook: REST routes mutate the DB, then call this to
    // rewrite the watched mcp.patch.yml so cordis HMR hot-swaps dsh-mcp-client
    // (no process restart). Assigned by initDshAgent.
    dshUpdateMcp: null,
    // Declared model list from the profile generator (initDshAgent populates
    // it; dsh exposes no stock listModels RPC, so this IS the model list).
    dshModels: [],
    // dsh→WS event-translation state: callId→name carried from tool/call
    // across to tool/result (which has no name); dshTurnError carries an
    // assistant/chunk finish error to the turn/end error broadcast.
    // dshTurnBlocks accumulates the turn's tool calls so assistant/message can
    // persist the block STRUCTURE (not just flattened text) — the transcript's
    // evidence trail survives reload.
    dshToolNames: new Map(),
    dshTurnError: null,
    dshTurnBlocks: [],

    // ── Bot session collectors (design D2) ────────────────────────────────────
    // Per-session notification handlers for non-web chat sessions, keyed by
    // session id. Registered by the bot turn runner; cleared when the turn
    // completes. The session-aware event pump in dsh-events.js routes to these
    // instead of the WS broadcast path.
    sessionCollectors: new Map(),

    // ── WS clients + fan-out ────────────────────────────────────────────────
    clients: new Set(),

    // ── Readiness (listen-first boot; see server.js) ────────────────────────
    // The port listens immediately; agent-dependent features gate on dsh.
    ready: { dsh: false },
  };

  // ctx.finishTurn is attached by server/dsh-events.js (attachDshEvents).

  ctx.broadcast = (data) => {
    const msg = JSON.stringify(data);
    for (const ws of ctx.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  };

  ctx.send = (ws, data) => {
    if (ws?.readyState !== ws?.OPEN) return false;
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  };

  return ctx;
}
