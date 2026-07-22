// ── LlamaIndex document readers (text extraction) ────────────────────────────
//
// Extracts plain text from uploaded file buffers for document types beyond
// PDF/Markdown/text/URL. Each type is parsed by the matching @llamaindex/readers
// reader (DocxReader, CSVReader, HTMLReader, JSONReader), which exposes
// loadDataAsContent(Uint8Array): Promise<Document[]>. The extracted text feeds
// into the PageIndex bridge (simpleTree) and the SQLite store, reusing the
// existing indexing pipeline (serialized queue, per-document failure isolation).
//
// All four readers work with no extra npm dependencies today: mammoth (docx),
// csv-parse (csv), @discoveryjs/json-ext (json), and htmlparser2 (html) are
// present transitively. JSONReader is constructed with a no-op logger so the
// underlying json-ext parser does not write progress lines to the server log.

import { DocxReader } from "@llamaindex/readers/docx";
import { CSVReader } from "@llamaindex/readers/csv";
import { HTMLReader } from "@llamaindex/readers/html";
import { JSONReader } from "@llamaindex/readers/json";

// Silences @discoveryjs/json-ext's per-parse "Parsing JSON" progress logging.
const SILENT_LOGGER = {
  log() {},
  warn() {},
  error() {},
  info() {},
  debug() {},
};

// document type -> () => reader instance. Types not listed here (pdf/markdown/
// text/url) are handled directly by pageindex-bridge and never reach here.
function readerFor(type) {
  switch (type) {
    case "docx":
      return new DocxReader();
    case "csv":
      return new CSVReader();
    case "html":
      return new HTMLReader();
    case "json":
      return new JSONReader({ logger: SILENT_LOGGER });
    default:
      return null;
  }
}

// Whether a document type is backed by a LlamaIndex reader (used by the bridge
// to dispatch extraction).
export function hasReader(type) {
  return readerFor(type) !== null;
}

// Extract plain text from an in-memory buffer for a LlamaIndex-reader-backed
// document type. Returns the concatenated text of all extracted Documents.
// Throws on extraction failure; the caller (documents.js runIndex) marks the
// document `error` in isolation, so one bad file never blocks the queue.
export async function extractText(type, buffer) {
  const reader = readerFor(type);
  if (!reader) throw new Error(`No LlamaIndex reader for document type: ${type}`);
  if (!buffer) throw new Error(`Missing buffer for ${type} document`);
  // Copy into a standalone Uint8Array so the reader sees a clean ArrayBuffer
  // (Node Buffers share a pooled ArrayBuffer that can confuse typed-array APIs).
  const content = new Uint8Array(buffer);
  const docs = await reader.loadDataAsContent(content);
  const text = docs.map((d) => d.text || "").join("\n\n").trim();
  if (!text) throw new Error(`LlamaIndex reader produced empty text for ${type}`);
  return text;
}
