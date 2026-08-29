// ── PageIndex <-> LlamaIndex bridge ──────────────────────────────────────────
//
// LlamaIndex.TS remains the project's data-management framework (document
// model, readers, orchestration in documents.js). This module adapts the
// `pageindex` library as the indexing layer LlamaIndex saves document data
// into, and persists the resulting hierarchical tree to the SQLite project
// database. Because `pageindex` exposes indexing only (no retrieval API, no
// storage backend), this bridge also implements reasoning-based retrieval over
// the persisted trees: the LLM reasons over node summaries to select relevant
// nodes, then synthesizes an answer with sources.
//
// LlamaIndex "accesses pageindex" (indexing) and "reads from sqlite" (retrieval
// loads trees + source text from the project database) through this module.

import * as db from "./db.js";
import { chat } from "./llm-chat.js";

// Heavy deps at first use: the pageindex lib and the LlamaIndex readers pull
// large dependency trees (mammoth, officeparser, csv/html/json parsers) that
// have no business blocking server boot — they load on the first indexing
// call and stay cached for the process lifetime.
let pageindexMod = null;
async function getPageindex() {
  pageindexMod ??= await import("pageindex");
  return pageindexMod;
}
async function getReaders() {
  return import("./readers.js");
}

// Reasoning model for indexing summaries and retrieval. Override with
// DOCUMENTS_MODEL; must be a model id registered on the configured provider.
export const DOCUMENTS_MODEL = process.env.DOCUMENTS_MODEL || "deepseek-v4-pro";

let provider = null; // { baseUrl, apiKey, model }

export function initBridge({ baseUrl, apiKey, model }) {
  provider = { baseUrl, apiKey, model: model || DOCUMENTS_MODEL };
  // pageindex's internal OpenAI client falls back to env vars; set them so
  // every indexing call routes to the configured provider.
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.OPENAI_API_KEY = apiKey;
}

function pageindexOptions() {
  return {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: provider.model,
    addNodeText: true, // carry node text for retrieval
    addNodeSummary: true, // LLM summaries for larger nodes (skipped below threshold)
    addDocDescription: false, // not used in retrieval; avoids an extra LLM call per doc
  };
}

// ── Indexing ─────────────────────────────────────────────────────────────────
//
// Build a PageIndex tree from a document. `content` is extracted text (for
// markdown/text/url, parsed/fetched by documents.js); `buffer` is the raw PDF
// bytes (PageIndex.fromPdf does its own page-aware parsing). Returns the
// extracted source text (for SQLite `source_text` + "view content") and the
// PageIndexResult tree (for SQLite `doc_index`).

export async function buildIndex({ type, name, content, buffer }) {
  const opts = pageindexOptions();
  let result;
  let sourceText;
  const { PageIndex, markdownToTree } = await getPageindex();
  const { hasReader } = await getReaders();

  if (type === "markdown") {
    sourceText = content ?? (buffer ? buffer.toString("utf8") : "");
    if (!sourceText) throw new Error("Missing markdown content");
    result = await markdownToTree(sourceText, name || "document", opts);
  } else if (type === "pdf") {
    if (!buffer) throw new Error("Missing PDF buffer");
    result = await new PageIndex(opts).fromPdf(buffer);
    sourceText = flattenTreeText(result.structure);
  } else if (type === "text" || type === "url") {
    // A .txt upload arrives as a raw buffer (multer) — decode it, mirroring
    // the markdown branch above.
    sourceText = content ?? (buffer ? buffer.toString("utf8") : "");
    if (!sourceText) throw new Error("Missing text content");
    result = simpleTree(name || "document", sourceText);
  } else if (hasReader(type)) {
    // LlamaIndex-reader-backed types (docx/csv/html/json): extract text from the
    // buffer via the reader, then build a simple PageIndex tree. If a buffer is
    // not present but content is (restart re-index from persisted source_text),
    // skip re-extraction and build the tree from the saved text directly.
    if (buffer) {
      const { extractText } = await getReaders();
      sourceText = await extractText(type, buffer);
    } else {
      sourceText = content || "";
    }
    if (!sourceText) throw new Error(`Missing ${type} content`);
    result = simpleTree(name || "document", sourceText);
  } else {
    throw new Error(`Unsupported document type for PageIndex: ${type}`);
  }

  // Ensure the tree is non-trivial.
  if (!result?.structure?.length) {
    throw new Error("PageIndex produced an empty index");
  }
  return { sourceText, result };
}

// Persist a built index to SQLite (doc_index) as JSON.
export function persistIndex(docId, result) {
  db.setDocIndex(docId, result);
  treeCache.delete(docId); // invalidate; next read re-caches the fresh row
}

// Load a persisted index tree by document id.
export function loadIndex(docId) {
  return db.getDocIndex(docId);
}

// Parsed-tree LRU: getDocIndex JSON.parse()s the whole serialized tree per
// document per query — with a cache, repeated queries (and every doc in a
// multi-doc query after the first) skip both the SQLite read and the parse.
// Simple insertion-order Map LRU; capped because trees can be large.
const TREE_CACHE_MAX = 32;
const treeCache = new Map();
function getDocIndexCached(docId) {
  const hit = treeCache.get(docId);
  if (hit) {
    treeCache.delete(docId);
    treeCache.set(docId, hit); // refresh recency
    return hit;
  }
  const idx = db.getDocIndex(docId);
  if (idx) {
    treeCache.set(docId, idx);
    if (treeCache.size > TREE_CACHE_MAX) treeCache.delete(treeCache.keys().next().value);
  }
  return idx;
}

// ── Retrieval (reasoning over the tree) ──────────────────────────────────────

const MAX_NODES_PER_DOC = 12; // cap selected nodes per document
const MAX_NODE_TEXT_CHARS = 2000; // cap each node's text in the answer context
// Per-document retrieval = 2 sequential LLM calls (node selection, then the
// per-doc answer). Documents run CONCURRENTLY up to this bound — a 10-doc
// query used to be 21 strictly sequential calls (minutes); at concurrency 3
// it's ~ceil(10/3) rounds + synthesis. Env-overridable.
const RAG_CONCURRENCY = Math.max(1, Number(process.env.RAG_CONCURRENCY) || 3);

// Tiny bounded-concurrency map: preserves per-doc failure isolation.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// Retrieve over a set of ready documents. `docs` defaults to all ready docs
// (the collection-wide query); passing a collection's members scopes retrieval
// to that collection (see documents.queryCollectionDocuments).
export async function queryCollection(query, docs) {
  if (!provider) throw new Error("PageIndex bridge not initialized");

  const ready = docs || db.listReadyDocuments(); // [{ id, name, type }] (light)
  if (!ready.length) return { answer: "", sources: [] };

  const perDoc = [];
  await mapLimit(ready, RAG_CONCURRENCY, async (doc) => {
    try {
      const idx = getDocIndexCached(doc.id);
      if (!idx?.structure) return;
      const nodes = flattenNodes(idx.structure);
      if (!nodes.length) return;

      const relevant = await selectRelevantNodes(query, doc.name, nodes);
      const ctxNodes = (relevant.length ? relevant : nodes.slice(0, MAX_NODES_PER_DOC));
      const ctx = ctxNodes
        .map((n) => `## ${n.path}\n${(n.text || n.summary || "").slice(0, MAX_NODE_TEXT_CHARS)}`)
        .join("\n\n");

      const ans = await chat({
        model: provider.model,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        system: `You answer questions using ONLY the provided context from document "${doc.name}". If the answer is not present, reply exactly "I don't know."`,
        prompt: `CONTEXT FROM "${doc.name}":\n${ctx}\n\nQUESTION: ${query}`,
        temperature: 0.2,
        maxRetries: 3,
      });

      if (ans && ans !== "Error" && !/i don't know/i.test(ans.trim())) {
        perDoc.push({ name: doc.name, text: ans.trim() });
      }
    } catch (err) {
      console.error(`[pageindex-bridge] query failed for "${doc.name}":`, err.message);
    }
  });

  if (!perDoc.length) return { answer: "", sources: [] };

  // Synthesize a single answer from the per-document answers.
  const joined = perDoc.map((d) => `### ${d.name}\n${d.text}`).join("\n\n");
  const prompt = `You are a knowledge retrieval assistant. Synthesize a single answer to the user's question using ONLY the per-document answers below. At the end, add a line "Sources: <comma-separated document names you used>". If none of them answer it, reply "I don't know based on the current document collection."

PER-DOCUMENT ANSWERS:
${joined}

USER QUESTION:
${query}`;

  let answer;
  try {
    answer = await chat({
      model: provider.model,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      prompt,
      temperature: 0.2,
      maxRetries: 3,
    });
  } catch (err) {
    throw new Error(`Query synthesis failed: ${err.message}`);
  }
  if (!answer || answer === "Error") {
    throw new Error("The reasoning model failed to answer (retries exhausted).");
  }
  answer = answer.trim();
  const sources = perDoc.map((d) => d.name).filter((n) => answer.includes(n));
  return { answer, sources };
}

// Ask the LLM which nodes (by 1-based index in the outline) are relevant to the
// query. Returns the selected TreeNode-like objects. Falls back to [] on any
// failure (the caller then uses a capped slice of all nodes).
async function selectRelevantNodes(query, docName, nodes) {
  const outline = nodes
    .map((n, i) => `${i + 1}. ${n.path}${n.summary ? ` — ${n.summary}` : ""}`)
    .join("\n")
    .slice(0, 6000);

  const prompt = `You are selecting relevant sections of a document for a question. Below is the outline of document "${docName}" (section path and summary). Return ONLY a JSON array of 1-based section numbers that are likely to contain the answer. If none are relevant, return []. Max ${MAX_NODES_PER_DOC} numbers.

OUTLINE:
${outline}

QUESTION: ${query}

JSON array:`;

  let resp;
  try {
    resp = await chat({
      model: provider.model,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      prompt,
      temperature: 0,
      maxRetries: 2,
    });
  } catch {
    return [];
  }
  if (!resp || resp === "Error") return [];

  const nums = parseNumberArray(resp);
  if (!nums.length) return [];
  const selected = [];
  for (const n of nums) {
    const node = nodes[n - 1];
    if (node && !selected.includes(node)) selected.push(node);
    if (selected.length >= MAX_NODES_PER_DOC) break;
  }
  return selected;
}

function parseNumberArray(text) {
  // Extract a JSON array of numbers from an LLM response (tolerant of prose).
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

// ── Tree helpers ─────────────────────────────────────────────────────────────

// Flatten a PageIndex tree into a list of { path, title, summary, text }.
function flattenNodes(structure) {
  const out = [];
  const walk = (nodes, parentPath) => {
    for (const n of nodes || []) {
      const title = n.title || "(untitled)";
      const path = parentPath ? `${parentPath} / ${title}` : title;
      out.push({ path, title, summary: n.summary || "", text: n.text || "" });
      if (n.nodes?.length) walk(n.nodes, path);
    }
  };
  walk(structure, "");
  return out;
}

// Concatenate all node text in reading order (used for PDF source_text).
function flattenTreeText(structure) {
  return flattenNodes(structure)
    .map((n) => n.text)
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

// Build a minimal single-node PageIndexResult for unstructured text/url docs.
function simpleTree(name, text) {
  const summary = text.slice(0, 200).replace(/\s+/g, " ").trim();
  return {
    docName: name,
    structure: [
      {
        title: name || "document",
        text,
        summary,
        nodes: [],
      },
    ],
  };
}
