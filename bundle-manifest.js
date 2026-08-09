// ── Bundle manifest: single source of truth for packaging-time selection ─────
//
// `platform.bundle.json` (repo root, shipped inside the packaged app) declares:
//   - components:   which heavyweight services get built + bundled
//                   (litellm / openconnector / postgres; postgres "auto" follows litellm)
//   - mcpServers:   MCP servers pre-installed at first run (origin "bundled")
//   - skills:       names of skills/ entries marked as bundled at first run
//   - permissions:  per-extension policy keyed "mcp:<name>" / "skill:<name>"
//                   ({ allow?, deny?, locked? }) — stored now, enforced by the
//                   extension-tool-permissions change.
//
// Every consumer (build scripts, electron-builder config, first-run, supervisor)
// resolves through resolveBundle() — nobody else parses the JSON.
//
// Override component selection without editing the file:
//   PLATFORM_BUNDLE_COMPONENTS=all | none | "openconnector,litellm"
// (postgres auto-included whenever litellm is selected — bundled LiteLLM needs it.)
// Override the manifest file location (tests, side-by-side manifests):
//   PLATFORM_BUNDLE_MANIFEST=/abs/path/to/manifest.json
//
// Error model: resolveBundle() THROWS BundleManifestError on an invalid manifest
// or override (build scripts let this fail the build). Runtime callers use
// resolveBundleSafe(), which falls back to DEFAULTS with a warning so a corrupt
// manifest never prevents the app from starting (graceful degradation).

import fs from "node:fs";
import path from "node:path";

export const MANIFEST_FILENAME = "platform.bundle.json";

const COMPONENT_NAMES = ["litellm", "openconnector", "postgres"];
const TOP_LEVEL_KEYS = ["components", "mcpServers", "skills", "permissions"];
const PERMISSION_KEY_RE = /^(mcp|skill):[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Missing manifest = legacy behavior: every component bundled, no pre-installed
// extensions, no locks.
export const DEFAULTS = Object.freeze({
  components: Object.freeze({ litellm: true, openconnector: true, postgres: true }),
  mcpServers: Object.freeze({}),
  skills: Object.freeze([]),
  permissions: Object.freeze({}),
});

export class BundleManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BundleManifestError";
  }
}

function fail(msg) {
  throw new BundleManifestError(`platform.bundle.json: ${msg}`);
}

function validateComponents(raw) {
  if (raw === undefined) return { litellm: { include: true }, openconnector: { include: true }, postgres: { include: "auto" } };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail('"components" must be an object');
  for (const key of Object.keys(raw)) {
    if (!COMPONENT_NAMES.includes(key)) fail(`unknown component "${key}" (known: ${COMPONENT_NAMES.join(", ")})`);
    const include = raw[key]?.include;
    if (include !== true && include !== false && include !== "auto") {
      fail(`components.${key}.include must be true, false, or "auto"`);
    }
    if (include === "auto" && key !== "postgres") fail(`components.${key}.include: "auto" is only valid for postgres`);
  }
  return raw;
}

function validateMcpServers(raw) {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail('"mcpServers" must be an object');
  for (const [name, cfg] of Object.entries(raw)) {
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) fail(`mcpServers."${name}" must be an object`);
    const isStdio = typeof cfg.command === "string";
    const isHttp = typeof cfg.url === "string";
    if (!isStdio && !isHttp) fail(`mcpServers."${name}" needs a "command" (stdio) or "url" (http)`);
    if (cfg.enabled !== undefined && typeof cfg.enabled !== "boolean") fail(`mcpServers."${name}".enabled must be a boolean`);
  }
  return raw;
}

function validateSkills(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) fail('"skills" must be an array of skill-name strings');
  return raw;
}

function validatePermissions(raw) {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail('"permissions" must be an object');
  for (const [key, policy] of Object.entries(raw)) {
    if (!PERMISSION_KEY_RE.test(key)) fail(`permissions key "${key}" must look like "mcp:<name>" or "skill:<name>"`);
    if (typeof policy !== "object" || policy === null || Array.isArray(policy)) fail(`permissions."${key}" must be an object`);
    for (const list of ["allow", "deny"]) {
      if (policy[list] !== undefined && (!Array.isArray(policy[list]) || policy[list].some((g) => typeof g !== "string"))) {
        fail(`permissions."${key}".${list} must be an array of tool-name globs`);
      }
    }
    if (policy.locked !== undefined && typeof policy.locked !== "boolean") fail(`permissions."${key}".locked must be a boolean`);
  }
  return raw;
}

// Apply PLATFORM_BUNDLE_COMPONENTS to the manifest's component map and resolve
// "auto"/absent postgres (bundled iff litellm is bundled — the LiteLLM child
// stores its DB in the bundled Postgres).
function resolveComponents(manifestComponents, env) {
  const override = (env.PLATFORM_BUNDLE_COMPONENTS ?? "").trim();
  const selected = { litellm: true, openconnector: true, postgres: "auto" };
  for (const [name, cfg] of Object.entries(manifestComponents)) selected[name] = cfg.include;

  let resolved;
  if (!override) {
    resolved = {
      litellm: selected.litellm === true,
      openconnector: selected.openconnector === true,
      postgres: selected.postgres === "auto" ? selected.litellm === true : selected.postgres === true,
    };
  } else if (override === "all") {
    resolved = { litellm: true, openconnector: true, postgres: true };
  } else if (override === "none") {
    resolved = { litellm: false, openconnector: false, postgres: false };
  } else {
    const names = override.split(",").map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      if (!COMPONENT_NAMES.includes(name)) {
        fail(`PLATFORM_BUNDLE_COMPONENTS: unknown component "${name}" (known: ${COMPONENT_NAMES.join(", ")}, all, none)`);
      }
    }
    resolved = {
      litellm: names.includes("litellm"),
      openconnector: names.includes("openconnector"),
      postgres: names.includes("postgres") || names.includes("litellm"),
    };
  }
  if (resolved.litellm && !resolved.postgres) {
    // Allowed (external DATABASE_URL at runtime) but almost always a mistake.
    console.warn("[bundle] WARNING: litellm is bundled without postgres — bundled LiteLLM needs an external DATABASE_URL at runtime");
  }
  return resolved;
}

/**
 * Resolve the bundle manifest. Throws BundleManifestError on invalid input.
 * @param {Object} opts
 * @param {Object} [opts.env] - environment (defaults to process.env)
 * @param {string} [opts.projectRoot] - dir containing platform.bundle.json (defaults to repo root)
 * @returns {{components: {litellm: boolean, openconnector: boolean, postgres: boolean},
 *            mcpServers: Object, skills: string[], permissions: Object,
 *            manifestPath: string, manifestPresent: boolean}}
 */
export function resolveBundle({ env = process.env, projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname)) } = {}) {
  const envManifest = (env.PLATFORM_BUNDLE_MANIFEST ?? "").trim();
  const manifestPath = envManifest ? path.resolve(envManifest) : path.join(projectRoot, MANIFEST_FILENAME);
  let raw = {};
  let manifestPresent = false;
  if (fs.existsSync(manifestPath)) {
    manifestPresent = true;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      fail(`invalid JSON — ${err.message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("top level must be an object");
    for (const key of Object.keys(parsed)) {
      if (!TOP_LEVEL_KEYS.includes(key)) fail(`unknown top-level key "${key}" (known: ${TOP_LEVEL_KEYS.join(", ")})`);
    }
    raw = parsed;
  }

  const manifestComponents = validateComponents(raw.components);
  const mcpServers = validateMcpServers(raw.mcpServers);
  const skills = validateSkills(raw.skills);
  const permissions = validatePermissions(raw.permissions);
  const components = resolveComponents(manifestComponents, env);

  return { components, mcpServers, skills, permissions, manifestPath, manifestPresent };
}

/**
 * Runtime-safe variant: on ANY manifest error, log a clear warning and return
 * the legacy defaults (all components, no bundled extensions). Never throws.
 */
export function resolveBundleSafe({ env = process.env, projectRoot, log = console.warn } = {}) {
  try {
    return resolveBundle({ env, ...(projectRoot ? { projectRoot } : {}) });
  } catch (err) {
    log(`[bundle] ${err.message} — falling back to all-components defaults`);
    const envManifest = (env.PLATFORM_BUNDLE_MANIFEST ?? "").trim();
    return {
      components: { ...DEFAULTS.components },
      mcpServers: {},
      skills: [],
      permissions: {},
      manifestPath: envManifest
        ? path.resolve(envManifest)
        : path.join(projectRoot ?? path.resolve(path.dirname(new URL(import.meta.url).pathname)), MANIFEST_FILENAME),
      manifestPresent: false,
    };
  }
}
