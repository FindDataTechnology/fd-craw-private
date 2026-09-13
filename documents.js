// ── Document library module (local extraction + SQLite) ──────────────────────
//
// Ingests documents (PDF, Markdown, plain text, URL, office formats) by
// extracting text LOCALLY — no LLM calls, no indexing pipeline, no provider
// configuration. Extraction happens inside the add request: the response
// carries the terminal status (`ready` or `error`), so the UI can never
// observe a stuck "indexing" state. Document records and extracted source
// text persist to the SQLite project database (`db.js`); search infrastructure
// over the library lives in `documents-search.js` (FTS5 chunks) and the agent
// retrieves through the library MCP tools.
//
// Status transitions are broadcast over WebSocket via an injected `broadcast`
// callback as `documents_status` events (a consistency mechanism — with
// synchronous ingest the HTTP response already carries the terminal status).

import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import * as readers from "./readers.js";
import * as search from "./documents-search.js";
import { PDFParse } from "pdf-parse";

// Supported file extensions -> document type. The single source of truth for
// what the upload route accepts; the client file-picker `accept` and drag/paste
// type inference mirror this. Unsupported extensions are rejected (HTTP 415)
// rather than silently classified as Markdown.
export const EXT_TYPE_MAP = {
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".text": "text",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".csv": "csv",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
};
export const SUPPORTED_EXTS = Object.keys(EXT_TYPE_MAP);

// Map an uploaded filename to its document type, or null if unsupported.
export function typeForFilename(filename) {
  const dot = (filename || "").lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  return EXT_TYPE_MAP[ext] || null;
}

// URL fetch caps (mirror the former knowledge module).
const MAX_FETCH_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

let broadcast = () => {}; // injected WS broadcast (no-op until initStore)

// ── Store init ────────────────────────────────────────────────────────────────

export async function initStore({ broadcast: broadcastFn }) {
  if (broadcastFn) broadcast = broadcastFn;

  // Reconcile rows left non-terminal by a previous process. Synchronous ingest
  // makes these rare (a crash mid-request); WITH source_text the extraction is
  // already the deliverable → ready; without it the ingest cannot resume.
  if (db.isDbReady()) {
    for (const d of db.listDocuments()) {
      if (d.status !== "queued" && d.status !== "indexing") continue;
      const full = db.getDocument(d.id);
      if (full?.source_text?.trim()) {
        db.updateDocumentStatus(d.id, "ready");
        emitStatus(d, "ready");
      } else {
        const msg = "Ingest interrupted by server restart; please re-add the document.";
        db.updateDocumentStatus(d.id, "error", msg);
        emitStatus(d, "error", msg);
      }
    }
    // Idempotent chunk backfill for pre-upgrade rows (local CPU, no LLM).
    search.backfillChunks();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Add a document: extract text locally, persist it, return the TERMINAL status.
// The row is inserted as `queued` first so a mid-extraction crash leaves
// something for startup reconciliation; callers only see `ready`/`error`.
// `payload` carries the ingestion input:
//   - pdf: { buffer }
//   - markdown/text: { content } or { buffer }
//   - url: { url }
//   - reader types (docx/csv/html/json/xlsx/pptx): { buffer }
export async function addDocument({ type, name, buffer, content, url }) {
  const id = randomUUID();
  const docName = name || defaultName(type, url, content);
  const now = new Date().toISOString();
  db.upsertDocument({ id, name: docName, type, status: "queued", added_at: now });
  try {
    const sourceText = await extractSourceText({ type, name: docName, buffer, content, url });
    if (!sourceText.trim()) throw new Error("Extraction produced empty text");
    db.setDocumentSource(id, sourceText);
    search.indexDocumentChunks(id, docName, sourceText);
    db.updateDocumentStatus(id, "ready");
    emitStatus({ id, name: docName }, "ready");
    return { id, name: docName, status: "ready" };
  } catch (err) {
    const msg = err.message || "Ingest failed";
    db.updateDocumentStatus(id, "error", msg);
    emitStatus({ id, name: docName }, "error", msg);
    console.error(`[documents] ingest failed for "${docName}":`, msg);
    return { id, name: docName, status: "error", error: msg };
  }
}

export function listDocuments() {
  return db.listDocuments(); // [{ id, name, type, status, addedAt, error }]
}

// Return the extracted source text for a document (for the "view content" UI).
export async function getDocumentContent(id) {
  const doc = db.getDocument(id);
  return doc?.source_text ?? null;
}

// Delete a document (record + source text + index rows, via ON DELETE CASCADE).
// Idempotent: a missing id succeeds.
export async function removeDocument(id) {
  db.deleteDocument(id);
  return true;
}

// ── Local extraction ─────────────────────────────────────────────────────────

// Extract plain text for any supported document type. Pure-local: file buffers
// are parsed in-process, URLs are fetched (SSRF-protected). Throws with a
// specific message on failure; addDocument turns that into an `error` row.
async function extractSourceText({ type, buffer, content, url }) {
  if (url || type === "url") {
    return fetchUrlAsText(url);
  }
  if (type === "markdown" || type === "text") {
    const text = content ?? (buffer ? buffer.toString("utf8") : "");
    if (!text.trim()) throw new Error(`Missing ${type} content`);
    return text;
  }
  if (type === "pdf") {
    if (!buffer) throw new Error("Missing PDF buffer");
    // pdf-parse v2: one parser instance per document; destroy releases the
    // worker it spins up, so the finally matters as much as the await.
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      const text = (result?.text || "").trim();
      if (!text) throw new Error("PDF extraction produced empty text (scanned/image PDF?)");
      return text;
    } finally {
      parser.destroy();
    }
  }
  if (readers.hasReader(type)) {
    // Reader-backed types extract from the buffer; a content-only payload means
    // a restart re-ingest of already-extracted text — pass it through.
    if (buffer) return readers.extractText(type, buffer);
    const text = content || "";
    if (!text.trim()) throw new Error(`Missing ${type} content`);
    return text;
  }
  throw new Error(`Unsupported document type: ${type}`);
}

// ── URL ingestion: fetch + HTML-to-text ──────────────────────────────────────

// Resolve the HTTP(S) proxy to use for URL ingestion. Node's global fetch does
// not honor http_proxy/https_proxy env vars, so this is consumed explicitly
// below. https_proxy is preferred over http_proxy.
function proxyForUrl() {
  return (
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    ""
  );
}

async function fetchUrlAsText(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http(s) URLs are allowed");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error("Fetching private or local network hosts is not allowed");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const proxyUrl = proxyForUrl();
  let res;
  try {
    const options = {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "platform-documents/1.0" },
    };
    if (proxyUrl) {
      // Node's global fetch ignores http_proxy/https_proxy env vars, so when a
      // proxy is configured route through it via undici's ProxyAgent dispatcher
      // (undici is the engine behind Node's fetch). undici's own fetch is used
      // here so the dispatcher instance is guaranteed compatible.
      const { ProxyAgent, fetch: undiciFetch } = await import("undici");
      options.dispatcher = new ProxyAgent(proxyUrl);
      res = await undiciFetch(url, options);
    } else {
      res = await fetch(url, options);
    }
  } catch (err) {
    throw new Error(`URL fetch failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`URL fetch failed: HTTP ${res.status}`);

  let html = await res.text();
  if (html.length > MAX_FETCH_BYTES) html = html.slice(0, MAX_FETCH_BYTES);

  // Strip scripts/styles then tags to plain text.
  return htmlToText(html);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

// Block loopback, private, link-local, and .local hosts to prevent SSRF.
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;

  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
  }
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultName(type, url, content) {
  if (type === "url" && url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
  if (type === "text") {
    const preview = (content || "").trim().slice(0, 40).replace(/\n/g, " ");
    return preview ? `Note: ${preview}` : `Note ${new Date().toISOString().slice(0, 16)}`;
  }
  return "Untitled";
}

function emitStatus(doc, status, error) {
  broadcast({
    type: "documents_status",
    id: doc.id,
    name: doc.name,
    status,
    error: error || undefined,
  });
}
