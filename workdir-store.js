// ── Workdir store (per-session working directory) ────────────────────────────
//
// Records which folder each chat session's agent operates in. The SDK fixes the
// agent's cwd at session creation (no runtime setter), so the workdir is read
// when (re)building the session for a folder and stored here per session id so
// switching back to a session restores its folder.
//
// Atomic JSON persistence (temp file + rename) matching the project's
// crash-safe pattern.

import { promises as fs } from "node:fs";
import path from "node:path";
import { storeDir } from "./paths.js";
import { atomicWriteJson, readJsonOr, createWriteChain } from "./lib/persistence.js";

let WORKDIRS_FILE = null;
let workdirsCache = null;
let dirty = false;
const writeChain = createWriteChain();

export async function initWorkdirStore() {
  WORKDIRS_FILE = path.join(storeDir("sessions-store"), "workdirs.json");
  await fs.mkdir(path.dirname(WORKDIRS_FILE), { recursive: true });
  workdirsCache = readJsonOr(WORKDIRS_FILE, {}, { label: "workdir" });
}

// Dirty-flag coalescing stays: only the actual disk write is serialized (and
// atomic with a unique temp name) so overlapping flushes can't interleave.
function save() {
  if (!dirty || !WORKDIRS_FILE) return Promise.resolve();
  dirty = false;
  const snapshot = JSON.parse(JSON.stringify(workdirsCache));
  return writeChain.mutate(() => atomicWriteJson(WORKDIRS_FILE, snapshot));
}

export async function getWorkdir(sessionId) {
  if (!sessionId) return null;
  return workdirsCache?.[sessionId] ?? null;
}

export async function setWorkdir(sessionId, workdir) {
  if (!sessionId) return;
  if (workdir) workdirsCache[sessionId] = workdir;
  else delete workdirsCache[sessionId];
  dirty = true;
  await save();
}
