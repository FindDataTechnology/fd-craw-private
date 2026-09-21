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
import { readFileSync, mkdirSync, chmodSync, existsSync, statSync, copyFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { atomicWriteTextSync, normalizeBaseUrl } from "./lib/persistence.js";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const SETTINGS_PATH = join(DSH_HOME, "settings.yaml");
const CREDENTIALS_PATH = join(DSH_HOME, ".credentials.yaml");
const MCP_CONFIG_PATH = resolve(process.env.MCP_CONFIG_PATH || "mcp.json");

// token.finddatatech.cloud gateway model catalog (IDs verified against
// GET /v1/models 2026-09-02; date-suffixed ids are the gateway's real ids).
const VOLCES_MODELS = [
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash", contextWindow: 128000, maxTokens: 8192 },
  { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", contextWindow: 128000, maxTokens: 8192 },
  { id: "glm-5.3", name: "GLM 5.3", contextWindow: 128000, maxTokens: 8192 },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 128000, maxTokens: 8192 },
  { id: "glm-5.2", name: "GLM 5.2", contextWindow: 128000, maxTokens: 8192 },
  { id: "glm-5.1", name: "GLM 5.1", contextWindow: 128000, maxTokens: 8192 },
  { id: "glm-5", name: "GLM 5", contextWindow: 128000, maxTokens: 8192 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 128000, maxTokens: 8192 },
  { id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 128000, maxTokens: 8192 },
  { id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 128000, maxTokens: 8192 },
  { id: "minimax-m2.7", name: "MiniMax M2.7", contextWindow: 128000, maxTokens: 8192 },
  { id: "minimax-m2.5", name: "MiniMax M2.5", contextWindow: 128000, maxTokens: 8192 },
  { id: "qwen3.8-max", name: "Qwen 3.8 Max", contextWindow: 128000, maxTokens: 8192 },
  { id: "qwen3.8-27b", name: "Qwen 3.8 27B", contextWindow: 128000, maxTokens: 8192 },
  { id: "qwen3.7-max", name: "Qwen 3.7 Max", contextWindow: 128000, maxTokens: 8192 },
  { id: "qwen3.7-flash", name: "Qwen 3.7 Flash", contextWindow: 128000, maxTokens: 8192 },
  { id: "seed-2.1-pro", name: "Seed 2.1 Pro", contextWindow: 128000, maxTokens: 8192 },
  { id: "seed-2.1-turbo", name: "Seed 2.1 Turbo", contextWindow: 128000, maxTokens: 8192 },
  { id: "longcat-2.0", name: "LongCat 2.0", contextWindow: 128000, maxTokens: 8192 },
  { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", contextWindow: 128000, maxTokens: 8192 },
];

// Thinking levels a model may be asked for. dsh-llm resolves an explicit effort
// against the model's declared map and throws UNSUPPORTED_REASONING_EFFORT on a
// miss, so only declare what the gateway actually accepts. Wire value = the
// level string itself (the OpenAI `reasoning_effort` field).
// ponytail: deepseek-v4 only until another family is verified — a wrong `false`
// just hides a control, a wrong map is a dispatch error.
const IDENTITY_EFFORTS = { low: "low", medium: "medium", high: "high" };

function declaredEfforts(modelId) {
  return modelId.startsWith("deepseek-v4") ? IDENTITY_EFFORTS : false;
}

// The selectable level names for a `reasoningEfforts` declaration (`false` =
// non-reasoning model → no control).
export function effortLevels(reasoningEfforts) {
  return reasoningEfforts && typeof reasoningEfforts === "object" ? Object.keys(reasoningEfforts) : [];
}

// Persisted per-provider thinking level (`llm.effort.<provider>` in the prefs
// table). Read here rather than passed in so every writeLlmProfile() caller —
// including the runtime model refresh — reproduces the choice.
async function persistedEffort(providerId) {
  try {
    const db = await import("./db.js");
    if (!db.isDbReady()) return null;
    return db.getPreference(`llm.effort.${providerId}`) || null;
  } catch {
    return null;
  }
}

// Normalize an LLM baseURL to include the API-version path (OpenAI convention).
// dsh's bundled pi-ai builds the request URL as `${baseURL}/chat/completions`; a
// bare host:port hits `/chat/completions`, which the gateway accepts but returns
// a stream whose finish chunk never registers, tripping pi-ai's
// "Stream ended without finish_reason". `/v1/chat/completions` returns a proper
// stream with finish_reason. So: no path → assume `/v1`; a URL already carrying
// a path (e.g. /api/coding/v3, /v1) is left untouched.
// ponytail: assumes /v1 for pathless origins; a gateway on /v2 must set the
// full path in LLM_BASE_URL.


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
  efforts = null,
} = {}) {
  const providers = {};
  const models = [];

  if (llmApiKey) {
    const route = "volces";
    providers[route] = {
      apiKeyEnv: "LLM_API_KEY",
      displayName: "Volces",
      api: "openai-completions",
      baseURL: normalizeBaseUrl(llmBaseUrl),
      models: VOLCES_MODELS.map((m) => ({ ...m, input: ["text"], reasoningEfforts: declaredEfforts(m.id) })),
    };
    for (const m of VOLCES_MODELS) {
      const levels = effortLevels(declaredEfforts(m.id));
      models.push({ id: m.id, name: m.name, provider: route, ...(levels.length ? { reasoningEfforts: levels } : {}) });
    }
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

  // Project the persisted thinking level onto each route (dsh reads effort
  // per-provider, not per-model — design D1).
  //
  // `compat` states what pi-ai cannot infer: it reads wire compatibility from
  // the provider id and baseURL, and a private gateway's URL tells it nothing,
  // so it falls back to assuming real OpenAI. Every route here IS a private
  // OpenAI-compatible gateway. Route-level switches skip models whose protocol
  // does not take them (model-level ones would fail resolution), so this is
  // safe to apply to every route regardless of `api`.
  for (const [id, p] of Object.entries(providers)) {
    const level = efforts ? efforts[id] : await persistedEffort(id);
    if (level) p.reasoning = level;
    // pi-ai sends `role: "developer"` to reasoning models; gateways that
    // predate it answer 400 "invalid value: `developer`". `false` keeps `system`.
    p.compat = { supportsDeveloperRole: false, ...p.compat };
  }

  return { providers, models };
}

// Write the llm-pi-ai section to $DSH_HOME/settings.yaml, preserving any other
// sections already in the document (data-loss safe). Atomic: temp+rename.
// Returns { providers, models } so server.js can source its model selector.
export async function writeLlmProfile(opts = {}) {
  const { providers, models } = await buildLlmProfile(opts);
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
  atomicWriteTextSync(SETTINGS_PATH, yaml.dump(doc));

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
  atomicWriteTextSync(CREDENTIALS_PATH, yaml.dump(doc));
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

// ── DSH home bootstrap ───────────────────────────────────────────────────────
// A hosted cell gets a FRESH DSH_HOME per user, so nothing about the profile
// can be assumed to exist the way it does in a long-lived ~/.dsh: dsh refuses
// to boot with `profile "platform" does not exist`, and even with the scaffold
// present it cannot resolve its bundles without the installed module tree.
// Materialize the scaffold from dsh-profile-template/ (the same four files the
// Dockerfile copies) and link the deployment's read-only module tree in, so
// every cell resolves identical code without a per-user install.
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template");
const SCAFFOLD_FILES = ["package.json", "pnpm-workspace.yaml", "cordis.yml", "cordis.patch.yml"];
// Two module levels matter: `profiles/node_modules` carries the bundles dsh
// composes (dsh-base, …), and `profiles/<name>/node_modules` carries the
// profile's own pinned deps (dsh-sdk-jsonrpc-server, dsh-agent-presets) that
// the preset bridge imports by bare specifier.
const MODULE_LINK_DIRS = [join("profiles", "node_modules"), join("profiles", PROFILE_NAME, "node_modules")];
// The deployment's installed dsh tree. Distinct from DSH_HOME only when DSH_HOME
// is a per-user cell home; in dev/desktop they are the same directory.
const SHARED_DSH_HOME = process.env.DSH_SHARED_HOME || join(homedir(), ".dsh");

export function ensureDshHome() {
  const profileDir = join(DSH_HOME, "profiles", PROFILE_NAME);
  mkdirSync(profileDir, { recursive: true });
  for (const file of SCAFFOLD_FILES) {
    const target = join(profileDir, file);
    if (!existsSync(target)) copyFileSync(join(TEMPLATE_DIR, file), target);
  }
  for (const dir of MODULE_LINK_DIRS) {
    const link = join(DSH_HOME, dir);
    const shared = join(SHARED_DSH_HOME, dir);
    if (existsSync(link) || resolve(shared) === resolve(link) || !existsSync(shared)) continue;
    try {
      symlinkSync(shared, link, "dir");
    } catch (err) {
      console.warn(`[dsh-profile] could not link shared dsh modules at ${dir}: ${err.message}`);
    }
  }
}

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
    // Relative command/args are authored against the repo root (where
    // mcp.json lives). The dsh child's cwd is the WORKSPACE and moves on
    // set_workspace, so pin the spawn cwd unless the config sets one — an
    // unpinned relative path breaks the moment the user switches folders.
    entry.config.cwd = config.cwd || process.cwd();
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
//   SQLite MCP table    — user edits via REST; overrides on collision (Task 4.1)
//
// userGroups (nullable array) role-filters DB rows stamped with
// requiredGroups: a gated row stays in the effective profile only while the
// profile user holds a matching group, so an identity-provider revocation
// lands on the next patch write with no record mutation. null (no
// authenticated identity — auth off) filters nothing.
//
// ownerEmail is the identity the effective profile is generated FOR. It
// resolves the credential of registry-origin servers (config.credentialRef):
// the Authorization header is read from that user's stored credential at each
// write — never from the installed record — so a refreshed token takes effect
// without reinstalling. No live credential ⇒ the server is omitted with a
// warning (same shape as the requiredGroups filter), and its record survives.
export async function writeMcpPatch({ mcpOverlay, userGroups = null, ownerEmail = null } = {}) {
  // 1. mcp.json (operator config, base layer).
  let mcpJsonServers = {};
  try {
    mcpJsonServers = JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf8")).mcpServers || {};
  } catch { /* no MCP config or parse error — MCP disabled via file */ }

  // Merge: mcp.json base → DB (enabled overrides, disabled drops).
  const servers = { ...mcpJsonServers };
  try {
    const db = await import("./db.js");
    if (db.isDbReady()) {
      const extensionStore = await import("./extension-store.js");
      for (const row of extensionStore.listMcpServers()) {
        if (row.enabled === false) { delete servers[row.name]; continue; }
        if (row.requiredGroups?.length && userGroups !== null &&
            !userGroups.some((g) => row.requiredGroups.includes(g))) {
          delete servers[row.name];
          continue;
        }
        servers[row.name] = row.config;
      }
    }
  } catch (e) {
    console.warn(`[dsh-profile] DB MCP read failed; mcp.json/OC only: ${e?.message || e}`);
  }

  // Resolve registry credentials before anything else looks at the config: a
  // server whose ref cannot be resolved must never reach toMcpClientEntry with
  // a placeholder header.
  const registryRefs = [];
  try {
    const credentials = await import("./registry-credentials.js");
    for (const [name, config] of Object.entries(servers)) {
      if (credentials.isRegistryRef(config)) registryRefs.push(name);
    }
    const token = registryRefs.length > 0 ? credentials.liveToken(ownerEmail) : null;
    if (token) {
      for (const name of registryRefs) {
        servers[name] = {
          ...servers[name],
          headers: { ...(servers[name].headers || {}), Authorization: `Bearer ${token}` },
        };
      }
    } else if (registryRefs.length > 0) {
      for (const name of registryRefs) delete servers[name];
      console.warn(
        `[dsh-profile] omitting ${registryRefs.length} registry MCP server(s) (${registryRefs.join(", ")}): no live market credential for ${ownerEmail || "the machine owner"}`,
      );
    }
  } catch (e) {
    // The ref is unresolvable for an unknown reason (import failure, DB error)
    // — omit every ref-carrying server rather than pass one through unauthenticated.
    console.warn(`[dsh-profile] registry credential resolution failed; omitting those servers: ${e?.message || e}`);
    for (const [name, config] of Object.entries(servers)) {
      if (config?.credentialRef) delete servers[name];
    }
  }

  // Apply the active identity's availability overlay after the global merge.
  // This changes only the runtime patch; extension_configs remains untouched.
  if (mcpOverlay && typeof mcpOverlay === "object") {
    for (const [name, enabled] of Object.entries(mcpOverlay)) {
      if (servers[name] && typeof enabled === "boolean" && !enabled) delete servers[name];
    }
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
  // Wrap entries in an `insert` list — a bare `{id, config}` is treated by
  // cordis-plugin-include as an override-by-id on an EXISTING entry, and since
  // these mcp-client entries don't exist in the base bundle they'd be warned +
  // skipped ("patch: entry "mcp-x" not found"). `insert` tells cordis to add
  // them as new loader entries. (The skills patch differs: skill-filesystem
  // DOES exist in the base bundle, so its override-by-id shape is correct.)
  atomicWriteTextSync(MCP_PATCH_PATH, yaml.dump([{ insert: entries }]));
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
  atomicWriteTextSync(SKILLS_PATCH_PATH, yaml.dump([entry]));
  console.log(`[dsh-profile] wrote skills patch (customSkillDirs: ${dirs.join(", ")}) → ${SKILLS_PATCH_PATH}`);
  return SKILLS_PATCH_PATH;
}

// ── Agent preset roster patch (dsh-agent-presets + preset bridge) ──────────────
// The dsh runtime composes agent presets (agent modes) through the
// @deepseek-ai/dsh-agent-presets roster service: it scans the SHIPPED preset
// root (config/agent-presets in the installed @deepseek-ai/dsh package) plus
// the user root (~/.dsh/.agent-presets, appended by the plugin's default
// includeUserRoot) and mounts the selected composition on each new session.
// The stock sdk-jsonrpc-server has zero preset awareness, so this generator
// also ships a small bridge plugin (dsh-profile-template/
// platform-preset-bridge.js, copied into the profile dir) that subclasses the
// SDK server: initialize carries the selected preset, session creation mounts
// it pre-publication, and a `presets/list` RPC serves the roster to the web
// picker. Everything rides one --patch overlay (presets.patch.yml):
//   - the stock `sdk-jsonrpc-server` row is disabled (a non-insert patch
//     cannot change a row's plugin name, and re-inserting the same id fails
//     the boot with "duplicate loader entry id" — so: disable + insert fresh);
//   - the `agent-presets` roster row is inserted (default `standard`, shipped
//     root at trust `system`);
//   - the bridge is inserted under a fresh `platform-sdk-server` row.
// Unresolvable shipped root → the whole overlay is skipped with a warning:
// chat still works on the bare host composition and the picker stays empty
// (graceful degradation, never a boot failure).
const PRESETS_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "presets.patch.yml");
const BRIDGE_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "dsh-profile-template", "platform-preset-bridge.js");
const PRESET_BRIDGE_FILE = "platform-preset-bridge.js";
const DEFAULT_AGENT_PRESET = "standard";

// Locate the installed @deepseek-ai/dsh package and return its shipped preset
// root (config/agent-presets), or null. The repo runtime cannot see the dsh
// package directly (it is not a dependency), so two anchors are tried: a
// repo-local install (createRequire from this module — the packaged-app
// layout) and the flat module fallback the dsh boot maintains for every
// profile ($DSH_HOME/profiles/node_modules/@deepseek-ai/dsh — the global
// install layout).
export function resolveShippedPresetRoot() {
  const anchors = [];
  try {
    anchors.push(join(dirname(createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json"))));
  } catch { /* not repo-local — expected with a global dsh install */ }
  anchors.push(join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "dsh"));
  for (const anchor of anchors) {
    const root = join(anchor, "config", "agent-presets");
    if (existsSync(root) && statSync(root).isDirectory()) return root;
  }
  return null;
}

// Write the bridge plugin file + presets.patch.yml into the profile dir.
// Returns the patch path for the bridge's --patch args, or null when the
// shipped preset root cannot be resolved (caller omits the flag).
export async function writePresetsPatch() {
  const presetRoot = resolveShippedPresetRoot();
  if (!presetRoot) {
    console.warn(
      `[dsh-profile] @deepseek-ai/dsh config/agent-presets not resolvable; skipping the agent-preset roster (picker stays empty, chat unaffected)`,
    );
    return null;
  }
  mkdirSync(dirname(PRESETS_PATCH_PATH), { recursive: true });
  // The bridge source is copied into the profile dir because the loader
  // resolves a relative plugin name beside the profile's cordis.yml.
  const bridgeTarget = join(dirname(PRESETS_PATCH_PATH), PRESET_BRIDGE_FILE);
  atomicWriteTextSync(bridgeTarget, readFileSync(BRIDGE_SOURCE, "utf8"));
  const patch = [
    { id: "sdk-jsonrpc-server", disabled: true },
    {
      insert: [
        {
          id: "agent-presets",
          name: "@deepseek-ai/dsh-agent-presets",
          config: {
            default: DEFAULT_AGENT_PRESET,
            roots: [{ path: presetRoot, trust: "system" }],
          },
        },
        { id: "platform-sdk-server", name: `./${PRESET_BRIDGE_FILE}` },
      ],
    },
  ];
  atomicWriteTextSync(PRESETS_PATCH_PATH, yaml.dump(patch));
  console.log(
    `[dsh-profile] wrote preset bridge + roster patch (default: ${DEFAULT_AGENT_PRESET}, shipped root: ${presetRoot}) → ${PRESETS_PATCH_PATH}`,
  );
  return PRESETS_PATCH_PATH;
}

// ── Permission preset bridge patch (add-permission-mode-selector) ─────────────
// The permission-mode selector rides the preset bridge: the composed
// dsh-permission-presets table (read-only / workspace-write / danger-full-access,
// default from DSH_PERMISSION_MODE) is exposed through a subclassed server.
// A cordis patch cannot rewrite an inserted row's plugin name (same constraint
// that made presets.patch.yml disable+insert), so this overlay disables the
// `platform-sdk-server` row and inserts `platform-permission-server` pointing
// at ./platform-permission-bridge.js — a subclass that adds permissions/list
// and permissions/set while inheriting the preset behavior. Ordering matters:
// the host passes presets.patch.yml BEFORE this file in --patch args.
const PERMISSIONS_PATCH_PATH = join(DSH_HOME, "profiles", PROFILE_NAME, "permissions.patch.yml");
const PERMISSION_BRIDGE_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "dsh-profile-template",
  "platform-permission-bridge.js",
);
const PERMISSION_BRIDGE_FILE = "platform-permission-bridge.js";

// Write the permission bridge file + permissions.patch.yml into the profile
// dir. Returns the patch path for the --patch args. The overlay is written
// unconditionally (the permission-presets plugin composes from the dsh-base
// bundle in every real deployment; an absent service degrades to an empty
// roster inside the bridge — the picker stays hidden, chat unaffected).
export async function writePermissionsPatch() {
  mkdirSync(dirname(PERMISSIONS_PATCH_PATH), { recursive: true });
  const bridgeTarget = join(dirname(PERMISSIONS_PATCH_PATH), PERMISSION_BRIDGE_FILE);
  atomicWriteTextSync(bridgeTarget, readFileSync(PERMISSION_BRIDGE_SOURCE, "utf8"));
  const patch = [
    { id: "platform-sdk-server", disabled: true },
    {
      insert: [{ id: "platform-permission-server", name: `./${PERMISSION_BRIDGE_FILE}` }],
    },
  ];
  atomicWriteTextSync(PERMISSIONS_PATCH_PATH, yaml.dump(patch));
  console.log(`[dsh-profile] wrote permission bridge patch → ${PERMISSIONS_PATCH_PATH}`);
  return PERMISSIONS_PATCH_PATH;
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
  // Thinking-level round-trip: an explicit effort lands as provider-level
  // `reasoning`, and a deepseek model declares its selectable levels.
  if (providers.volces) {
    const { providers: p2 } = await buildLlmProfile({ efforts: { volces: "high" } });
    const yamlDoc = yaml.load(yaml.dump({ "llm-pi-ai": { providers: p2 } }))["llm-pi-ai"].providers;
    const ds = yamlDoc.volces.models.find((m) => m.id.startsWith("deepseek-v4"));
    console.assert(yamlDoc.volces.reasoning === "high", "reasoning level did not round-trip");
    console.assert(ds && Object.keys(ds.reasoningEfforts).includes("high"), "deepseek model missing reasoningEfforts");
    console.assert(
      yamlDoc.volces.models.find((m) => m.id.startsWith("glm"))?.reasoningEfforts === false,
      "non-reasoning model should declare false",
    );
    console.log("OK reasoning effort round-trips");
  }
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
  // Preset roster patch self-check: proves the shipped-root resolution + shows
  // the generated overlay (null = unresolvable, warn-and-skip path).
  const presetsPatch = await writePresetsPatch();
  if (presetsPatch) {
    console.log(`--- presets patch (${presetsPatch}) ---`);
    console.log(readFileSync(presetsPatch, "utf8"));
  } else {
    console.log("presets patch skipped (shipped preset root unresolvable)");
  }
  // Permission bridge patch self-check.
  const permissionsPatch = await writePermissionsPatch();
  console.log(`--- permissions patch (${permissionsPatch}) ---`);
  console.log(readFileSync(permissionsPatch, "utf8"));
}
