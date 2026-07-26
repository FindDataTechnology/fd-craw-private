// Dashboard view: read-only system status. Fetches /api/supervisor/status
// (non-secret fields only). Manual refresh; no high-rate polling.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface ServerRow {
  id: string;
  name: string;
  kind: string;
  state: string;
  pid?: number;
  port?: number;
  url?: string | null;
}
interface Status {
  servers: ServerRow[];
  provider: string | null;
  currentModel: string | null;
  documentCount: number;
  documentByStatus?: Record<string, number>;
  collectionCount: number;
  mcpToolCount: number;
  uptimeMs?: number;
}

const STATE_COLORS: Record<string, string> = {
  healthy: "text-[color:var(--color-success)]",
  disabled: "text-muted-foreground",
  unhealthy: "text-destructive",
  starting: "text-warning",
};

export function DashboardPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/supervisor/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(await r.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6" data-testid="dashboard-page">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("dashboard.title")}</h1>
        <button onClick={refresh} disabled={loading}
          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50" data-testid="dashboard-refresh">
          {loading ? t("dashboard.refreshing") : t("dashboard.refresh")}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive" data-testid="dashboard-error">
          {t("dashboard.loadFailed", { error })}
          <button onClick={refresh} className="ml-2 underline">{t("dashboard.retry")}</button>
        </div>
      )}

      {status && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {/* Servers */}
          <section className="rounded-md border border-border p-4">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("dashboard.servers")}</h2>
            <ul className="mt-2 flex flex-col gap-1">
              {status.servers.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm" data-testid="server-row" data-server-id={s.id}>
                  <span className={cn("h-2 w-2 rounded-full", s.state === "healthy" ? "bg-[color:var(--color-success)]" : s.state === "disabled" ? "bg-muted-foreground" : "bg-destructive")} />
                  <span className="font-medium">{s.name}</span>
                  <span className={cn("text-xs", STATE_COLORS[s.state] ?? "text-muted-foreground")} data-testid="server-state">
                    {t(`dashboard.state.${s.state}`, { defaultValue: s.state })}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">{s.kind}{s.port ? ` :${s.port}` : ""}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Model + provider */}
          <section className="rounded-md border border-border p-4">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("dashboard.activeModel")}</h2>
            <p className="mt-2 text-sm" data-testid="current-model">
              {status.currentModel ?? "-"}
            </p>
            <p className="text-xs text-muted-foreground">{t("dashboard.provider", { name: status.provider ?? "-" })}</p>
            {typeof status.uptimeMs === "number" && (
              <p className="mt-2 text-xs text-muted-foreground">{t("dashboard.uptime", { sec: Math.round(status.uptimeMs / 1000) })}</p>
            )}
          </section>

          {/* Counts */}
          <section className="rounded-md border border-border p-4">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("dashboard.documents")}</h2>
            <p className="mt-2 text-2xl font-semibold" data-testid="doc-count">{status.documentCount}</p>
            {status.documentByStatus && (
              <p className="text-xs text-muted-foreground">
                {Object.entries(status.documentByStatus)
                  .map(([k, v]) => `${t(`documents.status.${k}`, { defaultValue: k })}: ${v}`)
                  .join(" · ") || t("dashboard.none")}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">{t("dashboard.collections", { count: status.collectionCount })}</p>
          </section>

          {/* MCP */}
          <section className="rounded-md border border-border p-4">
            <h2 className="text-sm font-semibold text-muted-foreground">{t("dashboard.mcpTools")}</h2>
            <p className="mt-2 text-2xl font-semibold" data-testid="mcp-count">{status.mcpToolCount}</p>
          </section>
        </div>
      )}
    </main>
  );
}
