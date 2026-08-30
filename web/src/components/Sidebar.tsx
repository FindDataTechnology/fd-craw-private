// Left nav: brand, tabs, session list, model select + status + clear.
// Nav items use react-router <NavLink> for in-app navigation (no page reload,
// WebSocket stays connected). The active route is highlighted automatically.
// All visible labels resolve through the i18n bundle (keys, not literals);
// tab identity/ordering/icons are stable across locales.
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import { useLanguage } from "@/i18n/useLanguage";
import type { Locale } from "@/i18n/config";
import type { ClientMessage } from "@/types/ws";
import { cn } from "@/lib/utils";
import { SettingsMenu } from "@/components/SettingsMenu";
import { ChatSessionMenu } from "@/components/ChatSessionMenu";
import { HelpDialog } from "@/components/HelpDialog";

interface Props {
  send: (m: ClientMessage) => void;
  // Called after in-drawer navigation so App can close the off-canvas drawer.
  onNavigate?: () => void;
}

const NAV_BASE = [
  { to: "/chat", key: "nav.chat", testId: "nav-chat" },
  { to: "/knowledge", key: "nav.knowledge", testId: "nav-knowledge" },
  { to: "/agents", key: "nav.agents", testId: "nav-agents" },
  { to: "/mcp", key: "nav.mcp", testId: "nav-mcp" },
  { to: "/skills", key: "nav.skills", testId: "nav-skills" },
  { to: "/models", key: "nav.models", testId: "nav-models" },
];

export function Sidebar({ send, onNavigate }: Props) {
  const { t, i18n } = useTranslation();
  const { locale, locales, changeLocale } = useLanguage();
  const status = useChatStore((s) => s.status);
  const models = useChatStore((s) => s.models);
  const currentModel = useChatStore((s) => s.currentModel);
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const clearView = useChatStore((s) => s.clearView);
  const agents = useChatStore((s) => s.agents);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const catalogVersion = useChatStore((s) => s.catalogVersion);
  const navigate = useNavigate();

  // Right-click context menu on session rows: one trigger ref per row, one
  // popover anchored to the row that fired the event.
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [menuTarget, setMenuTarget] = useState<{ id: string; el: HTMLElement } | null>(null);
  // The help center's second entry point (settings menu → 帮助).
  const [helpOpen, setHelpOpen] = useState(false);

  // The server bumps catalogVersion via `catalog_changed`; refetch the
  // switchable agent list so catalog/role edits appear live.
  useEffect(() => {
    if (catalogVersion > 0) send({ type: "list_agents" });
  }, [catalogVersion, send]);

  // LiteLLM nav removed — dsh-llm manages LLM natively, no LiteLLM UI to link to.
  const nav = NAV_BASE;

  const handleDeleteSession = useCallback(async (id: string) => {
    const r = await fetch(`/api/chat-history/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${r.status}`);
    }
    // The server broadcasts the refreshed `sessions` event; the store update
    // removes the row from the sidebar. If the deleted session was the active
    // one, the server would have 409'd; if a new session is required, the user
    // can click "+ New".
  }, []);

  return (
    <nav className="flex h-screen flex-col border-r border-border bg-card" data-testid="sidebar">
      <div className="border-b border-border p-4 text-base font-semibold">{t("sidebar.brand")}</div>

      <div className="flex flex-col gap-0.5 p-2">
        {nav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            data-testid={n.testId}
            onClick={() => onNavigate?.()}
            className={({ isActive }) =>
              cn(
                "rounded-md px-3 py-2 text-left text-sm text-muted-foreground",
                "hover:bg-muted hover:text-foreground",
                isActive && "bg-primary-deep text-primary-foreground hover:bg-primary-deep hover:text-primary-foreground",
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
              onNavigate?.();
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
              ref={(el) => {
                if (el) rowRefs.current.set(s.id, el);
                else rowRefs.current.delete(s.id);
              }}
              data-testid="session-row"
              data-session-id={s.id}
              data-current={s.id === currentSessionId ? "true" : "false"}
                onClick={() => {
                  // URL leads the switch (deep-link effect no-ops once the
                  // server's session_loaded lands); back/refresh keep place.
                  navigate(`/chat/${s.id}`);
                  if (s.id !== currentSessionId) send({ type: "switch_session", id: s.id });
                  onNavigate?.();
                }}
              onContextMenu={(e) => {
                e.preventDefault();
                const el = rowRefs.current.get(s.id);
                if (el) setMenuTarget({ id: s.id, el });
              }}
              onKeyDown={(e) => {
                if (e.shiftKey && e.key === "F10") {
                  e.preventDefault();
                  const el = rowRefs.current.get(s.id);
                  if (el) setMenuTarget({ id: s.id, el });
                }
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

      {menuTarget && (
        <ChatSessionMenu
          sessionId={menuTarget.id}
          isCurrent={menuTarget.id === currentSessionId}
          onDelete={handleDeleteSession}
          triggerRef={{ current: menuTarget.el }}
          onClose={() => setMenuTarget(null)}
        />
      )}

      {/* Footer: agent + model select, status, clear */}
      <div className="flex flex-col gap-2 border-t border-border p-3">
        <select
          value={currentAgent ?? "local"}
          disabled={isStreaming || agents.length === 0}
          onChange={(e) => send({ type: "set_agent", id: e.target.value })}
          data-testid="agent-select"
          className={cn(
            "w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground",
            "focus:border-primary focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {agents.length === 0 && <option>{t("common.loading")}</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.id}
            </option>
          ))}
        </select>
        {/* Model chip: read-only. The real configuration (add/edit/remove
            providers, set the default) lives on the /models page; the chip
            shows the current default model and navigates there on click. The
            legacy in-sidebar <select> is removed per the model-selection spec. */}
        <button
          type="button"
          onClick={() => navigate("/models")}
          title={t("sidebar.modelChipHint")}
          data-testid="model-chip"
          className={cn(
            "w-full truncate rounded-md border border-input bg-background px-2 py-1.5 text-left text-xs text-foreground",
            "hover:border-primary/60 hover:bg-accent",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {currentModel
            ? models.find((m) => m.id === currentModel)?.name || currentModel
            : t("sidebar.loadingModels")}
        </button>
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
        <SettingsMenu onHelp={() => setHelpOpen(true)} />
      </div>
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </nav>
  );
}

function StatusRow({ status }: { status: "connecting" | "connected" | "disconnected" }) {
  const { t } = useTranslation();
  const key =
    status === "connected" ? "status.connected" : status === "connecting" ? "status.connecting" : "status.disconnected";
  const dot =
    status === "connected"
      ? "bg-success"
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
