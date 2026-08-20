// ── Headless local-services launcher (dev `npm start`) ───────────────────────
//
// Brings up the bundled LiteLLM + OpenConnector locally - and server.js - for
// non-Electron runs, reusing the SAME shared supervisor primitives
// (supervisor/lifecycle.js) as the desktop Electron app. One lifecycle
// implementation, two entry points.
//
// Per-service URL resolution: a localhost *_BASE_URL (or empty) spawns the
// bundled service locally on that port (empty -> a free port); a non-localhost
// URL uses that remote server as-is. So .env sets e.g.
// LITELLM_BASE_URL=http://localhost:4000 to run the project's internal LiteLLM
// on port 4000 - the URL you see in .env is the URL server.js gets.
//
// server.js is pinned to PORT (default 3000) so the Vite dev proxy
// (:5173 -> :3000) and the WS client (ws://localhost:3000) keep working.
// LiteLLM and OpenConnector run on the ports parsed from their .env URLs (or
// free ports), injected into server.js's env so its modules need no code change.

import dotenv from "dotenv";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Supervisor } from "./supervisor/lifecycle.js";
import { hasBundledLiteLLM, hasBundledOpenConnector } from "./supervisor/descriptors.js";
import { resolveBundleSafe } from "./bundle-manifest.js";
import { findFreePort } from "./supervisor/ports.js";
import { runFirstRun } from "./bootstrap/first-run.js";

// Load .env with override so PROJECT config wins over inherited shell env - e.g.
// a globally-exported LITELLM_BASE_URL from .zshrc must not force external mode
// when .env has cleared it for local mode. (server.js stays no-override: the
// supervisor injects the resolved localhost URLs into its child env directly.)
dotenv.config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname;

// Keys forwarded from .env into the agent env. Mirrors SETTING_KEYS in
// electron/config/settings.js - the supervisor's descriptors read these to
// decide bundled-vs-external and to wire the litellm/OC child env. Keep in sync.
const SETTING_KEYS = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_UPSTREAM_BASE_URL",
  "LLM_UPSTREAM_KEY_1",
  "LLM_UPSTREAM_KEY_2",
  "VOLCES_PLAN_BASE_URL",
  "VOLCES_PLAN_KEY_1",
  "VOLCES_PLAN_KEY_2",
  "LITELLM_BASE_URL",
  "LITELLM_API_KEY",
  "LITELLM_MASTER_KEY",
  "LITELLM_SALT_KEY",
  "DATABASE_URL",
  "OPENCONNECTOR_BASE_URL",
  "OPENCONNECTOR_RUNTIME_TOKEN",
  "OPENCONNECTOR_ADMIN_TOKEN",
  "DEFAULT_MODEL",
  "DOCUMENTS_MODEL",
];

const DEV_SETTINGS_FILE = "dev-settings.json";

// Classify a service base URL: empty or localhost -> spawn the bundled service
// locally (on the parsed port, or a free port if none); anything else -> use
// that remote URL as-is (external). Returns { mode: "local"|"external", port }.
function parseServiceUrl(raw) {
  const url = (raw || "").trim();
  if (!url) return { mode: "local", port: null };
  try {
    const u = new URL(url);
    const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
    if (isLocal) return { mode: "local", port: u.port ? Number(u.port) : null };
    return { mode: "external", port: null };
  } catch {
    return { mode: "external", port: null };
  }
}

// Is a TCP port free on localhost? (bind + immediately release.)
function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

// Use `preferred` if it is free, otherwise grab a free port. The .env URL port
// is a HINT - if it collides with another service on the user's machine, we fall
// back so the bundled service still starts. The supervisor injects the ACTUAL
// URL into server.js, so server.js finds the service regardless.
async function resolvePort(preferred, label) {
  if (preferred && (await isPortFree(preferred))) return preferred;
  if (preferred) console.warn(`[local-services] ${label}: port ${preferred} in use; using a free port instead`);
  return findFreePort("127.0.0.1");
}

export async function main() {
  const env = process.env;
  const dataDir = env.PLATFORM_DATA_DIR || PROJECT_ROOT;
  const resourcesDir = path.join(PROJECT_ROOT, "resources");
  const nodeBin = env.PLATFORM_NODE_BIN || process.execPath;

  // Resolve each service URL: a localhost URL (or empty) means "spawn the
  // bundled service locally" on the parsed port (or a free port if empty); a
  // non-localhost URL means "use that remote server as-is". So .env can
  // explicitly say LITELLM_BASE_URL=http://localhost:4000 to run the project's
  // internal LiteLLM on port 4000 - and that's the URL server.js sees.
  const ll = parseServiceUrl(env.LITELLM_BASE_URL);
  const oc = parseServiceUrl(env.OPENCONNECTOR_BASE_URL);

  // First-run seeding: copy default litellm.yaml and generate the credentials
  // the bundled processes need (LITELLM_API_KEY master key, OC runtime/admin
  // tokens) when absent. Idempotent + atomic. Persisted to dev-settings.json
  // under the data dir (NOT the user's .env). Only fires for bundled services.
  const seeded = runFirstRun({
    userDataDir: dataDir,
    resourcesDir,
    defaultSettings: {},
    settingsFileName: DEV_SETTINGS_FILE,
  });

  // Assemble agentEnv: forward .env keys, but for LOCALLY-spawned services skip
  // the *_BASE_URL (the supervisor injects the resolved localhost URL into
  // server.js's env) and use the seeded (generated) credentials. For external
  // services, forward the .env URL + credentials so the remote proxy is reached
  // with the user's own key/token (the seeder's generated local creds are ignored).
  const agentEnv = {};
  for (const k of SETTING_KEYS) {
    if (k === "LITELLM_BASE_URL" && ll.mode === "local") continue;
    if (k === "OPENCONNECTOR_BASE_URL" && oc.mode === "local") continue;
    if (env[k] != null && env[k] !== "") agentEnv[k] = String(env[k]);
  }
  if (ll.mode === "local" && seeded.LITELLM_API_KEY) {
    agentEnv.LITELLM_API_KEY = seeded.LITELLM_API_KEY;
  }
  // Inject generated LiteLLM secrets for the admin UI and DB encryption
  if (ll.mode === "local") {
    if (seeded.LITELLM_MASTER_KEY) agentEnv.LITELLM_MASTER_KEY = seeded.LITELLM_MASTER_KEY;
    if (seeded.LITELLM_SALT_KEY) agentEnv.LITELLM_SALT_KEY = seeded.LITELLM_SALT_KEY;
  }
  if (oc.mode === "local") {
    if (seeded.OPENCONNECTOR_RUNTIME_TOKEN) agentEnv.OPENCONNECTOR_RUNTIME_TOKEN = seeded.OPENCONNECTOR_RUNTIME_TOKEN;
    if (seeded.OPENCONNECTOR_ADMIN_TOKEN) agentEnv.OPENCONNECTOR_ADMIN_TOKEN = seeded.OPENCONNECTOR_ADMIN_TOKEN;
  }

  // Resolve ports. server.js pins to PORT (default 3000) - the Vite dev proxy
  // (:5173 -> :3000) and the WS client (ws://localhost:3000) expect it, so a
  // conflict here is a hard error with a clear message. LiteLLM/OpenConnector
  // PREFER the port parsed from their .env URL but fall back to a free port if
  // it's in use, so common ports (4000/3001) on the user's machine don't block
  // startup. server.js gets the actual URL injected either way.
  const serverPort = Number(env.PORT) || 3000;
  if (!(await isPortFree(serverPort))) {
    console.error(
      `[local-services] ✖ Port ${serverPort} is already in use. server.js needs it ` +
        `(the Vite dev proxy + WS client expect :3000). Free it, or set PORT=<free> ` +
        `(and update the proxy target in web/vite.config.ts).`
    );
    process.exit(1);
  }
  const litellmPort = await resolvePort(ll.port, "LiteLLM");
  const ocPort = await resolvePort(oc.port, "OpenConnector");

  const supervisor = new Supervisor({
    nodeBin,
    projectRoot: PROJECT_ROOT,
    dataDir,
    agentEnv,
    serverPort,
    litellmPort,
    ocPort,
  });

  // Ordered shutdown on interrupt - the supervisor sets `shuttingDown` so its
  // restart-on-crash logic does not fire during shutdown.
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n[local-services] ${sig} received, shutting down...\n`);
    try {
      await supervisor.stop();
    } catch (e) {
      console.error("[local-services] supervisor stop error:", e);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // start() spawns server-js (non-optional; throws if unhealthy) and the
  // optional litellm/openconnector (non-blocking: a failure marks them
  // unhealthy without aborting). So a successful return means server.js is up.
  let serverUp = false;
  try {
    await supervisor.start();
    serverUp = true;
  } catch (err) {
    console.warn("[local-services] startup error:", err.message);
  }

  const st = supervisor.status();
  const serverJs = st.find((s) => s.id === "server-js");
  if (!serverJs || serverJs.state !== "healthy") {
    console.error("[local-services] server.js is not healthy; exiting.");
    // Surface the child's recent logs so the cause is visible (e.g. EADDRINUSE,
    // a crash, a missing dependency) instead of a bare "did not become healthy".
    for (const s of st) {
      const lines = (s.logs || []).slice(-12).map((l) => l.line);
      if (lines.length) console.error(`[local-services] ${s.id} logs:\n  ` + lines.join("\n  "));
    }
    try { await supervisor.stop(); } catch { /* swallow */ }
    process.exit(1);
  }

  // One-line per-service summary: local / external / absent / excluded.
  // "excluded (manifest)" = the bundle manifest (or PLATFORM_BUNDLE_COMPONENTS
  // override) deselected this component; the descriptor fell through to the
  // http-external branch (D4). "absent" = selected but resources/ not built.
  const bundleSel = resolveBundleSafe({ projectRoot: PROJECT_ROOT }).components;
  console.log(`\n[local-services] Platform ready: http://localhost:${supervisor.serverPort}`);
  for (const s of st) {
    if (s.id === "server-js") continue;
    let mode;
    if (s.state === "disabled" && s.kind === "http-external") {
      mode = bundleSel[s.id] === false ? "excluded (manifest)" : "absent";
    } else if (s.kind === "http-external") {
      mode = "external";
    } else {
      mode = "local";
    }
    const url = s.url ? ` ${s.url}` : "";
    console.log(`[local-services]   ${s.id}: ${mode} (${s.state})${url}`);
  }
  // If the user asked for local services (localhost URL) but the bundled
  // resources aren't built, tell them how to get them. Only mention components
  // the manifest actually selects — deselected components are intentionally
  // absent (the summary already said "excluded (manifest)").
  const missing = [];
  if (bundleSel.litellm && ll.mode === "local" && !hasBundledLiteLLM(PROJECT_ROOT)) missing.push("LiteLLM");
  if (bundleSel.openconnector && oc.mode === "local" && !hasBundledOpenConnector(PROJECT_ROOT)) missing.push("OpenConnector");
  if (missing.length) {
    console.warn(
      `[local-services] ⚠️  Bundled ${missing.join(" + ")} resources not found. ` +
        `Run \`npm run predist\` (or \`npm install\` without PLATFORM_SKIP_BUNDLE) to build them.`
    );
  }
  console.log("\n[local-services] Press Ctrl+C to stop.\n");
}
