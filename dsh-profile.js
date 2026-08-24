// dsh-profile.js — generates the dsh profile's settings.yaml from host env.
//
// The dsh-llm-pi-ai plugin mounts dormant and registers LLM routes the moment a
// `llm-pi-ai:` section appears in $DSH_HOME/settings.yaml (the settings service
// live-reloads it). This module is the single source that writes that section:
// it reads the host's LLM env — LLM_API_KEY/LLM_BASE_URL (the Volces gateway) —
// and declares an OpenAI-compatible (`openai-completions`) route dsh can serve.
//
// Per design D4 (host-side config sources unchanged), the env var names are the
// project's own LLM_* (not the task spec's aspirational VOLCES_*); the generator
// is the seam that adapts them to dsh's `llm-pi-ai:` shape. Per D3, server.js
// writes the profile and lets dsh load plugins — no JS tool/MCP wiring.
//
// LiteLLM was removed: dsh-llm manages LLM natively via settings.yaml +
// .credentials.yaml hot-reload, so there's no LiteLLM child process and no
// runtime model discovery from a proxy. Model discovery/refresh is handled by
// dsh-llm's ctx.llm.discoverModels() (when wired) — the generator's declared
// list remains the bootstrap set dsh loads at startup.
//
// Writes atomically (temp+rename) and returns the declared model list so server.js
// can source its model selector without a dsh listModels RPC (dsh has none stock;
// the generator's declared list IS the dsh list — dsh loads exactly this file).
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const SETTINGS_PATH = join(DSH_HOME, "settings.yaml");
const CREDENTIALS_PATH = join(DSH_HOME, ".credentials.yaml");

// Volces gateway model catalog — deliberately scoped to 3 ids to keep the
// model selector frozen. The gateway serves more (minimax-m3, qwen3.x, …);
// those reach the selector through dsh-llm's discoverModels() when configured,
// not through this static route.
const VOLCES_MODELS = [
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 128000, maxTokens: 8192 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 128000, maxTokens: 8192 },
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 128000, maxTokens: 8192 },
];

// Normalize an LLM baseURL to include the API-version path (OpenAI convention).
// dsh's bundled pi-ai builds the request URL as `${baseURL}/chat/completions`; a
// bare host:port hits `/chat/completions`, which the gateway accepts but returns
// a stream whose finish chunk never registers, tripping pi-ai's
// "Stream ended without finish_reason". `/v1/chat/completions` returns a proper
// stream with finish_reason. So: no path → assume `/v1`; a URL already carrying
// a path (e.g. /api/coding/v3, /v1) is left untouched.
// ponytail: assumes /v1 for pathless origins; a gateway on /v2 must set the
// full path in LLM_BASE_URL.
function normalizeBaseURL(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.pathname || u.pathname === "/") u.pathname = "/v1";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

// Build the llm-pi-ai providers dict + a flat {id,name,provider} model list from
// host env. No Volces key → empty providers (dormant); chat stays non-functional
// while static + REST still serve (graceful degrade, Task 3.6).
//
// User-added providers (llm-providers.js, managed via the Models page) are
// merged in after the env route. Their keys are referenced by env name and
// seeded into .credentials.yaml by ensureCredentialsStore(), so they hot-reload
// exactly like the Volces route.
export async function buildLlmProfile({
  llmApiKey = process.env.LLM_API_KEY?.trim(),
  llmBaseUrl = process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3",
} = {}) {
  const providers = {};
  const models = [];

  if (llmApiKey) {
    const route = "volces";
    providers[route] = {
      apiKeyEnv: "LLM_API_KEY",
      displayName: "Volces",
      api: "openai-completions",
      baseURL: normalizeBaseURL(llmBaseUrl),
      models: VOLCES_MODELS.map((m) => ({ ...m, input: ["text"] })),
    };
    for (const m of VOLCES_MODELS) models.push({ id: m.id, name: m.name, provider: route });
  }

  // Merge user-managed providers (Models page). Imported lazily to avoid a
  // cycle (llm-providers imports only paths.js).
  try {
    const userLlm = await import("./llm-providers.js");
    const { providers: userProviders, models: userModels } = userLlm.buildUserProviderEntries();
    Object.assign(providers, userProviders);
    models.push(...userModels);
  } catch (e) {
    console.warn(`[dsh-profile] user providers unavailable: ${e?.message || e}`);
  }

  return { providers, models };
}

// Write the llm-pi-ai section to $DSH_HOME/settings.yaml, preserving any other
// sections already in the document (data-loss safe). Atomic: temp+rename.
// Returns { providers, models } so server.js can source its model selector.
export async function writeLlmProfile() {
  const { providers, models } = await buildLlmProfile();
  let doc = {};
  try {
    const existing = readFileSync(SETTINGS_PATH, "utf8");
    const loaded = yaml.load(existing);
    // Only keep an object document; a scalar/array means the file isn't a settings
    // map, so don't merge into it — recreate as a fresh object.
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) doc = loaded;
  } catch (err) {
    // ENOENT is expected on first run; anything else is warned but not fatal.
    if (err.code !== "ENOENT") console.warn("[dsh-profile] settings.yaml unreadable, recreating:", err.message);
  }
  doc["llm-pi-ai"] = { providers };
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  const tmp = SETTINGS_PATH + ".tmp";
  writeFileSync(tmp, yaml.dump(doc), "utf8");
  renameSync(tmp, SETTINGS_PATH);

  if (Object.keys(providers).length === 0) {
    console.warn("[dsh] no LLM keys configured; chat non-functional (static + REST still served)");
  } else {
    console.log(
      `[dsh-profile] wrote ${Object.keys(providers).join(", ")} route(s), ${models.length} model(s) → ${SETTINGS_PATH}`,
    );
  }
  return { providers, models };
}

// ── Provider credentials via dsh-credentials-local (design D3) ───────────────
// dsh-credentials-local resolves a key per-request with this layering (read-only
// layers win): inherited process env > .credentials.yaml > .env files. To make
// .credentials.yaml the live-rotatable source, the dsh child is spawned with a
// scrubbed env that omits the upstream keys (see buildScrubbedEnv + dsh-bridge
// `env` option), so the file is the winning layer. A rotated key written here
// then reaches the next LLM request without a dsh restart — dsh-credentials-local
// Chokidar-watches this file and re-resolves per request.
//
// Document is the version-1 layout dsh-credentials-local requires:
//   version: 1
//   refs:
//     LLM_API_KEY: <value>
//     LLM_PROVIDER_KEY_<ID>: <value>   (user-added providers, Models page)
// Seeded from process.env on first run (file absent); 0600 perms. Atomic write.
// User-provider keys are added here too so their apiKeyEnv refs resolve; a key
// rotation via the Models page re-runs this and hot-reloads (Chokidar watch).
const CREDENTIAL_REFS = ["LLM_API_KEY"];

export async function ensureCredentialsStore() {
  let doc;
  try {
    const existing = readFileSync(CREDENTIALS_PATH, "utf8");
    const loaded = yaml.load(existing);
    doc = loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
  } catch (err) {
    if (err.code !== "ENOENT" && err.code !== undefined) {
      // A malformed credentials doc is warned but not fatal — recreate it.
      console.warn(`[dsh-profile] .credentials.yaml unreadable, recreating: ${err.message}`);
    }
    doc = {};
  }
  doc.version = 1;
  doc.refs = doc.refs && typeof doc.refs === "object" ? doc.refs : {};
  let changed = false;
  for (const ref of CREDENTIAL_REFS) {
    const val = process.env[ref]?.trim();
    if (val && doc.refs[ref] !== val) { doc.refs[ref] = val; changed = true; }
  }
  // User-managed provider keys (Models page). These come from llm-providers.json,
  // not process.env; stale refs (a deleted provider) are pruned so a removed key
  // doesn't linger in the credentials file.
  try {
    const userLlm = await import("./llm-providers.js");
    const userRefs = userLlm.credentialRefsForUserProviders();
    const userRefNames = new Set(Object.keys(userRefs));
    for (const [name, val] of Object.entries(userRefs)) {
      if (doc.refs[name] !== val) { doc.refs[name] = val; changed = true; }
    }
    for (const name of Object.keys(doc.refs)) {
      if (name.startsWith("LLM_PROVIDER_KEY_") && !userRefNames.has(name)) {
        delete doc.refs[name];
        changed = true;
      }
    }
  } catch (e) {
    console.warn(`[dsh-profile] user credential refs unavailable: ${e?.message || e}`);
  }
  // Always (re)write on first run (file absent) so perms are set; otherwise
  // only write when a ref changed, to avoid needlessly tripping the watcher.
  const absent = !existsSync(CREDENTIALS_PATH);
  if (!changed && !absent) return { path: CREDENTIALS_PATH, changed: false };
  mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true });
  const tmp = CREDENTIALS_PATH + ".tmp";
  writeFileSync(tmp, yaml.dump(doc), "utf8");
  renameSync(tmp, CREDENTIALS_PATH);
  try { chmodSync(CREDENTIALS_PATH, 0o600); } catch { /* perms best-effort on some FS */ }
  console.log(`[dsh-profile] wrote credentials store (${Object.keys(doc.refs).join(", ") || "empty"}) → ${CREDENTIALS_PATH}`);
  return { path: CREDENTIALS_PATH, changed: true };
}

// Build a dsh child env that inherits the parent env MINUS the upstream API
// keys, so dsh-credentials-local's .credentials.yaml is the winning resolution
// layer (the inherited-env layer would otherwise shadow it). The parent keeps
// its own process.env for server-side consumers (documents RAG).
// Returns null when no upstream keys are configured (no scrubbing needed —
// caller passes null and HarnessClient inherits process.env as before).
export function buildScrubbedEnv() {
  const hasAny = CREDENTIAL_REFS.some((r) => process.env[r]?.trim());
  if (!hasAny) return null;
  const env = { ...process.env };
  for (const ref of CREDENTIAL_REFS) delete env[ref];
  return env;
}

// ── MCP server patch (dsh-mcp-client) ─────────────────────────────────────────
// dsh-mcp-client is a cordis LOADER entry (not a settings.yaml section): one
// plugin instance per MCP server, declared in a `--patch` overlay so the user's
// cordis.patch.yml stays untouched. Tool naming is mcp__<serverName>__<rawName>,
// the same convention the host's WS protocol already speaks, so the migration
// is invisible to anything that references tool names. failOnStartupError:false
// on every entry preserves "failed MCP server doesn't block startup" (Task 4.5);
// the plugin's default reconnect (500ms→30s backoff, 10 attempts) covers an OC
// runtime that boots in parallel with server.js (no host-side retry needed).
const PROFILE_NAME = process.env.DSH_PROFILE || "platform";
const MCP_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "mcp.patch.yml");

// Map one host MCP config ({command,args,env,cwd} stdio | {url,headers} http) to
// a dsh-mcp-client cordis loader entry. Unknown shape → null (skipped, warned).
function toMcpClientEntry(name, config) {
  if (!config || typeof config !== "object") return null;
  const entry = {
    id: `mcp-${name}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config: { serverName: name, failOnStartupError: false },
  };
  if (config.command) {
    entry.config.transport = "stdio";
    entry.config.command = config.command;
    if (config.args) entry.config.args = config.args;
    if (config.env) entry.config.env = config.env;
    if (config.cwd) entry.config.cwd = config.cwd;
  } else if (config.url) {
    entry.config.transport = "streamable-http";
    entry.config.url = config.url;
    if (config.headers) entry.config.headers = config.headers;
  } else {
    return null;
  }
  return entry;
}

// Gather MCP server configs from every host source, merge (DB wins on name
// collision; a DB-disabled row drops its entry), and write a cordis patch file
// of dsh-mcp-client entries. Returns the patch path, or null when there are no
// servers (caller skips `--patch`). Atomic: temp+rename.
//
// Sources (design D4 — host-side config sources unchanged):
//   mcp.json            — operator config (base layer)
//   OpenConnector /mcp  — when OPENCONNECTOR_BASE_URL set (Task 4.2)
//   SQLite MCP table    — user edits via REST; overrides on collision (Task 4.1)
export async function writeMcpPatch() {
  // 1. mcp.json (operator config, base layer).
  let mcpJsonServers = {};
  try {
    mcpJsonServers = JSON.parse(readFileSync("mcp.json", "utf8")).mcpServers || {};
  } catch { /* no mcp.json or parse error — MCP disabled via file */ }

  // 2. OpenConnector /mcp endpoint (http transport, runtime token Bearer).
  let ocConfig = null;
  try {
    const oc = await import("./open-connector.js");
    ocConfig = oc.buildMcpServerConfig();
  } catch { /* open-connector module unavailable */ }

  // Merge: mcp.json base → OC overrides → DB (enabled overrides, disabled drops).
  const servers = { ...mcpJsonServers };
  if (ocConfig) servers["open-connector"] = ocConfig;
  try {
    const db = await import("./db.js");
    if (db.isDbReady()) {
      const extensionStore = await import("./extension-store.js");
      for (const row of extensionStore.listMcpServers()) {
        if (row.enabled === false) delete servers[row.name];
        else servers[row.name] = row.config;
      }
    }
  } catch (e) {
    console.warn(`[dsh-profile] DB MCP read failed; mcp.json/OC only: ${e?.message || e}`);
  }

  const entries = [];
  for (const [name, config] of Object.entries(servers)) {
    const e = toMcpClientEntry(name, config);
    if (e) entries.push(e);
    else console.warn(`[dsh-profile] skipping MCP server "${name}": unknown config shape`);
  }

  if (entries.length === 0) {
    console.log("[dsh-profile] no MCP servers configured; skipping --patch");
    return null;
  }
  mkdirSync(dirname(MCP_PATCH_PATH), { recursive: true });
  const tmp = MCP_PATCH_PATH + ".tmp";
  // Wrap entries in an `insert` list — a bare `{id, config}` is treated by
  // cordis-plugin-include as an override-by-id on an EXISTING entry, and since
  // these mcp-client entries don't exist in the base bundle they'd be warned +
  // skipped ("patch: entry "mcp-x" not found"). `insert` tells cordis to add
  // them as new loader entries. (The skills patch differs: skill-filesystem
  // DOES exist in the base bundle, so its override-by-id shape is correct.)
  writeFileSync(tmp, yaml.dump([{ insert: entries }]), "utf8");
  renameSync(tmp, MCP_PATCH_PATH);
  console.log(
    `[dsh-profile] wrote ${entries.length} MCP server(s): ${entries.map((e) => e.config.serverName).join(", ")} → ${MCP_PATCH_PATH}`,
  );
  return MCP_PATCH_PATH;
}

// ── Skills discovery patch (dsh-skill-filesystem) ──────────────────────────────
// The dsh-skill-filesystem plugin ships in the dsh-base bundle with no config, so
// it scans only its built-in roots (project .dsh/.agents, user ~/.dsh/~/.agents).
// To expose the project's skills/ dir, override the entry's config with
// customSkillDirs. This is
// an override-by-id patch (skill-filesystem exists in the base bundle, so cordis
// applies it — unlike the mcp entries, which are inserts). The dir is static, so
// written once at startup; no live-reload (skills/ doesn't change at runtime).
const SKILLS_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "skills.patch.yml");

export function writeSkillsPatch(skillsDirs = [resolve("skills")]) {
  // ponytail: single static entry; customSkillDirs is the only field that matters
  // (providerName/includeDefaultRoots/watch take schema defaults when config is
  // overridden, so the built-in discovery roots are preserved). skillsDirs may be
  // a single path (legacy) or an array; the materialization dir (DB custom skills)
  // is appended by server.js so dsh-skill-filesystem Chokidar-watches it too.
  const dirs = Array.isArray(skillsDirs) ? skillsDirs : [skillsDirs];
  const entry = {
    id: "skill-filesystem",
    name: "@deepseek-ai/dsh-skill-filesystem",
    config: { customSkillDirs: dirs },
  };
  mkdirSync(dirname(SKILLS_PATCH_PATH), { recursive: true });
  const tmp = SKILLS_PATCH_PATH + ".tmp";
  writeFileSync(tmp, yaml.dump([entry]), "utf8");
  renameSync(tmp, SKILLS_PATCH_PATH);
  console.log(`[dsh-profile] wrote skills patch (customSkillDirs: ${dirs.join(", ")}) → ${SKILLS_PATCH_PATH}`);
  return SKILLS_PATCH_PATH;
}

// Self-check: load .env, build the section, print it + the model list. No file
// write (read-only) — proves the generator emits valid YAML + the expected ids.
// Usage: node dsh-profile.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { (await import("dotenv")).config(); } catch { /* .env optional for the self-check */ }
  const { providers, models } = await buildLlmProfile();
  console.log("--- llm-pi-ai settings section ---");
  console.log(yaml.dump({ "llm-pi-ai": { providers } }));
  console.log(`models: ${models.map((m) => m.id).join(", ") || "(none — no keys configured)"}`);
  if (Object.keys(providers).length === 0) console.log("OK (dormant — graceful-degrade path)");
  else if (models.some((m) => VOLCES_MODELS.some((v) => v.id === m.id))) console.log("OK volces route declared");
  else console.log("FAIL: no volces models despite LLM_API_KEY set");
  // MCP patch self-check: write the file and dump it so the entry shape is visible.
  const patchPath = await writeMcpPatch();
  if (patchPath) {
    console.log(`--- mcp patch (${patchPath}) ---`);
    console.log(readFileSync(patchPath, "utf8"));
  }
  // Skills patch self-check.
  const skillsPatch = writeSkillsPatch();
  console.log(`--- skills patch (${skillsPatch}) ---`);
  console.log(readFileSync(skillsPatch, "utf8"));
}
