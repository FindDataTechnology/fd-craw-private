#!/usr/bin/env node
// ── Postinstall: build bundled LiteLLM + OpenConnector resources if missing ──
//
// So `npm install && npm start` works out of the box on a fresh clone: after
// the web build (postinstall-web.js), build the bundled services if they aren't
// already present. Best-effort - a build failure (no network, no git, no curl)
// logs a warning and NEVER fails `npm install`; the launcher also prints a hint
// when resources are absent.
//
// Skip with PLATFORM_SKIP_BUNDLE=1 (CI, or contributors who run `npm run predist`
// manually). Skips automatically when the resources are already built.
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.PLATFORM_SKIP_BUNDLE === "1") {
  console.log("[postinstall] PLATFORM_SKIP_BUNDLE=1, skipping resource build");
  process.exit(0);
}

// Cross-platform binary paths (mirror supervisor/descriptors.js).
const isWin = process.platform === "win32";
const pythonBin = path.join(root, "resources", "python", isWin ? "python.exe" : "bin/python3");
const litellmBin = path.join(root, "resources", "litellm", "venv", isWin ? "Scripts" : "bin", isWin ? "litellm.exe" : "litellm");
const ocEntry = path.join(root, "resources", "openconnector", "src", "server", "index.ts");

// Already built? (repeat installs don't rebuild.)
if (existsSync(pythonBin) && existsSync(litellmBin) && existsSync(ocEntry)) {
  console.log("[postinstall] bundled resources already present, skipping build");
  process.exit(0);
}

// Only mac arm64 + win x64 have resource build support; skip silently elsewhere.
const isTarget =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "win32" && process.arch === "x64");
if (!isTarget) {
  console.log(`[postinstall] no bundled-resource build for ${process.platform}/${process.arch}; skipping`);
  process.exit(0);
}

console.log("[postinstall] building bundled LiteLLM + OpenConnector resources (one-time; needs network)...");
function run(file) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", file)], { stdio: "inherit" });
  return r.status === 0;
}
const ok = run("build-openconnector.js") && run("build-python-litellm.js");
if (!ok) {
  console.warn(
    "[postinstall] WARNING: bundled-resource build incomplete (network/git/curl missing?). " +
      "`npm start` will run without local LiteLLM/OpenConnector. Run `npm run predist` to retry."
  );
}
// Never fail the install - the app still starts (graceful degradation).
process.exit(0);
