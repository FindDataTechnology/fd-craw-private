import { test, expect } from "@playwright/test";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

// Forward-auth + agent/app catalog e2e. Two targets:
//  - the shared webServer (AUTH_MODE unset): default behavior unchanged and
//    the connect broker refuses without forward auth.
//  - a second `node server.js` spawned here with AUTH_MODE=forward_auth and
//    AGENTS_CONFIG_URL pointing at an in-process fixture server that serves
//    the cloud catalog doc, a mock OpenAI-compat SSE endpoint, and a stubbed
//    Nango /connect/sessions.

// ── Shared server (auth off) ─────────────────────────────────────────────────

test.describe("default AUTH_MODE (auth off)", () => {
  test("/api/auth/me reports mode none; catalog stays open", async ({ request }) => {
    const me = await request.get("/api/auth/me");
    expect(me.ok()).toBeTruthy();
    expect(await me.json()).toEqual({ mode: "none", email: null, groups: null });

    const cat = await request.get("/api/catalog");
    expect(cat.ok()).toBeTruthy();
    const json = await cat.json();
    expect(json.agents.some((a) => a.id === "local")).toBe(true);
    expect(Array.isArray(json.apps)).toBe(true);
  });

  test("connect broker is 400 without forward auth", async ({ request }) => {
    const r = await request.post("/api/apps/whatever/connect");
    expect(r.status()).toBe(400);
  });
});

// ── Forward-auth server (spawned) ────────────────────────────────────────────

const ADMIN = { "x-forwarded-email": "admin@corp.com", "x-forwarded-groups": "admin" };
const USER = { "x-forwarded-email": "bob@corp.com", "x-forwarded-groups": "users" };

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, ms = 10_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}

let AUTH_PORT;
let BASE;
let child;
let fixtureServer;
let fixtureDoc;
const mock = { lastChat: null, lastConnect: null };
let bootLog = "";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paas-auth-e2e-"));

function openWs(headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${AUTH_PORT}/`, { headers });
    const msgs = [];
    ws.on("message", (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ ws, msgs }));
    ws.on("error", reject);
  });
}

test.describe("AUTH_MODE=forward_auth", () => {
  // beforeAll boots a second server.js — give the whole group headroom.
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    // Fixture server: cloud catalog + mock OpenAI-compat SSE + Nango stub.
    const fixturePort = await freePort();
    const FIXTURE = `http://127.0.0.1:${fixturePort}`;
    fixtureDoc = {
      agents: [
        // cloud wins by id — overrides the built-in local entry's name
        { id: "local", type: "agent-local", name: "Cloud Local Override" },
        { id: "remote-chat", type: "agent-remote", mode: "chat", baseUrl: `${FIXTURE}/v1`, model: "mock-model", apiKeyEnv: "REMOTE_AGENT_KEY" },
        { id: "admin-agent", type: "agent-remote", mode: "chat", baseUrl: `${FIXTURE}/v1`, model: "mock-model", roles: ["admin"] },
        { id: "link-agent", type: "agent-remote", mode: "link", url: "https://example.com/agent" },
        // invalid (chat mode without baseUrl) — must be dropped
        { id: "bad-agent", type: "agent-remote", mode: "chat", model: "no-base-url" },
      ],
      apps: [
        { id: "doc-app", type: "app", kind: "link", url: "https://example.com/docs" },
        { id: "nango-app", type: "app", kind: "nango-connect", nangoUrl: `${FIXTURE}/nango` },
      ],
    };
    fixtureServer = http.createServer((req, res) => {
      const readBody = () =>
        new Promise((resolve) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => resolve(body));
        });
      if (req.method === "GET" && req.url === "/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(fixtureDoc));
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        readBody().then((body) => {
          mock.lastChat = { auth: req.headers.authorization, body: JSON.parse(body) };
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          for (const piece of ["Hello ", "remote ", "world"]) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        });
        return;
      }
      if (req.method === "POST" && req.url === "/nango/connect/sessions") {
        readBody().then((body) => {
          mock.lastConnect = { auth: req.headers.authorization, tags: JSON.parse(body).tags };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token: "stub-session-token" }));
        });
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    await new Promise((r) => fixtureServer.listen(fixturePort, "127.0.0.1", r));

    // Second server.js with forward auth on; isolated stores; no OC/LiteLLM.
    AUTH_PORT = await freePort();
    BASE = `http://127.0.0.1:${AUTH_PORT}`;
    child = spawn(process.execPath, ["server.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(AUTH_PORT),
        HOST: "127.0.0.1",
        AUTH_MODE: "forward_auth",
        AGENTS_CONFIG_URL: `${FIXTURE}/config`,
        CATALOG_REFRESH_SECS: "0", // deterministic: refresh only via POST
        NANGO_SECRET_KEY: "test-nango-secret",
        REMOTE_AGENT_KEY: "test-remote-key",
        OPENCONNECTOR_BASE_URL: "",
        LITELLM_BASE_URL: "",
        CHAT_HISTORY_STORE_DIR: path.join(tmpRoot, "chat"),
        DOCUMENTS_STORE_DIR: path.join(tmpRoot, "docs"),
        SESSIONS_STORE_DIR: path.join(tmpRoot, "sessions"),
        DB_PATH: path.join(tmpRoot, "app.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (bootLog += d));
    child.stderr.on("data", (d) => (bootLog += d));

    const start = Date.now();
    let lastErr;
    while (Date.now() - start < 90_000) {
      try {
        const r = await fetch(`${BASE}/api/auth/me`);
        if (r.status === 401 || r.ok) break; // up and gated
        lastErr = new Error(`HTTP ${r.status}`);
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (Date.now() - start >= 90_000) {
      throw new Error(`forward-auth server not ready: ${lastErr?.message}\n${bootLog.slice(-2000)}`);
    }
  });

  test.afterAll(async () => {
    if (child) {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("HTTP: 401 without headers, identity with headers", async () => {
    const anon = await fetch(`${BASE}/api/auth/me`);
    expect(anon.status).toBe(401);

    const me = await fetch(`${BASE}/api/auth/me`, { headers: ADMIN });
    expect(me.ok).toBeTruthy();
    expect(await me.json()).toEqual({ mode: "forward_auth", email: "admin@corp.com", groups: ["admin"] });
  });

  test("WS: upgrade rejected without headers; agents list is role-filtered", async () => {
    await expect(openWs({})).rejects.toThrow(/401/);

    const admin = await openWs(ADMIN);
    await waitFor(() => admin.msgs.some((m) => m.type === "agents"));
    const ids = admin.msgs.find((m) => m.type === "agents").agents.map((a) => a.id);
    expect(ids).toContain("remote-chat"); // chat-mode remote is switchable
    expect(ids).toContain("admin-agent"); // admin sees the role-gated agent
    expect(ids).not.toContain("link-agent"); // link agents are pages, not chat targets
    admin.ws.close();

    const user = await openWs(USER);
    await waitFor(() => user.msgs.some((m) => m.type === "agents"));
    expect(user.msgs.find((m) => m.type === "agents").agents.map((a) => a.id)).not.toContain("admin-agent");
    user.ws.close();
  });

  test("catalog GET is role-filtered, validated, cloud-wins, and redacted", async () => {
    const adminCat = await (await fetch(`${BASE}/api/catalog`, { headers: ADMIN })).json();
    const agentIds = adminCat.agents.map((a) => a.id);
    expect(agentIds).toContain("admin-agent");
    expect(agentIds).toContain("link-agent"); // catalog lists link agents (unlike the WS switcher)
    expect(agentIds).not.toContain("bad-agent"); // invalid entry dropped
    expect(adminCat.agents.find((a) => a.id === "local").name).toBe("Cloud Local Override"); // cloud wins by id
    expect(adminCat.apps.map((a) => a.id)).toEqual(expect.arrayContaining(["doc-app", "nango-app"]));

    // Secrets never reach the client.
    const blob = JSON.stringify(adminCat);
    expect(blob).not.toContain("test-remote-key");
    expect(blob).not.toContain("REMOTE_AGENT_KEY");
    expect(adminCat.agents.find((a) => a.id === "remote-chat")).not.toHaveProperty("apiKey");

    const userCat = await (await fetch(`${BASE}/api/catalog`, { headers: USER })).json();
    expect(userCat.agents.map((a) => a.id)).not.toContain("admin-agent");
    expect(userCat.agents.map((a) => a.id)).toContain("remote-chat");
  });

  test("refresh is admin-gated; cloud change broadcasts catalog_changed", async () => {
    const forbidden = await fetch(`${BASE}/api/catalog/refresh`, { method: "POST", headers: USER });
    expect(forbidden.status).toBe(403);

    const admin = await openWs(ADMIN);
    await waitFor(() => admin.msgs.some((m) => m.type === "agents"));
    fixtureDoc.agents.push({ id: "added-agent", type: "agent-remote", mode: "link", url: "https://example.com/added" });
    const r = await fetch(`${BASE}/api/catalog/refresh`, { method: "POST", headers: ADMIN });
    expect(r.ok).toBeTruthy();
    await waitFor(() => admin.msgs.some((m) => m.type === "catalog_changed"));
    admin.ws.close();

    const cat = await (await fetch(`${BASE}/api/catalog`, { headers: ADMIN })).json();
    expect(cat.agents.map((a) => a.id)).toContain("added-agent");
  });

  test("remote agent chat streams from the mock OpenAI-compat server", async () => {
    const user = await openWs(USER);
    await waitFor(() => user.msgs.some((m) => m.type === "agents"));
    user.ws.send(JSON.stringify({ type: "set_agent", id: "remote-chat" }));
    await waitFor(() => user.msgs.some((m) => m.type === "agent_changed" && m.id === "remote-chat"));
    user.ws.send(JSON.stringify({ type: "prompt", text: "hi" }));
    await waitFor(() => user.msgs.some((m) => m.type === "done"));

    const text = user.msgs.filter((m) => m.type === "text").map((m) => m.delta).join("");
    expect(text).toBe("Hello remote world");
    // apiKeyEnv was resolved server-side and used as the bearer.
    expect(mock.lastChat.auth).toBe("Bearer test-remote-key");
    expect(mock.lastChat.body.model).toBe("mock-model");
    expect(mock.lastChat.body.messages[0].content).toBe("hi");
    user.ws.close();
  });

  test("connect broker mints a Nango session server-side", async () => {
    const r = await fetch(`${BASE}/api/apps/nango-app/connect`, { method: "POST", headers: USER });
    expect(r.status).toBe(200);
    const { url } = await r.json();
    expect(url).toContain("session_token=stub-session-token");

    // The stub saw the server-held secret + user-scoped tags; the secret
    // itself never appears in the response.
    expect(mock.lastConnect.auth).toBe("Bearer test-nango-secret");
    expect(mock.lastConnect.tags).toEqual({
      end_user_id: "bob@corp.com",
      end_user_email: "bob@corp.com",
      organization_id: "corp.com",
    });
    expect(JSON.stringify({ url })).not.toContain("test-nango-secret");
  });
});
