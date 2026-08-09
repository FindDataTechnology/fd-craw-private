#!/usr/bin/env node
// ── Integration check: bundled-extension seeding across restarts (5.4) ──────
// Spawns server.js with a throwaway manifest + a FRESH PLATFORM_DATA_DIR,
// asserts the bundled MCP server + bundled skill are listed in the extensions
// API, makes a user edit to the (unlocked) bundled MCP server, then restarts
// with the SAME data dir and asserts INSERT-OR-IGNORE preserved the edit.
// Run: node scripts/test-bundle-seeding.js  (exit 1 on first failure)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

const PORT = await new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-seed-test-"));
const manifestPath = path.join(root, "test.bundle.json");
fs.writeFileSync(
  manifestPath,
  JSON.stringify({
    components: { litellm: { include: false }, openconnector: { include: false }, postgres: { include: false } },
    mcpServers: {
      "seed-test": { command: "node", args: ["-e", "setTimeout(() => {}, 50)"], enabled: true },
    },
    skills: ["example-skill"],
    permissions: {},
  })
);

let passed = 0;
function ok(name) {
  passed++;
  console.log(`✅ ${name}`);
}

async function waitForServer() {
  const deadline = Date.now() + 45_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/extensions/mcp`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("server did not start in time");
    await new Promise((r) => setTimeout(r, 500));
  }
}

function startServer() {
  const p = spawn(process.execPath, ["server.js"], {
    cwd: REPO_ROOT, // server.js reads skills/ + mcp.json relative to repo root
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      OPENCONNECTOR_BASE_URL: "",
      LITELLM_BASE_URL: "",
      WEKNORA_BASE_URL: "",
      PLATFORM_BUNDLE_MANIFEST: manifestPath,
      PLATFORM_DATA_DIR: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  p.stdout.on("data", (d) => { /* consumed on demand */ });
  return p;
}

// Repo root = the dir containing this script's parent (scripts/../).
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let current = startServer();

// Is a TCP port free on localhost? (bind + immediately release.)
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function restart() {
  current.kill("SIGTERM");
  await new Promise((resolve) => current.once("exit", resolve));
  // The listening socket may take a beat to release after exit; poll before
  // respawning so the new server.js can bind the same port.
  const deadline = Date.now() + 10_000;
  while (!(await isPortFree(PORT))) {
    if (Date.now() > deadline) throw new Error("port did not free up after shutdown");
    await new Promise((r) => setTimeout(r, 200));
  }
  current = startServer();
}
process.on("exit", () => { try { current.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(root, { recursive: true, force: true }); });

const api = {
  async get(p) { return fetch(`${BASE}${p}`); },
  async patch(p, body) {
    return fetch(`${BASE}${p}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  },
};

try {
  await waitForServer();

  // ── Fresh data dir lists bundled entries in both endpoints ────────────────
  {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const { servers } = await (await api.get("/api/extensions/mcp")).json();
      if (servers.some((s) => s.name === "seed-test")) break;
      if (Date.now() > deadline) throw new Error("seeded MCP server never appeared");
      await new Promise((r) => setTimeout(r, 500));
    }
    const { servers } = await (await api.get("/api/extensions/mcp")).json();
    const seeded = servers.find((s) => s.name === "seed-test");
    assert.equal(seeded.origin, "bundled");
    assert.equal(Boolean(seeded.locked), false);
    assert.equal(seeded.enabled, true);
    ok("fresh run: bundled MCP server listed with origin=bundled, enabled");
  }
  {
    const { skills } = await (await api.get("/api/extensions/skills")).json();
    const skill = skills.find((s) => s.name === "example-skill");
    assert.ok(skill, "example-skill listed");
    assert.equal(skill.origin, "bundled");
    ok("fresh run: bundled skill listed with origin=bundled");
  }

  // ── User edits an (unlocked) bundled entry, then it survives a restart ────
  {
    const res = await api.patch("/api/extensions/mcp/seed-test/enable", { enabled: false });
    assert.equal(res.status, 200);
    const { servers } = await (await api.get("/api/extensions/mcp")).json();
    assert.equal(servers.find((s) => s.name === "seed-test").enabled, false);
    ok("user disables the bundled MCP server (unlocked ⇒ allowed)");
  }

  await restart();
  await waitForServer();

  {
    const { servers } = await (await api.get("/api/extensions/mcp")).json();
    const seeded = servers.find((s) => s.name === "seed-test");
    assert.ok(seeded, "still listed after restart");
    assert.equal(seeded.origin, "bundled");
    assert.equal(seeded.enabled, false, "INSERT OR IGNORE must NOT reset a user edit");
    ok("restart: user's disabled state preserved (INSERT OR IGNORE)");
  }

  console.log(`\n${passed} checks passed.`);
} finally {
  try { current.kill("SIGKILL"); } catch { /* gone */ }
  fs.rmSync(root, { recursive: true, force: true });
}
