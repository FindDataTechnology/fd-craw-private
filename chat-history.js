// ── Chat history module (SDK sessions, mirrored to SQLite) ───────────────────
//
// The pi SDK's `SessionManager` remains the live agent's context store (JSONL
// under SESSIONS_DIR) and the source for resume/switch - it is a sealed,
// file-based SDK class that cannot be replaced. This module MIRRORS each user
// prompt and assistant response into the project SQLite database as the turn
// progresses, making SQLite the store of record for the session list and
// read-only view APIs. List/view/path read from SQLite; resume/switch use the
// SDK's JSONL via the stored `path`.
//
// Exposes:
//   - recordMessage(sessionId, role, content): mirror a turn into SQLite.
//   - listSessions(): SQLite sessions, merged with the in-memory current session.
//   - getSession(id): read a session's messages (SQLite, or live for current).
//   - currentSessionId(), getSessionPath(), messagesForClient(), etc.
//
// Switching/creating sessions mutates the live agent (session.sessionManager +
// agent.state.messages) and is performed in server.js, which owns the agent
// session; this module owns read/convert/mirror operations.

import { SessionManager, buildSessionContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as db from "./db.js";
import { storeDir } from "./paths.js";

const TITLE_MAX = 60;

let SESSIONS_DIR = storeDir("sessions-store");
// The live agent's SessionManager (set by server.js once the agent is created).
let sm = null;

export async function initChatHistory() {
  SESSIONS_DIR = storeDir("sessions-store", process.env.SESSIONS_STORE_DIR);
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

export function setSessionManager(sessionManager) {
  sm = sessionManager;
}

export function getSessionsDir() {
  return SESSIONS_DIR;
}

// ── Message conversion ───────────────────────────────────────────────────────

// Extract a plain-text transcript from an SDK AgentMessage's content (which may be
// a string or an array of TextContent / ThinkingContent / ToolCall / ImageContent
// blocks). Thinking and tool-call blocks are omitted from the displayed transcript;
// the live agent still receives the full structured messages for context continuity.
export function extractMessageText(msg) {
  const c = msg?.content;
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (b == null) return "";
        if (typeof b === "string") return b;
        if (b.type === "text") return b.text || "";
        return ""; // skip thinking / toolCall / image
      })
      .join("\n")
      .trim();
  }
  return "";
}

// Convert SDK AgentMessage[] to the {role, content} form the UI renders. Only user
// and assistant text turns are included in the displayed transcript.
export function messagesForClient(agentMessages) {
  if (!Array.isArray(agentMessages)) return [];
  return agentMessages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: extractMessageText(m) }));
}

function truncateTitle(s) {
  const t = (s || "").trim().replace(/[\r\n]+/g, " ");
  if (!t) return "";
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + "…" : t;
}

function titleFromFirstUser(messages) {
  const first = messages.find((m) => m?.role === "user");
  return truncateTitle(extractMessageText(first)) || "New chat";
}

function toIso(d) {
  if (!d) return null;
  if (typeof d === "string") return d;
  if (d instanceof Date) return d.toISOString();
  if (typeof d.toISOString === "function") return d.toISOString();
  return String(d);
}

// ── Mirroring ────────────────────────────────────────────────────────────────

// Mirror a single turn (user prompt or assistant response) for the current
// session into SQLite. Creates the session row on first message (title derived
// from the first user message; path from the SDK session file), then appends the
// message. No-op when the DB is unavailable (chat stays in-memory).
export function recordMessage(sessionId, role, content) {
  if (!sessionId || !db.isDbReady()) return;
  const now = new Date().toISOString();
  const path = sm?.getSessionFile?.() ?? null;

  if (!db.sessionExists(sessionId)) {
    const title = role === "user" ? truncateTitle(content) || "New chat" : "New chat";
    db.upsertSession(sessionId, title, now, now, path);
  } else {
    db.touchSession(sessionId, now);
    if (path) db.setSessionPath(sessionId, path);
  }
  db.appendMessage(sessionId, role, content || "", now);
}

// ── Listing ──────────────────────────────────────────────────────────────────

// Return session metadata (no message bodies), most-recently-updated first, with
// the current session flagged. Sourced from SQLite, merged with the in-memory
// current session so a brand-new (not-yet-mirrored) chat still appears.
export async function listSessions() {
  const currentId = sm?.getSessionId?.() ?? null;

  let sessions = [];
  if (db.isDbReady()) {
    sessions = db.listChatSessions().map((s) => ({
      id: s.id,
      title: s.title || "Untitled",
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount ?? 0,
      path: s.path || null,
    }));
  }

  // Merge the current in-memory session if it isn't in SQLite yet (brand-new
  // chat before its first mirrored message).
  if (currentId && !sessions.some((s) => s.id === currentId)) {
    const ctx = sm?.buildSessionContext?.() ?? { messages: [] };
    sessions.push({
      id: currentId,
      title: titleFromFirstUser(ctx.messages),
      createdAt: null,
      updatedAt: null,
      messageCount: ctx.messages.length,
      path: sm?.getSessionFile?.() ?? null,
    });
  }

  for (const s of sessions) s.current = s.id === currentId;
  sessions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return sessions;
}

export function currentSessionId() {
  return sm?.getSessionId?.() ?? null;
}

// ── Read-only session access ─────────────────────────────────────────────────

// Return a single session's messages by id (read-only; does not touch the live
// agent). Reads from SQLite; falls back to the in-memory current session if the
// id is the current unflushed session.
export async function getSession(id) {
  if (!id) return null;
  if (id === currentSessionId()) {
    const ctx = sm?.buildSessionContext?.() ?? { messages: [] };
    return { id, title: titleFromFirstUser(ctx.messages), messages: messagesForClient(ctx.messages) };
  }
  if (!db.isDbReady()) return null;
  const meta = db.getSessionMeta(id);
  if (!meta) return null;
  const messages = db.getChatMessages(id);
  return { id, title: meta.title || "Untitled", messages };
}

// Resolve a session's on-disk JSONL file path by id (used when switching the
// live agent via the SDK). Sourced from SQLite.
export async function getSessionPath(id) {
  if (!id) return null;
  if (id === currentSessionId()) return sm?.getSessionFile?.() ?? null;
  return db.getSessionPath(id);
}

// ── One-time legacy import (chat-history-store -> SDK sessions) ──────────────
//
// On first run (when the SDK sessions store has no sessions yet), import each
// chat-history-store/*.json session into the SDK session store so existing
// conversations are not lost. These then flow into SQLite via migrate.js's
// sessions-store import. Per-session failures are logged and skipped; the legacy
// dir is left intact as a backup.
export async function importLegacySessions() {
  const legacyDir = storeDir("chat-history-store", process.env.CHAT_HISTORY_STORE_DIR);
  let files = [];
  try {
    files = await fs.readdir(legacyDir);
  } catch {
    return 0; // no legacy store
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  if (!jsonFiles.length) return 0;

  // Skip if the new store already has sessions (already imported, or in use).
  let existing = [];
  try {
    existing = await SessionManager.list(process.cwd(), SESSIONS_DIR);
  } catch {
    // ignore
  }
  if (existing.length) return 0;

  let imported = 0;
  for (const f of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(legacyDir, f), "utf8");
      const s = JSON.parse(raw);
      const msgs = Array.isArray(s.messages) ? s.messages : [];
      if (!msgs.length) continue;
      const tmp = SessionManager.create(process.cwd(), SESSIONS_DIR);
      let hasAssistant = false;
      for (const m of msgs) {
        if (m.role === "user") {
          tmp.appendMessage({ role: "user", content: String(m.content || ""), timestamp: Date.now() });
        } else if (m.role === "assistant") {
          hasAssistant = true;
          tmp.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: String(m.content || "") }],
            api: "openai-completions",
            provider: "volces",
            model: "legacy",
            usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          });
        }
      }
      if (hasAssistant) imported++; // only sessions that flushed a file count
    } catch (err) {
      console.warn(`[chat-history] legacy import skipped ${f}: ${err.message}`);
    }
  }
  if (imported) console.log(`[chat-history] Imported ${imported} legacy session(s) from ${legacyDir}`);
  return imported;
}
