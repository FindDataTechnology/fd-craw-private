// Optional forward-auth (AUTH_MODE=forward_auth). Identity = proxy-injected
// X-Forwarded-Email / X-Forwarded-Groups headers (Caddy forward_auth →
// oauth2-proxy → Logto). TRUST BOUNDARY: enabling this asserts the server is
// reachable ONLY through the forward-auth proxy — bind to localhost /
// firewall it, otherwise these headers are attacker-controlled.

export function userFromHeaders(headers) {
  const email = headers["x-forwarded-email"];
  if (!email) return null;
  const groups = String(headers["x-forwarded-groups"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { email: String(email), groups };
}

// Install the HTTP forward-auth gate: when enabled, every request needs a
// proxy-injected identity; attaches req.user = { email, groups } for
// downstream handlers. The WS upgrade gate lives in server.js (it needs the
// raw socket) and applies the same check.
export function registerAuth(ctx) {
  ctx.app.use((req, res, next) => {
    if (!ctx.authEnabled) return next();
    const user = userFromHeaders(req.headers);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    req.user = user;
    next();
  });

  // Gate for mutating admin routes (LLM provider CRUD, catalog refresh).
  // Open to any client when auth is off.
  ctx.requireAdmin = (req, res) => {
    if (ctx.authEnabled && !req.user?.groups?.includes("admin")) {
      res.status(403).json({ error: "Admin group required" });
      return false;
    }
    return true;
  };
}
