// Client wrappers for the document + collection REST endpoints.
// Mirrors the vanilla app.js behavior but typed and React-friendly.

export interface DocMeta {
  id: string;
  name: string;
  type: string;
  status: "queued" | "indexing" | "ready" | "error";
  error?: string;
  createdAt?: number;
}

export interface CollectionMeta {
  id: string;
  name: string;
  description?: string;
  documentCount?: number;
  createdAt?: number;
}

export interface QueryResult {
  answer?: string;
  sources?: { name: string }[];
  error?: string;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function listDocuments(): Promise<DocMeta[]> {
  const r = await fetch("/api/documents");
  const j = await jsonOrThrow<{ documents: DocMeta[] }>(r);
  return j.documents ?? [];
}

export async function getDocumentContent(id: string): Promise<string> {
  const r = await fetch(`/api/documents/${encodeURIComponent(id)}`);
  const j = await jsonOrThrow<{ content: string }>(r);
  return j.content ?? "";
}

export async function deleteDocument(id: string): Promise<void> {
  const r = await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function uploadFile(file: File, signal?: AbortSignal): Promise<DocMeta> {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/documents", { method: "POST", body: fd, signal });
  return jsonOrThrow<DocMeta>(r);
}

export async function addText(content: string, name?: string): Promise<DocMeta> {
  const r = await fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "text", content, name }),
  });
  return jsonOrThrow<DocMeta>(r);
}

export async function addUrl(url: string, name?: string): Promise<DocMeta> {
  const r = await fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "url", url, name }),
  });
  return jsonOrThrow<DocMeta>(r);
}

export async function queryDocuments(query: string): Promise<QueryResult> {
  const r = await fetch("/api/documents/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return jsonOrThrow<QueryResult>(r);
}

// ── Collections ──

export async function listCollections(): Promise<CollectionMeta[]> {
  const r = await fetch("/api/collections");
  const j = await jsonOrThrow<{ collections: CollectionMeta[] }>(r);
  return j.collections ?? [];
}

export async function createCollection(name: string, description?: string): Promise<CollectionMeta> {
  const r = await fetch("/api/collections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  const j = await jsonOrThrow<{ collection: CollectionMeta }>(r);
  return j.collection;
}

export async function deleteCollection(id: string): Promise<void> {
  const r = await fetch(`/api/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function listCollectionMembers(id: string): Promise<DocMeta[]> {
  const r = await fetch(`/api/collections/${encodeURIComponent(id)}/documents`);
  const j = await jsonOrThrow<{ documents: DocMeta[] }>(r);
  return j.documents ?? [];
}

export async function addDocumentToCollection(id: string, documentId: string): Promise<void> {
  const r = await fetch(`/api/collections/${encodeURIComponent(id)}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function queryCollection(id: string, query: string): Promise<QueryResult> {
  const r = await fetch(`/api/collections/${encodeURIComponent(id)}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return jsonOrThrow<QueryResult>(r);
}
