// Documents view: ingestion (file/text/URL), document list with live status,
// source-content viewer, per-doc + collection query, collection management.
//
// UI shape: hero card with collection summary, then three cards (ingest, list,
// query), then a card per collection. Each section is a Card primitive so the
// page reads as a stack of distinct actions rather than a flat form.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useDocumentsStore } from "@/hooks/useDocumentsStore";
import * as api from "@/lib/documents-api";
import type { DocMeta, CollectionMeta } from "@/lib/documents-api";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  ready: "bg-success/15 text-success",
  indexing: "bg-warning/15 text-warning",
  queued: "bg-muted text-muted-foreground",
  error: "bg-destructive/15 text-destructive",
};

export function DocumentsPage() {
  const { t } = useTranslation();
  const { documents, loading, selectedDocId, selectedDocContent } = useDocumentsStore(
    useShallow((s) => ({
      documents: s.documents,
      loading: s.loading,
      selectedDocId: s.selectedDocId,
      selectedDocContent: s.selectedDocContent,
    })),
  );
  const load = useDocumentsStore((s) => s.load);
  const refreshDocs = useDocumentsStore((s) => s.refreshDocs);
  const selectDoc = useDocumentsStore((s) => s.selectDoc);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — `load` is redefined per render; refetching only on `enabled` transitions
  useEffect(() => {
    if (enabled) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!configChecked) return <div className="p-6 text-muted-foreground">{t("documents.loading")}</div>;

  if (enabled === false) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center p-6">
        <h1 className="text-2xl font-semibold">{t("documents.title")}</h1>
        <p className="mt-2 text-muted-foreground" data-testid="documents-disabled">
          {t("documents.disabledMessage")}
        </p>
      </main>
    );
  }

  // Summary stats for the hero — counts per status drive the badges.
  const stats = {
    total: documents.length,
    ready: documents.filter((d) => d.status === "ready").length,
    indexing: documents.filter((d) => d.status === "indexing" || d.status === "queued").length,
    error: documents.filter((d) => d.status === "error").length,
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6" data-testid="documents-page">
      {/* Hero — sets context: how many docs, what state they're in. */}
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Icon name="file-text" size={22} className="text-primary" />
            {t("documents.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("documents.list.count", { count: stats.total })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {stats.ready > 0 && (
            <span className="rounded-full bg-success/15 px-2.5 py-0.5 text-xs font-medium text-success" data-testid="stats-ready">
              {t("documents.status.ready")} {stats.ready}
            </span>
          )}
          {stats.indexing > 0 && (
            <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-medium text-warning" data-testid="stats-indexing">
              {t("documents.status.indexing")} {stats.indexing}
            </span>
          )}
          {stats.error > 0 && (
            <span className="rounded-full bg-destructive/15 px-2.5 py-0.5 text-xs font-medium text-destructive" data-testid="stats-error">
              {t("documents.status.error")} {stats.error}
            </span>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <IngestSection onAdded={() => refreshDocs()} />

        <QuerySection />
      </div>

      {/* Document list — search + status filter, separate card so the list
          stays scannable even with 50+ docs. */}
      <section className="mt-6">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Icon name="file-text" size={16} />
              {t("documents.list.count", { count: documents.length })}
            </h2>
            <div className="flex items-center gap-2">
              <button onClick={() => refreshDocs()} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" data-testid="docs-refresh">
                {t("documents.list.refresh")}
              </button>
            </div>
          </div>
          {loading ? (
            <p className="mt-2 text-sm text-muted-foreground">{t("documents.loading")}</p>
          ) : documents.length === 0 ? (
            <div className="mt-4 flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-6 text-center" data-testid="doc-list-empty">
              <Icon name="file-text" size={28} className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("documents.list.empty")}</p>
            </div>
          ) : (
            <ul className="mt-3 flex flex-col gap-1" data-testid="doc-list">
              {documents.map((d) => (
                <DocRow key={d.id} doc={d}
                  selected={selectedDocId === d.id}
                  onSelect={() => selectDoc(d.id)}
                  onDelete={async () => { await api.deleteDocument(d.id); await refreshDocs(); }}
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {selectedDocId && (
        <section className="mt-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Icon name="file-text" size={16} />
              {t("documents.content.title")}
            </h2>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="doc-content">
              {selectedDocContent ?? t("documents.loading")}
            </pre>
          </div>
        </section>
      )}

      <CollectionsSection />
    </main>
  );
}

function IngestSection({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (f: File) => {
    if (!f) return;
    setBusy(true); setErr(null);
    try { await api.uploadFile(f); onAdded(); }
    catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  };
  const onFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) await handleFile(f);
    e.target.value = "";
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) await handleFile(f);
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
    <section className="rounded-lg border border-border bg-card p-4" data-testid="ingest-section">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <Icon name="upload" size={16} />
        {t("documents.ingest.uploadFile")}
      </h2>

      {/* Drop zone — a labeled file picker (always present) wrapped in a dashed
          border that highlights on dragover. The drop event reads the file
          directly so the user doesn't need to find the picker. */}
      <div
        className={cn(
          "mt-3 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 text-center transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-border",
        )}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        data-testid="dropzone"
      >
        <Icon name="cloud-upload" size={28} className="text-muted-foreground" />
        <label className="cursor-pointer rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted" data-testid="file-upload-label">
          {t("documents.ingest.uploadFile")}
          <input type="file" className="hidden" onChange={onFileInput}
            accept=".pdf,.md,.markdown,.docx,.csv,.html,.htm,.json,.txt,application/pdf,text/markdown" />
        </label>
        {busy && <span className="text-xs text-muted-foreground">{t("documents.ingest.working")}</span>}
      </div>

      <div className="mt-3 flex gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
          placeholder={t("documents.ingest.textPlaceholder")}
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs" data-testid="text-input" />
        <button onClick={handleText} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50" data-testid="add-text-btn">
          {t("documents.ingest.addNote")}
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/page"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs" data-testid="url-input" />
        <button onClick={handleUrl} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50" data-testid="add-url-btn">
          {t("documents.ingest.addUrl")}
        </button>
      </div>
      {err && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="ingest-error" role="alert">
          <Icon name="alert-circle" size={14} className="mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}
    </section>
  );
}

function DocRow({ doc, selected, onSelect, onDelete }: {
  doc: DocMeta; selected: boolean; onSelect: () => void; onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className={cn(
      "flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
      selected ? "border-primary bg-primary/5" : "border-border",
    )} data-testid="doc-row" data-doc-id={doc.id}>
      <button onClick={onSelect} className="flex flex-1 items-center gap-2 text-left">
        <Icon name="file-text" size={14} className="shrink-0 text-muted-foreground" />
        <span className="font-medium">{doc.name}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", STATUS_COLORS[doc.status] ?? "bg-muted text-muted-foreground")} data-testid="doc-status">
          {t(`documents.status.${doc.status}`, { defaultValue: doc.status })}
        </span>
        {doc.error && <span className="truncate text-xs text-destructive" title={doc.error}>{doc.error}</span>}
      </button>
      <button onClick={onDelete} className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" data-testid="doc-delete" title={t("documents.remove")}>
        <Icon name="trash-2" size={14} />
      </button>
    </li>
  );
}

function QuerySection() {
  const { t } = useTranslation();
  const { docQuery, docAnswer, docQueryLoading } = useDocumentsStore(
    useShallow((s) => ({ docQuery: s.docQuery, docAnswer: s.docAnswer, docQueryLoading: s.docQueryLoading })),
  );
  const setDocQuery = useDocumentsStore((s) => s.setDocQuery);
  const runDocQuery = useDocumentsStore((s) => s.runDocQuery);
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <Icon name="message-square" size={16} />
        {t("documents.query.title")}
      </h2>
      <div className="mt-3 flex gap-2">
        <input value={docQuery} onChange={(e) => setDocQuery(e.target.value)}
          placeholder={t("documents.query.placeholder")}
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs"
          onKeyDown={(e) => { if (e.key === "Enter" && !docQueryLoading) runDocQuery(); }}
          data-testid="doc-query-input" />
        <button onClick={runDocQuery} disabled={docQueryLoading}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50" data-testid="doc-query-btn">
          {docQueryLoading ? t("documents.ingest.working") : t("documents.query.ask")}
        </button>
      </div>
      {docAnswer && (
        <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs" data-testid="doc-answer">
          {docAnswer.error ? (
            <div className="flex items-start gap-2 text-destructive">
              <Icon name="alert-circle" size={14} className="mt-0.5 shrink-0" />
              <span>{docAnswer.error}</span>
            </div>
          ) : (
            <>
              <p className="whitespace-pre-wrap">{docAnswer.answer}</p>
              {docAnswer.sources && docAnswer.sources.length > 0 && (
                <p className="mt-2 flex items-start gap-1 text-muted-foreground">
                  <Icon name="book-open" size={12} className="mt-0.5 shrink-0" />
                  <span>{t("documents.query.sources", { names: docAnswer.sources.map((s) => s.name).join(", ") })}</span>
                </p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function CollectionsSection() {
  const { t } = useTranslation();
  const { collections, documents } = useDocumentsStore(
    useShallow((s) => ({ collections: s.collections, documents: s.documents })),
  );
  const load = useDocumentsStore((s) => s.load);
  const [name, setName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState<DocMeta[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addDocId, setAddDocId] = useState("");
  const [colQuery, setColQuery] = useState("");
  const [colAnswer, setColAnswer] = useState<{ answer?: string; sources?: { name: string }[]; error?: string } | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    try { await api.createCollection(name); setName(""); await load(); }
    catch (e) { alert((e as Error).message); }
  };
  const remove = async (id: string) => {
    if (!confirm(t("documents.collection.confirmDelete"))) return;
    await api.deleteCollection(id);
    if (openId === id) setOpenId(null);
    await load();
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
      <div className="rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Icon name="folder" size={16} />
          {t("documents.collection.title")}
        </h2>
        <div className="mt-3 flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("documents.collection.namePlaceholder")}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs" data-testid="col-name-input" />
          <button onClick={create} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90" data-testid="col-create-btn">
            {t("documents.collection.create")}
          </button>
        </div>
        {collections.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">{t("documents.collection.empty")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {collections.map((c) => (
              <li key={c.id} className="rounded-md border border-border" data-testid="col-item">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Icon name="folder" size={14} className="text-muted-foreground" />
                  <button onClick={() => open(c)} className="flex-1 text-left font-medium" data-testid="col-row">{c.name}</button>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{t("documents.collection.docsCount", { count: c.documentCount ?? 0 })}</span>
                  <button onClick={() => remove(c.id)} className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" data-testid="col-delete" title={t("documents.collection.delete")}>
                    <Icon name="trash-2" size={14} />
                  </button>
                </div>
                {openId === c.id && (
                  <div className="border-t border-border bg-muted/20 p-3" data-testid="col-detail">
                    {membersLoading ? <p className="text-xs text-muted-foreground">{t("documents.loading")}</p> : (
                      <>
                        <h3 className="text-xs font-semibold text-muted-foreground">{t("documents.title")}</h3>
                        <ul className="mt-2 flex flex-col gap-1">
                          {members.length === 0 && <li className="text-xs text-muted-foreground">{t("documents.collection.noDocuments")}</li>}
                          {members.map((m) => (
                            <li key={m.id} className="flex items-center gap-2 text-xs">
                              <Icon name="file-text" size={12} className="text-muted-foreground" />
                              <span>{m.name}</span>
                            </li>
                          ))}
                        </ul>
                        <div className="mt-3 flex gap-2">
                          <select value={addDocId} onChange={(e) => setAddDocId(e.target.value)} className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs" data-testid="col-add-select">
                            <option value="">{t("documents.collection.addDocPlaceholder")}</option>
                            {documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                          <button onClick={addDoc} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" data-testid="col-add-btn">{t("documents.collection.add")}</button>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <input value={colQuery} onChange={(e) => setColQuery(e.target.value)} placeholder={t("documents.collection.queryPlaceholder")}
                            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs" data-testid="col-query-input" />
                          <button onClick={runQuery} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90" data-testid="col-query-btn">{t("documents.query.ask")}</button>
                        </div>
                        {colAnswer && (
                          <div className="mt-3 rounded-md border border-border bg-background p-2 text-xs" data-testid="col-answer">
                            {colAnswer.error ? <span className="text-destructive">{colAnswer.error}</span> : <>
                              <p className="whitespace-pre-wrap">{colAnswer.answer}</p>
                              {colAnswer.sources && <p className="mt-1 text-muted-foreground">{t("documents.query.sources", { names: colAnswer.sources.map((s) => s.name).join(", ") })}</p>}
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
      </div>
    </section>
  );
}
