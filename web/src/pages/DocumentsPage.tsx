// Documents view: ingestion (file/text/URL), document list with live status,
// source-content viewer, per-doc + collection query, collection management.
// Replaces the legacy vanilla Documents + Collections tabs.
import { useEffect, useState } from "react";
import { useDocumentsStore } from "@/hooks/useDocumentsStore";
import * as api from "@/lib/documents-api";
import type { DocMeta, CollectionMeta } from "@/lib/documents-api";
import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  ready: "text-[color:var(--color-success)]",
  indexing: "text-warning",
  queued: "text-muted-foreground",
  error: "text-destructive",
};

export function DocumentsPage() {
  const store = useDocumentsStore();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [configChecked, setConfigChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => { if (!cancelled) setEnabled(Boolean(c?.documentsEnabled ?? true)); })
      .catch(() => { if (!cancelled) setEnabled(false); })
      .finally(() => { if (!cancelled) setConfigChecked(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (enabled) store.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!configChecked) return <div className="p-6 text-muted-foreground">Loading…</div>;

  if (enabled === false) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center p-6">
        <h1 className="text-2xl font-semibold">Documents</h1>
        <p className="mt-2 text-muted-foreground" data-testid="documents-disabled">
          Documents are unavailable (document collection is disabled or the database is unreachable).
        </p>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6" data-testid="documents-page">
      <h1 className="text-2xl font-semibold">Documents</h1>

      <IngestSection onAdded={() => store.refreshDocs()} />

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Documents <span className="text-muted-foreground">({store.documents.length})</span></h2>
          <button onClick={() => store.refreshDocs()} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" data-testid="docs-refresh">Refresh</button>
        </div>
        {store.loading ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : store.documents.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No documents yet. Add one above.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1" data-testid="doc-list">
            {store.documents.map((d) => (
              <DocRow key={d.id} doc={d}
                selected={store.selectedDocId === d.id}
                onSelect={() => store.selectDoc(d.id)}
                onDelete={async () => { await api.deleteDocument(d.id); await store.refreshDocs(); }}
              />
            ))}
          </ul>
        )}
      </section>

      {store.selectedDocId && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">Content</h2>
          <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="doc-content">
            {store.selectedDocContent ?? "Loading…"}
          </pre>
        </section>
      )}

      <QuerySection />

      <CollectionsSection />
    </main>
  );
}

function IngestSection({ onAdded }: { onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true); setErr(null);
    try { await api.uploadFile(f); onAdded(); }
    catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); e.target.value = ""; }
  };
  const handleText = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr(null);
    try { await api.addText(text); setText(""); onAdded(); }
    catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  };
  const handleUrl = async () => {
    if (!url.trim()) return;
    setBusy(true); setErr(null);
    try { await api.addUrl(url); setUrl(""); onAdded(); }
    catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <section className="mt-4 rounded-md border border-border p-3" data-testid="ingest-section">
      <div className="flex flex-wrap gap-2">
        <label className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted cursor-pointer" data-testid="file-upload-label">
          Upload file
          <input type="file" className="hidden" onChange={handleFile}
            accept=".pdf,.md,.markdown,.docx,.csv,.html,.htm,.json,.txt,application/pdf,text/markdown" />
        </label>
        {busy && <span className="text-xs text-muted-foreground self-center">Working…</span>}
      </div>
      <div className="mt-2 flex gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          placeholder="Paste plain text or notes…"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs" data-testid="text-input" />
        <button onClick={handleText} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50" data-testid="add-text-btn">Add note</button>
      </div>
      <div className="mt-2 flex gap-2">
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/page"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs" data-testid="url-input" />
        <button onClick={handleUrl} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50" data-testid="add-url-btn">Add URL</button>
      </div>
      {err && <p className="mt-2 text-xs text-destructive" data-testid="ingest-error">{err}</p>}
    </section>
  );
}

function DocRow({ doc, selected, onSelect, onDelete }: {
  doc: DocMeta; selected: boolean; onSelect: () => void; onDelete: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm" data-testid="doc-row" data-doc-id={doc.id}>
      <button onClick={onSelect} className="flex-1 text-left">
        <span className="font-medium">{doc.name}</span>
        <span className={cn("ml-2 text-xs", STATUS_COLORS[doc.status] ?? "text-muted-foreground")} data-testid="doc-status">{doc.status}</span>
        {doc.error && <span className="ml-2 text-xs text-destructive">{doc.error}</span>}
      </button>
      <button onClick={onDelete} className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted" data-testid="doc-delete">Remove</button>
    </li>
  );
}

function QuerySection() {
  const store = useDocumentsStore();
  return (
    <section className="mt-6">
      <h2 className="text-lg font-semibold">Ask the documents</h2>
      <div className="mt-2 flex gap-2">
        <input value={store.docQuery} onChange={(e) => store.setDocQuery(e.target.value)}
          placeholder="Ask a question about your documents…"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs" data-testid="doc-query-input" />
        <button onClick={store.runDocQuery} disabled={store.docQueryLoading}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50" data-testid="doc-query-btn">Ask</button>
      </div>
      {store.docAnswer && (
        <div className="mt-2 rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="doc-answer">
          {store.docAnswer.error ? (
            <span className="text-destructive">{store.docAnswer.error}</span>
          ) : (
            <>
              <p>{store.docAnswer.answer}</p>
              {store.docAnswer.sources && store.docAnswer.sources.length > 0 && (
                <p className="mt-2 text-muted-foreground">Sources: {store.docAnswer.sources.map((s) => s.name).join(", ")}</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function CollectionsSection() {
  const store = useDocumentsStore();
  const [name, setName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState<DocMeta[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addDocId, setAddDocId] = useState("");
  const [colQuery, setColQuery] = useState("");
  const [colAnswer, setColAnswer] = useState<{ answer?: string; sources?: { name: string }[]; error?: string } | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    try { await api.createCollection(name); setName(""); await store.load(); }
    catch (e) { alert((e as Error).message); }
  };
  const remove = async (id: string) => {
    if (!confirm("Delete this collection?")) return;
    await api.deleteCollection(id);
    if (openId === id) setOpenId(null);
    await store.load();
  };
  const open = async (c: CollectionMeta) => {
    if (openId === c.id) { setOpenId(null); return; }
    setOpenId(c.id); setMembersLoading(true); setColAnswer(null); setColQuery("");
    try { setMembers(await api.listCollectionMembers(c.id)); }
    catch (e) { alert((e as Error).message); }
    finally { setMembersLoading(false); }
  };
  const addDoc = async () => {
    if (!openId || !addDocId) return;
    try { await api.addDocumentToCollection(openId, addDocId); setMembers(await api.listCollectionMembers(openId)); setAddDocId(""); }
    catch (e) { alert((e as Error).message); }
  };
  const runQuery = async () => {
    if (!openId || !colQuery.trim()) return;
    setColAnswer(null);
    try { setColAnswer(await api.queryCollection(openId, colQuery)); }
    catch (e) { setColAnswer({ error: (e as Error).message }); }
  };

  return (
    <section className="mt-6" data-testid="collections-section">
      <h2 className="text-lg font-semibold">Collections</h2>
      <div className="mt-2 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Collection name…"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs" data-testid="col-name-input" />
        <button onClick={create} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted" data-testid="col-create-btn">Create</button>
      </div>
      {store.collections.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No collections yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {store.collections.map((c) => (
            <li key={c.id} className="rounded-md border border-border px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <button onClick={() => open(c)} className="flex-1 text-left font-medium" data-testid="col-row">{c.name}</button>
                <span className="text-xs text-muted-foreground">{c.documentCount ?? 0} docs</span>
                <button onClick={() => remove(c.id)} className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted" data-testid="col-delete">Delete</button>
              </div>
              {openId === c.id && (
                <div className="mt-2 border-t border-border pt-2" data-testid="col-detail">
                  {membersLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : (
                    <>
                      <h3 className="text-xs font-semibold text-muted-foreground">Documents</h3>
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {members.length === 0 && <li className="text-xs text-muted-foreground">No documents.</li>}
                        {members.map((m) => <li key={m.id} className="text-xs">{m.name}</li>)}
                      </ul>
                      <div className="mt-2 flex gap-2">
                        <select value={addDocId} onChange={(e) => setAddDocId(e.target.value)} className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs" data-testid="col-add-select">
                          <option value="">Add document…</option>
                          {store.documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                        <button onClick={addDoc} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" data-testid="col-add-btn">Add</button>
                      </div>
                      <div className="mt-2 flex gap-2">
                        <input value={colQuery} onChange={(e) => setColQuery(e.target.value)} placeholder="Ask about this collection…"
                          className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs" data-testid="col-query-input" />
                        <button onClick={runQuery} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" data-testid="col-query-btn">Ask</button>
                      </div>
                      {colAnswer && (
                        <div className="mt-2 rounded-md bg-muted/30 p-2 text-xs" data-testid="col-answer">
                          {colAnswer.error ? <span className="text-destructive">{colAnswer.error}</span> : <>
                            <p>{colAnswer.answer}</p>
                            {colAnswer.sources && <p className="mt-1 text-muted-foreground">Sources: {colAnswer.sources.map((s) => s.name).join(", ")}</p>}
                          </>}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
