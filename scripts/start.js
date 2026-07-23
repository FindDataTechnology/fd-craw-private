#!/usr/bin/env node
// ── Dev entry point (`npm start`) ────────────────────────────────────────────
//
// Brings up local LiteLLM + OpenConnector + server.js via the headless
// supervisor. See ../local-services.js for the orchestration. When bundled
// resources are absent or external URLs are set in .env, it degrades to running
// server.js alone (today's `node server.js` behavior).
import { main } from "../local-services.js";

main().catch((err) => {
  console.error("[local-services] fatal:", err);
  process.exit(1);
});
