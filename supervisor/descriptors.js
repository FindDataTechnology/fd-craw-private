// ── Server descriptor registry ──────────────────────────────────────────────
//
// Declares the four backend servers the supervisor manages (spec: "Server
// descriptor registry"). Each descriptor is a transport-agnostic record:
//   - kind:        "node" | "python" | "http-external"
//   - transport:   "http-port" | "stdio-rpc" | "none"
//   - enabled:     whether the supervisor starts/probes it
//   - optional:    if false, failure blocks app launch (per graceful-degradation spec)
//   - start:       { cmd, args, cwd, env } for spawned kinds
//   - url/healthPath: for HTTP health probes
//   - dependsOn:   ids that must be healthy first (startup ordering)
//
// When bundled resources exist and no external URL is set in settings, we
// spawn the service directly; otherwise health-check the external URL.

import fs from "node:fs";
import path from "node:path";
import { resolveBundleSafe } from "../bundle-manifest.js";

// Manifest selection (platform.bundle.json): a deselected component is treated
// as NOT bundled even if its resources/ dir exists — the descriptor falls
// through to the http-external branch (D4). Cached per projectRoot; the
// manifest is fixed for the process lifetime. bundle-manifest.js is pure
// fs/path (no native addons), safe to load in the Electron main process.
const bundleCache = new Map();
function manifestSelects(projectRoot, component) {
  if (!bundleCache.has(projectRoot)) {
    bundleCache.set(projectRoot, resolveBundleSafe({ projectRoot }).components);
  }
  return bundleCache.get(projectRoot)[component] === true;
}

// Cross-platform binary paths. python-build-standalone and Python venvs lay out
// their executables differently on Windows vs Unix:
//   python: mac/linux -> python/bin/python3 ; win -> python/python.exe
//   venv:   unix -> venv/bin/litellm        ; win -> venv/Scripts/litellm.exe
const IS_WIN = process.platform === "win32";
const PYTHON_BIN_PARTS = IS_WIN ? ["python.exe"] : ["bin", "python3"];
const LITELLM_BIN_PARTS = IS_WIN ? ["venv", "Scripts", "litellm.exe"] : ["venv", "bin", "litellm"];
// Venv bin dir name per platform (for PATH construction in the litellm env).
const VENV_BIN_DIR = IS_WIN ? "Scripts" : "bin";
// The venv python interpreter. On mac the `litellm` wrapper script's shebang is
// an absolute path baked at venv-creation time (the CI runner's path) which
// breaks when the app is installed elsewhere - so litellm is invoked via the
// venv python directly (bypassShebang in the litellm descriptor) instead of
// exec'ing the wrapper script and trusting its shebang.
const VENV_PYTHON_PARTS = IS_WIN ? ["venv", "Scripts", "python.exe"] : ["venv", "bin", "python"];
const pythonBinPath = (root) => path.join(root, "python", ...PYTHON_BIN_PARTS);
const litellmBinPath = (llmRoot) => path.join(llmRoot, ...LITELLM_BIN_PARTS);
const litellmPythonPath = (llmRoot) => path.join(llmRoot, ...VENV_PYTHON_PARTS);

// Check if bundled resources exist (relative to projectRoot in dev, process.resourcesPath when packaged)
function getResourceRoot(projectRoot) {
  // Packaged: resources/ under app.getPath("resources") which is process.resourcesPath
  return typeof process !== "undefined" && process.resourcesPath
    ? process.resourcesPath
    : path.join(projectRoot, "resources");
}

export function hasBundledOpenConnector(projectRoot) {
  if (!manifestSelects(projectRoot, "openconnector")) return false;
  const root = getResourceRoot(projectRoot);
  // dev-mode override from env
  if (process.env.PLATFORM_OC_BUNDLED_ROOT) {
    return fs.existsSync(path.join(process.env.PLATFORM_OC_BUNDLED_ROOT, "src", "server", "index.ts"));
  }
  return fs.existsSync(path.join(root, "openconnector", "src", "server", "index.ts"));
}

export function hasBundledLiteLLM(projectRoot) {
  if (!manifestSelects(projectRoot, "litellm")) return false;
  const root = getResourceRoot(projectRoot);
  // dev-mode override from env
  if (process.env.PLATFORM_LITELLM_BUNDLED_ROOT) {
    return fs.existsSync(litellmBinPath(process.env.PLATFORM_LITELLM_BUNDLED_ROOT)) &&
           fs.existsSync(pythonBinPath(root));
  }
  return fs.existsSync(litellmBinPath(path.join(root, "litellm"))) &&
         fs.existsSync(pythonBinPath(root));
}

export function hasBundledPostgres(projectRoot) {
  if (!manifestSelects(projectRoot, "postgres")) return false;
  const root = getResourceRoot(projectRoot);
  if (process.env.PLATFORM_POSTGRES_BUNDLED_ROOT) {
    return fs.existsSync(path.join(process.env.PLATFORM_POSTGRES_BUNDLED_ROOT, "bin", IS_WIN ? "postgres.exe" : "postgres"));
  }
  return fs.existsSync(path.join(root, "postgres", "bin", IS_WIN ? "postgres.exe" : "postgres"));
}

export function getDescriptors({
  serverPort,
  ocPort,
  litellmPort,
  pgPort,
  projectRoot,
  nodeBin,
  dataDir,
  agentEnv = {},
}) {
  const childEnv = {
    PORT: String(serverPort),
    HOST: "localhost",
    ...(dataDir ? { PLATFORM_DATA_DIR: dataDir } : {}),
    ...agentEnv,
  };
  const litellmExternalUrl = (agentEnv.LITELLM_BASE_URL || "").trim().replace(/\/+$/, "");
  const openconnectorExternalUrl = (agentEnv.OPENCONNECTOR_BASE_URL || "").trim().replace(/\/+$/, "");
  const postgresExternalDbUrl = (agentEnv.DATABASE_URL || "").trim();

  const resourceRoot = getResourceRoot(projectRoot);
  const bundledOpenConnector = hasBundledOpenConnector(projectRoot) && !openconnectorExternalUrl;
  const bundledLiteLLM = hasBundledLiteLLM(projectRoot) && !litellmExternalUrl;
  const bundledPostgres = hasBundledPostgres(projectRoot) && !postgresExternalDbUrl;

  // Resolve postgres descriptor (before LiteLLM so LiteLLM can depend on it).
  let postgresDescriptor;
  if (bundledPostgres) {
    const pgRoot = process.env.PLATFORM_POSTGRES_BUNDLED_ROOT || path.join(resourceRoot, "postgres");
    const pgDataDir = path.join(dataDir || projectRoot, "postgres-data");
    postgresDescriptor = {
      id: "postgres",
      name: "Postgres database",
      kind: "node",
      transport: "http-port",
      enabled: true,
      optional: true,
      // pg-serve.js owns initdb + pg_ctl start/stop + createdb + keep-alive.
      start: {
        cmd: nodeBin,
        args: [path.join(projectRoot, "scripts", "pg-serve.js"), path.join(pgRoot, "bin"), pgDataDir, String(pgPort)],
        cwd: projectRoot,
        env: {},
      },
      url: `http://localhost:${pgPort}`,
      healthPath: "",
      healthKind: "tcp",
      dependsOn: [],
    };
  } else {
    postgresDescriptor = {
      id: "postgres",
      name: "Postgres database",
      kind: "http-external",
      transport: "none",
      enabled: !!postgresExternalDbUrl,
      optional: true,
      start: null,
      url: postgresExternalDbUrl || null,
      healthPath: "",
      dependsOn: [],
    };
  }

  // Resolve openconnector descriptor
  let openconnectorDescriptor;
  if (bundledOpenConnector) {
    const ocDir = process.env.PLATFORM_OC_BUNDLED_ROOT || path.join(resourceRoot, "openconnector");
    const ocCwd = process.env.PLATFORM_OC_BUNDLED_ROOT ? process.env.PLATFORM_OC_BUNDLED_ROOT : path.join(resourceRoot, "openconnector");
    // OC has no emitted dist - it runs from src/server/index.ts via tsx
    // (Node 25's type-stripping can't load .ts from node_modules, so tsx compiles it).
    const tsxPath = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    openconnectorDescriptor = {
      id: "openconnector",
      name: "OpenConnector runtime",
      kind: "node",
      transport: "http-port",
      enabled: true,
      optional: true,
      start: {
        cmd: nodeBin,
        args: [tsxPath, "src/server/index.ts"],
        cwd: ocCwd,
        env: {
          PORT: String(ocPort),
          DATABASE_URL: `sqlite://${path.join(dataDir || projectRoot, "openconnector.db").replace(/\\/g, "/")}`,
          RUNTIME_TOKEN: agentEnv.OPENCONNECTOR_RUNTIME_TOKEN || "",
          ADMIN_TOKEN: agentEnv.OPENCONNECTOR_ADMIN_TOKEN || "",
          NODE_ENV: "production",
        },
      },
      url: `http://localhost:${ocPort}`,
      healthPath: "/v1/health",
      dependsOn: [],
    };
  } else {
    openconnectorDescriptor = {
      id: "openconnector",
      name: "OpenConnector runtime",
      kind: "http-external",
      transport: "none",
      enabled: !!openconnectorExternalUrl,
      optional: true,
      start: null,
      url: openconnectorExternalUrl || null,
      healthPath: "/",
      dependsOn: [],
    };
  }

  // Resolve litellm descriptor
  let litellmDescriptor;
  if (bundledLiteLLM) {
    const llmRoot = process.env.PLATFORM_LITELLM_BUNDLED_ROOT || path.join(resourceRoot, "litellm");
    const litellmBin = litellmBinPath(llmRoot);
    // On mac, invoke litellm via the venv python directly: the `litellm` wrapper
    // script's shebang is an absolute path baked at venv-creation time (the CI
    // runner's path) which breaks when the app is installed elsewhere. Windows
    // uses litellm.exe (a real launcher, no shebang) so it runs directly.
    const bypassShebang = process.platform !== "win32";
    const litellmPython = litellmPythonPath(llmRoot);
    const venvBinDir = path.join(llmRoot, "venv", VENV_BIN_DIR);
    const nodeDir = path.dirname(nodeBin);
    const pathSep = IS_WIN ? ";" : ":";
    litellmDescriptor = {
      id: "litellm",
      name: "LiteLLM gateway",
      kind: "python",
      transport: "http-port",
      enabled: true,
      optional: true,
      start: {
        cmd: bypassShebang ? litellmPython : litellmBin,
        args: [...(bypassShebang ? [litellmBin] : []), "--port", String(litellmPort), "--config", path.join(dataDir || projectRoot, "litellm.yaml")],
        cwd: llmRoot,
        env: {
          VOLCES_API_KEY: agentEnv.VOLCES_API_KEY || "",
          VOLCES_BASE_URL: agentEnv.VOLCES_BASE_URL || "https://aquasearch.volces.com",
          LITELLM_API_KEY: agentEnv.LITELLM_API_KEY || "",
          // Volces plan/v3 upstream for the Agent-harness alias + plan models (litellm.yaml
          // references these via os.environ/). Two keys for rotation.
          VOLCES_PLAN_BASE_URL:
            agentEnv.VOLCES_PLAN_BASE_URL || "https://ark.cn-beijing.volces.com/api/plan/v3",
          VOLCES_PLAN_KEY_1: agentEnv.VOLCES_PLAN_KEY_1 || "",
          VOLCES_PLAN_KEY_2: agentEnv.VOLCES_PLAN_KEY_2 || "",
          // Postgres DB for the admin UI (Prisma). litellm shells out to `prisma` +
          // `node` at startup (`prisma db push`), so PATH must include the venv bin
          // (where `prisma` lives) + the bundled node bin (where `node` lives), and
          // PRISMA_QUERY_ENGINE_BINARY must point at the bundled engine.
          DATABASE_URL: postgresExternalDbUrl || `postgresql://postgres@localhost:${pgPort}/postgres`,
          LITELLM_MASTER_KEY: agentEnv.LITELLM_MASTER_KEY || agentEnv.LITELLM_API_KEY || "",
          LITELLM_SALT_KEY: agentEnv.LITELLM_SALT_KEY || "",
          STORE_MODEL_IN_DB: "True",
          PRISMA_QUERY_ENGINE_BINARY: path.join(llmRoot, "venv", "prisma-engine", "query-engine"),
          PATH: [venvBinDir, nodeDir, process.env.PATH].filter(Boolean).join(pathSep),
        },
      },
      url: `http://localhost:${litellmPort}`,
      healthPath: "/health/liveliness",
      dependsOn: bundledPostgres ? ["postgres"] : [],
    };
  } else {
    litellmDescriptor = {
      id: "litellm",
      name: "LiteLLM gateway",
      kind: "http-external",
      transport: "none",
      enabled: !!litellmExternalUrl,
      optional: true,
      start: null,
      url: litellmExternalUrl || null,
      healthPath: "/health/liveliness",
      dependsOn: [],
    };
  }

  // Inject resolved OC/LiteLLM URLs into server-js env so server.js discovers them
  if (bundledOpenConnector) {
    childEnv.OPENCONNECTOR_BASE_URL = `http://localhost:${ocPort}`;
  }
  if (bundledLiteLLM) {
    childEnv.LITELLM_BASE_URL = `http://localhost:${litellmPort}`;
  }

  return [
    {
      id: "server-js",
      name: "Platform backend",
      kind: "node",
      transport: "http-port",
      enabled: true,
      optional: false,
      start: {
        cmd: nodeBin,
        args: [path.join(projectRoot, "server.js")],
        cwd: projectRoot,
        env: childEnv,
      },
      url: `http://localhost:${serverPort}`,
      healthPath: "/api/config",
      dependsOn: [], // Phase 2: ["pi-agent"]
    },
    {
      id: "pi-agent",
      name: "pi agent",
      kind: "node",
      transport: "stdio-rpc",
      enabled: false, // Phase 2 flips this on
      optional: false,
      start: null,
      url: null,
      healthPath: null,
      dependsOn: [],
    },
    postgresDescriptor,
    litellmDescriptor,
    openconnectorDescriptor,
  ];
}
