#!/usr/bin/env node
// ── Bundled Postgres lifecycle wrapper (spawned by the supervisor) ───────────
//
// Postgres doesn't fit the supervisor's "spawn one long-running process" model
// (`pg_ctl start` returns immediately after starting postgres in the background),
// so this wrapper owns the full lifecycle and stays alive until signaled:
//   1. initdb the data dir if missing (first run)
//   2. pg_ctl start on the assigned port (localhost-only, trust auth)
//   3. createdb litellm (idempotent)
//   4. keep the process alive
//   5. on SIGINT/SIGTERM: pg_ctl stop (fast) then exit
//
// Usage: node pg-serve.js <pgBinDir> <dataDir> <port>
// The supervisor health-checks the postgres port via TCP (healthKind: "tcp").

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [pgBinDir, dataDirArg, portArg] = process.argv.slice(2);
if (!pgBinDir || !dataDirArg || !portArg) {
  console.error("Usage: node pg-serve.js <pgBinDir> <dataDir> <port>");
  process.exit(1);
}
const port = Number(portArg);
const dataDir = path.resolve(dataDirArg); // Convert to absolute path for unix_socket_directories
const IS_WIN = process.platform === "win32";
const ext = IS_WIN ? ".exe" : "";
const bin = (name) => path.join(pgBinDir, name + ext);

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

// 1. initdb if the data dir is uninitialized.
if (!fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
  console.log(`[pg] initdb -> ${dataDir}`);
  fs.mkdirSync(dataDir, { recursive: true });
  run(bin("initdb"), ["-D", dataDir, "--auth=trust", "-U", "postgres", "--encoding=UTF8"]);
}

// 2. start postgres on the assigned port (localhost-only; unix socket in the data
//    dir so it doesn't collide with a system postgres socket).
console.log(`[pg] starting on port ${port}...`);
const absDataDir = path.resolve(dataDir);
run(bin("pg_ctl"), [
  "-D", absDataDir, "-w", "start",
  "-o", `-p ${port} -c listen_addresses=localhost -c unix_socket_directories=${absDataDir}`,
]);

// 3. (The default `postgres` database created by initdb is used by LiteLLM -
//    the @embedded-postgres package ships only initdb/pg_ctl/postgres, no
//    createdb/psql, so LiteLLM's DATABASE_URL points at the `postgres` DB.)

console.log(`[pg] ready on port ${port}`);

// 4. keep alive until signaled.
const stop = () => {
  console.log("[pg] stopping...");
  try {
    run(bin("pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"]);
  } catch (e) {
    console.warn("[pg] pg_ctl stop failed:", e.message);
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Keep the Node process alive (pg_ctl start returned; postgres runs as a child
// of pg_ctl, not of this process, so we must not exit).
setInterval(() => {}, 1 << 30);
