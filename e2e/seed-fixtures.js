// Playwright webServer: make the fast suite hermetic without touching the
// developer's personal data. The server reads MCP_CONFIG_PATH when it is set;
// Playwright points it at the temporary store, so an existing repo mcp.json is
// never rewritten. agents.json is still seeded at the repo root only when absent.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs as part of the Playwright webServer command (before `node server.js`
// boots): Playwright starts the webServer BEFORE globalSetup, so fixtures
// seeded there would land after the server already read the repo root.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function seedFixtures() {
  const agentsPath = path.join(root, "agents.json");
  if (!existsSync(agentsPath)) {
    writeFileSync(
      agentsPath,
      JSON.stringify(
        {
          apps: [
            {
              id: "e2e-demo-app",
              type: "app",
              kind: "link",
              name: "E2E Demo App",
              url: "https://example.com/e2e-demo",
              description: "Fixture app seeded by e2e global-setup on machines without agents.json",
            },
          ],
          agents: [],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log("[e2e global-setup] seeded fixture agents.json (was absent)");
  }

  const mcpPath = process.env.MCP_CONFIG_PATH
    ? path.resolve(process.env.MCP_CONFIG_PATH)
    : path.join(root, "mcp.json");
  if (!existsSync(mcpPath)) {
    mkdirSync(path.dirname(mcpPath), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            "memory": {
              command: "node",
              args: ["-e", "process.exit(0)"],
            },
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(`[e2e seed-fixtures] seeded fixture MCP config at ${mcpPath} (was absent)`);
  }
}

seedFixtures();
