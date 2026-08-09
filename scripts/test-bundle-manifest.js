#!/usr/bin/env node
// ── Unit checks for bundle-manifest.js (plain assertions, no test runner) ────
// Run: node scripts/test-bundle-manifest.js  (exit 1 on first failure)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { resolveBundle, resolveBundleSafe, BundleManifestError, MANIFEST_FILENAME } from "../bundle-manifest.js";

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}: ${err.message}`);
    process.exit(1);
  }
}

function withManifest(json, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
  try {
    if (json !== undefined) fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(json));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const NO_ENV = {}; // no PLATFORM_BUNDLE_COMPONENTS

// ── Missing manifest → legacy all-components defaults ────────────────────────
check("missing manifest → all components, empty extensions", () => {
  withManifest(undefined, (dir) => {
    const b = resolveBundle({ env: NO_ENV, projectRoot: dir });
    assert.deepEqual(b.components, { litellm: true, openconnector: true, postgres: true });
    assert.deepEqual(b.mcpServers, {});
    assert.deepEqual(b.skills, []);
    assert.deepEqual(b.permissions, {});
    assert.equal(b.manifestPresent, false);
  });
});

// ── Repo default manifest → byte-equivalent to today ─────────────────────────
check("repo default manifest → all components selected", () => {
  const b = resolveBundle({ env: NO_ENV });
  assert.deepEqual(b.components, { litellm: true, openconnector: true, postgres: true });
  assert.equal(b.manifestPresent, true);
  assert.ok(b.skills.includes("computer-shell"));
});

// ── postgres "auto" follows litellm ──────────────────────────────────────────
check('postgres "auto" follows litellm (on)', () => {
  withManifest({ components: { litellm: { include: true }, postgres: { include: "auto" } } }, (dir) => {
    assert.equal(resolveBundle({ env: NO_ENV, projectRoot: dir }).components.postgres, true);
  });
});
check('postgres "auto" follows litellm (off)', () => {
  withManifest({ components: { litellm: { include: false }, postgres: { include: "auto" } } }, (dir) => {
    assert.equal(resolveBundle({ env: NO_ENV, projectRoot: dir }).components.postgres, false);
  });
});
check("postgres explicit false honored", () => {
  withManifest({ components: { litellm: { include: false }, postgres: { include: false } } }, (dir) => {
    assert.equal(resolveBundle({ env: NO_ENV, projectRoot: dir }).components.postgres, false);
  });
});

// ── Env override ─────────────────────────────────────────────────────────────
check("override 'none' deselects everything", () => {
  const b = resolveBundle({ env: { PLATFORM_BUNDLE_COMPONENTS: "none" } });
  assert.deepEqual(b.components, { litellm: false, openconnector: false, postgres: false });
});
check("override 'all' selects everything", () => {
  withManifest({ components: { litellm: { include: false } } }, (dir) => {
    const b = resolveBundle({ env: { PLATFORM_BUNDLE_COMPONENTS: "all" }, projectRoot: dir });
    assert.deepEqual(b.components, { litellm: true, openconnector: true, postgres: true });
  });
});
check("override comma list selects only listed; litellm drags postgres", () => {
  const b = resolveBundle({ env: { PLATFORM_BUNDLE_COMPONENTS: "openconnector, litellm" } });
  assert.deepEqual(b.components, { litellm: true, openconnector: true, postgres: true });
});
check("override 'openconnector' excludes litellm+postgres", () => {
  const b = resolveBundle({ env: { PLATFORM_BUNDLE_COMPONENTS: "openconnector" } });
  assert.deepEqual(b.components, { litellm: false, openconnector: true, postgres: false });
});
check("unknown override component throws", () => {
  assert.throws(() => resolveBundle({ env: { PLATFORM_BUNDLE_COMPONENTS: "bogus" } }), BundleManifestError);
});

// ── Manifest path override ────────────────────────────────────────────────────
check("PLATFORM_BUNDLE_MANIFEST redirects the manifest path", () => {
  withManifest(undefined, (dir) => {
    const alt = path.join(dir, "alt.json");
    fs.writeFileSync(alt, JSON.stringify({ skills: ["example-skill"], permissions: { "skill:example-skill": { locked: true } } }));
    const b = resolveBundle({ env: { PLATFORM_BUNDLE_MANIFEST: alt }, projectRoot: dir });
    assert.equal(b.manifestPath, alt);
    assert.equal(b.manifestPresent, true);
    assert.deepEqual(b.skills, ["example-skill"]);
    assert.equal(b.permissions["skill:example-skill"].locked, true);
  });
});
check("PLATFORM_BUNDLE_MANIFEST pointing nowhere → manifest absent", () => {
  withManifest(undefined, (dir) => {
    const b = resolveBundle({ env: { PLATFORM_BUNDLE_MANIFEST: path.join(dir, "nope.json") }, projectRoot: dir });
    assert.equal(b.manifestPresent, false);
  });
});

// ── Invalid manifests throw (build-time) ─────────────────────────────────────
check("invalid JSON throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
  try {
    fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), "{not json");
    assert.throws(() => resolveBundle({ env: NO_ENV, projectRoot: dir }), BundleManifestError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check("unknown top-level key throws", () => {
  withManifest({ bogus: {} }, (dir) => {
    assert.throws(() => resolveBundle({ env: NO_ENV, projectRoot: dir }), BundleManifestError);
  });
});
check("unknown component throws", () => {
  withManifest({ components: { redis: { include: true } } }, (dir) => {
    assert.throws(() => resolveBundle({ env: NO_ENV, projectRoot: dir }), BundleManifestError);
  });
});
check('"auto" on non-postgres throws', () => {
  withManifest({ components: { litellm: { include: "auto" } } }, (dir) => {
    assert.throws(() => resolveBundle({ env: NO_ENV, projectRoot: dir }), BundleManifestError);
  });
});
check("mcpServers entry without command/url throws", () => {
  withManifest({ mcpServers: { bad: { args: [] } } }, (dir) => {
    assert.throws(() => resolveBundle({ env: NO_ENV, projectRoot: dir }), BundleManifestError);
  });
});
check("permissions key without mcp:/skill: prefix throws", () => {
  withManifest({ permissions: { "fetch": { locked: true } } }, (dir) => {
    assert.throws(() => resolveBundle({ env: NO_ENV, projectRoot: dir }), BundleManifestError);
  });
});

// ── resolveBundleSafe never throws ───────────────────────────────────────────
check("resolveBundleSafe falls back on invalid manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-test-"));
  try {
    fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), "{not json");
    let warned = false;
    const b = resolveBundleSafe({ env: NO_ENV, projectRoot: dir, log: () => { warned = true; } });
    assert.deepEqual(b.components, { litellm: true, openconnector: true, postgres: true });
    assert.equal(warned, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Full manifest shape passes through ───────────────────────────────────────
check("mcpServers/skills/permissions pass through resolved", () => {
  withManifest({
    mcpServers: { fetch: { command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"], enabled: true } },
    skills: ["computer-shell"],
    permissions: { "mcp:fetch": { allow: ["*"], deny: [] }, "skill:computer-shell": { locked: true } },
  }, (dir) => {
    const b = resolveBundle({ env: NO_ENV, projectRoot: dir });
    assert.equal(b.mcpServers.fetch.command, "npx");
    assert.deepEqual(b.skills, ["computer-shell"]);
    assert.equal(b.permissions["skill:computer-shell"].locked, true);
  });
});

console.log(`\n${passed} checks passed.`);
