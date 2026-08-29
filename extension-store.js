// extension-store.js
// Business logic layer for managing MCP server configs and custom skills.
// Wraps the db.js CRUD operations and provides market catalog loading.

import path from "node:path";
import { readJsonOr } from "./lib/persistence.js";
import * as db from "./db.js";

const MARKET_CATALOG_PATH = path.resolve("market-catalog.json");
const MARKET_CATALOG_SKILLS_PATH = path.resolve("market-catalog-skills.json");

// shared predicate for "this arg needs user input".
// Matches /path/..., your_..., and <...> placeholders.
// Used by both requiresConfig derivation (server) and setup-form field generation (client re-implements the same rule).
export function isPlaceholderArg(arg) {
  return /\/path\//.test(arg) || /^your_/.test(arg) || /^<.*>$/.test(arg);
}

// Derive whether a catalog entry needs user-supplied config.
function requiresConfig(template) {
  if (!template) return false;
  const env = template.env || {};
  if (Object.keys(env).length > 0) return true;
  const args = template.args || [];
  return args.some(isPlaceholderArg);
}

// ── MCP Server Configs ───────────────────────────────────────────────────────

export function listMcpServers() {
  return db.listExtensionConfigs().filter((c) => c.type === "mcp");
}

export function getMcpServer(name) {
  const config = db.getExtensionConfig(name);
  if (!config || config.type !== "mcp") return null;
  return config;
}

// seed on startup — skip if already present (preserves user edits).
// origin/locked/permissions come from the bundle manifest for packaged seeds
// ("bundled", locked, tool allow/deny lists); default to a plain user row.
export function seedMcpServer({ name, config, enabled = true, origin = "user", locked = false, permissions = null }) {
  return db.seedExtensionConfig({ name, type: "mcp", config, enabled, origin, locked, permissions });
}

export function addMcpServer({ name, config, enabled = true }) {
  return db.addExtensionConfig({ name, type: "mcp", config, enabled });
}

export function updateMcpServer(name, { config, enabled }) {
  return db.updateExtensionConfig(name, { type: "mcp", config, enabled });
}

export function removeMcpServer(name) {
  const server = getMcpServer(name);
  if (!server) return false;
  return db.deleteExtensionConfig(name);
}

export function toggleMcpServer(name, enabled) {
  const server = getMcpServer(name);
  if (!server) return null;
  return db.setExtensionEnabled(name, enabled);
}

// ── Custom Skills ────────────────────────────────────────────────────────────

export function listCustomSkills() {
  return db.listCustomSkills();
}

export function getCustomSkill(name) {
  return db.getCustomSkill(name);
}

export function addCustomSkill({ name, description, content, enabled = true }) {
  return db.addCustomSkill({ name, description, content, enabled });
}

export function updateCustomSkill(name, { description, content, enabled }) {
  return db.updateCustomSkill(name, { description, content, enabled });
}

export function removeCustomSkill(name) {
  const skill = getCustomSkill(name);
  if (!skill) return false;
  return db.deleteCustomSkill(name);
}

export function toggleCustomSkill(name, enabled) {
  const skill = getCustomSkill(name);
  if (!skill) return null;
  return db.setCustomSkillEnabled(name, enabled);
}

// ── Market Catalog ───────────────────────────────────────────────────────────

let marketCatalogCache = null;
let marketCatalogSkillsCache = null;

export async function loadMarketCatalog() {
  if (marketCatalogCache) return marketCatalogCache;
  const doc = readJsonOr(MARKET_CATALOG_PATH, null, { label: "extensions" });
  // readJsonOr warns on parse errors; a missing/invalid file degrades to the
  // empty catalog (fresh installs ship without market catalogs).
  marketCatalogCache = doc ?? { mcpServers: [] };
  return marketCatalogCache;
}

export async function loadMarketCatalogSkills() {
  if (marketCatalogSkillsCache) return marketCatalogSkillsCache;
  const doc = readJsonOr(MARKET_CATALOG_SKILLS_PATH, null, { label: "extensions" });
  marketCatalogSkillsCache = doc ?? { skills: [] };
  return marketCatalogSkillsCache;
}

export async function getMarketCatalog() {
  const [mcpServers, skills] = await Promise.all([
    loadMarketCatalog(),
    loadMarketCatalogSkills(),
  ]);
  const servers = (mcpServers.mcpServers || []).map((s) => ({
    ...s,
    requiresConfig: requiresConfig(s.configTemplate),
  }));
  // sort ready-to-use first, then alphabetical. The JSON file order is a hint, this is the source of truth.
  servers.sort((a, b) => {
    if (a.requiresConfig !== b.requiresConfig) return a.requiresConfig ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return { mcpServers: servers, skills: skills.skills || [] };
}

// Clear caches (for testing or when catalog files change)
export function clearMarketCatalogCache() {
  marketCatalogCache = null;
  marketCatalogSkillsCache = null;
}
