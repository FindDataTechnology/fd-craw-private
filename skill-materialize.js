// skill-materialize.js — DB custom skills → SKILL.md files in a watched dir.
//
// dsh-skill-filesystem Chokidar-watches every dir in its customSkillDirs and
// hot-reloads SKILL.md add/change/unlink live (no process restart). The DB is
// the durable store; this module mirrors each custom_skills row into a
// <name>/SKILL.md under the materialization dir so the agent sees DB skills
// exactly like file skills — at startup AND on runtime CRUD.
//
// Atomic writes (temp+rename) match documents.js / writeMcpPatch. The dir is a
// runtime artifact under PLATFORM_DATA_DIR (gitignored), rebuilt idempotently
// from the DB on startup.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextSync } from "./lib/persistence.js";
import { storeDir } from "./paths.js";

const MATERIALIZE_DIR = storeDir("custom-skills");

// Sanitize a skill name into a safe filesystem segment. dsh-skill-filesystem
// keys skills off the frontmatter `name`, not the dir, so the dir name only
// needs to be filesystem-safe and stable across writes.
function safeDir(name) {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

function skillFilePath(name) {
  return join(MATERIALIZE_DIR, safeDir(name), "SKILL.md");
}

// Render a custom_skills row into a SKILL.md the filesystem plugin can load.
// The body is the user's `content`; the frontmatter carries name+description.
function renderSkillMd({ name, description, content }) {
  const desc = (description || "").replace(/\n/g, " ");
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${content || ""}\n`;
}

// Write one skill's SKILL.md atomically (temp+rename). Returns true on success.
export function writeSkill(skill) {
  if (!skill || !skill.name) return false;
  if (skill.enabled === false) {
    removeSkill(skill.name);
    return true;
  }
  const file = skillFilePath(skill.name);
  atomicWriteTextSync(file, renderSkillMd(skill));
  return true;
}

// Remove one skill's materialized dir (Chokidar fires unlink → hot-remove).
export function removeSkill(name) {
  const dir = join(MATERIALIZE_DIR, safeDir(name));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

// Rebuild the whole materialization dir from the DB: wipe stale entries, write
// every enabled row. Idempotent — safe to call on every startup. Returns the
// list of skills that failed to write (caller may retry).
export function rebuildFromDb(listCustomSkills) {
  let failures = [];
  mkdirSync(MATERIALIZE_DIR, { recursive: true });
  // Wipe stale materialized dirs not backed by a current DB row.
  const live = new Set((listCustomSkills() || []).map((s) => safeDir(s.name)));
  let entries = [];
  try { entries = readdirSync(MATERIALIZE_DIR); } catch { /* dir absent */ }
  for (const entry of entries) {
    if (!live.has(entry)) {
      try { rmSync(join(MATERIALIZE_DIR, entry), { recursive: true, force: true }); }
      catch { /* best-effort */ }
    }
  }
  for (const skill of listCustomSkills() || []) {
    try {
      if (!writeSkill(skill)) failures.push(skill.name);
    } catch (e) {
      console.warn(`[skill-materialize] write failed for "${skill.name}": ${e.message}`);
      failures.push(skill.name);
    }
  }
  return { dir: MATERIALIZE_DIR, failures };
}

export { MATERIALIZE_DIR };
