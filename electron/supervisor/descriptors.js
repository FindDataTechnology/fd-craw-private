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

// Check if bundled resources exist (relative to projectRoot in dev, process.resourcesPath when packaged)
function getResourceRoot(projectRoot) {
  // Packaged: resources/ under app.getPath("resources") which is process.resourcesPath
  return typeof process !== "undefined" && process.resourcesPath
    ? process.resourcesPath
    : path.join(projectRoot, "resources");
}

export function hasBundledOpenConnector(projectRoot) {
  const root = getResourceRoot(projectRoot);
  // dev-mode override from env
  if (process.env.PLATFORM_OC_BUNDLED_ROOT) {
    return fs.existsSync(path.join(process.env.PLATFORM_OC_BUNDLED_ROOT, "src", "server", "index.ts"));
  }
  return fs.existsSync(path.join(root, "openconnector", "src", "server", "index.ts"));
}

export function hasBundledLiteLLM(projectRoot) {
  const root = getResourceRoot(projectRoot);
  // dev-mode override from env
  if (process.env.PLATFORM_LITELLM_BUNDLED_ROOT) {
    return fs.existsSync(path.join(process.env.PLATFORM_LITELLM_BUNDLED_ROOT, "venv", "bin", "litellm")) &&
           fs.existsSync(path.join(root, "python", "bin", "python3"));
  }
  return fs.existsSync(path.join(root, "litellm", "venv", "bin", "litellm")) &&
         fs.existsSync(path.join(root, "python", "bin", "python3"));
}

export function getDescriptors({
  serverPort,
  ocPort,
  litellmPort,
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

  const bundledOpenConnector = hasBundledOpenConnector(projectRoot) && !openconnectorExternalUrl;
  const bundledLiteLLM = hasBundledLiteLLM(projectRoot) && !litellmExternalUrl;

  // Resolve openconnector descriptor
  let openconnectorDescriptor;
  const resourceRoot = getResourceRoot(projectRoot);
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
          DATABASE_URL: `sqlite://${path.join(dataDir || projectRoot, "openconnector.db")}`,
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
    const pythonBin = path.join(resourceRoot, "python", "bin", "python3");
    const litellmBin = path.join(llmRoot, "venv", "bin", "litellm");
    litellmDescriptor = {
      id: "litellm",
      name: "LiteLLM gateway",
      kind: "python",
      transport: "http-port",
      enabled: true,
      optional: true,
      start: {
        cmd: litellmBin,
        args: ["--port", String(litellmPort), "--config", path.join(dataDir || projectRoot, "litellm.yaml")],
        cwd: llmRoot,
        env: {
          VOLCES_API_KEY: agentEnv.VOLCES_API_KEY || "",
          VOLCES_BASE_URL: agentEnv.VOLCES_BASE_URL || "https://aquasearch.volces.com",
          LITELLM_API_KEY: agentEnv.LITELLM_API_KEY || "",
        },
      },
      url: `http://localhost:${litellmPort}`,
      healthPath: "/health/liveliness",
      dependsOn: [],
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
    litellmDescriptor,
    openconnectorDescriptor,
  ];
}
