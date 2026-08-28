// Misc routes: identity introspection, agent/app catalog, Nango connect
// broker, server config, supervisor status, preferences — plus the static SPA
// serving, registered separately (registerStaticAndFallback) so the
// composition root can place it after the app's /api routes and before the
// OpenConnector catch-all proxies, exactly matching the pre-split order.

import path from "node:path";
import express from "express";
import { WEB_DIST } from "../context.js";

export function registerMiscRoutes(ctx) {
  const { app, catalog, openConnector, db } = ctx;

  // Identity introspection: lets the frontend render login state without
  // inspecting headers. email/groups are null when auth is off.
  app.get("/api/auth/me", (req, res) => {
    res.json({
      mode: ctx.AUTH_MODE,
      email: req.user?.email ?? null,
      groups: req.user?.groups ?? null,
    });
  });

  // ── Agent & app catalog (agents.json + AGENTS_CONFIG_URL, see catalog.js) ──
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

  // ── Nango connect broker (nango-connect app entries) ─────────────────────
  // Mirrors connect-app/server.mjs: mint a connect session tagged to the
  // requesting user (org = email domain) so Nango isolates their connections,
  // and hand back the Connect UI URL. Requires forward-auth — there is no
  // identity to tag otherwise. The Nango secret stays server-side.
  app.post("/api/apps/:id/connect", async (req, res) => {
    if (!ctx.authEnabled || !req.user?.email) {
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

  // ── Server config (e.g. openconnector / documents state) ──────────────────
  app.get("/api/config", (_req, res) => {
    res.json({
      openconnectorEnabled: openConnector.openConnectorEnabled,
      documentsEnabled: db.isDbReady(),
    });
  });

  // ── Supervisor / system status (for the Dashboard view) ──────────────────
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
          port: ctx.PORT,
          url: `http://localhost:${ctx.PORT}`,
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

  // ── User preferences endpoints (single-user, key/value) ──────────────────
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
}

// Static SPA serving + deep-link fallback. Must be registered after the app's
// /api routes and before the OpenConnector /assets|/v1|/api catch-all proxies
// (so dist files win over the proxy, matching the pre-split order).
export function registerStaticAndFallback(ctx) {
  const { app } = ctx;
  // The React app's Vite `base` is `/chat/`, so its assets self-reference as
  // `/chat/assets/...` — no conflict with legacy `/assets/...` from OpenConnector.
  app.use(express.static(WEB_DIST));
  // SPA fallback: any GET that isn't an API route, proxy path, or static asset
  // serves index.html so the client router handles it. /v1/* is excluded so the
  // OpenConnector /v1 reverse-proxy routes - registered after this - are not
  // shadowed by this fallback (which would serve index.html for the embedded
  // SPA's API calls).
  app.get(/^\/(?!api\/|oc-web|external\/|assets\/|v1\/|v2\/|ui|key\/|spend\/|model\/|sso\/|login|logout|user\/|get_image|get_favicon|get\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
}

