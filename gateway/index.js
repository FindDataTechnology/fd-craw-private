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
import { createMpAuth } from "./mp-auth.js";
import { createMpBindings } from "./mp-bindings.js";

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
  // CELL_SERVER_ENTRY defaults to the real cell; tests point it at a stub so
  // the identity/routing contract can be exercised without booting dsh.
  serverEntry: process.env.CELL_SERVER_ENTRY || path.join(REPO, "server.js"),
  // Cells run from the repo so they share the read-only app code and the
  // project's skills/ dir. Their writes are confined to their own data root
  // (proven by scripts/test-cell-containment.mjs).
  cwd: REPO,
  env: process.env,
});

// ── Mini-program identity (second front door) ──────────────────────────────
// Account-binding model: a WeChat openid is bound to a platform (Logto)
// account on first sign-in; every later launch exchanges a fresh wx.login
// code for a platform JWT carrying the ACCOUNT identity (same email/groups
// as the web session → same cell, shared data). Inert (login reports
// not-configured, Bearer never verifies) until MP_APPID/MP_SECRET/
// MP_TOKEN_SECRET are set — the Logto browser flow is unaffected either way.
const mpBindings = createMpBindings({ file: path.join(DATA_ROOT, "mp-bindings.json") });
await mpBindings.load();

const mpAuth = createMpAuth({
  appid: process.env.MP_APPID || "",
  mpSecret: process.env.MP_SECRET || "",
  tokenSecret: process.env.MP_TOKEN_SECRET || "",
  ttlHours: Number(process.env.MP_TOKEN_TTL_HOURS || 12),
  codeUrl: process.env.MP_JS_CODE_URL || "https://api.weixin.qq.com/sns/jscode2session",
  bindings: mpBindings,
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

// Identity resolution: a verified Logto browser session (cookie), or — for
// mini-program clients — a platform JWT minted by /api/mp/login (silent, for
// a bound openid) or /api/mp/login-account (first sign-in, binds the openid
// to the Logto account). Both produce the same user shape and flow through
// the same cell mapping; the cell never learns which door the user came
// through beyond the email it receives.
function resolveUser(req) {
  const cookieUser = logtoAuth.userFromCookie(req.headers.cookie);
  if (cookieUser) return cookieUser;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const payload = mpAuth.verifyToken(auth.slice(7));
    if (payload) return { email: payload.email, groups: payload.groups ?? [], mp: true };
  }
  return null;
}

// Bind-code minting for the web side: an authenticated BROWSER session (the
// Logto cookie) gets a 6-digit, single-use, 5-minute code to type into the
// mini program once. Browsers get a small human-readable page; programmatic
// clients (Accept: application/json) get JSON. No Logto internals involved —
// this is the gateway's own session doing the proving.
app.get("/api/mp/bindcode", async (req, res) => {
  const user = resolveUser(req);
  if (!user) return rejectUnauthenticated(req, res);
  const { code, ttlMs } = mpBindings.issueBindCode(user.email, user.groups ?? []);
  if (req.accepts("json") && !req.accepts("html")) {
    return res.json({ code, ttlMs });
  }
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>绑定小程序</title>
<body style="font-family:system-ui;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#f3f4f6">
  <div style="text-align:center;background:#fff;padding:48px 64px;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,.08)">
    <div style="color:#6b7280;font-size:14px">微信小程序 · 登录绑定码（${user.email}）</div>
    <div style="font-size:56px;letter-spacing:12px;font-weight:700;color:#111827;margin:24px 0">${code}</div>
    <div style="color:#9ca3af;font-size:13px">5 分钟内有效，一次性使用。在小程序登录页输入此码完成绑定。</div>
    <div style="margin-top:20px"><a href="/api/mp/bindcode" style="color:#2563eb;font-size:14px">刷新新码</a></div>
  </div>
</body>`);
});

// Mini-program silent login: wx.login code in, platform JWT out. A 404 with
// `binding_required` tells the client this openid has no bound account yet
// and it should show the login page. The WeChat appid/secret and the
// session key never leave this process.
app.post("/api/mp/login", express.json(), async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const r = await mpAuth.login(code);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ token: r.token, email: r.email });
});

// Mini-program first sign-in: a fresh wx.login code + a bind code minted
// from the account's web session. Redeems the code, binds the openid to the
// account, returns the same platform JWT the silent path issues.
app.post("/api/mp/login-bindcode", express.json(), async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const bindCode = typeof req.body?.bindCode === "string" ? req.body.bindCode : "";
  const r = await mpAuth.loginWithBindCode(code, bindCode);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ token: r.token, email: r.email });
});

// Mini-program logout: removes the openid⇄account binding behind the
// presented token. The next launch asks for credentials again.
app.delete("/api/mp/bind", async (req, res) => {
  const auth = req.headers.authorization;
  const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const r = await mpAuth.unbind(token);
  if (!r.ok) return res.status(r.status).json({ error: "Invalid token" });
  res.json({ ok: true });
});

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
  const user = resolveUser(req);
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
  const user = resolveUser(req);
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
