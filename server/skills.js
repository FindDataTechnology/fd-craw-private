// Slash-command parsing + skill-file helpers shared by the WS prompt
// dispatcher (server/ws.js) and the extensions routes. Pure functions except
// expandDocRefs, which reads the documents service through ctx.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";

// Parse a leading slash-command from a prompt. Returns one of:
//   { command: "skill", name, args }   - /skill:<name> [args]
//   { command: "model", args }          - /model [id]
//   { command: "new" | "clear" | "help", args: "" }
//   { command: null }                   - a "/…" token that is NOT a recognised
//                                         command (caller lets it fall through to
//                                         the agent as a normal prompt)
//   null                                - not a slash-command at all
// `/clear` and `/help` are client-handled (the UI should not forward them); if
// they reach the server they are treated as no-ops.
export function parseCommand(text) {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const skillMatch = t.match(/^\/skill:([^\s]+)(?:[\s]+([\s\S]*))?$/);
  if (skillMatch) {
    return { command: "skill", name: skillMatch[1], args: (skillMatch[2] || "").trim() };
  }
  const modelMatch = t.match(/^\/model(?:[\s]+([\s\S]*))?$/i);
  if (modelMatch) {
    return { command: "model", args: (modelMatch[1] || "").trim() };
  }
  const simpleMatch = t.match(/^\/(new|clear|help)\b/i);
  if (simpleMatch) {
    return { command: simpleMatch[1].toLowerCase(), args: "" };
  }
  return { command: null };
}

// Read a SKILL.md file, strip YAML frontmatter, and combine with the user's args.
export async function expandSkillContent(skill, args) {
  const raw = await readFile(skill.filePath, "utf8");
  const body = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
  const argSection = args ? `\n\n## Arguments\n${args}` : "";
  return `${body}${argSection}`;
}

// Expand @doc:<id> reference tokens into the ingested document's source text so
// the agent sees the attachment content in context (design D4). Mirrors how
// /skill: tokens are expanded before session.prompt(). Unknown/missing ids are
// replaced with a short note so the prompt stays coherent. No new dependency —
// reuses documents.getDocumentContent (the same path /api/documents/:id serves).
export async function expandDocRefs(ctx, text) {
  if (!text.includes("@doc:")) return text;
  const refs = [...text.matchAll(/@doc:([A-Za-z0-9_-]+)/g)];
  if (!refs.length) return text;
  let out = text;
  for (const m of refs) {
    const id = m[1];
    // Prefix fetch at the SQL layer (12k budget — same slice the caller
    // applied before, without loading the full column).
    let body;
    try { body = ctx.db.getDocumentPrefix(id, 12000); }
    catch (e) { console.warn(`[doc] @doc:${id} lookup failed: ${e.message}`); }
    const snippet = body && body.trim()
      ? body.trim()
      : `(document ${id} is unavailable or empty)`;
    out = out.replaceAll(m[0], `\n\n--- attached document ${id} ---\n${snippet}\n--- end document ${id} ---\n`);
  }
  return out;
}

// Scan the project skills/ dir (dir bundles `<name>/SKILL.md` + flat `<name>.md`)
// for [{name, description, filePath}]. list_skills + /skill: expansion source
// the same dir the skill-filesystem plugin's customSkillDirs points at (Task 5.3).
// ponytail: regex frontmatter parse + no caching (4 files, called rarely); a
// multi-line/quoted description or a hot list_skills path needs a real parser + cache.
export function getFileSkills(dir = path.resolve("skills")) {
  let entries;
  try { entries = readdirSync(dir); } catch { return []; }
  const skills = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    const filePath = st.isDirectory() ? path.join(full, "SKILL.md") : (entry.endsWith(".md") ? full : null);
    if (!filePath) continue;
    let raw;
    try { raw = readFileSync(filePath, "utf8"); } catch { continue; }
    const block = raw.match(/^---[\s\S]*?---/)?.[0];
    if (!block) continue;
    const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const desc = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (!name) continue;
    skills.push({ name, description: desc || "", filePath });
  }
  return skills;
}
