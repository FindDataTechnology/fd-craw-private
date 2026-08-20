// Agents & Apps catalog page. GET /api/catalog is role-filtered and
// redacted server-side; link entries open externally, nango-connect entries
// mint a connect session via the server-side broker then redirect.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import type { AgentInfo, AppInfo } from "@/types/ws";

export function AgentsPage() {
  const { t } = useTranslation();
  const catalogVersion = useChatStore((s) => s.catalogVersion);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);

  // catalogVersion bumps on `catalog_changed` — refetch so cloud edits show up live.
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/catalog");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const c = await r.json();
      setAgents(c.agents ?? []);
      setApps(c.apps ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, catalogVersion]);

  const connect = async (id: string) => {
    setConnecting(id);
    setError(null);
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(id)}/connect`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      window.location.href = data.url as string;
    } catch (e) {
      setError((e as Error).message);
      setConnecting(null);
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6" data-testid="agents-page">
      <h1 className="text-2xl font-semibold">{t("agentsPage.title")}</h1>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="agents-error">
          {t("agentsPage.loadFailed", { error })}
        </div>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section className="rounded-md border border-border p-4" data-testid="agents-section">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("agentsPage.agents")}</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {agents.map((a) => (
              <li key={a.id} className="text-sm" data-testid="agent-row" data-agent-id={a.id}>
                {a.type === "agent-remote" && a.mode === "link" && a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="underline hover:text-primary">
                    {a.name || a.id} ↗
                  </a>
                ) : (
                  <>
                    <span className="font-medium">{a.name || a.id}</span>
                    {a.model && <span className="ml-2 text-xs text-muted-foreground">{a.model}</span>}
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="rounded-md border border-border p-4" data-testid="apps-section">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("agentsPage.apps")}</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {apps.map((app) => (
              <li key={app.id} className="text-sm" data-testid="app-row" data-app-id={app.id}>
                {app.kind === "nango-connect" ? (
                  <button
                    onClick={() => connect(app.id)}
                    disabled={connecting === app.id}
                    data-testid="connect-btn"
                    className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    {connecting === app.id ? t("agentsPage.connecting") : t("agentsPage.connect")}
                  </button>
                ) : (
                  <a href={app.url} target="_blank" rel="noreferrer" className="underline hover:text-primary">
                    {app.name || app.id} ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
