#!/usr/bin/env node
// ── Build bundled Postgres into resources/postgres/ (cross-platform) ──────────
//
// Downloads the @embedded-postgres/* npm tarball for the host platform - prebuilt,
// relocatable Postgres 17 binaries (bin/lib/share) shipped INSIDE the tarball - and
// extracts native/ into resources/postgres/. The mac tarball is universal (covers
// arm64 + x64). SHA512-verified against the npm registry dist.integrity. Mirrors
// scripts/build-node.js (curl + tar, skip-if-built, platform detection).
//
// Postgres runs portably: bin/postgres auto-resolves ../lib + ../share relative
// to the executable, so the read-only bundle (resources/postgres) + a writable
// data dir (PLATFORM_DATA_DIR/postgres-data, created by the supervisor at first
// start) works without env vars. Runs during `npm run predist`. Skips if built.
//
// Only mac arm64/x64 (universal tarball) + win x64 are build targets.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { resolveBundle } from "../bundle-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Bundle-manifest gate: skip when postgres is deselected (platform.bundle.json
// or PLATFORM_BUNDLE_COMPONENTS). An invalid manifest throws → the build fails.
if (!resolveBundle().components.postgres) {
  console.log("[bundle] postgres deselected by bundle manifest — skipping build");
  process.exit(0);
}
const TARGET = path.join(PROJECT_ROOT, "resources", "postgres");

const IS_WIN = process.platform === "win32";
// mac arm64/x64 (universal tarball) + linux x64 (Docker) + win x64 are build targets.
const IS_TARGET =
  (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) ||
  (process.platform === "linux" && process.arch === "x64") ||
  (process.platform === "win32" && process.arch === "x64");
if (!IS_TARGET) {
  console.warn(`⚠️  Skipping Postgres build: only mac arm64/x64 / linux x64 / win x64 supported. Got ${process.platform}/${process.arch}`);
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const PG_VERSION = pkg.platformBundles.postgresVersion;
// mac binaries are universal - the darwin-arm64 tarball covers x64 too.
// linux x64 has its own @embedded-postgres/linux-x64 package.
const PKG_NAME = IS_WIN ? "@embedded-postgres/windows-x64" : process.platform === "linux" ? "@embedded-postgres/linux-x64" : "@embedded-postgres/darwin-arm64";
const TARBALL_NAME = IS_WIN ? "windows-x64" : process.platform === "linux" ? "linux-x64" : "darwin-arm64";
const TARBALL = `${TARBALL_NAME}-${PG_VERSION}.tgz`;
const TARBALL_URL = `https://registry.npmjs.org/${PKG_NAME}/-/${TARBALL}`;

// Binary path the supervisor expects (mirror supervisor/descriptors.js):
//   mac -> resources/postgres/bin/postgres ;  win -> resources/postgres/bin/postgres.exe
const PG_BIN = IS_WIN
  ? path.join(TARGET, "bin", "postgres.exe")
  : path.join(TARGET, "bin", "postgres");

// Skip if already built.
if (fs.existsSync(PG_BIN)) {
  console.log("✅ Bundled Postgres already present - skipping");
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// Proxy for curl (thread explicitly - inherited env can drop it).
const PROXY = process.env.http_proxy || process.env.HTTP_PROXY || "";
const curlProxy = PROXY ? ["--proxy", PROXY] : [];

fs.mkdirSync(TARGET, { recursive: true });
console.log(`🔨 Building bundled Postgres ${PG_VERSION} (${process.platform}/${process.arch})`);

// 1. Fetch the tarball's SHA512 from the npm registry (dist.integrity).
console.log(`Fetching integrity for ${PKG_NAME}@${PG_VERSION}...`);
const metaPath = path.join(TARGET, "meta.json");
run("curl", ["-fsL", ...curlProxy, `https://registry.npmjs.org/${PKG_NAME}/${PG_VERSION}`, "-o", metaPath]);
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const integrity = meta?.dist?.integrity;
if (!integrity || !integrity.startsWith("sha512-")) {
  console.error(`❌ No sha512 integrity for ${PKG_NAME}@${PG_VERSION} (got: ${integrity})`);
  process.exit(1);
}
const expectedHash = integrity.slice("sha512-".length); // base64 digest

// 2. Download the tarball.
const archivePath = path.join(TARGET, TARBALL);
console.log(`Downloading: ${TARBALL_URL}`);
run("curl", ["-fL", ...curlProxy, TARBALL_URL, "-o", archivePath]);

// 3. Verify size (>20MB - catches a 404 HTML page) then SHA512 (tamper/corruption).
const size = fs.statSync(archivePath).size;
if (size < 20_000_000) {
  console.error(`❌ Downloaded archive is only ${size} bytes - expected >20MB. Aborting (likely a 404 error page).`);
  console.error(fs.readFileSync(archivePath, "utf8").slice(0, 500));
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(metaPath, { force: true });
  process.exit(1);
}
const actualHash = crypto.createHash("sha512").update(fs.readFileSync(archivePath)).digest("base64");
if (actualHash !== expectedHash) {
  console.error(`❌ SHA512 mismatch for ${TARBALL}`);
  console.error(`   expected: ${expectedHash}`);
  console.error(`   actual:   ${actualHash}`);
  fs.rmSync(archivePath, { force: true });
  fs.rmSync(metaPath, { force: true });
  process.exit(1);
}
console.log("✅ SHA512 verified");

// 4. Extract. The npm tarball extracts to package/native/{bin,lib,share}.
console.log("Extracting Postgres...");
run("tar", ["-xzf", archivePath], { cwd: TARGET });

// 5. Flatten: move package/native/* up into resources/postgres/, drop package/.
const nativeDir = path.join(TARGET, "package", "native");
if (fs.existsSync(nativeDir)) {
  for (const entry of fs.readdirSync(nativeDir)) {
    fs.renameSync(path.join(nativeDir, entry), path.join(TARGET, entry));
  }
}
fs.rmSync(path.join(TARGET, "package"), { recursive: true, force: true });
fs.rmSync(archivePath, { force: true });
fs.rmSync(metaPath, { force: true });

// 5.5 Create the major-version + versionless dylib symlinks the binaries link
// against (mac only - the @embedded-postgres tarball ships only the full-version
// dylibs like libicuuc.68.2.dylib; the binaries reference libicuuc.68.dylib and
// libicuuc.dylib). Linux ships .so files with the right soname already, so this
// is darwin-only. Idempotent (skip if the link already exists).
if (process.platform === "darwin") {
  const libDir = path.join(TARGET, "lib");
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir)) {
      const m = /^(lib[^.]+)\.(\d+)((\.\d+)+)\.dylib$/.exec(f);
      if (!m) continue;
      for (const link of [`${m[1]}.${m[2]}.dylib`, `${m[1]}.dylib`]) {
        const p = path.join(libDir, link);
        if (!fs.existsSync(p)) fs.symlinkSync(f, p);
      }
    }
    console.log("✅ Created dylib major/version symlinks");
  }
}

// 6. Sanity-check the binary landed where the supervisor expects it.
if (!fs.existsSync(PG_BIN)) {
  console.error(`❌ Expected Postgres binary not found at: ${PG_BIN}`);
  console.error("   Check the tarball layout (@embedded-postgres may have changed).");
  process.exit(1);
}
// mac: ensure the binaries are executable (tar preserves perms, but be safe).
if (!IS_WIN) {
  for (const bin of ["postgres", "initdb", "pg_ctl"]) {
    const p = path.join(TARGET, "bin", bin);
    if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
  }
}

console.log(`✅ Done: Postgres ${PG_VERSION} -> ${PG_BIN}`);
