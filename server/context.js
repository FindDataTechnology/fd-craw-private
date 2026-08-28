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
import * as openConnector from "../open-connector.js";
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
    // Derived: forward-auth gate enabled (see server/auth.js).
    authEnabled: config.AUTH_MODE === "forward_auth",
    // Bundle-manifest permissions splitter (extensions routes + MCP seeding).
    splitPolicy,

    // ── Service singletons ──────────────────────────────────────────────────
    chatHistory,
    openConnector,
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
    // Active catalog agent: "local" = the local dsh session; any other id = a
    // catalog agent-remote (chat mode) entry that prompts are forked to.
    currentAgentId: "local",
    // The model the agent session starts on (set during async init; read by
    // the /api/supervisor/status route).
    defaultModel: null,
    // dsh bridge + session id.
    dshBridge: null,
    dshSessionId: null,
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
    dshToolNames: new Map(),
    dshTurnError: null,

    // ── WS clients + fan-out ────────────────────────────────────────────────
    clients: new Set(),
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

  return ctx;
}
