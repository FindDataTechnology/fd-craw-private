// ControlStrip — the row of runtime controls beneath the composer textarea:
// workspace, agent, model, reasoning effort, commands.
//
// This is the SOLE surface for per-turn runtime configuration. Persistent
// configuration (which providers exist, what the default is) lives in Settings.
// That split is why the sidebar no longer carries a model chip or agent select.
//
// Workspace, model and effort change dsh runtime config, and dsh bakes config
// into the `initialize` handshake — there is no setModel/setCwd RPC. So each of
// those restarts the child process. That cost is deliberately visible: the
// changed control shows a spinner and the send button disables until the
// server's confirming broadcast lands (see `pendingConfig` in the store).
// Agent is the exception — it switches synchronously, no restart, no spinner.
//
// Nothing here holds optimistic local state. A control renders what the store
// says the runtime IS, not what was requested — so a dropdown briefly shows
// the old value after a click. That is correct: the strip reports reality.

import { useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, Folder, FolderOpen, Loader2, ShieldCheck, SlidersHorizontal, Sparkles, TerminalSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuthStore } from "@/hooks/useAuth";
import { useChatStore } from "@platform/core";
import { savePersonalModel } from "@platform/core";
import type { ClientMessage } from "@platform/core";
import { cn } from "@/lib/utils";

interface Props {
  send: (m: ClientMessage) => void;
  // Inserts "/" into the composer, which opens the existing SlashCommandPicker
  // through its normal text-derived path. The picker needs no click-mode.
  onOpenCommands: () => void;
}

// Shared popover shell for the three menu-style controls. Dismisses on outside
// click, Escape, and selection — same behavior as the settings modal.
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

// Shipped permission presets have localized labels/descriptions in the web
// bundles (the runtime table carries raw keys); anything else renders the
// server-provided label verbatim — the same rule the agent-preset picker uses.
const PERMISSION_I18N = {
  "read-only": "permissionReadonly",
  "workspace-write": "permissionWrite",
  "danger-full-access": "permissionFull",
} as const;

// The native folder picker exists only inside the Electron shell (exposed via
// the preload bridge); in a plain browser the path input is the only entry.
const CAN_PICK_NATIVE =
  typeof window !== "undefined" && typeof window.platform?.pickWorkdir === "function";

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
  const agents = useChatStore((s) => s.agents);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const permissionOptions = useChatStore((s) => s.permissionOptions);
  const currentPermission = useChatStore((s) => s.currentPermission);
  // Non-null only when the socket carries an identity the server can bind to.
  const userBindings = useChatStore((s) => s.userBindings);
  const runtimePending = useChatStore((s) => s.runtimePending);
  const ssoConfigured = useAuthStore((s) => s.ssoConfigured);
  const [bindingMsg, setBindingMsg] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);

  // Pinning the model currently in effect is a separate, explicit act — the
  // picker above stays a global operation and never writes a personal row.
  const saveAsMyModel = async () => {
    const m = models.find((x) => x.id === currentModel);
    if (!m) return;
    setBindingMsg(null);
    setBindingError(null);
    try {
      const res = await savePersonalModel(m.provider ?? "", m.id);
      setBindingMsg(res.pending ? t("bindings.pending") : t("bindings.saved"));
    } catch (e) {
      setBindingError((e as Error).message);
    }
  };

  const agentLabel =
    agents.find((a) => a.id === currentAgent)?.name ??
    currentAgent ??
    t("composer.strip.agentUnset");

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

  // Electron only: hand the picked folder to the same validation/confirm/
  // restart path as a typed one. A cancelled dialog resolves null — the menu
  // simply stays open.
  const browseWorkspace = async (close: () => void) => {
    const picked = await window.platform?.pickWorkdir();
    if (picked) switchWorkspace(picked, close);
  };

  const workspaceLabel = currentWorkspace
    ? currentWorkspace.split(/[/\\]/).filter(Boolean).pop() || currentWorkspace
    : t("composer.strip.workspaceUnset");

  // Chip label: localized name for known presets, the server label for any
  // user-defined table entry, `custom` when the knobs match no preset, and a
  // placeholder while no session has pinned a value yet.
  const permissionLabel = (name: string | null) => {
    if (!name) return t("composer.strip.permissionUnset");
    if (name === "custom") return t("composer.strip.permissionCustom");
    const known = PERMISSION_I18N[name as keyof typeof PERMISSION_I18N];
    return known ? t(`composer.strip.${known}.label`) : name;
  };

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
            {/* In a plain browser, picking a server-side directory is
                impossible — typing the absolute path once is the cost, and the
                recents list above pays it back. Inside the Electron shell the
                browse button opens the native picker instead. */}
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
              {CAN_PICK_NATIVE && (
                <button
                  type="button"
                  onClick={() => void browseWorkspace(close)}
                  data-testid="strip-workspace-browse"
                  className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t("composer.strip.workspaceBrowse")}
                </button>
              )}
            </div>
          </div>
        )}
      </StripMenu>

      {/* Agent. Unlike every other control here, switching the agent does NOT
          restart the dsh child — `switchAgentTo` flips the id and broadcasts
          synchronously — so there is no pending spinner to show. It still
          renders store state only, and is still rejected while streaming.
          Hidden below two agents: a control that displays one unchangeable
          value is noise, and the catalog is optional. */}
      {agents.length > 1 && (
        <StripMenu
          label={t("composer.strip.agent")}
          value={agentLabel}
          icon={<Bot className="h-3.5 w-3.5 shrink-0" />}
          disabled={disabled || isStreaming}
          testId="strip-agent"
        >
          {(close) => (
            <div className="max-h-72 overflow-y-auto py-1">
              {agents.map((a) => (
                <MenuItem
                  key={a.id}
                  active={a.id === currentAgent}
                  primary={a.name || a.id}
                  secondary={a.name ? a.id : undefined}
                  onClick={() => {
                    close();
                    if (a.id === currentAgent) return;
                    send({ type: "set_agent", id: a.id });
                  }}
                />
              ))}
            </div>
          )}
        </StripMenu>
      )}

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
            {userBindings
              ? currentModel && (
                  <div className="border-b border-border px-3 py-2">
                    <button
                      type="button"
                      data-testid="strip-save-model"
                      onClick={saveAsMyModel}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      {t("bindings.saveAsMyModel")}
                    </button>
                    {userBindings.model && (
                      <div className="mt-1 text-[10px] text-muted-foreground" data-testid="strip-model-source">
                        {userBindings.model.source === "personal"
                          ? t("bindings.myModel")
                          : t("bindings.globalSource")}
                      </div>
                    )}
                    {runtimePending && (
                      <div className="mt-1 text-[10px] text-warning" data-testid="strip-model-pending">
                        {t("bindings.pending")}
                      </div>
                    )}
                    {bindingMsg && <div className="mt-1 text-[10px] text-muted-foreground">{bindingMsg}</div>}
                    {bindingError && <div className="mt-1 text-[10px] text-destructive">{bindingError}</div>}
                  </div>
                )
              : ssoConfigured && (
                  <div className="border-b border-border px-3 py-2">
                    <Link
                      to="/login"
                      data-testid="strip-model-signin"
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      {t("bindings.signIn")}
                    </Link>
                  </div>
                )}
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

      {/* Permission preset (sandbox + approval bundle). Hidden until the
          roster arrives — a control showing nothing real teaches users to
          ignore the strip. Unlike every restart-carrying control above, a
          permission switch applies to the LIVE session, so there is no
          pending window and send stays enabled; the chip re-renders when the
          confirming current_permission broadcast lands. The current value can
          be `custom` (knobs match no preset) — shown, never switchable. */}
      {permissionOptions.length > 0 && (
        <StripMenu
          label={t("composer.strip.permission")}
          value={permissionLabel(currentPermission)}
          icon={<ShieldCheck className="h-3.5 w-3.5 shrink-0" />}
          disabled={status !== "connected" || isStreaming}
          testId="strip-permission"
        >
          {(close) => (
            <div className="max-h-72 overflow-y-auto py-1">
              {permissionOptions.map((o) => {
                const known = PERMISSION_I18N[o.name as keyof typeof PERMISSION_I18N];
                return (
                  <MenuItem
                    key={o.name}
                    active={o.name === currentPermission}
                    primary={known ? t(`composer.strip.${known}.label`) : o.label}
                    secondary={known ? t(`composer.strip.${known}.desc`) : o.description || undefined}
                    onClick={() => {
                      close();
                      if (o.name === currentPermission) return;
                      send({ type: "set_permission", name: o.name });
                    }}
                  />
                );
              })}
            </div>
          )}
        </StripMenu>
      )}

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
    </div>
  );
}
