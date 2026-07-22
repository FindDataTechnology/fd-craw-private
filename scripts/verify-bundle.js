#!/usr/bin/env node
// ── Post-build verification: check all bundled resources exist ───────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const RESOURCES_ROOT = path.join(PROJECT_ROOT, "resources");

const checks = [
  {
    name: "OpenConnector",
    path: path.join(RESOURCES_ROOT, "openconnector", "src", "server", "index.ts"),
    required: process.env.PLATFORM_SKIP_OC_BUILD ? false : true,
  },
  {
    name: "Python runtime",
    path: path.join(RESOURCES_ROOT, "python", "bin", "python3"),
    required: process.env.PLATFORM_SKIP_PYTHON_BUILD ? false : process.arch === "arm64" && process.platform === "darwin",
  },
  {
    name: "LiteLLM venv",
    path: path.join(RESOURCES_ROOT, "litellm", "venv", "bin", "litellm"),
    required: process.env.PLATFORM_SKIP_PYTHON_BUILD ? false : process.arch === "arm64" && process.platform === "darwin",
  },
  {
    name: "LiteLLM default config",
    path: path.join(RESOURCES_ROOT, "litellm", "default-config.yaml"),
    required: true,
  },
];

let allGood = true;

console.log("🔍 Verifying bundled resources...");
for (const check of checks) {
  const exists = fs.existsSync(check.path);
  if (check.required && !exists) {
    console.error(`❌ ${check.name} missing at: ${check.path}`);
    allGood = false;
  } else if (!check.required && !exists) {
    console.log(`⚠️  ${check.name} missing (optional for this platform/build)`);
  } else {
    console.log(`✅ ${check.name}: OK`);
  }
}

// Warn about signing if no credentials set
if (!process.env.CSC_LINK && process.platform === "darwin") {
  console.log("\n⚠️  CSC_LINK / CSC_KEY_PASSWORD not set in environment.");
  console.log("   The resulting .dmg will not pass Gatekeeper on other machines.");
  console.log("   Set these env vars before building for a signed, notarized release.\n");
}

if (!allGood) {
  console.error("\n❌ Verification failed: some required resources are missing.");
  console.error("   Run `npm run predist` to build all bundled resources before `npm run dist`.");
  process.exit(1);
}

console.log("\n✅ All required bundled resources verified.");
process.exit(0);
