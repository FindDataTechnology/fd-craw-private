import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT, baseURL, prepareTempStoreDirs } from "./e2e/helpers.js";

// Create throwaway store directories before the server boots so the suite never
// touches the project's real chat-history-store/ or documents-store/.
const storeDirs = prepareTempStoreDirs();

export default defineConfig({
  testDir: "./e2e",
  // The server hosts ONE shared agent session, so tests must run sequentially.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  globalTeardown: "./e2e/teardown.js",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  // fast: deterministic, no-LLM tests (default). smoke: the real chat-turn test
  // that makes one LLM call. `npm run test:e2e` runs fast; `test:e2e:smoke`
  // runs both.
  projects: [
    {
      name: "fast",
      use: { ...devices["Desktop Chrome"] },
      grepInvert: /@smoke/,
    },
    {
      name: "smoke",
      use: { ...devices["Desktop Chrome"] },
      grep: /@smoke/,
    },
  ],
  webServer: {
    command: "node server.js",
    port: E2E_PORT,
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      HOST: "127.0.0.1",
      CHAT_HISTORY_STORE_DIR: storeDirs.chat,
      DOCUMENTS_STORE_DIR: storeDirs.docs,
      SESSIONS_STORE_DIR: storeDirs.sessions,
      DB_PATH: storeDirs.db,
    },
  },
});
