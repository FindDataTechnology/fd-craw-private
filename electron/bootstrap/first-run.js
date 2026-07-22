// ── First-run bootstrap for bundled services ─────────────────────────────────
//
// Runs before the supervisor starts:
// 1. Idempotent atomic seeding of userData/settings.json
// 2. Generates OpenConnector runtime/admin tokens if missing (when bundled OC exists)
// 3. Copies default litellm.yaml if missing (when bundled LiteLLM exists)
// 4. All writes are temp+rename so interrupted writes leave the filesystem consistent

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {Object} FirstRunOptions
 * @property {string} userDataDir - writable userData directory (PLATFORM_DATA_DIR)
 * @property {string} resourcesDir - root of bundled resources (process.resourcesPath when packaged)
 * @property {Object} defaultSettings - base default settings (baked Volces key, etc.)
 */

/**
 * Run first-run bootstrap. Idempotent. Never overwrites existing user files.
 * @param {FirstRunOptions} opts
 * @returns {Object} updated settings
 */
export function runFirstRun(opts) {
  const { userDataDir, resourcesDir, defaultSettings = {} } = opts;
  console.log("[bootstrap] Running first-run check in", userDataDir);

  // Ensure userDataDir exists
  fs.mkdirSync(userDataDir, { recursive: true });

  // Paths
  const settingsPath = path.join(userDataDir, "settings.json");
  const litellmUserPath = path.join(userDataDir, "litellm.yaml");
  const litellmDefaultPath = path.join(resourcesDir, "litellm", "default-config.yaml");

  // Step 1: Read/parse settings.json
  let settings = {};
  let settingsExists = false;
  if (fs.existsSync(settingsPath)) {
    settingsExists = true;
    try {
      const raw = fs.readFileSync(settingsPath, "utf8");
      settings = JSON.parse(raw);
    } catch (err) {
      console.error("[bootstrap] Corrupt settings.json, leaving unchanged:", err.message);
      // Don't overwrite - let supervisor handle graceful degradation
      return { ...defaultSettings, ...settings };
    }
  }

  // Step 2: Merge default settings if missing
  const merged = { ...defaultSettings, ...settings };

  // Step 3: Check if bundled resources exist
  const hasBundledOC = fs.existsSync(path.join(resourcesDir, "openconnector", "dist", "index.js"));
  const hasBundledLiteLLM = fs.existsSync(litellmDefaultPath) && fs.existsSync(path.join(resourcesDir, "python", "bin", "python3"));

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

  // Step 5: Generate LiteLLM master key if missing and bundled
  if (hasBundledLiteLLM) {
    if (!merged.LITELLM_API_KEY) {
      merged.LITELLM_API_KEY = "sk-" + crypto.randomBytes(32).toString("hex");
      console.log("[bootstrap] Generated new LITELLM_API_KEY");
    }

    // Step 6: Copy default litellm.yaml if missing
    if (!fs.existsSync(litellmUserPath)) {
      // atomic: temp -> rename
      const tempPath = litellmUserPath + ".tmp";
      fs.copyFileSync(litellmDefaultPath, tempPath);
      fs.renameSync(tempPath, litellmUserPath);
      console.log("[bootstrap] Seeded default litellm.yaml to", litellmUserPath);
    }
  }

  // Step 7: Write settings atomically if we changed it OR it didn't exist
  if (!settingsExists || Object.keys(settings).length !== Object.keys(merged).length) {
    const tempPath = settingsPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tempPath, settingsPath);
    console.log("[bootstrap] Wrote updated settings.json to", settingsPath);
  }

  return merged;
}
