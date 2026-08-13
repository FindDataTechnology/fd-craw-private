# Packaging MCP servers and skills into the app

When you build an installer (`npm run dist`) or bundle the app, you can **pre-install** MCP servers and **ship** skills so end users get them on first run — no setup, no editing `.env` or `mcp.json`. This is driven by the bundle manifest `platform.bundle.json` at the repo root, which is the single source of truth for what a build contains and is shipped inside the packaged app (see `electron-builder.js` `files:`).

The manifest has four keys. This doc covers the two for extensions — `mcpServers` and `skills` — plus the `permissions` that control them. (`components` selects heavyweight services; see the [Bundle manifest section in README](../README.md)).

```json
{
  "components": { "litellm": { "include": true }, "openconnector": { "include": true }, "postgres": { "include": "auto" } },
  "mcpServers": {},
  "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill"],
  "permissions": {}
}
```

> **Every consumer resolves this file through `resolveBundle()` in `bundle-manifest.js`** — nobody parses the JSON directly. An invalid manifest (bad JSON, unknown key, malformed permission key) fails the build scripts and makes the runtime log an error and fall back to the defaults (all components, no bundled extensions).

---

## 1. Packaging an MCP server

Add an entry under `mcpServers`. Each entry is a name → config map, with an optional `enabled` flag:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true
    },
    "my-http-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer secret" },
      "enabled": false
    }
  }
}
```

Each entry is one of:

| Field | Type | Meaning |
|---|---|---|
| `command` | string | **stdio** server — the binary to spawn (with optional `args`). One of `command` or `url` is required. |
| `url` | string | **http/SSE** server — the MCP endpoint. |
| `args` | string[] | CLI args for a `command` (stdio) server. |
| `headers` | object | HTTP headers for a `url` server (e.g. auth). |
| `enabled` | boolean | Seed state of the extension. `false` ships it **disabled** — visible in the Installed tab, off until the user turns it on. Defaults to `true`. |

### What happens at first run

1. `server.js` connects every enabled manifest server **before** the agent session is created, so their tools join the session tool allowlist (an MCP tool that fails to connect is skipped — never fatal).
2. Each entry is seeded into the extensions DB with `origin: "bundled"` and its `enabled` state, so it shows up in the **Extensions → Installed** tab like any installed extension.
3. Seeding is INSERT-OR-IGNORE: if the user has already edited or disabled that server, **their edits win** and are preserved across restarts and app upgrades.

### Rules and gotchas

- **`mcp.json` wins name collisions.** `mcp.json` is the operator's local config (gitignored); if a name exists in both, the `mcp.json` config is used and the bundled one is skipped.
- **Locking and tool scoping** go in the `permissions` map — see [section 3](#3-permissions-and-locking).
- **⚠️ Offline installs: prefer `url` servers or bundle the binary.** A `command`-based stdio server is spawned by name and, for `npx` packages, must download from the npm registry on the *end user's* first connect. A truly offline install has no registry access. For self-contained packaging either (a) use an `url`/http server, or (b) build the server's JS into `resources/` and point `command` at a binary that ships with the app. Nothing in the default manifest bundles a stdio MCP yet — this is the known limitation to watch.

---

## 2. Packaging skills

Skills are plain `SKILL.md` files (YAML frontmatter `name`/`description` + body) under `skills/<name>/`. **Every directory under `skills/` ships in the installer automatically** (`skills/**` is in `electron-builder.js` `files:`) — the manifest entry only marks the skill as *bundled* so it gets lock/permission semantics in the API.

### To add a new skill

1. Create `skills/<my-skill>/SKILL.md`:

```markdown
---
name: my-skill
description: What this skill does and when to use it. One or two sentences.
---

# My Skill

Body: instructions the agent expands and follows when invoked as `/skill:my-skill <args>`.
```

2. Add its name to the manifest `skills` array:

```json
{ "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill", "my-skill"] }
```

### What the manifest `skills` entry does

File skills are **not** DB rows — there's nothing to seed. Instead, `GET /api/extensions/skills` derives the extension metadata from the manifest:

- names in `skills` are reported with `origin: "bundled"` (vs `"file"` for other local skills),
- their `locked` / `permissions` come from `permissions["skill:<name>"]`,
- skills **not** in the manifest still work and ship — they're just ordinary editable file skills.

---

## 3. Permissions and locking

`permissions` is keyed `mcp:<name>` / `skill:<name>`, each with `{ allow?, deny?, locked? }`:

```json
{
  "permissions": {
    "mcp:memory":        { "locked": true },
    "mcp:my-http-server": { "allow": ["fetch*"], "deny": ["fetch:https://internal*"] },
    "skill:my-skill":    { "locked": true }
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `locked` | boolean | Makes the entry **immutable via the API** — DELETE / edit / enable-toggle return 400. Use to protect bundled defaults from being removed. |
| `allow` | string[] | Tool-name globs the extension may call. Stored now; enforced by the extension-tool-permissions work. |
| `deny` | string[] | Tool-name globs the extension may not call. Same enforcement status. |

---

## 4. Worked example

Ship a disabled-but-visible http MCP, a locked stdio MCP, and two new skills:

```json
{
  "components": { "litellm": { "include": true }, "openconnector": { "include": true }, "postgres": { "include": "auto" } },
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "enabled": true
    },
    "corp-gateway": {
      "url": "https://gateway.example.com/mcp",
      "headers": { "Authorization": "Bearer ${CORP_TOKEN}" },
      "enabled": false
    }
  },
  "skills": ["computer-file-system", "computer-process", "computer-shell", "example-skill", "my-skill", "team-skill"],
  "permissions": {
    "mcp:memory":   { "locked": true },
    "skill:team-skill": { "locked": true }
  }
}
```

Result on first run: the `memory` MCP is connected, seeded, and locked; `corp-gateway` appears disabled in Installed (turn it on in the UI, but note the header value is a static string from the manifest — server-side only, never the browser); `my-skill` and `team-skill` ship as bundled skills.

> Note: `${CORP_TOKEN}` is **not** env-interpolated by the manifest — it's a literal string. Put real tokens in `mcp.json` (operator config) or a secret-injecting proxy, not in a manifest that ships to every user. Prefer pointing `url` servers at endpoints that don't need per-user secrets, or document that `headers` are baked in.

---

## 5. Build and verify

```bash
npm run predist   # build the bundled resources for the resolved component set
npm run dist      # electron-builder → installers (mac .dmg / win .exe)
```

Manifest-aware knobs:

- `PLATFORM_BUNDLE_COMPONENTS=all|none|"openconnector,litellm"` — override component selection without editing the file (CI lean builds, local testing). `postgres` auto-includes whenever `litellm` is selected.
- `PLATFORM_BUNDLE_MANIFEST=/abs/path.json` — point the runtime at a different manifest file. Use this to **test your extensions manifest before shipping**:

```bash
# build a lean local run with a throwaway manifest and see the Installed tab seed it
PLATFORM_BUNDLE_MANIFEST=/tmp/test-bundle.json PLATFORM_BUNDLE_COMPONENTS=openconnector npm start
```

- CI: the release workflow's `workflow_dispatch` takes a `components` input (same syntax as `PLATFORM_BUNDLE_COMPONENTS`); lean dispatch builds upload artifacts with a `-lean` suffix.

---

## 6. Runtime reference

| Where | What |
|---|---|
| `platform.bundle.json` | Manifest (repo root in dev, inside `Resources/app/` when packaged). |
| `bundle-manifest.js` | `resolveBundle()` / `resolveBundleSafe()` — the only parser; validation, overrides, postgres auto-resolution. |
| `server.js` `initAgent()` | Connects enabled manifest `mcpServers` before session creation; seeds each into the extensions DB (`origin: "bundled"`, INSERT-OR-IGNORE). |
| `server.js` `/api/extensions/*` | Extensions management API — list/add/edit/delete MCP configs and custom skills. Locked bundled entries reject mutation with 400. |
| `extension-store.js` | DB layer (`seedMcpServer`, `seedExtensionConfig`); `origin` / `locked` / `permissions` columns. |
| `electron-builder.js` | Ships `platform.bundle.json` + `skills/**`; `extraResources` for bundled components. |
| Spec | `openspec/specs/bundle-manifest/spec.md` (formal requirements + scenarios). |
