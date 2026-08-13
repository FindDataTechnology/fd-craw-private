// Left nav: brand, tabs, session list, model select + status + clear.
// Nav items use react-router <NavLink> for in-app navigation (no page reload,
// WebSocket stays connected). The active route is highlighted automatically.
// All visible labels resolve through the i18n bundle (keys, not literals);
// tab identity/ordering/icons are stable across locales.
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import { useLanguage } from "@/i18n/useLanguage";
import type { Locale } from "@/i18n/config";
import type { ClientMessage } from "@/types/ws";
import { cn } from "@/lib/utils";

interface Props {
  send: (m: ClientMessage) => void;
}

const NAV_BASE = [
  { to: "/chat", key: "nav.chat", testId: "nav-chat" },
  { to: "/dashboard", key: "nav.dashboard", testId: "nav-dashboard" },
  { to: "/documents", key: "nav.documents", testId: "nav-documents" },
  { to: "/extensions", key: "nav.extensions", testId: "nav-extensions" },
  { to: "/openconnector", key: "nav.openconnector", testId: "nav-openconnector" },
];
const LITELLM_NAV = { to: "/litellm", key: "nav.litellm", testId: "nav-litellm" };

export function Sidebar({ send }: Props) {
  const { t, i18n } = useTranslation();
  const { locale, locales, changeLocale } = useLanguage();
  const status = useChatStore((s) => s.status);
  const models = useChatStore((s) => s.models);
  const currentModel = useChatStore((s) => s.currentModel);
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const clearView = useChatStore((s) => s.clearView);
  const currentWorkdir = useChatStore((s) => s.currentWorkdir);
  const setWorkdir = useChatStore((s) => s.setWorkdir);
  const navigate = useNavigate();

  // Gate the LiteLLM link on server config. Hidden until /api/config resolves
  // (matches how the legacy vanilla nav skips the link when unconfigured).
  const [litellmEnabled, setLitellmEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => { if (!cancelled) setLitellmEnabled(Boolean(c?.litellmEnabled)); })
      .catch(() => { /* graceful: link stays hidden */ });
    return () => { cancelled = true; };
  }, []);
  const nav = litellmEnabled ? [...NAV_BASE, LITELLM_NAV] : NAV_BASE;

  return (
    <nav className="flex h-screen flex-col border-r border-border bg-card" data-testid="sidebar">
      <div className="border-b border-border p-4 text-base font-semibold">{t("sidebar.brand")}</div>

      <div className="flex flex-col gap-0.5 p-2">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            data-testid={n.testId}
            className={({ isActive }) =>
              cn(
                "rounded-md px-3 py-2 text-left text-sm text-muted-foreground",
                "hover:bg-muted hover:text-foreground",
                isActive && "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
              )
            }
          >
            {t(n.key)}
          </NavLink>
        ))}
      </div>

      {/* Session list */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border p-2" data-testid="session-list-section">
        <div className="flex items-center justify-between px-1 pb-2 pt-1 text-xs font-semibold text-muted-foreground">
          <span>{t("sidebar.chats")}</span>
          <button
            onClick={() => {
              navigate("/chat");
              send({ type: "new_session" });
            }}
            data-testid="new-chat-btn"
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t("sidebar.new")}
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" data-testid="session-list">
          {sessions.length === 0 && (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("sidebar.noChats")}
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              data-testid="session-row"
              data-session-id={s.id}
              data-current={s.id === currentSessionId ? "true" : "false"}
              onClick={() => {
                if (s.id !== currentSessionId) send({ type: "switch_session", id: s.id });
              }}
              className={cn(
                "flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                s.id === currentSessionId && "bg-muted",
              )}
            >
              <span className="truncate text-foreground">{s.title || t("sidebar.untitled")}</span>
              {s.updatedAt && (
                <span className="text-[10px] text-muted-foreground">
                  {new Date(s.updatedAt).toLocaleString(i18n.language)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Working directory: folder the agent operates in. Only wired in the
          desktop app (window.platform is undefined in a plain browser). */}
      <div className="flex flex-col gap-1 border-t border-border p-3" data-testid="workdir-section">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground">{t("workdir.label")}</span>
          <button
            onClick={async () => {
              if (!window.platform?.pickWorkdir) {
                alert(t("workdir.desktopOnly"));
                return;
              }
              const path = await window.platform.pickWorkdir();
              if (path) {
                setWorkdir(path);
                send({ type: "set_workdir", path });
              }
            }}
            data-testid="workdir-pick-btn"
            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t("workdir.change")}
          </button>
        </div>
        <div
          className="truncate text-xs text-muted-foreground"
          title={currentWorkdir ?? undefined}
          data-testid="workdir-path"
        >
          {currentWorkdir || t("workdir.notSet")}
        </div>
      </div>

      {/* Footer: model select, status, clear */}
      <div className="flex flex-col gap-2 border-t border-border p-3">
        <select
          value={currentModel ?? ""}
          disabled={isStreaming || models.length === 0}
          onChange={(e) => send({ type: "set_model", id: e.target.value })}
          data-testid="model-select"
          className={cn(
            "w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground",
            "focus:border-primary focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {models.length === 0 && <option>{t("sidebar.loadingModels")}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </select>
        <StatusRow status={status} />
        <button
          onClick={clearView}
          data-testid="clear-btn"
          className="rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("sidebar.clearChat")}
        </button>
        <select
          value={locale}
          onChange={(e) => changeLocale(e.target.value as Locale)}
          data-testid="locale-select"
          aria-label={t("sidebar.language")}
          className={cn(
            "w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground",
            "focus:border-primary focus:outline-none",
          )}
        >
          {locales.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </nav>
  );
}

function StatusRow({ status }: { status: "connecting" | "connected" | "disconnected" }) {
  const { t } = useTranslation();
  const key =
    status === "connected" ? "status.connected" : status === "connecting" ? "status.connecting" : "status.disconnected";
  const dot =
    status === "connected"
      ? "bg-[color:var(--color-success)]"
      : status === "disconnected"
        ? "bg-destructive"
        : "bg-warning";
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="status">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} data-testid="status-dot" />
      <span data-testid="status-text">{t(key)}</span>
    </div>
  );
}
