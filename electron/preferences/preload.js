// ── Preload script for Preferences window ─────────────────────────────────────
// Exposes only the whitelisted IPC channels via contextBridge.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("platform", {
  // Get visible whitelisted settings
  getVisibleSettings: () => ipcRenderer.invoke("settings:get-visible"),

  // Set a settings field
  setSettingField: (key, value) => ipcRenderer.invoke("settings:set-field", { key, value }),

  // Get full LiteLLM YAML config
  getLiteLLMConfig: () => ipcRenderer.invoke("litellm:get-config"),

  // Save new LiteLLM YAML config
  setLiteLLMConfig: (content) => ipcRenderer.invoke("litellm:set-config", { content }),

  // Regenerate OpenConnector tokens (never returns the tokens)
  rotateOpenConnectorTokens: () => ipcRenderer.invoke("openconnector:rotate-tokens"),

  // Restart a service after changes
  restartService: (id) => ipcRenderer.invoke("service:restart", { id }),
});
