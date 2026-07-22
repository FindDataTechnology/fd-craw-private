// ── Document management module (LlamaIndex framework + PageIndex, SQLite) ────
//
// Ingests documents (PDF, Markdown, plain text, web page/URL). LlamaIndex.TS
// remains the data-management framework (its Settings/Document model is
// configured here); the `pageindex` library is the indexing layer, integrated
// through `pageindex-bridge.js`, which LlamaIndex "saves document data into".
// Document records, extracted source text, and the PageIndex index tree are
// persisted to the SQLite project database (`db.js`), not to per-doc folders.
//
// Indexing runs in a serialized queue with per-document failure isolation;
// status transitions are broadcast over WebSocket via an injected `broadcast`
// callback as `documents_status` events. Query (reasoning-based retrieval over
// the PageIndex trees) is delegated to the bridge.

import { Settings } from "llamaindex";
import { OpenAI } from "@llamaindex/openai";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import * as bridge from "./pageindex-bridge.js";

// Reasoning model used for both indexing and retrieval. Override with the
// DOCUMENTS_MODEL env var; must be a model id registered on the configured
// provider in server.js.
export const DOCUMENTS_MODEL = process.env.DOCUMENTS_MODEL || "deepseek-v4-pro";

// Supported file extensions -> document type. The single source of truth for
// what the upload route accepts; the client file-picker `accept` and drag/paste
// type inference mirror this. Unsupported extensions are rejected (HTTP 415)
// rather than silently classified as Markdown.
export const EXT_TYPE_MAP = {
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".docx": "docx",
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

let provider = null; // { baseUrl, apiKey, model }
let broadcast = () => {}; // injected WS broadcast (no-op until initStore)
let queue = Promise.resolve(); // serialized indexing chain

// ── Store init ────────────────────────────────────────────────────────────────

export async function initStore({ baseUrl, apiKey, model, broadcast: broadcastFn }) {
  provider = { baseUrl, apiKey, model: model || DOCUMENTS_MODEL };
  if (broadcastFn) broadcast = broadcastFn;

  // LlamaIndex remains the data-management framework: configure its LLM so the
  // framework is live, and route its OpenAI client to the configured provider.
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.OPENAI_API_KEY = apiKey;
  Settings.llm = new OpenAI({
    model: provider.model,
    apiKey,
    baseURL: baseUrl,
    temperature: 0.2,
  });

  // Initialize the PageIndex bridge (PageIndex indexing + SQLite persistence +
  // reasoning retrieval) with the same provider. LlamaIndex "accesses pageindex"
  // and "reads from sqlite" through this bridge.
  bridge.initBridge({ baseUrl, apiKey, model: provider.model });

  // Reconcile jobs that were queued/indexing when the previous process exited.
  // Those WITH persisted source_text can be re-indexed through PageIndex (e.g.
  // migrated docs); those without (interrupted new ingestions) cannot resume.
  if (db.isDbReady()) {
    for (const d of db.listDocuments()) {
      if (d.status !== "queued" && d.status !== "indexing") continue;
      const full = db.getDocument(d.id);
      if (full?.source_text) {
        enqueueIndex(d, { content: full.source_text });
      } else {
        const msg = "Indexing interrupted by server restart; please re-add the document.";
        db.updateDocumentStatus(d.id, "error", msg);
        emitStatus(d, "error", msg);
      }
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

// Add a document and auto-index it. Returns { id, status: "queued" }.
// `payload` carries the in-memory ingestion input (not persisted separately):
//   - pdf: { buffer }
//   - markdown: { content } or { buffer }
//   - text: { content }
//   - url: { url }
export async function addDocument({ type, name, buffer, content, url }) {
  const id = randomUUID();
  const docName = name || defaultName(type, url, content);
  const now = new Date().toISOString();
  db.upsertDocument({ id, name: docName, type, status: "queued", added_at: now });
  emitStatus({ id, name: docName }, "queued");
  enqueueIndex({ id, name: docName, type }, { buffer, content, url });
  return { id, status: "queued" };
}

export function listDocuments() {
  return db.listDocuments(); // [{ id, name, type, status, addedAt, error }]
}

// Return the extracted source text for a document (for the "view content" UI).
export async function getDocumentContent(id) {
  const doc = db.getDocument(id);
  return doc?.source_text ?? null;
}

// Delete a document (record + source text + index row, via ON DELETE CASCADE).
// Idempotent: a missing id succeeds.
export async function removeDocument(id) {
  db.deleteDocument(id);
  return true;
}

// Reasoning-based retrieval over the persisted PageIndex trees.
export async function queryCollection(query) {
  return bridge.queryCollection(query);
}

// Retrieve over only the ready documents in a collection (see collections.js).
export async function queryCollectionDocuments(query, collectionId) {
  const docs = db.listReadyDocumentsInCollection(collectionId);
  return bridge.queryCollection(query, docs);
}

// ── Serialized indexing queue ────────────────────────────────────────────────

function enqueueIndex(doc, payload) {
  // Chain jobs so only one document indexes at a time (bounds LLM load, makes
  // failures cleanly attributable). A rejection in one job cannot break the chain.
  queue = queue.then(() => runIndex(doc, payload)).catch((err) => {
    console.error("[documents] indexing chain error:", err.message);
  });
}

async function runIndex(doc, payload) {
  db.updateDocumentStatus(doc.id, "indexing");
  emitStatus(doc, "indexing");

  try {
    // Resolve the input for the bridge. URL is fetched here (SSRF-protected);
    // markdown/text use content (a buffer is decoded as utf8 by the bridge);
    // pdf uses the raw buffer (PageIndex.fromPdf does its own page-aware parse).
    let content = payload.content;
    let buffer = payload.buffer;
    if (payload.url) {
      content = await fetchUrlAsText(payload.url);
    }

    const { sourceText, result } = await bridge.buildIndex({
      type: doc.type,
      name: doc.name,
      content,
      buffer,
    });

    // Persist source text (view content + re-index fallback) and the PageIndex
    // tree to SQLite, then mark ready.
    db.setDocumentSource(doc.id, sourceText);
    bridge.persistIndex(doc.id, result);
    db.updateDocumentStatus(doc.id, "ready");
    emitStatus(doc, "ready");
  } catch (err) {
    db.updateDocumentStatus(doc.id, "error", err.message);
    emitStatus(doc, "error", err.message);
    console.error(`[documents] indexing failed for "${doc.name}":`, err.message);
  }
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
