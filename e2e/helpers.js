// E2E test helpers: isolated store directories + shared base URL.
//
// The server hosts one shared agent session and resolves its store dirs from
// SESSIONS_STORE_DIR / DOCUMENTS_STORE_DIR (CHAT_HISTORY_STORE_DIR is now only
// the legacy migration source). These helpers create throwaway dirs under
// os.tmpdir() so the suite never touches the user's real sessions-store/ or
// documents-store/.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { expect } from "@playwright/test";

export const E2E_PORT = Number(process.env.E2E_PORT) || 3100;
export const baseURL = `http://127.0.0.1:${E2E_PORT}`;

// Deterministic per-port root so both config load and global teardown can find
// it without passing state between processes.
function tempStoreRoot() {
  return path.join(os.tmpdir(), `paas-e2e-${E2E_PORT}`);
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
  fs.mkdirSync(chat, { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  return { chat, docs, sessions, db, root };
}

export function cleanupTempStoreDirs() {
  fs.rmSync(tempStoreRoot(), { recursive: true, force: true });
}

// ── Chat-page helpers (React app under /chat/) ────────────────────────────────
//
// The React SPA is the sole frontend. `/` is served by the SPA which routes
// to /chat; Documents/Dashboard/History/OpenConnector/LiteLLM are React routes.

// Navigate to the React chat and wait for the WS to connect.
export async function gotoChat(page) {
  await page.goto("/chat/");
  await expect(page.getByTestId("status-text")).toHaveText("Connected", { timeout: 15000 });
}

// Navigate to the React Documents page and wait for it to render.
export async function gotoDocuments(page) {
  await page.goto("/documents");
  await expect(page.getByTestId("documents-page")).toBeVisible({ timeout: 15000 });
}

// Navigate to the React Dashboard page.
export async function gotoDashboard(page) {
  await page.goto("/dashboard");
  await expect(page.getByTestId("dashboard-page")).toBeVisible({ timeout: 15000 });
}

// Navigate to the React Chat History page.
export async function gotoHistory(page) {
  await page.goto("/history");
  await expect(page.getByTestId("history-page")).toBeVisible({ timeout: 15000 });
}
