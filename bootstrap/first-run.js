// ── First-run bootstrap for bundled services (shared, Electron-agnostic) ──────
//
// Runs before the supervisor starts:
// 1. Idempotent atomic seeding of <dataDir>/<settingsFileName>
// 2. Generates OpenConnector runtime/admin tokens if missing (when bundled OC exists)
// 3. All writes are temp+rename so interrupted writes leave the filesystem consistent
//
// Shared by the packaged Electron app (settings.json under userData) and the
// headless local-services launcher (dev-settings.json under PLATFORM_DATA_DIR).
// Takes a `dataDir` + `settingsFileName` instead of app.getPath("userData").
//
// LLM management is now handled natively by dsh-llm (no bundled LiteLLM child
// process) and persistence is SQLite (no bundled Postgres); only OpenConnector
// remains as a bundled service that needs bootstrap.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} FirstRunOptions
 * @property {string} userDataDir - writable data directory (PLATFORM_DATA_DIR / userData)
 * @property {string} resourcesDir - root of bundled resources (process.resourcesPath when packaged)
 * @property {Object} [defaultSettings] - base default settings (baked Volces key, etc.)
 * @property {string} [settingsFileName] - settings file name within dataDir (default "settings.json")
 */

/**
 * Run first-run bootstrap. Idempotent. Never overwrites existing user files.
 * @param {FirstRunOptions} opts
 * @returns {Object} updated settings
 */
export function runFirstRun(opts) {
  const { userDataDir, resourcesDir, defaultSettings = {}, settingsFileName = "settings.json" } = opts;
  console.log("[bootstrap] Running first-run check in", userDataDir);

  // Ensure userDataDir exists
  fs.mkdirSync(userDataDir, { recursive: true });

  // Paths
  const settingsPath = path.join(userDataDir, settingsFileName);

  // Step 1: Read/parse settings
  let settings = {};
  let settingsExists = false;
  if (fs.existsSync(settingsPath)) {
    settingsExists = true;
    try {
      const raw = fs.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(raw);
    } catch (err) {
      console.error("[bootstrap] Corrupt settings file, leaving unchanged:", err.message);
      // Don't overwrite - let supervisor handle graceful degradation
      return { ...defaultSettings, ...settings };
    }
  }

  // Step 2: Merge default settings if missing
  const merged = { ...defaultSettings, ...settings };

  // Step 3: Check if bundled resources exist. OC detection mirrors
  // supervisor/descriptors.js (hasBundledOpenConnector): the runtime runs from
  // src/server/index.ts via tsx - there is no emitted dist/index.js.
  const hasBundledOC = fs.existsSync(path.join(resourcesDir, "openconnector", "src", "server", "index.ts"));

  // Step 4: Generate OC tokens if missing and bundled
  if (hasBundledOC) {
    if (!merged.OPENCONNECTOR_RUNTIME_TOKEN) {
      merged.OPENCONNECTOR_RUNTIME_TOKEN = crypto.randomBytes(32).toString("hex");
      console.log("[bootstrap] Generated new OPENCONNECTOR_RUNTIME_TOKEN");
    }
    if (!merged.OPENCONNECTOR_ADMIN_TOKEN) {
      merged.OPENCONNECTOR_ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
      console.log("[bootstrap] Generated new OPENCONNECTOR_ADMIN_TOKEN");
    }
  }

  // Step 5: Write settings atomically if we changed it OR it didn't exist
  if (!settingsExists || Object.keys(settings).length !== Object.keys(merged).length) {
    const tempPath = settingsPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tempPath, settingsPath);
    console.log("[bootstrap] Wrote updated", settingsFileName, "to", settingsPath);
  }

  return merged;
}
