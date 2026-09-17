#!/usr/bin/env node
// ── Cloud gateway ────────────────────────────────────────────────────────────
//
// The hosted deployment's only reachable surface. It authenticates every
// request through Logto, routes each session to the requesting user's cell
// (starting one on that user's first traffic), and reverse-proxies HTTP and
// WebSocket traffic there with the verified identity injected.
//
// It holds no per-user data — everything stateful lives in the cells it
// starts, which is what keeps the blast radius of a bug here small and the
// Phase 3 swap (a k8s client in place of the spawner) contained.
//
//   node gateway/index.js        # see .env.example, "Hosted cells"

import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogtoAuth } from "../server/logto-auth.js";
import { resolveSessionSecret } from "../server/session.js";
import { createCellRegistry, userIdFor } from "./spawner.js";
import { forwardedHeaders, proxyHttp, proxyUpgrade } from "./proxy.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.GATEWAY_PORT || 3080);
// The gateway IS the public surface, so it binds where the proxy/ingress can
// reach it. The cells it starts are loopback-only regardless.
const HOST = process.env.GATEWAY_HOST || "0.0.0.0";
const SECRET = String(process.env.CELL_GATEWAY_SECRET || "");
const DATA_ROOT = path.resolve(process.env.CELL_DATA_ROOT || "cell-data");
// 0 = never reap: cells stay resident once started (the default contract).
const IDLE_REAP_SECS = Number(process.env.CELL_IDLE_REAP_SECS || 0);
const START_TIMEOUT_MS = Number(process.env.CELL_START_TIMEOUT_MS || 60_000);
const startedAt = Date.now();

if (!SECRET) {
  console.error("[gateway] CELL_GATEWAY_SECRET is required — cells reject identity headers without it");
  process.exit(1);
}

const logtoAuth = await createLogtoAuth({
  AUTH_MODE: "logto",
  LOGTO_ENDPOINT: process.env.LOGTO_ENDPOINT || "",
  LOGTO_APP_ID: process.env.LOGTO_APP_ID || "",
  LOGTO_APP_SECRET: process.env.LOGTO_APP_SECRET || "",
  LOGTO_CLIENT_TYPE: process.env.LOGTO_CLIENT_TYPE || "confidential",
  LOGTO_END_SESSION: process.env.LOGTO_END_SESSION || "false",
  SESSION_TTL_HRS: process.env.SESSION_TTL_HRS || "24",
  PAAS_BASE_URL: process.env.PAAS_BASE_URL || "",
  resolveSessionSecret: () => resolveSessionSecret({ env: process.env }),
});

const registry = createCellRegistry({
  dataRoot: DATA_ROOT,
  secret: SECRET,
  startTimeoutMs: START_TIMEOUT_MS,
  idleReapSecs: IDLE_REAP_SECS,
  serverEntry: path.join(REPO, "server.js"),
  // Cells run from the repo so they share the read-only app code and the
  // project's skills/ dir. Their writes are confined to their own data root
  // (proven by scripts/test-cell-containment.mjs).
  cwd: REPO,
  env: process.env,
});

const app = express();
const server = http.createServer(app);

// Login, callback, logout. The gateway is the sole Logto client in this
// deployment; cells never talk to the identity provider.
logtoAuth.register(app);

// Browsers get sent to login; anything programmatic gets a 401 it can act on.
// The path decides, not `Accept`: a fetch with `Accept: */*` still "accepts"
// HTML, so content negotiation alone would answer JSON clients with a redirect.
function rejectUnauthenticated(req, res) {
  const programmatic = req.path.startsWith("/api/") || req.path.startsWith("/external/");
  if (!programmatic && req.accepts("html")) return res.redirect("/auth/login");
  return res.status(401).json({ error: "Authentication required" });
}

// Liveness. Public by design — a probe has no session cookie — and it reports
// no per-user information.
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptimeMs: Date.now() - startedAt, cells: registry.cells.size });
});

// Per-user cell status for operators. Same identity check as everything else,
// plus the admin group: the list of users on this deployment is deployment
// information, not something any signed-in user should be able to enumerate.
app.get("/api/gateway/status", (req, res) => {
  const user = logtoAuth.userFromCookie(req.headers.cookie);
  if (!user) return rejectUnauthenticated(req, res);
  if (!(user.groups || []).includes("admin")) return res.status(403).json({ error: "Admin group required" });
  res.json({
    cells: registry.status(),
    idleReapSecs: IDLE_REAP_SECS,
    dataRoot: DATA_ROOT,
    uptimeMs: Date.now() - startedAt,
  });
});

// Everything else belongs to a cell.
app.use(async (req, res) => {
  const user = logtoAuth.userFromCookie(req.headers.cookie);
  if (!user) return rejectUnauthenticated(req, res);
  let cell;
  try {
    cell = await registry.ensure(user);
  } catch (err) {
    console.error(`[gateway] cell start failed for ${userIdFor(user.email)}: ${err.message}`);
    return res.status(503).json({ error: `Your workspace failed to start: ${err.message}` });
  }
  proxyHttp(req, res, {
    host: "127.0.0.1",
    port: cell.port,
    headers: forwardedHeaders(req, user, SECRET),
  });
});

// WebSocket upgrades take the same identity check, then pin to the user's cell
// for the life of the socket.
server.on("upgrade", async (req, socket, head) => {
  const user = logtoAuth.userFromCookie(req.headers.cookie);
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  let cell;
  try {
    cell = await registry.ensure(user);
  } catch (err) {
    console.error(`[gateway] WS cell start failed for ${userIdFor(user.email)}: ${err.message}`);
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket, head, {
    host: "127.0.0.1",
    port: cell.port,
    headers: forwardedHeaders(req, user, SECRET, { keepUpgrade: true }),
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[gateway] listening on http://${HOST}:${PORT} (cells under ${DATA_ROOT})`);
  console.log(`[gateway] idle reaping: ${IDLE_REAP_SECS > 0 ? `after ${IDLE_REAP_SECS}s` : "disabled (cells stay resident)"}`);
});

// No cell outlives the gateway: a redeploy would otherwise leak one process
// per user on the host.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.log(`[gateway] ${signal} — stopping ${registry.cells.size} cell(s)`);
    await registry.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
