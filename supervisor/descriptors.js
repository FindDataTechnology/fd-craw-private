// ── Server descriptor registry ──────────────────────────────────────────────
//
// Declares the two backend servers the supervisor manages (spec: "Server
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
//
// LiteLLM + Postgres removed — dsh-llm manages LLM natively via settings.yaml +
// .credentials.yaml hot-reload, no bundled child processes needed.

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
// LiteLLM/Postgres removed — dsh-llm manages LLM natively via settings.yaml +
// .credentials.yaml hot-reload, no bundled child processes needed.
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

// LiteLLM + Postgres are no longer bundled (dsh-llm manages LLM natively).
// These stubs remain as "always false" guards so any external caller still
// compiles; the descriptors below never produce a bundled litellm/postgres child.
export function hasBundledLiteLLM(_projectRoot) {
  return false;
}

export function hasBundledPostgres(_projectRoot) {
  return false;
}

export function getDescriptors({
  serverPort,
  ocPort,
  projectRoot,
  nodeBin,
  dataDir,
  agentEnv = {},
}) {
  const childEnv = {
    PORT: String(serverPort),
    // Respect HOST from the environment so the backend can bind 0.0.0.0 in a
    // container (k8s probes + docker port-forward reach it). Defaults to
    // localhost for local dev (the Vite dev proxy + WS client expect it).
    HOST: process.env.HOST || "localhost",
    ...(dataDir ? { PLATFORM_DATA_DIR: dataDir } : {}),
    ...agentEnv,
  };
  const openconnectorExternalUrl = (agentEnv.OPENCONNECTOR_BASE_URL || "").trim().replace(/\/+$/, "");

  const resourceRoot = getResourceRoot(projectRoot);
  const bundledOpenConnector = hasBundledOpenConnector(projectRoot) && !openconnectorExternalUrl;

  // Resolve openconnector descriptor
  let openconnectorDescriptor;
  if (bundledOpenConnector) {
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

  // Inject resolved OC URL into server-js env so server.js discovers it
  if (bundledOpenConnector) {
    childEnv.OPENCONNECTOR_BASE_URL = `http://localhost:${ocPort}`;
  }

  // LiteLLM removed — dsh-llm manages LLM natively via settings.yaml +
  // .credentials.yaml hot-reload, no child process needed. No LITELLM_BASE_URL
  // injected since there's no bundled liteLLM to discover.

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
    openconnectorDescriptor,
  ];
}
