import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT, baseURL, prepareTempStoreDirs } from "./e2e/helpers.js";

// Live service testing: target the deployed k3s NodePort. The live project has
// NO webServer - it connects to an already-running external URL. Read-only checks
// (no chat history writes, no document uploads, no LLM tokens spent) except the
// opt-in @live-smoke chat-turn gated behind LIVE_SMOKE=1.
//
// Playwright's root-level `webServer` applies to ALL projects, so the live
// scripts set PW_LIVE=1 to skip both the local-server launch and the temp-store
// dir setup (the live suite touches neither).
const PW_LIVE = process.env.PW_LIVE === "1";
const LIVE_SERVICE_URL = process.env.LIVE_SERVICE_URL || "http://23.144.68.246:30950";

// Create throwaway store directories before the server boots so the suite never
// touches the project's real chat-history-store/ or documents-store/. Skipped for
// the live project (no local server, no temp dirs).
const storeDirs = PW_LIVE ? null : prepareTempStoreDirs();

export default defineConfig({
  testDir: "./e2e",
  // The server hosts ONE shared agent session, so tests must run sequentially.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  // The live suite doesn't create temp dirs, so skip the cleanup teardown for it.
  ...(PW_LIVE ? {} : { globalTeardown: "./e2e/teardown.js" }),
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  // fast: deterministic, no-LLM tests (default). smoke: the real chat-turn test
  // that makes one LLM call. `npm run test:e2e` runs fast; `test:e2e:smoke`
  // runs both. live: read-only tests against the deployed k3s NodePort (no
  // webServer, no temp store dirs).
  projects: [
    {
      name: "fast",
      use: { ...devices["Desktop Chrome"] },
      // Exclude @smoke (real LLM call) AND @live (deployed-service tests that
      // belong only to the `live` project - they would otherwise run against
      // the local 127.0.0.1 server and assert the wrong things).
      grepInvert: /@smoke|@live/,
    },
    {
      name: "smoke",
      use: { ...devices["Desktop Chrome"] },
      grep: /@smoke/,
    },
    // Live project - targets deployed k3s NodePort at http://23.144.68.246:30950
    // (overridable via LIVE_SERVICE_URL env). Runs only `@live` tagged tests,
    // NEVER spawns a local server (PW_LIVE=1 skips the root webServer), NEVER
    // creates temp store dirs. `--proxy-server=direct://` forces direct
    // connections because the dev machine has a macOS system HTTP proxy
    // (127.0.0.1:7892) that 502s the deployed LAN IP and breaks the WebSocket
    // upgrade; the local fast/smoke projects are unaffected (they hit 127.0.0.1,
    // which is in the system proxy bypass list).
    {
      name: "live",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: LIVE_SERVICE_URL,
        launchOptions: { args: ["--proxy-server=direct://"] },
      },
      grep: /@live/,
    },
  ],
  // The local-server webServer is only defined for the non-live projects.
  ...(PW_LIVE
    ? {}
    : {
        webServer: {
          command: "node server.js",
          port: E2E_PORT,
          // server.js listens only after dsh init completes; a cold first
          // spawn (fresh profile composition, e.g. on a CI runner) can
          // exceed 60s.
          timeout: 180_000,
          reuseExistingServer: false,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            PORT: String(E2E_PORT),
            HOST: "127.0.0.1",
            // The e2e suite runs `node server.js` directly (no launcher, no bundled
            // OC). Disable OpenConnector so server.js doesn't spend ~30s retrying its
            // MCP connection. OC views are tested via stubConfig, not a real runtime.
            OPENCONNECTOR_BASE_URL: "",
            CHAT_HISTORY_STORE_DIR: storeDirs.chat,
            DOCUMENTS_STORE_DIR: storeDirs.docs,
            SESSIONS_STORE_DIR: storeDirs.sessions,
            DB_PATH: storeDirs.db,
            LLM_PROVIDERS_STORE: storeDirs.llmProviders,
            LLM_DEFAULT_STORE: storeDirs.llmDefault,
          },
        },
      }),
});
