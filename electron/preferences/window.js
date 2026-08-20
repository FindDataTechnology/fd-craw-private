// ── Preferences window singleton ─────────────────────────────────────────────
//
// Opens the Preferences window as a singleton (only one open at a time).

import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { readSettings, writeSettings } from "../config/settings.js";
import { getSupervisor } from "./ipc.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

let preferencesWindow = null;

export function openPreferencesWindow() {
  if (preferencesWindow !== null) {
    preferencesWindow.focus();
    return;
  }

  preferencesWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: "Preferences — Platform",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  preferencesWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  preferencesWindow.on("closed", () => {
    preferencesWindow = null;
  });
}

// IPC handlers registered once when the app starts
export function registerPreferencesIpc(supervisor) {
  // Allow only these keys to be read/written
  const ALLOWED_VISIBLE_KEYS = ["LLM_API_KEY", "LLM_BASE_URL", "DEFAULT_MODEL", "DOCUMENTS_MODEL", "LITELLM_API_KEY"];
  const ALLOWED_WRITE_KEYS = ["LLM_API_KEY", "LLM_BASE_URL", "DEFAULT_MODEL", "DOCUMENTS_MODEL"];
  const ALLOWED_SERVICE_RESTART = ["server-js", "litellm", "openconnector"];

  // Get whitelisted visible settings
  ipcMain.handle("settings:get-visible", () => {
    const all = readSettings();
    const visible = {};
    for (const k of ALLOWED_VISIBLE_KEYS) {
      if (k in all) visible[k] = all[k];
    }
    // Never return OC tokens
    return visible;
  });

  // Set a single setting field
  ipcMain.handle("settings:set-field", async (_event, { key, value }) => {
    if (!ALLOWED_WRITE_KEYS.includes(key)) {
      return { ok: false, error: "Key not allowed for editing" };
    }
    const current = readSettings();
    current[key] = value;
    writeSettings(current);
    return { ok: true };
  });

  // Get full text of litellm.yaml from userData
  ipcMain.handle("litellm:get-config", () => {
    const dataDir = app.isPackaged ? app.getPath("userData") : "";
    const configPath = dataDir ? path.join(dataDir, "litellm.yaml") : "litellm.yaml";
    try {
      return { ok: true, content: require("fs").readFileSync(configPath, "utf8") };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // Write new text to litellm.yaml
  ipcMain.handle("litellm:set-config", async (_event, { content }) => {
    const dataDir = app.isPackaged ? app.getPath("userData") : "";
    const configPath = dataDir ? path.join(dataDir, "litellm.yaml") : "litellm.yaml";
    const tempPath = configPath + ".tmp";
    try {
      require("fs").writeFileSync(tempPath, content, "utf8");
      require("fs").renameSync(tempPath, configPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // Rotate OpenConnector tokens (never return the new tokens to renderer)
  ipcMain.handle("openconnector:rotate-tokens", async () => {
    const crypto = require("node:crypto");
    const current = readSettings();
    current.OPENCONNECTOR_RUNTIME_TOKEN = crypto.randomBytes(32).toString("hex");
    current.OPENCONNECTOR_ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");
    writeSettings(current);
    // Tokens never leave main process
    return { ok: true };
  });

  // Restart a service
  ipcMain.handle("service:restart", async (_event, { id }) => {
    if (!ALLOWED_SERVICE_RESTART.includes(id)) {
      return { ok: false, error: "Service not allowed for restart" };
    }
    if (!supervisor) {
      return { ok: false, error: "Supervisor not initialized" };
    }
    const ok = await supervisor.restart(id);
    // If restart fails, get last error and logs
    if (!ok) {
      const status = supervisor.status().find(s => s.id === id);
      return { ok: false, error: status?.lastError || "Restart failed", logs: status?.logs || [] };
    }
    return { ok: true };
  });
}
