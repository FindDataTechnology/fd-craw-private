#!/usr/bin/env node
// ── Build bundled Python + LiteLLM venv into resources/litellm/ (cross-platform) ─
//
// Downloads python-build-standalone (pinned release) for the host platform,
// creates a venv, and installs litellm[proxy] at the pinned version. Runs during
// `npm run dist` (via predist). Skips if already built (cached).
//
// Replaces the macOS-only build-python-litellm.sh. Supports macOS arm64 and
// Windows x64 (the two electron-builder targets). Uses `curl` + `tar` (both
// shipped on Windows 10+ and macOS) for download/extract so no bash is required.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TARGET_PY = path.join(PROJECT_ROOT, "resources", "python");
const TARGET_LL = path.join(PROJECT_ROOT, "resources", "litellm");

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const PB_TAG = pkg.platformBundles.pythonBuildStandaloneTag;
const PY_VER = pkg.platformBundles.pythonVersion;
const PINNED_VERSION = pkg.platformBundles.litellmVersion;

const IS_WIN = process.platform === "win32";
// python-build-standalone install_only asset per platform + arch.
const PB_ASSET = IS_WIN
  ? `cpython-${PY_VER}+${PB_TAG}-x86_64-pc-windows-msvc-shared-install_only.tar.gz`
  : `cpython-${PY_VER}+${PB_TAG}-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin-install_only.tar.gz`;
// python + venv executable layout per platform (mirror supervisor/descriptors.js).
const PYTHON_BIN_PARTS = IS_WIN ? ["python.exe"] : ["bin", "python3"];
const VENV_BIN_DIR = IS_WIN ? "Scripts" : "bin";
const PIP_NAME = IS_WIN ? "pip.exe" : "pip";
const LITELLM_NAME = IS_WIN ? "litellm.exe" : "litellm";

// Only mac arm64/x64 (x64 via Rosetta on an arm64 host) and win x64 are supported.
const IS_TARGET =
  (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) ||
  (process.platform === "win32" && process.arch === "x64");
if (!IS_TARGET) {
  console.warn(`⚠️  Skipping Python/LiteLLM build: only mac arm64/x64 / win x64 supported. Got ${process.platform}/${process.arch}`);
  process.exit(0);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// Find the Prisma query-engine binary produced by `prisma generate` (lands under
// <cache>/node_modules/prisma/engines/<hash>/query-engine-<platform>-<arch>[.exe]).
function findPrismaEngine(cacheDir) {
  if (!fs.existsSync(cacheDir)) return null;
  let result = null;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.startsWith("query-engine")) result = p;
    }
  };
  walk(cacheDir);
  return result;
}

// Install Prisma + generate the LiteLLM client + place the query-engine at a
// stable path. Idempotent: safe to call whether the venv was just built OR
// restored from a cache that predates the Prisma engine. verify-bundle.js
// requires resources/litellm/venv/prisma-engine/query-engine, so this MUST run
// even when the venv itself is skipped.
function ensurePrismaEngine(venvDir) {
  const enginePath = path.join(venvDir, "prisma-engine", "query-engine");
  if (fs.existsSync(enginePath)) {
    console.log("✅ Prisma engine already present - skipping");
    return;
  }
  const pipBin = path.join(venvDir, VENV_BIN_DIR, PIP_NAME);
  const prismaBin = path.join(venvDir, VENV_BIN_DIR, IS_WIN ? "prisma.exe" : "prisma");
  const prismaCacheDir = path.join(venvDir, "prisma-cache");
  const PY_DIR = "python" + PY_VER.split(".").slice(0, 2).join(".");
  // Windows venvs lay out site-packages as Lib/site-packages (no pythonX.Y
  // subdir); UNIX venvs use lib/pythonX.Y/site-packages. Both must resolve or
  // prisma generate cannot find litellm's schema.prisma.
  const sitePackages = IS_WIN
    ? path.join(venvDir, "Lib", "site-packages")
    : path.join(venvDir, "lib", PY_DIR, "site-packages");
  const prismaSchema = path.join(sitePackages, "litellm", "proxy", "schema.prisma");
  if (!fs.existsSync(prismaSchema)) {
    throw new Error(`LiteLLM Prisma schema not found at ${prismaSchema} - venv may be incomplete`);
  }
  // litellm[proxy] does not pull `prisma`; litellm shells out to `prisma` + `node`
  // at startup (`prisma db push`), so the engine + generated client must live in
  // the venv and PATH + PRISMA_QUERY_ENGINE_BINARY must be set at runtime (see
  // supervisor/descriptors.js). PRISMA_BINARY_CACHE_DIR points inside the venv so
  // the engine is bundled (the default ~/.cache is NOT bundled).
  console.log(`Installing prisma + generating the LiteLLM Prisma client...`);
  run(pipBin, ["install", "--no-cache-dir", "prisma==0.11.0"]);
  run(prismaBin, ["generate", `--schema=${prismaSchema}`], {
    env: {
      ...process.env,
      PRISMA_BINARY_CACHE_DIR: prismaCacheDir,
      PRISMA_USE_GLOBAL_NODE: "true",
      // prisma-client-py (the generator) lives in the venv bin; the node CLI
      // invokes it via PATH, so the venv bin must be on PATH for `generate`.
      PATH: [path.dirname(prismaBin), process.env.PATH].filter(Boolean).join(IS_WIN ? ";" : ":"),
    },
  });
  // Copy the platform query-engine to a stable path - the generated client bakes
  // build-time absolute paths, so a stable runtime path is required (the supervisor
  // sets PRISMA_QUERY_ENGINE_BINARY to this path).
  const engineSrc = findPrismaEngine(prismaCacheDir);
  if (!engineSrc) throw new Error("prisma generate did not produce a query-engine binary under " + prismaCacheDir);
  const engineDir = path.join(venvDir, "prisma-engine");
  fs.mkdirSync(engineDir, { recursive: true });
  fs.copyFileSync(engineSrc, path.join(engineDir, "query-engine"));
  console.log(`✅ Prisma engine -> ${path.join(engineDir, "query-engine")}`);
}

// Skip the heavy python/venv/litellm install if already built, but STILL ensure
// the Prisma engine exists - older caches predate it and verify-bundle.js
// requires it.
const pythonBin = path.join(TARGET_PY, ...PYTHON_BIN_PARTS);
const litellmBin = path.join(TARGET_LL, "venv", VENV_BIN_DIR, LITELLM_NAME);
const venvDir = path.join(TARGET_LL, "venv");
if (fs.existsSync(pythonBin) && fs.existsSync(litellmBin)) {
  console.log("✅ Python + LiteLLM venv already built");
  ensurePrismaEngine(venvDir);
  console.log(`✅ Done: Python -> ${TARGET_PY}, LiteLLM -> ${TARGET_LL}`);
  process.exit(0);
}

// Proxy for curl (thread explicitly - inherited env can drop it).
const PROXY = process.env.http_proxy || process.env.HTTP_PROXY || "";
const curlProxy = PROXY ? ["--proxy", PROXY] : [];

fs.mkdirSync(TARGET_PY, { recursive: true });
console.log(`🔨 Building Python ${PB_TAG} (cpython ${PY_VER}) + LiteLLM ${PINNED_VERSION} (${process.platform}/${process.arch})`);

// 1. Download python-build-standalone (install_only variant - extracts directly
//    to bin/lib/include or python.exe/Lib/..., no cpython-* wrapper dir).
const URL = `https://github.com/indygreg/python-build-standalone/releases/download/${PB_TAG}/${PB_ASSET}`;
const archive = path.join(TARGET_PY, "python.tar.gz");
console.log(`Downloading: ${URL}`);
run("curl", ["-fL", ...curlProxy, URL, "-o", archive]);

// 2. Verify the download is real (>1MB) before extracting (catches a 404 page).
const size = fs.statSync(archive).size;
if (size < 1_000_000) {
  console.error(`❌ Downloaded archive is only ${size} bytes - expected >1MB. Aborting (likely a 404 error page).`);
  console.error(fs.readFileSync(archive, "utf8").slice(0, 500));
  fs.rmSync(archive, { force: true });
  process.exit(1);
}

console.log("Extracting Python...");
run("tar", ["-xzf", archive], { cwd: TARGET_PY });
// install_only extracts to a `python/` subdir; move its contents up one level.
const inner = path.join(TARGET_PY, "python");
if (fs.existsSync(path.join(inner, "bin")) || fs.existsSync(path.join(inner, "python.exe"))) {
  for (const entry of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, entry), path.join(TARGET_PY, entry));
  }
  fs.rmdirSync(inner);
}
fs.rmSync(archive, { force: true });

// 3. Create venv + install LiteLLM. (Strip stdlib AFTER - ensurepip is needed
//    to bootstrap pip in the venv.)
console.log("Creating venv...");
fs.mkdirSync(TARGET_LL, { recursive: true });
run(pythonBin, ["-m", "venv", venvDir]);
const pipBin = path.join(venvDir, VENV_BIN_DIR, PIP_NAME);
console.log(`Installing litellm[proxy]==${PINNED_VERSION}...`);
run(pipBin, ["install", "--no-cache-dir", `litellm[proxy]==${PINNED_VERSION}`]);

// 3.5. Install Prisma + generate the litellm client (needed for the admin UI's DB).
ensurePrismaEngine(venvDir);

// 4. Strip unused stdlib (pyc/__pycache__ cleanup is left to electron-builder
//    extraResources filters, which exclude them at packaging time).
console.log("Stripping unused standard library...");
const libPython = path.join(TARGET_PY, "lib", "python");
if (fs.existsSync(libPython)) {
  for (const ver of fs.readdirSync(libPython)) {
    for (const sub of ["test", "ensurepip", "idlelib", "turtledemo"]) {
      fs.rmSync(path.join(libPython, ver, sub), { recursive: true, force: true });
    }
    fs.rmSync(path.join(libPython, ver, "tkinter", "test"), { recursive: true, force: true });
  }
}

// 5. Copy the default config template (if not already in place).
const defaultCfg = path.join(TARGET_LL, "default-config.yaml");
if (!fs.existsSync(defaultCfg)) {
  fs.copyFileSync(path.join(PROJECT_ROOT, "resources", "litellm", "default-config.yaml"), defaultCfg);
}

console.log(`✅ Done: Python -> ${TARGET_PY}, LiteLLM -> ${TARGET_LL}`);
