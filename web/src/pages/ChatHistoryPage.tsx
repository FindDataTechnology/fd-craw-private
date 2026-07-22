// Chat History view: browse past sessions read-only.
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface SessionMeta {
  id: string;
  title?: string;
  updatedAt?: number;
}
interface SessionDetail {
  id: string;
  title?: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

export function ChatHistoryPage() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/chat-history/sessions");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setSessions(j.sessions ?? []);
      setCurrent(j.current ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const open = async (id: string) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null);
    try {
      const r = await fetch(`/api/chat-history/sessions/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDetail(await r.json());
    } catch (e) {
      setDetail({ id, messages: [], title: `Error: ${(e as Error).message}` });
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="history-page">
      {/* Session list */}
      <section className="flex w-72 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border p-3">
          <h2 className="text-sm font-semibold">Sessions</h2>
          <button onClick={load} disabled={loading} className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50" data-testid="history-refresh">
            {loading ? "…" : "Refresh"}
          </button>
        </div>
        <ul className="flex-1 overflow-y-auto p-2" data-testid="history-list">
          {sessions.length === 0 && <li className="px-2 py-1 text-xs text-muted-foreground">No sessions.</li>}
          {sessions.map((s) => (
            <li key={s.id}>
              <button onClick={() => open(s.id)}
                data-testid="history-row" data-session-id={s.id}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                  openId === s.id && "bg-muted",
                )}>
                <span className="truncate text-foreground">{s.title || "Untitled"}</span>
                {s.updatedAt && <span className="text-[10px] text-muted-foreground">{new Date(s.updatedAt).toLocaleString()}</span>}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* Message viewer */}
      <section className="flex-1 overflow-y-auto p-4">
        {error && <p className="text-sm text-destructive" data-testid="history-error">{error}</p>}
        {!detail && !error && <p className="text-sm text-muted-foreground">Select a session to view its messages.</p>}
        {detail && (
          <div data-testid="history-detail">
            <h1 className="mb-3 text-lg font-semibold">{detail.title || "Untitled"}</h1>
            <div className="flex flex-col gap-3">
              {detail.messages.length === 0 && <p className="text-sm text-muted-foreground">No messages.</p>}
              {detail.messages.map((m, i) => (
                <div key={i} data-testid="history-message" data-role={m.role}
                  className={cn("rounded-md border border-border p-3 text-sm", m.role === "user" ? "bg-muted/30" : "")}>
                  <div className="mb-1 text-xs font-semibold text-muted-foreground">{m.role}</div>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
