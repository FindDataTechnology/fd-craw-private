// ── First-run bootstrap for bundled services (shared, Electron-agnostic) ──────
//
// Runs before the supervisor starts:
// 1. Idempotent atomic seeding of <dataDir>/<settingsFileName>
// 2. Generates OpenConnector runtime/admin tokens if missing (when bundled OC exists)
// 3. Copies default litellm.yaml if missing (when bundled LiteLLM exists)
// 4. All writes are temp+rename so interrupted writes leave the filesystem consistent
//
// Shared by the packaged Electron app (settings.json under userData) and the
// headless local-services launcher (dev-settings.json under PLATFORM_DATA_DIR).
// Takes a `dataDir` + `settingsFileName` instead of app.getPath("userData").

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
  const litellmUserPath = path.join(userDataDir, "litellm.yaml");
  const litellmDefaultPath = path.join(resourcesDir, "litellm", "default-config.yaml");

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

    // Step 6b: Make the bundled venv relocatable. `python -m venv` (run on the
    // CI runner) bakes absolute runner paths into bin/python3 (symlink target)
    // and pyvenv.cfg `home` - both break when the app is installed elsewhere.
    // The `litellm` wrapper shebang is bypassed by the supervisor (it invokes
    // litellm via the venv python), so only the symlink + pyvenv.cfg need fixing.
    fixupBundledVenv(resourcesDir);
  }

  // Step 7: Write settings atomically if we changed it OR it didn't exist
  if (!settingsExists || Object.keys(settings).length !== Object.keys(merged).length) {
    const tempPath = settingsPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tempPath, settingsPath);
    console.log("[bootstrap] Wrote updated", settingsFileName, "to", settingsPath);
  }

  return merged;
}

// Make the bundled LiteLLM venv relocatable (mac only; Windows venv copies
// python.exe so there's no symlink/home issue). Idempotent + non-fatal.
function fixupBundledVenv(resourcesDir) {
  if (process.platform === "win32") return;
  const venvDir = path.join(resourcesDir, "litellm", "venv");
  const venvBin = path.join(venvDir, "bin");
  const python3Link = path.join(venvBin, "python3");
  // Relative from venv/bin/ to the bundled python: bin -> venv -> litellm -> resources -> python/bin
  const relTarget = "../../../python/bin/python3";
  try {
    const cur = fs.existsSync(python3Link) && fs.readlinkSync(python3Link);
    if (cur !== relTarget) {
      fs.rmSync(python3Link, { force: true });
      fs.symlinkSync(relTarget, python3Link);
      console.log("[bootstrap] Repointed venv python3 -> relative bundled python");
    }
    // pyvenv.cfg `home` must be absolute (relative isn't supported by CPython)
    // and points to the runner's python bin in a fresh build -> pin to the local
    // bundled python. Re-pinned each launch (self-heals if the app is moved).
    const pyvenvCfg = path.join(venvDir, "pyvenv.cfg");
    if (fs.existsSync(pyvenvCfg)) {
      const pyBin = path.join(resourcesDir, "python", "bin");
      let cfg = fs.readFileSync(pyvenvCfg, "utf8");
      const before = cfg;
      cfg = cfg.replace(/^home = .*/m, `home = ${pyBin}`);
      cfg = cfg.replace(/^executable = .*/m, `executable = ${path.join(pyBin, "python3.13")}`);
      if (cfg !== before) {
        fs.writeFileSync(pyvenvCfg, cfg);
        console.log("[bootstrap] Pinned venv pyvenv.cfg home/executable -> local bundled python");
      }
    }
  } catch (e) {
    console.warn("[bootstrap] venv relocation fixup failed (non-fatal):", e.message);
  }
}
