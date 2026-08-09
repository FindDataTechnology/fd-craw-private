#!/usr/bin/env node
// ── Integration checks for locked (bundled) extension API guards ─────────────
// Spawns server.js with a throwaway manifest (PLATFORM_BUNDLE_MANIFEST) that
// declares a locked + an unlocked bundled MCP server and a locked bundled skill,
// then asserts the D6 semantics over HTTP:
//   locked   → DELETE/PUT/PATCH-enable all 400; entry stays listed
//   unlocked → fully manageable (PATCH/PUT/DELETE succeed)
// Run: node scripts/test-bundle-locking.js  (exit 1 on first failure)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

// Grab a free port — a fixed one collides with stray dev/test servers.
const PORT = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}: ${err.message}`);
    console.error(`── server log ──\n${serverLog.split("\n").slice(-30).join("\n")}`);
    process.exitCode = 1;
    throw err; // stop on first failure (server state is sequential)
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-lock-test-"));
const manifestPath = path.join(root, "test.bundle.json");
fs.writeFileSync(
  manifestPath,
  JSON.stringify({
    components: { litellm: { include: false }, openconnector: { include: false }, postgres: { include: false } },
    mcpServers: {
      "test-locked": { command: "node", args: ["-e", "setTimeout(() => {}, 50)"], enabled: true },
      "test-unlocked": { command: "node", args: ["-e", "setTimeout(() => {}, 50)"], enabled: true },
    },
    skills: ["example-skill"],
    permissions: {
      "mcp:test-locked": { locked: true, allow: ["*"] },
      "skill:example-skill": { locked: true },
    },
  })
);

for (const d of ["chat-history-store", "documents-store", "sessions-store"]) {
  fs.mkdirSync(path.join(root, d), { recursive: true });
}

const server = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    OPENCONNECTOR_BASE_URL: "",
    LITELLM_BASE_URL: "",
    WEKNORA_BASE_URL: "",
    PLATFORM_BUNDLE_MANIFEST: manifestPath,
    CHAT_HISTORY_STORE_DIR: path.join(root, "chat-history-store"),
    DOCUMENTS_STORE_DIR: path.join(root, "documents-store"),
    SESSIONS_STORE_DIR: path.join(root, "sessions-store"),
    DB_PATH: path.join(root, "app.db"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });

function cleanup() {
  server.kill("SIGTERM");
  fs.rmSync(root, { recursive: true, force: true });
}
process.on("exit", cleanup);

async function waitForServer(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/extensions/mcp`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 500));
  }
}

const api = {
  async get(p) { return fetch(`${BASE}${p}`); },
  async del(p) { return fetch(`${BASE}${p}`, { method: "DELETE" }); },
  async patch(p, body) {
    return fetch(`${BASE}${p}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  },
  async put(p, body) {
    return fetch(`${BASE}${p}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  },
  async post(p, body) {
    return fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  },
};

try {
  await waitForServer();

  // ── Seeded bundled MCP servers carry origin/locked/permissions ────────────
  await check("manifest MCP servers seeded with origin/locked/permissions", async () => {
    // Seeding happens during async agent init, after the HTTP listener is up —
    // poll until the bundled rows appear.
    let servers = [];
    const deadline = Date.now() + 20_000;
    for (;;) {
      ({ servers } = await (await api.get("/api/extensions/mcp")).json());
      if (servers.some((s) => s.name === "test-locked") && servers.some((s) => s.name === "test-unlocked")) break;
      if (Date.now() > deadline) throw new Error(`seeded servers never appeared (got: ${servers.map((s) => s.name).join(", ")})`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const locked = servers.find((s) => s.name === "test-locked");
    const unlocked = servers.find((s) => s.name === "test-unlocked");
    assert.equal(locked.origin, "bundled");
    assert.equal(locked.locked, true);
    assert.deepEqual(locked.permissions, { allow: ["*"] });
    assert.equal(unlocked.origin, "bundled");
    assert.equal(Boolean(unlocked.locked), false);
  });

  // ── Locked MCP: DELETE / PUT / PATCH-enable all 400 ───────────────────────
  await check("locked MCP DELETE → 400", async () => {
    const res = await api.del("/api/extensions/mcp/test-locked");
    assert.equal(res.status, 400);
  });
  await check("locked MCP PUT → 400", async () => {
    const res = await api.put("/api/extensions/mcp/test-locked", { config: { command: "node", args: [] } });
    assert.equal(res.status, 400);
  });
  await check("locked MCP PATCH enable → 400", async () => {
    const res = await api.patch("/api/extensions/mcp/test-locked/enable", { enabled: false });
    assert.equal(res.status, 400);
  });
  await check("locked MCP survives the rejected mutations", async () => {
    const { servers } = await (await api.get("/api/extensions/mcp")).json();
    const locked = servers.find((s) => s.name === "test-locked");
    assert.ok(locked, "still listed");
    assert.equal(locked.enabled, true);
  });

  // ── Unlocked bundled MCP: fully manageable ────────────────────────────────
  await check("unlocked bundled MCP PATCH enable → 200", async () => {
    const res = await api.patch("/api/extensions/mcp/test-unlocked/enable", { enabled: false });
    assert.equal(res.status, 200);
  });
  await check("unlocked bundled MCP PUT → 200", async () => {
    const res = await api.put("/api/extensions/mcp/test-unlocked", { enabled: true });
    assert.equal(res.status, 200);
  });
  await check("unlocked bundled MCP DELETE → 200", async () => {
    const res = await api.del("/api/extensions/mcp/test-unlocked");
    assert.equal(res.status, 200);
    const { servers } = await (await api.get("/api/extensions/mcp")).json();
    assert.ok(!servers.find((s) => s.name === "test-unlocked"), "removed");
  });

  // ── Locked bundled skill (manifest-derived): guards on every mutation ─────
  await check("manifest skill listed with origin bundled + locked", async () => {
    const { skills } = await (await api.get("/api/extensions/skills")).json();
    const skill = skills.find((s) => s.name === "example-skill");
    assert.ok(skill, "example-skill listed");
    assert.equal(skill.origin, "bundled");
    assert.equal(skill.locked, true);
  });
  await check("locked skill PATCH enable → 400", async () => {
    const res = await api.patch("/api/extensions/skills/example-skill/enable", { enabled: false });
    assert.equal(res.status, 400);
  });
  await check("locked skill PUT → 400", async () => {
    const res = await api.put("/api/extensions/skills/example-skill", { content: "x" });
    assert.equal(res.status, 400);
  });
  await check("locked skill DELETE → 400", async () => {
    const res = await api.del("/api/extensions/skills/example-skill");
    assert.equal(res.status, 400);
  });

  // ── User skills stay fully manageable ─────────────────────────────────────
  await check("custom skill add/toggle/delete cycle works", async () => {
    const add = await api.post("/api/extensions/skills", { name: "lock-test-user-skill", content: "do a thing" });
    assert.equal(add.status, 200);
    const toggle = await api.patch("/api/extensions/skills/lock-test-user-skill/enable", { enabled: false });
    assert.equal(toggle.status, 200);
    const del = await api.del("/api/extensions/skills/lock-test-user-skill");
    assert.equal(del.status, 200);
  });

  console.log(`\n${passed} checks passed.`);
} finally {
  cleanup();
}
