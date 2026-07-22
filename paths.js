// ── Store path resolution ───────────────────────────────────────────────────
//
// Centralizes where on-disk state lives. In dev (`npm start`) PLATFORM_DATA_DIR
// is unset and each store keeps its historical relative location (relative to
// CWD). When packaged as an Electron app, the supervisor sets PLATFORM_DATA_DIR
// to app.getPath('userData') so all writable state lands in a per-user,
// update-safe, writable directory - the macOS app bundle itself is read-only.
//
// A module-specific override (an absolute path) always wins over
// PLATFORM_DATA_DIR, preserving the existing DB_PATH / SESSIONS_STORE_DIR /
// CRON_STORAGE_PATH env vars used in dev and tests.

import path from "node:path";

export const PLATFORM_DATA_DIR = process.env.PLATFORM_DATA_DIR || "";

// Resolve a store directory. `override` (from a module-specific env var) wins;
// otherwise the store lands under PLATFORM_DATA_DIR/<subdir> when packaged, or
// <subdir> relative to CWD in dev.
export function storeDir(subdir, override) {
  if (override) return path.resolve(override);
  if (PLATFORM_DATA_DIR) return path.join(PLATFORM_DATA_DIR, subdir);
  return path.resolve(subdir);
}
