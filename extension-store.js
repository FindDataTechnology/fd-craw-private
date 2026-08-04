// extension-store.js
// Business logic layer for managing MCP server configs and custom skills.
// Wraps the db.js CRUD operations and provides market catalog loading.

import { promises as fs } from "node:fs";
import path from "node:path";
import * as db from "./db.js";

const MARKET_CATALOG_PATH = path.resolve("market-catalog.json");
const MARKET_CATALOG_SKILLS_PATH = path.resolve("market-catalog-skills.json");

// ── MCP Server Configs ───────────────────────────────────────────────────────

export function listMcpServers() {
  return db.listExtensionConfigs().filter((c) => c.type === "mcp");
}

export function getMcpServer(name) {
  const config = db.getExtensionConfig(name);
  if (!config || config.type !== "mcp") return null;
  return config;
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
  try {
    const raw = await fs.readFile(MARKET_CATALOG_PATH, "utf8");
    marketCatalogCache = JSON.parse(raw);
    return marketCatalogCache;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("[extensions] No market-catalog.json found");
      marketCatalogCache = { mcpServers: [] };
    } else {
      console.warn(`[extensions] Failed to read market catalog: ${err.message}`);
      marketCatalogCache = { mcpServers: [] };
    }
    return marketCatalogCache;
  }
}

export async function loadMarketCatalogSkills() {
  if (marketCatalogSkillsCache) return marketCatalogSkillsCache;
  try {
    const raw = await fs.readFile(MARKET_CATALOG_SKILLS_PATH, "utf8");
    marketCatalogSkillsCache = JSON.parse(raw);
    return marketCatalogSkillsCache;
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("[extensions] No market-catalog-skills.json found");
      marketCatalogSkillsCache = { skills: [] };
    } else {
      console.warn(`[extensions] Failed to read market skills catalog: ${err.message}`);
      marketCatalogSkillsCache = { skills: [] };
    }
    return marketCatalogSkillsCache;
  }
}

export async function getMarketCatalog() {
  const [mcpServers, skills] = await Promise.all([
    loadMarketCatalog(),
    loadMarketCatalogSkills(),
  ]);
  return { mcpServers: mcpServers.mcpServers || [], skills: skills.skills || [] };
}

// Clear caches (for testing or when catalog files change)
export function clearMarketCatalogCache() {
  marketCatalogCache = null;
  marketCatalogSkillsCache = null;
}
