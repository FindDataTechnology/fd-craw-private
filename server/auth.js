// Optional forward-auth (AUTH_MODE=forward_auth). Identity = proxy-injected
// X-Forwarded-Email / X-Forwarded-Groups headers (Caddy forward_auth →
// oauth2-proxy → Logto). TRUST BOUNDARY: enabling this asserts the server is
// reachable ONLY through the forward-auth proxy — bind to localhost /
// firewall it, otherwise these headers are attacker-controlled.

// Paths exempt from the identity requirement, because the caller is an
// external service that cannot supply the proxy header. Each exempt path MUST
// carry its own authentication — this list is not a public-route escape hatch.
//   /api/bots/webhook/ — chat platforms (WeCom/Feishu/Telegram/WeChat OA);
//     authenticated by the per-bot path secret plus the platform's own
//     signature check or payload decryption (see server/routes/bots.js).
const AUTH_EXEMPT_PREFIXES = ["/api/bots/webhook/"];

export function normalizeAuthPath(value, fallback) {
  const raw = String(value || "").trim();
  return raw.startsWith("/") && !raw.startsWith("//") && !/\s/.test(raw) ? raw : fallback;
}

const isPublicRequest = (req) => {
  if (!["GET", "HEAD"].includes(req.method)) return false;
  const p = req.path;
  return (
    p === "/api/auth/me" ||
    p === "/login" ||
    p.startsWith("/assets/") ||
    (!p.startsWith("/api/") && !p.startsWith("/external/"))
  );
};

const isLogtoPublicRequest = (req) => {
  const p = req.path;
  if (p === "/api/auth/logout") return true;
  if (!["GET", "HEAD"].includes(req.method)) return false;
  return p === "/api/auth/me" || p === "/api/config" || p === "/api/ready" || p === "/login" || p === "/auth/login" || p === "/auth/callback" || p.startsWith("/assets/");
};

const isExempt = (p) => AUTH_EXEMPT_PREFIXES.some((prefix) => p.startsWith(prefix));

export function userFromHeaders(headers) {
  const email = String(headers["x-forwarded-email"] || "").trim();
  if (!email) return null;
  const groups = String(headers["x-forwarded-groups"] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { email, groups };
}

// Install the HTTP auth gate. forward_auth trusts proxy-injected identity;
// logto verifies the signed session cookie and ignores those headers.
export function registerAuth(ctx) {
  ctx.app.use((req, res, next) => {
    const headerUser = userFromHeaders(req.headers);
    if (ctx.authMode === "logto") {
      if (isLogtoPublicRequest(req) || isExempt(req.path)) {
        const user = ctx.logtoAuth?.authenticate(req, res);
        if (user) req.user = user;
        return next();
      }
      const user = ctx.logtoAuth?.authenticate(req, res);
      if (!user) {
        if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Authentication required" });
        if (req.accepts("html")) return res.redirect("/login");
        return res.status(401).json({ error: "Authentication required" });
      }
      req.user = user;
      return next();
    }

    if (ctx.authEnabled) {
      if (isPublicRequest(req) || isExempt(req.path)) {
        if (headerUser) req.user = headerUser;
        return next();
      }
      if (!headerUser) return res.status(401).json({ error: "Authentication required" });
      req.user = headerUser;
      return next();
    }
    // Optional SSO is an identity overlay only. It never turns auth off into
    // forward-auth, grants admin rights, or changes route authorization.
    if (ctx.ssoEnabled && headerUser) req.ssoUser = headerUser;
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
