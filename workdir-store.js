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

let WORKDIRS_FILE = null;
let workdirsCache = null;
let dirty = false;

export async function initWorkdirStore() {
  WORKDIRS_FILE = path.join(storeDir("sessions-store"), "workdirs.json");
  await fs.mkdir(path.dirname(WORKDIRS_FILE), { recursive: true });
  try {
    workdirsCache = JSON.parse(await fs.readFile(WORKDIRS_FILE, "utf8"));
  } catch {
    workdirsCache = {};
  }
}

async function save() {
  if (!dirty || !WORKDIRS_FILE) return;
  dirty = false;
  const tmp = `${WORKDIRS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(workdirsCache, null, 2), "utf8");
  await fs.rename(tmp, WORKDIRS_FILE);
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
