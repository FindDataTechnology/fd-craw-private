// ── Project database (SQLite) ────────────────────────────────────────────────
//
// The single persistence layer for the project's important information: chat
// messages, document records & source text, the PageIndex document index, and
// single-user preferences. Opened with WAL + foreign keys; schema migrations
// are tracked in `schema_migrations` and applied transactionally.
//
// Graceful degradation: if the DB cannot be opened or migrated (missing dir,
// permissions, corrupt file), `dbReady` stays false, a warning is logged, and
// the server continues to start - chat runs in-memory without persistence and
// documents are disabled. This mirrors the project's optional-dependency pattern.
//
// `DB_PATH` overrides the default `data/app.db` location.

import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { storeDir } from "./paths.js";

const DEFAULT_DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(storeDir("data"), "app.db");
const INDEX_VERSION = 1; // PageIndex result format version (re-index from source_text if bumped)

let db = null;
let dbReady = false;

// ── Schema migrations ───────────────────────────────────────────────────────
//
// Each migration is a list of SQL statements applied in a single transaction.
// `schema_migrations` itself is bootstrapped by the runner (chicken-and-egg),
// so it does not appear as a numbered migration.

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New chat',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        path TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_session
        ON chat_messages(session_id, seq)`,
      `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        added_at TEXT NOT NULL,
        error TEXT,
        source_text TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS doc_index (
        doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        index_data TEXT NOT NULL,
        index_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS user_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS collection_documents (
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        PRIMARY KEY (collection_id, document_id)
      )`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS extension_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS custom_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 4,
    statements: [
      `ALTER TABLE extension_configs ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`,
    ],
  },
];

function nowIso() {
  return new Date().toISOString();
}

function bootstrapMigrationsTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

function appliedVersions() {
  return new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version)
  );
}

function runMigrations() {
  bootstrapMigrationsTable();
  const applied = appliedVersions();
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const apply = db.transaction(() => {
      for (const stmt of m.statements) db.exec(stmt);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(m.version, nowIso());
    });
    apply();
    console.log(`[db] applied migration v${m.version}`);
  }
}

function latestVersion() {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row?.v ?? 0;
}

// ── Init / degradation ───────────────────────────────────────────────────────

export async function initDb() {
  const dbPath = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : DEFAULT_DB_PATH;
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations();
    dbReady = true;
    console.log(`[db] opened ${dbPath} (schema v${latestVersion()})`);
  } catch (err) {
    dbReady = false;
    db = null;
    console.warn(`[db] disabled: could not open/migrate ${dbPath}: ${err.message}`);
  }
}

export function isDbReady() {
  return dbReady;
}

export function getIndexVersion() {
  return INDEX_VERSION;
}

// ── Chat sessions & messages ─────────────────────────────────────────────────

export function upsertSession(id, title, createdAt, updatedAt, path = null) {
  if (!dbReady) return;
  db.prepare(
    `INSERT INTO chat_sessions (id, title, created_at, updated_at, path)
     VALUES (@id, @title, @created_at, @updated_at, @path)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updated_at = excluded.updated_at,
       path = COALESCE(excluded.path, chat_sessions.path)`
  ).run({ id, title: title || "New chat", created_at: createdAt, updated_at: updatedAt, path });
}

export function setSessionPath(id, path) {
  if (!dbReady) return;
  db.prepare("UPDATE chat_sessions SET path = ? WHERE id = ?").run(path, id);
}

export function touchSession(id, updatedAt) {
  if (!dbReady) return;
  db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(updatedAt, id);
}

// Append a message with the next per-session seq. Returns the inserted seq.
export function appendMessage(sessionId, role, content, createdAt) {
  if (!dbReady) return null;
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM chat_messages WHERE session_id = ?")
    .get(sessionId);
  const seq = (row?.max_seq ?? 0) + 1;
  db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, seq, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sessionId, role, content, seq, createdAt);
  return seq;
}

export function listChatSessions() {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt, s.path,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS messageCount
       FROM chat_sessions s
       ORDER BY s.updated_at DESC`
    )
    .all();
}

export function getSessionPath(id) {
  if (!dbReady) return null;
  return db.prepare("SELECT path FROM chat_sessions WHERE id = ?").get(id)?.path ?? null;
}

export function sessionExists(id) {
  if (!dbReady) return false;
  return !!db.prepare("SELECT 1 FROM chat_sessions WHERE id = ?").get(id);
}

export function getSessionMeta(id) {
  if (!dbReady) return null;
  return db
    .prepare(
      "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, path FROM chat_sessions WHERE id = ?"
    )
    .get(id);
}

export function getChatMessages(sessionId) {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY seq ASC"
    )
    .all(sessionId);
}

export function countChatSessions() {
  if (!dbReady) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM chat_sessions").get()?.n ?? 0;
}

// ── Documents ────────────────────────────────────────────────────────────────

export function upsertDocument(doc) {
  // doc: { id, name, type, status, added_at, error?, source_text? }
  if (!dbReady) return;
  db.prepare(
    `INSERT INTO documents (id, name, type, status, added_at, error, source_text)
     VALUES (@id, @name, @type, @status, @added_at, @error, @source_text)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       status = excluded.status,
       error = excluded.error,
       source_text = COALESCE(excluded.source_text, documents.source_text)`
  ).run({
    id: doc.id,
    name: doc.name,
    type: doc.type,
    status: doc.status,
    added_at: doc.added_at,
    error: doc.error ?? null,
    source_text: doc.source_text ?? null,
  });
}

export function updateDocumentStatus(id, status, error = null) {
  if (!dbReady) return;
  db.prepare("UPDATE documents SET status = ?, error = ? WHERE id = ?").run(
    status,
    error,
    id
  );
}

export function setDocumentSource(id, sourceText) {
  if (!dbReady) return;
  db.prepare("UPDATE documents SET source_text = ? WHERE id = ?").run(sourceText, id);
}

export function listDocuments() {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT id, name, type, status, added_at AS addedAt, error FROM documents"
    )
    .all();
}

export function getDocument(id) {
  if (!dbReady) return null;
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
}

export function documentExists(id) {
  if (!dbReady) return false;
  return !!db.prepare("SELECT 1 FROM documents WHERE id = ?").get(id);
}

export function deleteDocument(id) {
  if (!dbReady) return;
  // ON DELETE CASCADE removes the doc_index row.
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
}

export function listReadyDocuments() {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT id, name, type, source_text FROM documents WHERE status = 'ready'"
    )
    .all();
}

export function countDocuments() {
  if (!dbReady) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM documents").get()?.n ?? 0;
}

// ── Document index (PageIndex tree, JSON) ────────────────────────────────────

export function setDocIndex(docId, indexData) {
  if (!dbReady) return;
  db.prepare(
    `INSERT INTO doc_index (doc_id, index_data, index_version, updated_at)
     VALUES (@doc_id, @index_data, @index_version, @updated_at)
     ON CONFLICT(doc_id) DO UPDATE SET
       index_data = excluded.index_data,
       index_version = excluded.index_version,
       updated_at = excluded.updated_at`
  ).run({
    doc_id: docId,
    index_data: JSON.stringify(indexData),
    index_version: INDEX_VERSION,
    updated_at: nowIso(),
  });
}

export function getDocIndex(docId) {
  if (!dbReady) return null;
  const row = db.prepare("SELECT index_data, index_version FROM doc_index WHERE doc_id = ?").get(docId);
  if (!row) return null;
  try {
    // index_data is the JSON-serialized PageIndexResult ({ docName, structure }).
    // Spread it so callers get .structure (the TreeNode[]) directly.
    const parsed = JSON.parse(row.index_data);
    return { ...parsed, indexVersion: row.index_version };
  } catch {
    return null;
  }
}

// ── Collections ───────────────────────────────────────────────────────────────
//
// Named groups of documents. `collection_documents` is the join table; both
// foreign keys ON DELETE CASCADE, so deleting a document removes its memberships
// and deleting a collection removes its memberships (but never the documents).

export function createCollection({ id, name, description, created_at }) {
  if (!dbReady) return;
  db.prepare(
    `INSERT INTO collections (id, name, description, created_at)
     VALUES (@id, @name, @description, @created_at)`
  ).run({ id, name, description, created_at });
}

export function getCollection(id) {
  if (!dbReady) return null;
  return (
    db
      .prepare(
        `SELECT c.id, c.name, c.description, c.created_at AS createdAt,
                (SELECT COUNT(*) FROM collection_documents cd WHERE cd.collection_id = c.id) AS documentCount
         FROM collections c WHERE c.id = ?`
      )
      .get(id) || null
  );
}

export function listCollections() {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT c.id, c.name, c.description, c.created_at AS createdAt,
              (SELECT COUNT(*) FROM collection_documents cd WHERE cd.collection_id = c.id) AS documentCount
       FROM collections c ORDER BY c.created_at DESC`
    )
    .all();
}

export function renameCollection(id, { name, description }) {
  if (!dbReady) return;
  db.prepare(
    `UPDATE collections SET name = @name, description = @description WHERE id = @id`
  ).run({ id, name, description });
}

export function deleteCollection(id) {
  if (!dbReady) return;
  // ON DELETE CASCADE removes the membership rows.
  db.prepare("DELETE FROM collections WHERE id = ?").run(id);
}

// Idempotent: adding an existing membership is a no-op (INSERT OR IGNORE).
export function addDocumentToCollection(collectionId, documentId) {
  if (!dbReady) return;
  db.prepare(
    `INSERT OR IGNORE INTO collection_documents (collection_id, document_id, added_at)
     VALUES (?, ?, ?)`
  ).run(collectionId, documentId, nowIso());
}

// Idempotent: removing a non-member is a no-op.
export function removeDocumentFromCollection(collectionId, documentId) {
  if (!dbReady) return;
  db.prepare(
    "DELETE FROM collection_documents WHERE collection_id = ? AND document_id = ?"
  ).run(collectionId, documentId);
}

export function listCollectionDocuments(collectionId) {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT d.id, d.name, d.type, d.status, d.added_at AS addedAt,
              cd.added_at AS addedToCollectionAt
       FROM collection_documents cd
       JOIN documents d ON d.id = cd.document_id
       WHERE cd.collection_id = ?
       ORDER BY cd.added_at ASC`
    )
    .all(collectionId);
}

// Ready member documents of a collection with source_text, for scoped retrieval.
export function listReadyDocumentsInCollection(collectionId) {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT d.id, d.name, d.type, d.source_text
       FROM collection_documents cd
       JOIN documents d ON d.id = cd.document_id
       WHERE cd.collection_id = ? AND d.status = 'ready'`
    )
    .all(collectionId);
}

// ── User preferences (single-user, key/value) ────────────────────────────────

export function setPreference(key, value) {
  if (!dbReady) return;
  db.prepare(
    `INSERT INTO user_preferences (key, value, updated_at)
     VALUES (@key, @value, @updated_at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run({ key, value: String(value), updated_at: nowIso() });
}

export function getPreference(key) {
  if (!dbReady) return null;
  return db.prepare("SELECT value FROM user_preferences WHERE key = ?").get(key)?.value ?? null;
}

export function getAllPreferences() {
  if (!dbReady) return {};
  const rows = db.prepare("SELECT key, value FROM user_preferences").all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ── Extension configs (MCP servers) ──────────────────────────────────────────

export function listExtensionConfigs() {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT id, name, type, config_json AS configJson, enabled, source, created_at AS createdAt, updated_at AS updatedAt FROM extension_configs ORDER BY name"
    )
    .all()
    .map((r) => ({ ...r, config: JSON.parse(r.configJson), enabled: !!r.enabled }));
}

export function getExtensionConfig(name) {
  if (!dbReady) return null;
  const row = db
    .prepare(
      "SELECT id, name, type, config_json AS configJson, enabled, source, created_at AS createdAt, updated_at AS updatedAt FROM extension_configs WHERE name = ?"
    )
    .get(name);
  if (!row) return null;
  return { ...row, config: JSON.parse(row.configJson), enabled: !!row.enabled };
}

// ponytail: INSERT OR IGNORE so startup seeding doesn't overwrite user edits.
// Returns the existing row if it was already present, or the newly inserted row.
export function seedExtensionConfig({ name, type, config, enabled = true, source = "startup" }) {
  if (!dbReady) return null;
  const existing = getExtensionConfig(name);
  if (existing) return existing;
  return addExtensionConfig({ name, type, config, enabled, source });
}

export function addExtensionConfig({ name, type, config, enabled = true, source = "user" }) {
  if (!dbReady) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO extension_configs (id, name, type, config_json, enabled, source, created_at, updated_at)
     VALUES (@id, @name, @type, @config_json, @enabled, @source, @created_at, @updated_at)`
  ).run({
    id,
    name,
    type,
    config_json: JSON.stringify(config),
    enabled: enabled ? 1 : 0,
    source,
    created_at: now,
    updated_at: now,
  });
  return getExtensionConfig(name);
}

export function updateExtensionConfig(name, { type, config, enabled }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { name, updated_at: nowIso() };
  if (type !== undefined) {
    updates.push("type = @type");
    params.type = type;
  }
  if (config !== undefined) {
    updates.push("config_json = @config_json");
    params.config_json = JSON.stringify(config);
  }
  if (enabled !== undefined) {
    updates.push("enabled = @enabled");
    params.enabled = enabled ? 1 : 0;
  }
  if (updates.length === 0) return getExtensionConfig(name);
  updates.push("updated_at = @updated_at");
  db.prepare(`UPDATE extension_configs SET ${updates.join(", ")} WHERE name = @name`).run(params);
  return getExtensionConfig(name);
}

export function deleteExtensionConfig(name) {
  if (!dbReady) return false;
  const result = db.prepare("DELETE FROM extension_configs WHERE name = ?").run(name);
  return result.changes > 0;
}

export function setExtensionEnabled(name, enabled) {
  if (!dbReady) return null;
  db.prepare("UPDATE extension_configs SET enabled = ?, updated_at = ? WHERE name = ?").run(
    enabled ? 1 : 0,
    nowIso(),
    name
  );
  return getExtensionConfig(name);
}

// ── Custom skills ────────────────────────────────────────────────────────────

export function listCustomSkills() {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT id, name, description, content, enabled, created_at AS createdAt, updated_at AS updatedAt FROM custom_skills ORDER BY name"
    )
    .all()
    .map((r) => ({ ...r, enabled: !!r.enabled }));
}

export function getCustomSkill(name) {
  if (!dbReady) return null;
  const row = db
    .prepare(
      "SELECT id, name, description, content, enabled, created_at AS createdAt, updated_at AS updatedAt FROM custom_skills WHERE name = ?"
    )
    .get(name);
  if (!row) return null;
  return { ...row, enabled: !!row.enabled };
}

export function addCustomSkill({ name, description, content, enabled = true }) {
  if (!dbReady) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO custom_skills (id, name, description, content, enabled, created_at, updated_at)
     VALUES (@id, @name, @description, @content, @enabled, @created_at, @updated_at)`
  ).run({
    id,
    name,
    description: description || null,
    content,
    enabled: enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  return getCustomSkill(name);
}

export function updateCustomSkill(name, { description, content, enabled }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { name, updated_at: nowIso() };
  if (description !== undefined) {
    updates.push("description = @description");
    params.description = description;
  }
  if (content !== undefined) {
    updates.push("content = @content");
    params.content = content;
  }
  if (enabled !== undefined) {
    updates.push("enabled = @enabled");
    params.enabled = enabled ? 1 : 0;
  }
  if (updates.length === 0) return getCustomSkill(name);
  updates.push("updated_at = @updated_at");
  db.prepare(`UPDATE custom_skills SET ${updates.join(", ")} WHERE name = @name`).run(params);
  return getCustomSkill(name);
}

export function deleteCustomSkill(name) {
  if (!dbReady) return false;
  const result = db.prepare("DELETE FROM custom_skills WHERE name = ?").run(name);
  return result.changes > 0;
}

export function setCustomSkillEnabled(name, enabled) {
  if (!dbReady) return null;
  db.prepare("UPDATE custom_skills SET enabled = ?, updated_at = ? WHERE name = ?").run(
    enabled ? 1 : 0,
    nowIso(),
    name
  );
  return getCustomSkill(name);
}
