// Agent & app catalog: dual-source (local agents.json + cloud
// AGENTS_CONFIG_URL), merged by id with cloud winning, refreshed on an
// interval; a content change broadcasts `catalog_changed` so clients refetch
// GET /api/catalog. Mirrors extension-store.js conventions: module state +
// accessors, no DB, absent sources degrade to just the built-in local agent.
import { readFile } from "node:fs/promises";
import path from "node:path";

const CATALOG_FILE = path.resolve("agents.json");
const CLOUD_URL = process.env.AGENTS_CONFIG_URL?.trim() || null;
const REFRESH_SECS = Number(process.env.CATALOG_REFRESH_SECS || 60);

// The built-in pi agent session is always present (sources may override it).
const BUILT_IN = { id: "local", type: "agent-local", name: "Platform" };

let localEntries = { agents: [], apps: [] };
let cloudEntries = null; // last-good cloud document (null until first success)
let lastSignature = null;
let timer = null;
let broadcastFn = null;

// Validation: unknown type / duplicate id / missing required fields ⇒ drop the
// entry with a warning, serve the rest (spec: agent-catalog, invalid entries).
function validateEntry(entry, source) {
  const where = `[catalog] ${source} entry`;
  if (!entry || typeof entry !== "object" || !entry.id || !entry.type) {
    console.warn(`${where}: missing id or type — dropped`);
    return null;
  }
  if (entry.type === "agent-local") return entry;
  if (entry.type === "agent-remote") {
    if (entry.mode === "chat" && (!entry.baseUrl || !entry.model)) {
      console.warn(`${where} '${entry.id}': chat-mode agent-remote needs baseUrl + model — dropped`);
      return null;
    }
    if (entry.mode === "link" && !entry.url) {
      console.warn(`${where} '${entry.id}': link-mode agent-remote needs url — dropped`);
      return null;
    }
    if (entry.mode !== "chat" && entry.mode !== "link") {
      console.warn(`${where} '${entry.id}': unknown mode '${entry.mode}' — dropped`);
      return null;
    }
    return entry;
  }
  if (entry.type === "app") {
    if (entry.kind === "link" && entry.url) return entry;
    if (entry.kind === "nango-connect" && entry.nangoUrl) return entry;
    console.warn(`${where} '${entry.id}': kind must be "link" (with url) or "nango-connect" (with nangoUrl) — dropped`);
    return null;
  }
  console.warn(`${where} '${entry.id}': unknown type '${entry.type}' — dropped`);
  return null;
}

function validateDoc(doc, source) {
  const agents = [];
  const apps = [];
  const seen = new Set();
  for (const e of [...(doc?.agents ?? []), ...(doc?.apps ?? [])]) {
    const v = validateEntry(e, source);
    if (!v) continue;
    if (seen.has(v.id)) {
      console.warn(`[catalog] ${source}: duplicate id '${v.id}' — second occurrence dropped`);
      continue;
    }
    seen.add(v.id);
    (v.type === "app" ? apps : agents).push(v);
  }
  return { agents, apps };
}

async function loadLocal() {
  try {
    localEntries = validateDoc(JSON.parse(await readFile(CATALOG_FILE, "utf8")), "agents.json");
  } catch (err) {
    if (err.code !== "ENOENT") console.warn(`[catalog] agents.json unreadable: ${err.message}`);
    localEntries = { agents: [], apps: [] };
  }
}

async function loadCloud() {
  if (!CLOUD_URL) return;
  try {
    const r = await fetch(CLOUD_URL, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    cloudEntries = validateDoc(await r.json(), "cloud");
  } catch (err) {
    // Cloud outage never empties the catalog: keep the last-good entries.
    console.warn(`[catalog] AGENTS_CONFIG_URL fetch failed (keeping last-good): ${err.message}`);
  }
}

// Merge by id: built-in → agents.json → cloud (later wins, so the cloud is the
// live control plane even for ids first defined locally).
function merged() {
  const byId = new Map();
  for (const doc of [{ agents: [BUILT_IN], apps: [] }, localEntries, cloudEntries]) {
    if (!doc) continue;
    for (const e of [...doc.agents, ...doc.apps]) byId.set(e.id, e);
  }
  const all = [...byId.values()];
  return { agents: all.filter((e) => e.type !== "app"), apps: all.filter((e) => e.type === "app") };
}

// Client-facing serializer: whitelists display fields only. Secrets (apiKey,
// apiKeyEnv, resolved keys) never reach the browser (design D5).
function serialize(entry) {
  const base = { id: entry.id, type: entry.type, name: entry.name || entry.id };
  if (entry.type === "agent-remote") {
    base.mode = entry.mode;
    if (entry.mode === "chat") base.model = entry.model;
    if (entry.mode === "link") base.url = entry.url;
  } else if (entry.type === "app") {
    base.kind = entry.kind;
    if (entry.kind === "link") base.url = entry.url;
  }
  return base;
}

// Role visibility: an entry with a non-empty roles[] is served only when the
// user's groups intersect it. No user (auth off) → only role-less entries.
function visible(entry, user) {
  if (!entry.roles?.length) return true;
  return (user?.groups ?? []).some((g) => entry.roles.includes(g));
}

export function getCatalogFor(user) {
  const cat = merged();
  return {
    agents: cat.agents.filter((e) => visible(e, user)).map(serialize),
    apps: cat.apps.filter((e) => visible(e, user)).map(serialize),
  };
}

// Full (unredacted) entries for server-side use. The remote-agent key is
// resolved here at call time: literal apiKey, else apiKeyEnv → process.env.
export function getAgentEntry(id) {
  const e = merged().agents.find((a) => a.id === id);
  if (!e) return null;
  if (e.type === "agent-remote" && e.mode === "chat") {
    return { ...e, apiKey: e.apiKey || (e.apiKeyEnv ? process.env[e.apiKeyEnv] : undefined) };
  }
  return e;
}

export function getAppEntry(id) {
  return merged().apps.find((a) => a.id === id) || null;
}

// Re-read both sources; broadcast `catalog_changed` when the merged catalog
// changed. Returns the refreshed, redacted catalog for the requesting user.
export async function refresh(user = null) {
  await Promise.all([loadLocal(), loadCloud()]);
  const cat = merged();
  const sig = JSON.stringify({ agents: cat.agents.map(serialize), apps: cat.apps.map(serialize) });
  if (sig !== lastSignature) {
    lastSignature = sig;
    broadcastFn?.({ type: "catalog_changed" });
  }
  return getCatalogFor(user);
}

export async function initCatalog({ broadcast }) {
  broadcastFn = broadcast;
  await refresh();
  if (REFRESH_SECS > 0) {
    timer = setInterval(
      () => refresh().catch((e) => console.warn(`[catalog] periodic refresh failed: ${e.message}`)),
      REFRESH_SECS * 1000
    );
    timer.unref?.();
  }
}

export function stopCatalog() {
  if (timer) clearInterval(timer);
  timer = null;
}
