// ControlStrip — the row of runtime controls beneath the composer textarea:
// workspace, commands, model, reasoning effort.
//
// Every control here except commands changes dsh runtime config, and dsh bakes
// config into the `initialize` handshake — there is no setModel/setCwd RPC. So
// each change restarts the child process. That cost is deliberately visible:
// the changed control shows a spinner and the send button disables until the
// server's confirming broadcast lands (see `pendingConfig` in the store).
//
// Nothing here holds optimistic local state. A control renders what the store
// says the runtime IS, not what was requested — so a dropdown briefly shows
// the old value after a click. That is correct: the strip reports reality.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Folder, Loader2, SlidersHorizontal, Sparkles, TerminalSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import type { ClientMessage } from "@/types/ws";
import { cn } from "@/lib/utils";

interface Props {
  send: (m: ClientMessage) => void;
  // Inserts "/" into the composer, which opens the existing SlashCommandPicker
  // through its normal text-derived path. The picker needs no click-mode.
  onOpenCommands: () => void;
}

// Shared popover shell for the three menu-style controls. Dismisses on outside
// click, Escape, and selection — same behavior as <SettingsMenu>.
function StripMenu({
  label,
  value,
  icon,
  pending,
  disabled,
  testId,
  children,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  pending?: boolean;
  disabled?: boolean;
  testId: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        data-pending={pending ? "true" : undefined}
        className={cn(
          "flex max-w-[14rem] items-center gap-1 rounded-md px-1.5 py-1 text-xs",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-40",
          open && "bg-muted text-foreground",
        )}
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : icon}
        <span className="truncate">{value}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`${testId}-menu`}
          className={cn(
            "absolute bottom-full left-0 z-50 mb-1 min-w-[17rem] max-w-[24rem]",
            "overflow-hidden rounded-md border border-border bg-popover shadow-lg",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  primary,
  secondary,
}: {
  active?: boolean;
  onClick: () => void;
  primary: string;
  secondary?: string;
  }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={!!active}
      onClick={onClick}
      data-testid="strip-menu-item"
      className={cn(
        "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-xs",
        active ? "bg-muted text-foreground" : "text-foreground hover:bg-muted/60",
      )}
    >
      <span className="w-full truncate font-mono">{primary}</span>
      {secondary && <span className="w-full truncate text-[10px] text-muted-foreground">{secondary}</span>}
    </button>
  );
}

export function ControlStrip({ send, onOpenCommands }: Props) {
  const { t } = useTranslation();
  const status = useChatStore((s) => s.status);
  const models = useChatStore((s) => s.models);
  const currentModel = useChatStore((s) => s.currentModel);
  const currentEffort = useChatStore((s) => s.currentEffort);
  const currentWorkspace = useChatStore((s) => s.currentWorkspace);
  const workspaceRecents = useChatStore((s) => s.workspaceRecents);
  const pendingConfig = useChatStore((s) => s.pendingConfig);
  const setPendingConfig = useChatStore((s) => s.setPendingConfig);
  const turns = useChatStore((s) => s.turns);

  const [pathDraft, setPathDraft] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);

  const disabled = status !== "connected" || pendingConfig !== null;

  // The effort control exists only for models that declare levels. A
  // permanently-disabled control teaches users to ignore this region.
  const efforts = models.find((m) => m.id === currentModel)?.reasoningEfforts ?? [];

  const switchWorkspace = (path: string, close: () => void) => {
    const next = path.trim();
    if (!next) return;
    // Validation proper is server-side; this catches the one mistake worth
    // catching before a round-trip.
    if (!next.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(next)) {
      setPathError(t("composer.strip.workspaceAbsolute"));
      return;
    }
    if (next === currentWorkspace) {
      close();
      return;
    }
    // Switching mid-conversation leaves the transcript referencing paths that
    // no longer resolve — make that the user's call, not a side effect.
    if (turns.length > 0 && !window.confirm(t("composer.strip.workspaceConfirm", { path: next }))) {
      return;
    }
    setPathError(null);
    setPathDraft("");
    setPendingConfig("workspace");
    send({ type: "set_workspace", path: next });
    close();
  };

  const workspaceLabel = currentWorkspace
    ? currentWorkspace.split(/[/\\]/).filter(Boolean).pop() || currentWorkspace
    : t("composer.strip.workspaceUnset");

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-0.5" data-testid="composer-control-strip">
      <StripMenu
        label={t("composer.strip.workspace")}
        value={workspaceLabel}
        icon={<Folder className="h-3.5 w-3.5 shrink-0" />}
        pending={pendingConfig === "workspace"}
        disabled={disabled}
        testId="strip-workspace"
      >
        {(close) => (
          <div>
            {currentWorkspace && (
              <div className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
                <span className="break-all font-mono">{currentWorkspace}</span>
              </div>
            )}
            {workspaceRecents.filter((p) => p !== currentWorkspace).length > 0 && (
              <div className="border-b border-border py-1">
                <div className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t("composer.strip.workspaceRecents")}
                </div>
                {workspaceRecents
                  .filter((p) => p !== currentWorkspace)
                  .map((p) => (
                    <MenuItem key={p} onClick={() => switchWorkspace(p, close)} primary={p} />
                  ))}
              </div>
            )}
            {/* A browser cannot pick a server-side directory; typing the path
                once is the cost, and the recents list above pays it back. */}
            <div className="p-2">
              <input
                type="text"
                value={pathDraft}
                onChange={(e) => {
                  setPathDraft(e.target.value);
                  if (pathError) setPathError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    switchWorkspace(pathDraft, close);
                  }
                }}
                placeholder={t("composer.strip.workspacePlaceholder")}
                aria-label={t("composer.strip.workspacePlaceholder")}
                data-testid="strip-workspace-input"
                className={cn(
                  "w-full rounded-md border bg-background px-2 py-1 font-mono text-xs outline-none",
                  pathError ? "border-destructive" : "border-border focus:border-primary",
                )}
              />
              {pathError && (
                <p data-testid="strip-workspace-error" className="mt-1 text-[10px] text-destructive">
                  {pathError}
                </p>
              )}
            </div>
          </div>
        )}
      </StripMenu>

      <button
        type="button"
        onClick={onOpenCommands}
        disabled={status !== "connected"}
        aria-label={t("composer.strip.commands")}
        data-testid="strip-commands"
        className={cn(
          "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        <TerminalSquare className="h-3.5 w-3.5 shrink-0" />
        <span>{t("composer.strip.commands")}</span>
      </button>

      <StripMenu
        label={t("composer.strip.model")}
        value={currentModel || t("composer.strip.modelUnset")}
        icon={<Sparkles className="h-3.5 w-3.5 shrink-0" />}
        pending={pendingConfig === "model"}
        disabled={disabled || models.length === 0}
        testId="strip-model"
      >
        {(close) => (
          <div className="max-h-72 overflow-y-auto py-1">
            {models.map((m) => (
              <MenuItem
                key={m.id}
                active={m.id === currentModel}
                primary={m.id}
                secondary={m.provider}
                onClick={() => {
                  close();
                  if (m.id === currentModel) return;
                  setPendingConfig("model");
                  send({ type: "set_model", id: m.id });
                }}
              />
            ))}
          </div>
        )}
      </StripMenu>

      {efforts.length > 0 && (
        <StripMenu
          label={t("composer.strip.effort")}
          value={currentEffort || t("composer.strip.effortDefault")}
          icon={<SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />}
          pending={pendingConfig === "effort"}
          disabled={disabled}
          testId="strip-effort"
        >
          {(close) => (
            <div className="py-1">
              {efforts.map((e) => (
                <MenuItem
                  key={e}
                  active={e === currentEffort}
                  primary={e}
                  onClick={() => {
                    close();
                    if (e === currentEffort) return;
                    setPendingConfig("effort");
                    send({ type: "set_effort", effort: e });
                  }}
                />
              ))}
            </div>
          )}
        </StripMenu>
      )}
    </div>
  );
}
