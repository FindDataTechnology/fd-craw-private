#!/usr/bin/env node
// ── Build OpenConnector from pinned git SHA into resources/openconnector/ ─────────
//
// OpenConnector has no emitted `dist/` - its `build` script is typecheck-only
// and the runtime is `src/server/index.ts` run via tsx. So this script clones
// the source, generates the catalog, and copies the whole source tree (+ prod
// node_modules) into resources/openconnector/. At runtime the supervisor spawns
// `node <tsx> src/server/index.ts` (see supervisor/descriptors.js).
//
// Fixes for failures seen in the previous bundle-services attempt:
//  1. Thread http_proxy into `git clone -c http.proxy=...` explicitly.
//  2. Run OC's .ts postinstall/catalog scripts through tsx - bypasses Node 25's
//     experimental type-stripping which can't load .ts from node_modules.
//  3. createRequire() used correctly (this file is ESM).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execa } from "execa";
import pjson from "../package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const TARGET_DIR = path.join(PROJECT_ROOT, "resources", "openconnector");
const REPO = "https://github.com/oomol-lab/open-connector.git";
const PINNED_SHA = pjson.platformBundles?.openconnectorSha;

if (!PINNED_SHA) {
  console.error("❌ platformBundles.openconnectorSha not set in package.json");
  process.exit(1);
}

const proxy = process.env.http_proxy || process.env.HTTP_PROXY || "";
const gitProxyArgs = proxy ? ["-c", `http.proxy=${proxy}`, "-c", `https.proxy=${proxy}`] : [];

// Directories not needed at runtime (trim bundle size).
const SKIP_DIRS = new Set([".git", "docs", "examples", "docker", ".github", "assets", "web"]);
const SKIP_FILES = new Set([".codex"]);

async function main() {
  if (fs.existsSync(path.join(TARGET_DIR, "src", "server", "index.ts"))) {
    console.log("✅ OpenConnector already built - skipping");
    return;
  }

  console.log(`🔨 Building OpenConnector from SHA: ${PINNED_SHA}`);
  const tempDir = path.join(PROJECT_ROOT, "node_modules", ".temp-openconnector");
  await fs.promises.rm(tempDir, { recursive: true, force: true });

  console.log("Cloning...");
  await execa("git", [...gitProxyArgs, "clone", REPO, tempDir]);
  await execa("git", ["checkout", PINNED_SHA], { cwd: tempDir });

  // Install deps without running scripts (postinstall .ts trips type-stripping).
  console.log("Installing dependencies (--ignore-scripts)...");
  await execa("npm", ["install", "--ignore-scripts"], { cwd: tempDir });

  // Generate the catalog via tsx (bypasses Node 25 type-stripping).
  console.log("Generating catalog via tsx...");
  const tsxPath = require.resolve("tsx", { paths: [path.join(PROJECT_ROOT, "node_modules")] });
  await execa(process.execPath, [tsxPath, "scripts/ensure-generated.ts"], { cwd: tempDir });

  // Copy the source tree (+ prod node_modules) into target, skipping heavy dirs.
  await fs.promises.rm(TARGET_DIR, { recursive: true, force: true });
  await fs.promises.mkdir(TARGET_DIR, { recursive: true });
  console.log("Copying source tree...");
  await copyDir(tempDir, TARGET_DIR);

  // Reinstall prod-only node_modules in the target (drops devDeps).
  console.log("Pruning to production dependencies...");
  await execa("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: TARGET_DIR });

  // Clean temp + the copied .git if any.
  await fs.promises.rm(tempDir, { recursive: true, force: true });
  await fs.promises.rm(path.join(TARGET_DIR, ".git"), { recursive: true, force: true }).catch(() => {});

  console.log(`✅ Done: OpenConnector source built to ${TARGET_DIR}`);
}

async function copyDir(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isSymbolicLink()) {
      // Preserve symlinks rather than following them (avoids copying huge trees
      // or choking on broken links).
      try {
        const target = await fs.promises.readlink(s);
        await fs.promises.symlink(target, d).catch(() => {});
      } catch { /* skip unreadable link */ }
    } else if (entry.isFile()) {
      await fs.promises.copyFile(s, d);
    }
    // Skip sockets, fifos, block/char devices (e.g. @oomol/connect-web).
  }
}

main().catch((err) => {
  console.error("❌ Build failed:", err.shortMessage || err.message || err);
  process.exit(1);
});
