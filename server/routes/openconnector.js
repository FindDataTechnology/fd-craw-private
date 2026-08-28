// OpenConnector endpoints + reverse proxies.
// The runtime/admin tokens stay server-side; the browser only ever talks to
// these /api/openconnector/* routes (never to the runtime URL directly). The
// config route is always mounted so the UI can detect enabled/disabled state;
// the runtime-proxying routes are mounted only when OpenConnector is enabled.

export function registerOpenConnectorRoutes(ctx) {
  const { app, openConnector, catalog } = ctx;

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

  // ── OpenConnector native web UI reverse proxy ────────────────────────────
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

  // ── External-service proxy (NEW API-style embedded apps) ──────────────────
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
    const svc = externalServiceApp(appId);
    if (!svc) return null;
    // Resolve the bearer token server-side. catalog.js never serializes apiKey/
    // apiKeyEnv to the client (spec D5 — tokens never reach the browser), so this
    // lookup runs on the server and never leaks to the client.
    const apiKey =
      (svc.apiKeyEnv && process.env[svc.apiKeyEnv]) ||
      svc.apiKey ||
      null;
    return createWebProxy({
      prefix: `/external/${svc.id}`,
      getBase: () => svc.url,
      getToken: () => apiKey,
      label: svc.name || svc.id,
    });
  }

  // Register a /external/:appId proxy for every external-service in the catalog.
  // Catch-all registration AFTER the app's own /api/* routes (so those win on
  // conflict) and AFTER the OC roots (/v1/*, /api/*, /assets/*) so OC's
  // /v1/* and /api/* own their paths when both services are configured.
  // Unknown /external/:appId values 404 — agents.json's getExternalServices() is
  // the only source of truth, so a stale link in the browser fails fast.
  for (const svc of catalog.getExternalServices()) {
    const proxy = buildExternalServiceProxy(svc.id);
    if (proxy) {
      app.all(`/external/${svc.id}`, proxy);
      app.all(`/external/${svc.id}/*`, proxy);
    }
  }
}
