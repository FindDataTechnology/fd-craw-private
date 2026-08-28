// Playwright globalSetup: make the fast suite hermetic on machines without the
// developer's personal data. mcp.json and agents.json are gitignored; several
// specs assert UI that renders from their content (extensions' startup MCP
// servers, the Agents page apps tab). When the files are absent — e.g. a CI
// runner or a fresh clone — seed minimal fixtures at the repo root (the server
// reads both via path.resolve() from its cwd). Existing files are never
// touched, so dev machines keep using their real data.
import { existsSync, writeFileSync } from "node:fs";
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

  const mcpPath = path.join(root, "mcp.json");
  if (!existsSync(mcpPath)) {
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
    console.log("[e2e seed-fixtures] seeded fixture mcp.json (was absent)");
  }
}

seedFixtures();
