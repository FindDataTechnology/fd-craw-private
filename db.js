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
  {
    version: 5,
    // origin: who seeded the row ("bundled" = shipped in the installer via the
    //   bundle manifest / server startup, "startup" = mcp.json, "user" = API).
    // locked: bundled entries the packager forbids deleting/disabling/editing.
    // permissions: nullable JSON ({ allow?: string[], deny?: string[] }) — the
    //   packager-declared tool allow/deny lists (consumed by the follow-up
    //   extension-tool-permissions change; stored now so seeding can persist it).
    // PRAGMA-guarded so the migration stays idempotent on DBs that picked the
    // columns up out-of-band (e.g. dev experimentation).
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(extension_configs)").all().map((c) => c.name)
      );
      if (!cols.has("origin"))
        db.exec(`ALTER TABLE extension_configs ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`);
      if (!cols.has("locked"))
        db.exec(`ALTER TABLE extension_configs ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`);
      if (!cols.has("permissions"))
        db.exec(`ALTER TABLE extension_configs ADD COLUMN permissions TEXT`);
    },
  },
  {
    version: 6,
    // Transcript block structure (tool calls with results) as nullable JSON on
    // assistant messages, so a reloaded session rebuilds the evidence trail
    // instead of flattening it to prose. Rows written before this migration
    // have NULL blocks and fall back to the plain-content path.
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(chat_messages)").all().map((c) => c.name)
      );
      if (!cols.has("blocks")) db.exec(`ALTER TABLE chat_messages ADD COLUMN blocks TEXT`);
    },
  },
  {
    version: 7,
    // Full-fidelity dsh notification log for the /trace viewer. One row per
    // runtime notification, keyed by turn (the durable message id returned by
    // prompt()). Payload is raw JSON; per-type summaries are derived at read
    // time so new event types never need a migration.
    statements: [
      `CREATE TABLE IF NOT EXISTS trace_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        method TEXT NOT NULL,
        event_type TEXT,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_trace_turn ON trace_events(turn_id)`,
      `CREATE INDEX IF NOT EXISTS idx_trace_ts ON trace_events(ts)`,
    ],
  },
  {
    version: 8,
    // Social chat-platform bots (WeCom / Feishu / Telegram / WeChat OA).
    // `secret` is the per-bot random path segment of the webhook URL (it
    // defeats bot-id guessing; the platform's own signature check is the real
    // verification). `credentials` is server-only JSON — never serialized to
    // the browser (the REST layer masks it).
    statements: [
      `CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        secret TEXT NOT NULL,
        credentials TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 9,
    // The dsh agent preset (agent mode) a session STARTED under, recorded at
    // session-row creation so a resumed session's header label resolves to the
    // composition it actually runs. Nullable: rows written before this
    // migration (and blank deployments) read as "the deployment default".
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(chat_sessions)").all().map((c) => c.name)
      );
      if (!cols.has("agent_preset"))
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_preset TEXT`);
    },
  },
  {
    version: 10,
    // The runtime workspace a session ran in, recorded at session-row creation
    // so the sidebar can group sessions by workspace. Nullable: rows written
    // before this migration surface as the sidebar's "Ungrouped" group, and a
    // mid-session workspace switch never re-stamps the row.
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(chat_sessions)").all().map((c) => c.name)
      );
      if (!cols.has("workspace"))
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN workspace TEXT`);
    },
  },
  {
    version: 11,
    // Library search index: chunked document text under FTS5 (bm25 ranking).
    // Written in the same logical step as source_text at ingest; rows are
    // replaced wholesale per document (delete + insert in one transaction).
    // A virtual table cannot carry FK cascades, so document deletion purges
    // chunks explicitly in deleteDocument(). Existing rows are backfilled at
    // startup by documents-search.js, not by this migration (keep DDL only).
    statements: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
        text,
        doc_id UNINDEXED,
        name UNINDEXED,
        loc UNINDEXED
      )`,
    ],
  },
  {
    version: 12,
    statements: [
      `CREATE TABLE IF NOT EXISTS user_model_bindings (
        email TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email)
      )`,
      `CREATE TABLE IF NOT EXISTS user_mcp_bindings (
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email, name)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_mcp_bindings_email
        ON user_mcp_bindings(email)`,
    ],
  },
  {
    // Role gating for market-installed MCP entries (add-role-gated-extensions):
    // null = ungated; a JSON array of group names required to keep the server
    // in the effective runtime profile. Stamped at install time only.
    version: 13,
    statements: [
      `ALTER TABLE extension_configs ADD COLUMN required_groups TEXT`,
    ],
  },
  {
    // Machine-caller relay (add-bot-relay-endpoint). `bot_chats` records which
    // chats have actually talked to each bot — the chat key is otherwise never
    // persisted (it is hashed one-way into the dsh session id), so this is the
    // only way a destination can be shown or bound. `bot_channels` binds a
    // stable name to exactly one (bot, chat_key), which is what a relay caller
    // addresses. `bot_relay_log` audits every relay attempt.
    //
    // No message text in any of the three: the log keeps the length only, and
    // the chat record keeps identity and timing only (design D4/D5).
    version: 14,
    statements: [
      `CREATE TABLE IF NOT EXISTS bot_chats (
        bot_id TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        sender_name TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, chat_key)
      )`,
      `CREATE TABLE IF NOT EXISTS bot_channels (
        name TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS bot_relay_log (
        ts TEXT NOT NULL,
        channel TEXT,
        bot_id TEXT,
        text_chars INTEGER,
        outcome TEXT NOT NULL,
        error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_bot_relay_log_ts ON bot_relay_log(ts)`,
    ],
  },
  {
    // registry-sso-credentials: one market-proxy credential per user, minted
    // through the registry's silent SSO popup (or pasted by hand). Keyed by
    // identity email, never returned to the browser, and referenced from an
    // installed registry MCP server as `credentialRef: "registry"` — the
    // effective-profile writer resolves that ref to an Authorization header, so
    // the token itself never lands in extension_configs.
    version: 15,
    statements: [
      `CREATE TABLE IF NOT EXISTS user_registry_credentials (
        email TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'sso',
        updated_at TEXT NOT NULL
      )`,
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
      for (const stmt of m.statements ?? []) db.exec(stmt);
      if (m.apply) m.apply(db);
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

// Raw handle for feature modules that own their own tables/queries (trace).
// Null when the DB failed to open — callers guard with isDbReady().
export function getDb() {
  return db;
}

export function getIndexVersion() {
  return INDEX_VERSION;
}

// Prepared-statement registry: better-sqlite3 statements are reusable and
// compiled per prepare() — caching them turns every helper call (hot path:
// two per chat message) from a compile+run into a run only. Cache lives for
// the process lifetime; db.js opens exactly once (initDb) and a failed open
// nulls dbReady before any helper runs.
const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

// ── Chat sessions & messages ─────────────────────────────────────────────────

export function upsertSession(id, title, createdAt, updatedAt, path = null, agentPreset = null, workspace = null) {
  if (!dbReady) return;
  stmt(
    `INSERT INTO chat_sessions (id, title, created_at, updated_at, path, agent_preset, workspace)
     VALUES (@id, @title, @created_at, @updated_at, @path, @agent_preset, @workspace)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updated_at = excluded.updated_at,
       path = COALESCE(excluded.path, chat_sessions.path),
       agent_preset = COALESCE(chat_sessions.agent_preset, excluded.agent_preset),
       workspace = COALESCE(chat_sessions.workspace, excluded.workspace)`
  ).run({ id, title: title || "New chat", created_at: createdAt, updated_at: updatedAt, path, agent_preset: agentPreset, workspace });
}

export function setSessionPath(id, path) {
  if (!dbReady) return;
  stmt("UPDATE chat_sessions SET path = ? WHERE id = ?").run(path, id);
}

export function touchSession(id, updatedAt) {
  if (!dbReady) return;
  stmt("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(updatedAt, id);
}

// Set a session's title and bump updated_at. Returns true if the row was
// updated, false if no such session or the DB is unavailable.
export function setTitle(id, title, updatedAt) {
  if (!dbReady || !id) return false;
  const result = db
    .prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?")
    .run(title || "New chat", updatedAt, id);
  return result.changes > 0;
}

// Append a message with the next per-session seq. Returns the inserted seq.
export function appendMessage(sessionId, role, content, createdAt, blocksJson) {
  if (!dbReady) return null;
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM chat_messages WHERE session_id = ?")
    .get(sessionId);
  const seq = (row?.max_seq ?? 0) + 1;
  stmt(
    `INSERT INTO chat_messages (session_id, role, content, seq, created_at, blocks)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, role, content, seq, createdAt, blocksJson ?? null);
  return seq;
}

export function listChatSessions() {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt, s.path, s.agent_preset AS agentPreset, s.workspace,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS messageCount
       FROM chat_sessions s
       ORDER BY s.updated_at DESC`
    )
    .all();
}

export function getSessionPath(id) {
  if (!dbReady) return null;
  return stmt("SELECT path FROM chat_sessions WHERE id = ?").get(id)?.path ?? null;
}

export function sessionExists(id) {
  if (!dbReady) return false;
  return !!stmt("SELECT 1 FROM chat_sessions WHERE id = ?").get(id);
}

// Delete a session row (cascades to chat_messages via FK). Returns true if a row
// was removed, false if no such session or the DB is unavailable.
export function deleteSession(id) {
  if (!dbReady || !id) return false;
  const result = stmt("DELETE FROM chat_sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getSessionMeta(id) {
  if (!dbReady) return null;
  return db
    .prepare(
      "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, path, agent_preset AS agentPreset, workspace FROM chat_sessions WHERE id = ?"
    )
    .get(id);
}

export function getChatMessages(sessionId) {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT role, content, blocks FROM chat_messages WHERE session_id = ? ORDER BY seq ASC"
    )
    .all(sessionId)
    .map((row) => ({
      role: row.role,
      content: row.content,
      // Block structure (nullable JSON; absent on pre-migration rows).
      ...(row.blocks ? { blocks: JSON.parse(row.blocks) } : {}),
    }));
}

export function countChatSessions() {
  if (!dbReady) return 0;
  return stmt("SELECT COUNT(*) AS n FROM chat_sessions").get()?.n ?? 0;
}

// ── Documents ────────────────────────────────────────────────────────────────

export function upsertDocument(doc) {
  // doc: { id, name, type, status, added_at, error?, source_text? }
  if (!dbReady) return;
  stmt(
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
  stmt("UPDATE documents SET status = ?, error = ? WHERE id = ?").run(
    status,
    error,
    id
  );
}

export function setDocumentSource(id, sourceText) {
  if (!dbReady) return;
  stmt("UPDATE documents SET source_text = ? WHERE id = ?").run(sourceText, id);
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
  return stmt("SELECT * FROM documents WHERE id = ?").get(id);
}

// Prefix-only fetch for @doc: prompt expansion: the caller slices to a fixed
// character budget anyway, so selecting substr(source_text, 1, n) at the SQL
// layer avoids dragging a potentially multi-megabyte column into memory (and
// blocking the event loop) for every attachment reference.
export function getDocumentPrefix(id, chars) {
  if (!dbReady) return null;
  return stmt("SELECT substr(source_text, 1, ?) AS source_text FROM documents WHERE id = ?")
    .get(chars, id)?.source_text ?? null;
}

export function documentExists(id) {
  if (!dbReady) return false;
  return !!stmt("SELECT 1 FROM documents WHERE id = ?").get(id);
}

export function deleteDocument(id) {
  if (!dbReady) return;
  // FTS chunks carry no FK cascade (virtual table) — purge explicitly, then
  // the row delete cascades doc_index + collection memberships.
  deleteDocumentChunks(id);
  stmt("DELETE FROM documents WHERE id = ?").run(id);
}

// Light select for retrieval: queryCollection only reads id/name (the tree
// text comes from getDocIndex). Loading every ready document's source_text
// here dragged megabytes through memory per query for nothing.
export function listReadyDocuments() {
  if (!dbReady) return [];
  return stmt("SELECT id, name, type FROM documents WHERE status = 'ready'").all();
}

export function countDocuments() {
  if (!dbReady) return 0;
  return stmt("SELECT COUNT(*) AS n FROM documents").get()?.n ?? 0;
}

// Light card for chat-side @doc: expansion: metadata plus a bounded summary
// prefix — never loads the full source_text column (which can be megabytes).
export function getDocumentCard(id) {
  if (!dbReady) return null;
  return (
    db
      .prepare(
        `SELECT id, name, type, status, substr(source_text, 1, 220) AS summary
         FROM documents WHERE id = ?`
      )
      .get(id) || null
  );
}

// ── Library search chunks (FTS5) ─────────────────────────────────────────────

// Replace a document's chunks wholesale: delete + insert in one transaction,
// so a reader never sees a half-written chunk set. `name` is denormalized onto
// each row so search results carry the document name without a join.
export function replaceDocumentChunks(docId, name, chunks) {
  if (!dbReady) return;
  const run = db.transaction(() => {
    db.prepare("DELETE FROM document_chunks WHERE doc_id = ?").run(docId);
    const ins = db.prepare(
      "INSERT INTO document_chunks (text, doc_id, name, loc) VALUES (?, ?, ?, ?)"
    );
    for (const c of chunks) ins.run(c.text, docId, name, c.loc);
  });
  run();
}

export function deleteDocumentChunks(docId) {
  if (!dbReady) return;
  stmt("DELETE FROM document_chunks WHERE doc_id = ?").run(docId);
}

export function hasDocumentChunks(docId) {
  if (!dbReady) return false;
  return !!stmt("SELECT 1 FROM document_chunks WHERE doc_id = ? LIMIT 1").get(docId);
}

// Ids of ready docs that have source text but no chunks yet — the backfill
// source. Ids only: the backfill loads each doc separately so no read cursor
// is open while it writes (better-sqlite3 iterators hold the connection busy).
export function listDocIdsWithoutChunks() {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT id FROM documents
       WHERE status = 'ready' AND source_text IS NOT NULL AND source_text != ''
         AND NOT EXISTS (SELECT 1 FROM document_chunks WHERE doc_id = documents.id)`
    )
    .all()
    .map((r) => r.id);
}

// FTS5-ranked chunk search, scoped to ready documents. `matchExpr` is a
// pre-built MATCH expression (caller quotes terms). Filters: a collection id
// (membership subselect) and/or a document id. Emits loc for follow-up reads.
export function searchDocumentChunks(matchExpr, { collectionId, docId, limit = 10 } = {}) {
  if (!dbReady) return [];
  const conds = [];
  const params = [matchExpr];
  if (collectionId) {
    conds.push(
      "c.doc_id IN (SELECT document_id FROM collection_documents WHERE collection_id = ?)"
    );
    params.push(collectionId);
  }
  if (docId) {
    conds.push("c.doc_id = ?");
    params.push(docId);
  }
  params.push(Math.max(1, Math.min(20, limit)));
  const extra = conds.length ? ` AND ${conds.join(" AND ")}` : "";
  // Unaliased FTS references: this SQLite build resolves auxiliary functions
  // (snippet/bm25) and the MATCH qualifier by table NAME only, not by alias.
  return db
    .prepare(
      `SELECT document_chunks.doc_id, document_chunks.name, document_chunks.loc,
              snippet(document_chunks, 0, '«', '»', '…', 16) AS snippet,
              bm25(document_chunks) AS rank
       FROM document_chunks JOIN documents d ON d.id = document_chunks.doc_id
       WHERE document_chunks MATCH ? AND d.status = 'ready'${extra}
       ORDER BY rank
       LIMIT ?`
    )
    .all(...params);
}

// LIKE-based fallback scan over chunks, for scripts (CJK etc.) the unicode61
// tokenizer cannot MATCH. Unranked — row order is chunk insertion order.
export function likeDocumentChunks(likeExpr, { collectionId, docId, limit = 10 } = {}) {
  if (!dbReady) return [];
  const conds = ["c.text LIKE ? ESCAPE '\\'", "d.status = 'ready'"];
  const params = [likeExpr];
  if (collectionId) {
    conds.push(
      "c.doc_id IN (SELECT document_id FROM collection_documents WHERE collection_id = ?)"
    );
    params.push(collectionId);
  }
  if (docId) {
    conds.push("c.doc_id = ?");
    params.push(docId);
  }
  params.push(Math.max(1, Math.min(20, limit)));
  return db
    .prepare(
      `SELECT c.doc_id, c.name, c.loc, substr(c.text, 1, 200) AS snippet
       FROM document_chunks c JOIN documents d ON d.id = c.doc_id
       WHERE ${conds.join(" AND ")}
       LIMIT ?`
    )
    .all(...params);
}

// One page of a document's source text, sliced SQL-side so a page read never
// loads the full column. Offsets are SQLite character positions (1-based
// substr); the total lets callers size follow-up pages.
export function getDocumentPage(id, offset, len) {
  if (!dbReady) return null;
  return (
    db
      .prepare(
        `SELECT name, status, length(source_text) AS total,
                substr(source_text, ?, ?) AS text
         FROM documents WHERE id = ?`
      )
      .get(offset + 1, len, id) || null
  );
}

// ── Document index (PageIndex tree, JSON) ────────────────────────────────────

export function setDocIndex(docId, indexData) {
  if (!dbReady) return;
  stmt(
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
  const row = stmt("SELECT index_data, index_version FROM doc_index WHERE doc_id = ?").get(docId);
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
  stmt(
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
  stmt(
    `UPDATE collections SET name = @name, description = @description WHERE id = @id`
  ).run({ id, name, description });
}

export function deleteCollection(id) {
  if (!dbReady) return;
  // ON DELETE CASCADE removes the membership rows.
  stmt("DELETE FROM collections WHERE id = ?").run(id);
}

// Idempotent: adding an existing membership is a no-op (INSERT OR IGNORE).
export function addDocumentToCollection(collectionId, documentId) {
  if (!dbReady) return;
  stmt(
    `INSERT OR IGNORE INTO collection_documents (collection_id, document_id, added_at)
     VALUES (?, ?, ?)`
  ).run(collectionId, documentId, nowIso());
}

// Idempotent: removing a non-member is a no-op.
export function removeDocumentFromCollection(collectionId, documentId) {
  if (!dbReady) return;
  stmt(
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
  return stmt(
    `SELECT d.id, d.name, d.type
     FROM collection_documents cd
     JOIN documents d ON d.id = cd.document_id
     WHERE cd.collection_id = ? AND d.status = 'ready'`
  ).all(collectionId);
}

// ── User preferences (single-user, key/value) ────────────────────────────────

export function setPreference(key, value) {
  if (!dbReady) return;
  stmt(
    `INSERT INTO user_preferences (key, value, updated_at)
     VALUES (@key, @value, @updated_at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run({ key, value: String(value), updated_at: nowIso() });
}

export function getPreference(key) {
  if (!dbReady) return null;
  return stmt("SELECT value FROM user_preferences WHERE key = ?").get(key)?.value ?? null;
}

export function getAllPreferences() {
  if (!dbReady) return {};
  const rows = stmt("SELECT key, value FROM user_preferences").all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function normalizeIdentityEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function getUserModelBinding(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  // Aliased to the {id, provider} shape the runtime uses for a model everywhere
  // else (ctx.defaultModel, ctx.dshModels), so callers compare like with like.
  const row = stmt("SELECT model_id AS id, provider_id AS provider, updated_at AS updatedAt FROM user_model_bindings WHERE email = ?").get(key);
  return row || null;
}

export function setUserModelBinding(email, providerId, modelId) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || !providerId || !modelId) return null;
  stmt(
    `INSERT INTO user_model_bindings (email, provider_id, model_id, updated_at)
     VALUES (@email, @providerId, @modelId, @updatedAt)
     ON CONFLICT(email) DO UPDATE SET
       provider_id = excluded.provider_id,
       model_id = excluded.model_id,
       updated_at = excluded.updated_at`
  ).run({ email: key, providerId, modelId, updatedAt: nowIso() });
  return getUserModelBinding(key);
}

export function clearUserModelBinding(email) {
  if (!dbReady) return false;
  return stmt("DELETE FROM user_model_bindings WHERE email = ?").run(normalizeIdentityEmail(email)).changes > 0;
}

export function getUserMcpBindings(email) {
  if (!dbReady) return {};
  const key = normalizeIdentityEmail(email);
  if (!key) return {};
  return Object.fromEntries(
    stmt("SELECT name, enabled FROM user_mcp_bindings WHERE email = ?")
      .all(key)
      .map((row) => [row.name, !!row.enabled])
  );
}

export function setUserMcpBinding(email, name, enabled) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || !name || typeof enabled !== "boolean") return null;
  stmt(
    `INSERT INTO user_mcp_bindings (email, name, enabled, updated_at)
     VALUES (@email, @name, @enabled, @updatedAt)
     ON CONFLICT(email, name) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  ).run({ email: key, name, enabled: enabled ? 1 : 0, updatedAt: nowIso() });
  return { name, enabled };
}

export function deleteUserMcpBinding(email, name) {
  if (!dbReady) return false;
  return stmt("DELETE FROM user_mcp_bindings WHERE email = ? AND name = ?")
    .run(normalizeIdentityEmail(email), name).changes > 0;
}

// ── Registry credentials (market proxy token, one row per user) ──────────────
//
// The raw token is returned by getRegistryCredential for the overlay writer
// only. Route handlers must go through registry-credentials.js, whose status
// projection is token-free by construction.

export function getRegistryCredential(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const row = stmt(
    "SELECT token, expires_at AS expiresAt, stale, source, updated_at AS updatedAt FROM user_registry_credentials WHERE email = ?"
  ).get(key);
  return row ? { ...row, stale: !!row.stale } : null;
}

export function setRegistryCredential({ email, token, expiresAt = null, source = "sso" }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || !token) return null;
  // A fresh token clears the stale flag: the user just proved the credential
  // works (or replaced it), so the next overlay write may use it again.
  stmt(
    `INSERT INTO user_registry_credentials (email, token, expires_at, stale, source, updated_at)
     VALUES (@email, @token, @expiresAt, 0, @source, @updatedAt)
     ON CONFLICT(email) DO UPDATE SET
       token = excluded.token,
       expires_at = excluded.expires_at,
       stale = 0,
       source = excluded.source,
       updated_at = excluded.updated_at`
  ).run({ email: key, token, expiresAt, source, updatedAt: nowIso() });
  return getRegistryCredential(key);
}

export function deleteRegistryCredential(email) {
  if (!dbReady) return false;
  return stmt("DELETE FROM user_registry_credentials WHERE email = ?")
    .run(normalizeIdentityEmail(email)).changes > 0;
}

// 401 from a registry-origin MCP server: keep the row (so the UI can tell
// "expired" apart from "never connected") but stop injecting it until the user
// reconnects. `AND stale = 0` makes the return value "the state actually
// changed", which is what the caller uses to re-apply the profile exactly once
// per expiry instead of on every failing call.
export function markRegistryCredentialStale(email) {
  if (!dbReady) return false;
  return stmt("UPDATE user_registry_credentials SET stale = 1, updated_at = ? WHERE email = ? AND stale = 0")
    .run(nowIso(), normalizeIdentityEmail(email)).changes > 0;
}

// ── Extension configs (MCP servers) ──────────────────────────────────────────

function parsePermissions(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function serializeExtensionConfig(row) {
  if (!row) return null;
  return {
    ...row,
    config: JSON.parse(row.configJson),
    enabled: !!row.enabled,
    locked: !!row.locked,
    permissions: parsePermissions(row.permissions),
    requiredGroups: parsePermissions(row.requiredGroups),
  };
}

export function listExtensionConfigs() {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT id, name, type, config_json AS configJson, enabled, source, origin, locked, permissions, required_groups AS requiredGroups, created_at AS createdAt, updated_at AS updatedAt FROM extension_configs ORDER BY name"
    )
    .all()
    .map(serializeExtensionConfig);
}

export function getExtensionConfig(name) {
  if (!dbReady) return null;
  const row = db
    .prepare(
      "SELECT id, name, type, config_json AS configJson, enabled, source, origin, locked, permissions, required_groups AS requiredGroups, created_at AS createdAt, updated_at AS updatedAt FROM extension_configs WHERE name = ?"
    )
    .get(name);
  return serializeExtensionConfig(row);
}

// INSERT OR IGNORE so startup seeding doesn't overwrite user edits.
// Returns the existing row if it was already present, or the newly inserted row.
export function seedExtensionConfig({ name, type, config, enabled = true, source = "startup", origin = "user", locked = false, permissions = null, requiredGroups = null }) {
  if (!dbReady) return null;
  const existing = getExtensionConfig(name);
  if (existing) return existing;
  return addExtensionConfig({ name, type, config, enabled, source, origin, locked, permissions, requiredGroups });
}

export function addExtensionConfig({ name, type, config, enabled = true, source = "user", origin = "user", locked = false, permissions = null, requiredGroups = null }) {
  if (!dbReady) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  stmt(
    `INSERT INTO extension_configs (id, name, type, config_json, enabled, source, origin, locked, permissions, required_groups, created_at, updated_at)
     VALUES (@id, @name, @type, @config_json, @enabled, @source, @origin, @locked, @permissions, @required_groups, @created_at, @updated_at)`
  ).run({
    id,
    name,
    type,
    config_json: JSON.stringify(config),
    enabled: enabled ? 1 : 0,
    source,
    origin,
    locked: locked ? 1 : 0,
    permissions: permissions ? JSON.stringify(permissions) : null,
    required_groups: requiredGroups ? JSON.stringify(requiredGroups) : null,
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
  stmt(`UPDATE extension_configs SET ${updates.join(", ")} WHERE name = @name`).run(params);
  return getExtensionConfig(name);
}

export function deleteExtensionConfig(name) {
  if (!dbReady) return false;
  const result = stmt("DELETE FROM extension_configs WHERE name = ?").run(name);
  return result.changes > 0;
}

export function setExtensionEnabled(name, enabled) {
  if (!dbReady) return null;
  stmt("UPDATE extension_configs SET enabled = ?, updated_at = ? WHERE name = ?").run(
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
  stmt(
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
  stmt(`UPDATE custom_skills SET ${updates.join(", ")} WHERE name = @name`).run(params);
  return getCustomSkill(name);
}

export function deleteCustomSkill(name) {
  if (!dbReady) return false;
  const result = stmt("DELETE FROM custom_skills WHERE name = ?").run(name);
  return result.changes > 0;
}

export function setCustomSkillEnabled(name, enabled) {
  if (!dbReady) return null;
  stmt("UPDATE custom_skills SET enabled = ?, updated_at = ? WHERE name = ?").run(
    enabled ? 1 : 0,
    nowIso(),
    name
  );
  return getCustomSkill(name);
}

// ── Bots (social chat channels) ──────────────────────────────────────────────
//
// Rows carry the raw `credentials` JSON and the webhook `secret`; both are
// server-only. Callers that serve the browser MUST go through the masking in
// server/bots.js — never hand a row straight to res.json().

const BOT_COLS =
  "id, type, name, enabled, secret, credentials, created_at AS createdAt";

function hydrateBot(row) {
  if (!row) return null;
  let credentials = {};
  try { credentials = JSON.parse(row.credentials); } catch { /* corrupt row → no creds */ }
  return { ...row, enabled: !!row.enabled, credentials };
}

export function listBots() {
  if (!dbReady) return [];
  return db.prepare(`SELECT ${BOT_COLS} FROM bots ORDER BY created_at`).all().map(hydrateBot);
}

export function getBot(id) {
  if (!dbReady) return null;
  return hydrateBot(stmt(`SELECT ${BOT_COLS} FROM bots WHERE id = ?`).get(id));
}

export function addBot({ id, type, name, credentials, secret, enabled = true }) {
  if (!dbReady) return null;
  stmt(
    `INSERT INTO bots (id, type, name, enabled, secret, credentials, created_at)
     VALUES (@id, @type, @name, @enabled, @secret, @credentials, @created_at)`
  ).run({
    id,
    type,
    name,
    enabled: enabled ? 1 : 0,
    secret,
    credentials: JSON.stringify(credentials ?? {}),
    created_at: nowIso(),
  });
  return getBot(id);
}

export function updateBot(id, { name, credentials, enabled }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { id };
  if (name !== undefined) { updates.push("name = @name"); params.name = name; }
  if (credentials !== undefined) {
    updates.push("credentials = @credentials");
    params.credentials = JSON.stringify(credentials);
  }
  if (enabled !== undefined) { updates.push("enabled = @enabled"); params.enabled = enabled ? 1 : 0; }
  if (updates.length) stmt(`UPDATE bots SET ${updates.join(", ")} WHERE id = @id`).run(params);
  return getBot(id);
}

export function deleteBot(id) {
  if (!dbReady) return false;
  return stmt("DELETE FROM bots WHERE id = ?").run(id).changes > 0;
}

// ── Bot chats, relay channels, relay audit (add-bot-relay-endpoint) ───────────
//
// The relay's destination list. A channel binding is only creatable from a row
// `upsertBotChat` wrote, so a caller holding the relay token cannot reach a
// chat this deployment has never seen. None of these rows carries message text.

const BOT_CHAT_COLS =
  "bot_id AS botId, chat_key AS chatKey, sender_name AS senderName, " +
  "first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt";

// Record a verified inbound message's chat. `first_seen_at` is written once;
// later messages only advance `last_seen_at`, and a later message without a
// display name keeps the name already known.
export function upsertBotChat(botId, chatKey, senderName) {
  if (!dbReady) return false;
  const now = nowIso();
  stmt(
    `INSERT INTO bot_chats (bot_id, chat_key, sender_name, first_seen_at, last_seen_at)
     VALUES (@bot_id, @chat_key, @sender_name, @now, @now)
     ON CONFLICT(bot_id, chat_key) DO UPDATE SET
       last_seen_at = @now,
       sender_name = COALESCE(excluded.sender_name, bot_chats.sender_name)`
  ).run({
    bot_id: String(botId),
    chat_key: String(chatKey),
    sender_name: String(senderName ?? "").trim() || null,
    now,
  });
  return true;
}

export function listBotChats() {
  if (!dbReady) return [];
  return db.prepare(`SELECT ${BOT_CHAT_COLS} FROM bot_chats ORDER BY last_seen_at DESC`).all();
}

export function getBotChat(botId, chatKey) {
  if (!dbReady) return null;
  return (
    stmt(`SELECT ${BOT_CHAT_COLS} FROM bot_chats WHERE bot_id = ? AND chat_key = ?`).get(
      String(botId),
      String(chatKey),
    ) ?? null
  );
}

const CHANNEL_COLS = "name, bot_id AS botId, chat_key AS chatKey, created_at AS createdAt";

export function listChannels() {
  if (!dbReady) return [];
  return db.prepare(`SELECT ${CHANNEL_COLS} FROM bot_channels ORDER BY name`).all();
}

export function getChannel(name) {
  if (!dbReady) return null;
  return stmt(`SELECT ${CHANNEL_COLS} FROM bot_channels WHERE name = ?`).get(String(name)) ?? null;
}

// Throws on a duplicate name (the primary key is the authority — a check-then-
// insert in the route would race the constraint anyway).
export function createChannel({ name, botId, chatKey }) {
  if (!dbReady) return null;
  stmt(
    `INSERT INTO bot_channels (name, bot_id, chat_key, created_at)
     VALUES (@name, @botId, @chatKey, @createdAt)`
  ).run({ name, botId, chatKey: String(chatKey), createdAt: nowIso() });
  return getChannel(name);
}

export function deleteChannel(name) {
  if (!dbReady) return false;
  return stmt("DELETE FROM bot_channels WHERE name = ?").run(String(name)).changes > 0;
}

// One row per relay attempt that got past authentication. `text_chars` is the
// length, never the text — the log answers "to which channel, and did it land"
// for incident review without becoming a copy of the traffic.
export function insertRelayLog({ channel, botId, textChars, outcome, error }) {
  if (!dbReady) return false;
  stmt(
    `INSERT INTO bot_relay_log (ts, channel, bot_id, text_chars, outcome, error)
     VALUES (@ts, @channel, @bot_id, @text_chars, @outcome, @error)`
  ).run({
    ts: nowIso(),
    channel: channel == null ? null : String(channel),
    bot_id: botId == null ? null : String(botId),
    text_chars: Number.isInteger(textChars) ? textChars : null,
    outcome: String(outcome),
    error: error == null ? null : String(error),
  });
  return true;
}

export function listRelayLog(limit = 50) {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT ts, channel, bot_id AS botId, text_chars AS textChars, outcome, error
       FROM bot_relay_log ORDER BY ts DESC, rowid DESC LIMIT ?`
    )
    .all(Math.max(1, Number(limit) || 50));
}
