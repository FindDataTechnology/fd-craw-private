// E2E test helpers: isolated store directories + shared base URL.
//
// The server hosts one shared agent session and resolves its store dirs from
// SESSIONS_STORE_DIR / DOCUMENTS_STORE_DIR (CHAT_HISTORY_STORE_DIR is now only
// the legacy migration source). These helpers create throwaway dirs under
// os.tmpdir() so the suite never touches the user's real sessions-store/ or
// documents-store/.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";

export const E2E_PORT = Number(process.env.E2E_PORT) || 3100;
export const baseURL = `http://127.0.0.1:${E2E_PORT}`;

// Deterministic per-port root so both config load and global teardown can find
// it without passing state between processes. Repo-local on purpose: os.tmpdir()
// is NOT guaranteed to resolve to the same view across the playwright main
// process, workers, and spawned children in every environment — a repo-relative
// path is (cwd is inherited), which matters for specs that open the same
// SQLite file the webServer writes (library MCP child).
function tempStoreRoot() {
  const helperDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(helperDir, "..", `.e2e-store-${E2E_PORT}`);
}

// Create fresh, isolated store directories for a run. Removes any stale
// directory from a previous (possibly crashed) run first. Returns the
// chat/docs/sessions/db paths to pass to the server via env. The db path is a
// throwaway SQLite file (DB_PATH) so the suite never touches the project's real
// data/app.db.
export function prepareTempStoreDirs() {
  const root = tempStoreRoot();
  fs.rmSync(root, { recursive: true, force: true });
  const chat = path.join(root, "chat-history-store");
  const docs = path.join(root, "documents-store");
  const sessions = path.join(root, "sessions-store");
  const db = path.join(root, "app.db");
  const llmProviders = path.join(root, "llm-providers.json");
  const llmDefault = path.join(root, "llm-default.json");
  fs.mkdirSync(chat, { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  return { chat, docs, sessions, db, llmProviders, llmDefault, root };
}

export function cleanupTempStoreDirs() {
  fs.rmSync(tempStoreRoot(), { recursive: true, force: true });
}

// The temp SQLite file path — shared by the webServer env (playwright.config)
// and specs that open the same file (library MCP child, expansion checks).
// Always derive from tempStoreRoot(); never recompute with os.tmpdir().
export function tempDbPath() {
  return path.join(tempStoreRoot(), "app.db");
}

// ── Chat-page helpers (React app under /chat/) ────────────────────────────────
//
// The React SPA is the sole frontend. `/` is served by the SPA which routes
// to /chat; Documents/Dashboard are React routes.

// Default the app to English for the test run. The app reads
// localStorage["platform.locale"] at i18n init (before any page script), so
// addInitScript runs early enough. It only sets the key when none is stored, so
// it does NOT fight a locale the test (or a real user) sets afterwards, and a
// later reload re-reads the stored choice instead of being forced back to en.
// This keeps existing text assertions (e.g. status-text -> "Connected") valid
// regardless of the browser's default language.
export async function pinLocaleEn(page) {
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("platform.locale")) localStorage.setItem("platform.locale", "en");
    } catch { /* ignore */ }
  });
}

// Wait until no agent turn is streaming. Uses the e2e build's
// window.__chatStore seam; on a plain prod build (no seam) it resolves
// immediately — best effort only. Tests that send prompts should call this
// before interacting again: while a turn streams, the composer's autogrow
// re-runs every render and Playwright's click stability checks never settle.
export async function waitForIdle(page, timeout = 20000) {
  await page.waitForFunction(
    () => !window.__chatStore || window.__chatStore.getState().isStreaming === false,
    null,
    { timeout },
  );
}

// Navigate to the React chat and wait for the WS to connect.
export async function gotoChat(page) {
  await pinLocaleEn(page);
  await page.goto("/chat/");
  await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
  // The status is set on socket open; wait for the server's session sync too.
  // On narrow viewports the desktop rail is intentionally CSS-hidden until the
  // drawer opens, so assert that the row exists rather than that it is visible.
  await expect(page.locator('[data-testid="session-row"]').first()).toHaveCount(1, { timeout: 15000 });
}

// Navigate to the React Documents page and wait for it to render.
export async function gotoDocuments(page) {
  await pinLocaleEn(page);
  await page.goto("/documents");
  await expect(page.getByTestId("documents-page")).toBeVisible({ timeout: 15000 });
}

// Navigate to the React Knowledge page (was /documents).
export async function gotoKnowledge(page) {
  await pinLocaleEn(page);
  await page.goto("/knowledge");
  await expect(page.getByTestId("documents-page")).toBeVisible({ timeout: 15000 });
}

// Navigate to the Trace list page.
export async function gotoTrace(page) {
  await pinLocaleEn(page);
  await page.goto("/trace");
  await expect(page.getByTestId("trace-page")).toBeVisible({ timeout: 15000 });
}

// Navigate to the React System Status page — now Settings → System Status.
export async function gotoDashboard(page) {
  await openSettings(page, "status");
  await expect(page.getByTestId("system-status-page")).toBeVisible({ timeout: 15000 });
}

// Navigate to the React Agents page (with sub-tabs).
export async function gotoAgents(page, tab) {
  await pinLocaleEn(page);
  const url = tab ? `/agents?tab=${tab}` : "/agents";
  await page.goto(url);
  await expect(page.getByTestId("agents-page")).toBeVisible({ timeout: 15000 });
}

// Open the Settings modal at a given section, by URL.
//
// The single way tests reach a Settings section — deep-linking rather than
// clicking the gear and then the section keeps a spec from breaking every time
// the modal chrome moves. Specs that test the modal's OWN behavior (gear click,
// keyboard shortcut, dismissal) drive it directly instead; that is the point of
// those specs.
export async function openSettings(page, section = "general") {
  await pinLocaleEn(page);
  await page.goto(`/settings/${section}`);
  await expect(page.getByTestId("settings-panel")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("settings-panel")).toHaveAttribute("data-section", section);
}

// Navigate to the React MCP Servers page — now Settings → MCP.
export async function gotoMcp(page) {
  await openSettings(page, "mcp");
  await expect(page.getByTestId("extensions-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("extensions-page")).toHaveAttribute("data-extensions-type", "mcp");
}

// Navigate to the React Skills page — now Settings → Skills.
export async function gotoSkills(page) {
  await openSettings(page, "skills");
  await expect(page.getByTestId("extensions-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("extensions-page")).toHaveAttribute("data-extensions-type", "skills");
}

// Navigate to the React LLM Models page — now Settings → Models.
export async function gotoModels(page) {
  await openSettings(page, "models");
  await expect(page.getByTestId("models-page")).toBeVisible({ timeout: 15000 });
}

// Legacy /extensions URL — must redirect into Settings → MCP.
export async function gotoExtensions(page) {
  await pinLocaleEn(page);
  await page.goto("/extensions");
  await expect(page).toHaveURL(/\/settings\/mcp$/);
  await expect(page.getByTestId("extensions-page")).toBeVisible({ timeout: 15000 });
}
