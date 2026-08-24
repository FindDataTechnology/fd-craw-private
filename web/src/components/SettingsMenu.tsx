// SettingsMenu — gear-icon button in the sidebar footer that opens a small
// popover with links to operator surfaces (System Status, LLM Models,
// OpenConnector). The popover dismisses on outside click, Escape, and item
// selection. Anchored to the gear button so it overlays the chat list without
// taking layout space.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface Item {
  to: string;
  key: string;
  testId: string;
}

const ITEMS: Item[] = [
  { to: "/dashboard", key: "settingsMenu.status", testId: "settings-menu-status" },
  { to: "/models", key: "settingsMenu.models", testId: "settings-menu-models" },
  { to: "/openconnector", key: "settingsMenu.openconnector", testId: "settings-menu-openconnector" },
];

export function SettingsMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Outside click + Escape close the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t("settingsMenu.title")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="settings-menu-btn"
        className={cn(
          "w-full rounded-md border border-border px-2 py-1.5 text-xs",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          open && "bg-muted text-foreground",
        )}
      >
        <span className="mr-1">⚙</span>
        {t("settingsMenu.title")}
      </button>
      {open && (
        <div
          role="menu"
          data-testid="settings-menu"
          className="absolute bottom-full left-0 z-50 mb-1 w-full min-w-[180px] overflow-hidden rounded-md border border-border bg-card shadow-lg"
        >
          {ITEMS.map((it) => (
            <button
              key={it.to}
              type="button"
              role="menuitem"
              data-testid={it.testId}
              onClick={() => {
                setOpen(false);
                navigate(it.to);
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
            >
              {t(it.key)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
