// ── Chat history module (mirrored to SQLite) ─────────────────────────────────
//
// The dsh runtime persists chat sessions by id; SQLite is the store of record
// for the session list and read-only view APIs. This module MIRRORS each user
// prompt and assistant response into the project SQLite database as the turn
// progresses. List/view read from SQLite; the live agent is held by server.js.
//
// The `sm` (session manager) shim is set by server.js once the agent is created
// and exposes the minimum shape this module needs (getSessionId /
// getSessionFile / buildSessionContext) so the sidebar can flag the current
// session. Under dsh it is a thin shim around the dsh session id.
//
// Exposes:
//   - recordMessage(sessionId, role, content): mirror a turn into SQLite.
//   - listSessions(): SQLite sessions, merged with the in-memory current session.
//   - getSession(id): read a session's messages (SQLite, or live for current).
//   - currentSessionId(), getSessionPath(), messagesForClient(), etc.
//
// Switching/creating sessions mutates the live agent and is performed in
// server.js, which owns the agent session; this module owns read/convert/mirror
// operations.

import { promises as fs } from "node:fs";
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
  // Under dsh the session shim's buildSessionContext() is a no-op (returns no
  // messages), so the live branch would hand back an empty transcript for the
  // current session even though recordMessage has mirrored the turns into
  // SQLite. Fall through to SQLite when the live context is empty. (Under the
  // old pi runtime buildSessionContext returned the freshest in-memory state,
  // which is why the live branch existed.)
  if (id === currentSessionId()) {
    const ctx = sm?.buildSessionContext?.() ?? { messages: [] };
    const live = messagesForClient(ctx.messages);
    if (live.length) return { id, title: titleFromFirstUser(ctx.messages), messages: live };
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

// ── One-time legacy import ────────────────────────────────────────────────────
//
// Legacy chat-history-store/*.json sessions are imported straight into SQLite by
// migrate.js's importLegacySessions (it reads both sessions-store/*.jsonl and
// chat-history-store/*.json directly with stdlib fs). This module no longer
// round-trips them through an intermediate SDK-JSONL store, so it has no legacy
// import of its own — see migrate.js.
