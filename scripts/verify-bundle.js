#!/usr/bin/env node
// ── Post-build verification: bundled resources match the bundle manifest ─────
//
// Asserts that exactly the manifest-selected component set is present in
// resources/ (+ the bundled Node, always required on build targets):
//   - selected component resources missing  → fail
//   - deselected component dir exists        → warn (dev) / fail (CI, env CI)
// A stale all-components resources/ must never silently leak into a lean
// installer. An invalid platform.bundle.json throws → the build fails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundle } from "../bundle-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RESOURCES_ROOT = path.join(PROJECT_ROOT, "resources");

const bundle = resolveBundle({ projectRoot: PROJECT_ROOT });
const sel = bundle.components;

// Cross-platform binary paths (mirror supervisor/descriptors.js).
const IS_WIN = process.platform === "win32";
const PYTHON_BIN_PARTS = IS_WIN ? ["python.exe"] : ["bin", "python3"];
const LITELLM_BIN_PARTS = IS_WIN ? ["venv", "Scripts", "litellm.exe"] : ["venv", "bin", "litellm"];
// Python/LiteLLM are required on the build targets (mac arm64/x64, win x64, linux x64).
const PY_TARGET = (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) ||
                  (process.platform === "win32" && process.arch === "x64") ||
                  (process.platform === "linux" && process.arch === "x64");

const checks = [
  {
    name: "OpenConnector",
    path: path.join(RESOURCES_ROOT, "openconnector", "src", "server", "index.ts"),
    required: sel.openconnector,
    component: "openconnector",
    componentDir: path.join(RESOURCES_ROOT, "openconnector"),
  },
  {
    name: "Bundled Node",
    path: path.join(RESOURCES_ROOT, "node", ...(IS_WIN ? ["node.exe"] : ["bin", "node"])),
    required: PY_TARGET, // server.js always runs on the bundled Node — never deselectable
  },
  {
    name: "Python runtime",
    path: path.join(RESOURCES_ROOT, "python", ...PYTHON_BIN_PARTS),
    required: sel.litellm && PY_TARGET,
    component: "litellm",
    componentDir: path.join(RESOURCES_ROOT, "python"),
  },
  {
    name: "LiteLLM venv",
    path: path.join(RESOURCES_ROOT, "litellm", ...LITELLM_BIN_PARTS),
    required: sel.litellm && PY_TARGET,
    component: "litellm",
    componentDir: path.join(RESOURCES_ROOT, "litellm"),
  },
  {
    name: "LiteLLM default config",
    path: path.join(RESOURCES_ROOT, "litellm", "default-config.yaml"),
    required: sel.litellm,
  },
  {
    name: "Postgres",
    path: path.join(RESOURCES_ROOT, "postgres", "bin", IS_WIN ? "postgres.exe" : "postgres"),
    required: sel.postgres && PY_TARGET,
    component: "postgres",
    componentDir: path.join(RESOURCES_ROOT, "postgres"),
  },
  {
    name: "LiteLLM Prisma engine",
    path: path.join(RESOURCES_ROOT, "litellm", "venv", "prisma-engine", "query-engine"),
    required: sel.litellm && PY_TARGET,
  },
];

// Selected-set consistency: python/ exists only to run LiteLLM.
if (sel.litellm && !sel.postgres) {
  console.warn("⚠️  litellm selected without postgres — bundled LiteLLM will need an external DATABASE_URL at runtime");
}

let allGood = true;

console.log("🔍 Verifying bundled resources against platform.bundle.json...");
console.log(`   selected components: ${Object.entries(sel).filter(([, v]) => v).map(([k]) => k).join(", ") || "(none)"}`);
for (const check of checks) {
  const exists = fs.existsSync(check.path);
  if (check.required && !exists) {
    console.error(`❌ ${check.name} missing at: ${check.path}`);
    allGood = false;
  } else if (!check.required && !exists) {
    console.log(`⚪ ${check.name}: not selected / not required — skipped`);
  } else if (!check.required && exists) {
    console.log(`⚪ ${check.name}: present but not selected (excluded from bundle)`);
  } else {
    console.log(`✅ ${check.name}: OK`);
  }
}

// A deselected component's PAYLOAD left over from an earlier full build would
// get packed by a misconfigured extraResources. Fail in CI; warn in dev.
// Check the payload binary (the check.path each entry already computes), NOT
// the bare dir: `resources/litellm/default-config.yaml` is tracked in git and
// therefore always present on a fresh checkout — it's a seed file, not a leak.
// Only the built payload (e.g. venv/bin/litellm, python/bin/python3) signals a
// stale all-components resources/ that must not reach a lean installer.
const deselectedPayloads = checks.filter((c) => c.component && !sel[c.component] && c.componentDir);
// One payload per componentDir (litellm owns both resources/python and
// resources/litellm — distinct dirs, distinct payload binaries).
for (const check of [...new Map(deselectedPayloads.map((c) => [c.componentDir, c])).values()]) {
  if (fs.existsSync(check.path)) {
    const dir = path.relative(PROJECT_ROOT, check.componentDir);
    const msg = `deselected component payload exists in resources/: ${dir} (remove it before packing a lean installer)`;
    if (process.env.CI) {
      console.error(`❌ ${msg}`);
      allGood = false;
    } else {
      console.warn(`⚠️  ${msg}`);
    }
  }
}

// Warn about signing if no credentials set
if (!process.env.CSC_LINK && process.platform === "darwin") {
  console.log("\n⚠️  CSC_LINK / CSC_KEY_PASSWORD not set in environment.");
  console.log("   The resulting .dmg will not pass Gatekeeper on other machines.");
  console.log("   Set these env vars before building for a signed, notarized release.\n");
}

if (!allGood) {
  console.error("\n❌ Verification failed: bundled resources do not match the bundle manifest.");
  console.error("   Run `npm run predist` to build the selected resources before `npm run dist`.");
  process.exit(1);
}

console.log("\n✅ Bundled resources match the selected component set.");
process.exit(0);
