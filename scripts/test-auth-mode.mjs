import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import express from "express";
import { test } from "node:test";
import { registerAuth, userFromHeaders } from "../server/auth.js";
import { signSession } from "../server/session.js";

function request(app, path = "/", headers = {}) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    });
    server.on("error", reject);
  });
}

function expressApp(ctx) {
  const app = express();
  ctx.app = app;
  registerAuth(ctx);
  app.get("/protected", (req, res) => res.json({ user: req.user || null }));
  app.get("/api/auth/me", (req, res) => res.json({ user: req.user || null }));
  return app;
}

test("logto ignores forged identity headers and accepts a signed cookie", async () => {
  const secret = "secret";
  const cookie = signSession({ email: "user@example.com", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  const ctx = {
    authMode: "logto",
    authEnabled: true,
    ssoEnabled: false,
    logtoAuth: {
      userFromCookie: (value) => value === `paas_session=${cookie}` ? { email: "user@example.com", groups: ["admin"] } : null,
      authenticate: (req, res) => {
        const user = ctx.logtoAuth.userFromCookie(req.headers.cookie);
        if (user) res.setHeader("Set-Cookie", "refreshed=1");
        return user;
      },
    },
  };
  const anonymous = await request(expressApp(ctx), "/protected", { accept: "text/html", "x-forwarded-email": "forged@example.com" });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.location, "/login");

  const authenticated = await request(expressApp(ctx), "/protected", { cookie: `paas_session=${cookie}` });
  assert.equal(authenticated.status, 200);
  assert.deepEqual(JSON.parse(authenticated.body).user, { email: "user@example.com", groups: ["admin"] });
});

test("forward_auth preserves proxy email casing", () => {
  assert.deepEqual(userFromHeaders({ "x-forwarded-email": "User@Example.COM", "x-forwarded-groups": "users" }), {
    email: "User@Example.COM",
    groups: ["users"],
  });
});
