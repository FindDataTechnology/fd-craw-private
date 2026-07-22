#!/usr/bin/env node
// Root postinstall — build the React frontend so `npm start` works out of the box.
//
// Skips when:
//   - PLATFORM_SKIP_WEB_BUILD=1 is set (CI, contributors iterating on web/ manually)
//   - web/dist/index.html already exists (repeat installs don't rebuild)
//   - web/package.json is missing (safety, though this shouldn't happen)
//
// Spec: openspec/changes/redesign-chat-ui-react-shadcn/specs/chat-ui-shell/spec.md
//       § "A single build step produces the frontend"
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "web");
const dist = path.join(webDir, "dist", "index.html");

if (process.env.PLATFORM_SKIP_WEB_BUILD === "1") {
  console.log("[postinstall] PLATFORM_SKIP_WEB_BUILD=1, skipping web build");
  process.exit(0);
}
if (!existsSync(path.join(webDir, "package.json"))) {
  console.log("[postinstall] web/package.json not found, skipping");
  process.exit(0);
}
if (existsSync(dist)) {
  console.log("[postinstall] web/dist/index.html exists, skipping build");
  process.exit(0);
}

console.log("[postinstall] installing web/ deps...");
let r = spawnSync("npm", ["install"], { cwd: webDir, stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

console.log("[postinstall] building web/...");
r = spawnSync("npm", ["run", "build"], { cwd: webDir, stdio: "inherit" });
process.exit(r.status ?? 0);
