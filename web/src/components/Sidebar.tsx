// Left nav: brand, work-surface tabs, session list, status + settings.
//
// The tabs are WORK SURFACES only — places you go to look at or produce
// something. Configuration (models, MCP, skills, system status) lives in the
// Settings modal behind the gear, so the nav stays a short, stable list rather
// than mixing the product with its admin panel.
//
// Nav items use react-router <NavLink> for in-app navigation (no page reload,
// WebSocket stays connected). The active route is highlighted automatically.
// All visible labels resolve through the i18n bundle (keys, not literals);
// tab identity/ordering/icons are stable across locales.
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, BookOpen, MessageSquare, Settings, Sparkles, Waypoints } from "lucide-react";
import { useChatStore } from "@/hooks/useChatStore";
import type { ClientMessage } from "@/types/ws";
import { cn } from "@/lib/utils";
import { ChatSessionMenu } from "@/components/ChatSessionMenu";
import { settingsPath } from "@/components/settings/sections";

interface Props {
  send: (m: ClientMessage) => void;
  // Called after in-drawer navigation so App can close the off-canvas drawer.
  onNavigate?: () => void;
}

// Icon is part of a tab's identity and stays fixed across locales — the label
// translates, the glyph does not.
const NAV_BASE = [
  { to: "/chat", key: "nav.chat", testId: "nav-chat", icon: MessageSquare },
  { to: "/knowledge", key: "nav.knowledge", testId: "nav-knowledge", icon: BookOpen },
  { to: "/agents", key: "nav.agents", testId: "nav-agents", icon: Sparkles },
  { to: "/bots", key: "nav.bots", testId: "nav-bots", icon: Bot },
  { to: "/trace", key: "nav.trace", testId: "nav-trace", icon: Waypoints },
];

export function Sidebar({ send, onNavigate }: Props) {
  const { t, i18n } = useTranslation();
  const status = useChatStore((s) => s.status);
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const catalogVersion = useChatStore((s) => s.catalogVersion);
  const navigate = useNavigate();
  const location = useLocation();

  // Right-click context menu on session rows: one trigger ref per row, one
  // popover anchored to the row that fired the event.
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [menuTarget, setMenuTarget] = useState<{ id: string; el: HTMLElement } | null>(null);

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
        {nav.map((n) => {
          const Icon = n.icon;
          return (
            <NavLink
              key={n.to}
              to={n.to}
              data-testid={n.testId}
              onClick={() => onNavigate?.()}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground",
                  "hover:bg-muted hover:text-foreground",
                  isActive && "bg-primary-deep text-primary-foreground hover:bg-primary-deep hover:text-primary-foreground",
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t(n.key)}
            </NavLink>
          );
        })}
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

      {/* Footer: one row. Connection status on the left, Settings on the right.
          The agent select, model chip, clear button and locale select that used
          to stack here have moved to the control strip, the session menu, and
          Settings respectively — none of them belonged in a permanent rail. */}
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3"
        data-testid="sidebar-footer"
      >
        <StatusRow status={status} />
        <button
          type="button"
          onClick={() => {
            navigate(settingsPath("general"), { state: { backgroundLocation: location } });
            onNavigate?.();
          }}
          aria-label={t("settings.title")}
          title={t("settings.title")}
          data-testid="settings-btn"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </button>
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
