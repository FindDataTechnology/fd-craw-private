// ── Legacy data migration importer ───────────────────────────────────────────
//
// One-time import of the project's legacy file-based stores into the SQLite
// project database, run at startup when the DB is fresh (empty). Each import is
// idempotent (skipped if the DB already has data / ids) and never deletes the
// legacy stores - they remain on disk as a backup / migration source.
//
//   - documents-store/manifest.json + per-doc source.txt  ->  documents
//       Ready docs are marked `queued` so the indexing pipeline re-indexes them
//       through PageIndex from their imported source_text (the old LlamaIndex
//       SummaryIndex is incompatible). Other statuses are preserved.
//   - sessions-store/*.jsonl (SDK SessionManager)          ->  chat_sessions +
//       chat_messages, mirroring user/assistant turns.
//
// Per-item failures are logged and skipped; they never block startup.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  SessionManager,
  parseSessionEntries,
  buildSessionContext,
} from "@earendil-works/pi-coding-agent";
import * as db from "./db.js";
import { extractMessageText } from "./chat-history.js";

const TITLE_MAX = 60;

function truncateTitle(s) {
  const t = (s || "").trim().replace(/[\r\n]+/g, " ");
  if (!t) return "New chat";
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) + "…" : t;
}

function toIso(d) {
  if (!d) return new Date().toISOString();
  if (typeof d === "string") return d;
  if (d instanceof Date) return d.toISOString();
  if (typeof d.toISOString === "function") return d.toISOString();
  return String(d);
}

// ── Documents ────────────────────────────────────────────────────────────────

export async function importLegacyDocuments() {
  if (!db.isDbReady()) return 0;
  if (db.countDocuments() > 0) return 0; // not fresh

  const storeDir = process.env.DOCUMENTS_STORE_DIR
    ? path.resolve(process.env.DOCUMENTS_STORE_DIR)
    : path.resolve("documents-store");
  const manifestPath = path.join(storeDir, "manifest.json");

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return 0; // no legacy document store
  }

  const docs = Array.isArray(manifest.documents) ? manifest.documents : [];
  let imported = 0;
  for (const d of docs) {
    try {
      let sourceText = null;
      try {
        sourceText = await fs.readFile(path.join(storeDir, d.id, "source.txt"), "utf8");
      } catch {
        /* source may be missing for non-ready docs */
      }
      // Ready docs must be re-indexed through PageIndex; the old LlamaIndex
      // SummaryIndex is incompatible. Other statuses are preserved as-is.
      const status = d.status === "ready" ? "queued" : d.status || "queued";
      db.upsertDocument({
        id: d.id,
        name: d.name,
        type: d.type,
        status,
        added_at: d.addedAt || toIso(),
        error: d.error ?? null,
        source_text: sourceText,
      });
      imported++;
    } catch (err) {
      console.warn(`[migrate] skipped document ${d.id}: ${err.message}`);
    }
  }
  if (imported) {
    console.log(`[migrate] imported ${imported} document(s) from ${storeDir}`);
  }
  return imported;
}

// ── Chat sessions ────────────────────────────────────────────────────────────

export async function importLegacySessions() {
  if (!db.isDbReady()) return 0;
  if (db.countChatSessions() > 0) return 0; // not fresh

  const sessionsDir = process.env.SESSIONS_STORE_DIR
    ? path.resolve(process.env.SESSIONS_STORE_DIR)
    : path.resolve("sessions-store");

  let list;
  try {
    list = await SessionManager.list(process.cwd(), sessionsDir);
  } catch {
    return 0; // no legacy session store
  }

  let imported = 0;
  for (const s of list) {
    if (!s.path) continue;
    try {
      const raw = await fs.readFile(s.path, "utf8");
      const entries = parseSessionEntries(raw);
      const ctx = buildSessionContext(entries);
      const msgs = (ctx.messages || []).filter(
        (m) => m && (m.role === "user" || m.role === "assistant")
      );
      if (!msgs.length) continue;

      const title = truncateTitle(s.name || s.firstMessage);
      db.upsertSession(s.id, title, toIso(s.created), toIso(s.modified), s.path || null);
      for (const m of msgs) {
        db.appendMessage(s.id, m.role, extractMessageText(m) || "", toIso());
      }
      imported++;
    } catch (err) {
      console.warn(`[migrate] skipped session ${s.id}: ${err.message}`);
    }
  }
  if (imported) {
    console.log(`[migrate] imported ${imported} session(s) from ${sessionsDir}`);
  }
  return imported;
}

export async function runLegacyMigrations() {
  if (!db.isDbReady()) return;
  await importLegacyDocuments();
  await importLegacySessions();
}
