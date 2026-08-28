// ChatSessionMenu — right-click context menu for a single session row in the
// sidebar. Opens on `contextmenu` (right-click) and on Shift+F10. Contains a
// single "Delete" entry (with a confirmation dialog). The Delete entry is
// disabled (with a tooltip) on the currently active session — the server will
// also 409 the request, but disabling in the UI prevents the obviously-wrong
// action. The menu dismisses on outside click, Escape, or item activation.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface Props {
  sessionId: string;
  isCurrent: boolean;
  onDelete: (id: string) => Promise<void>;
  // Trigger element ref so we can position the menu relative to it.
  triggerRef: React.RefObject<HTMLElement>;
  onClose: () => void;
}

export function ChatSessionMenu({ sessionId, isCurrent, onDelete, triggerRef, onClose }: Props) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Position near the right edge of the row, just below it. Clamp to viewport.
    const x = Math.min(rect.left + 16, window.innerWidth - 200);
    const y = Math.min(rect.bottom + 4, window.innerHeight - 80);
    setPos({ x, y });
  }, [triggerRef]);

  useEffect(() => {
    // While the confirm dialog is open, the dialog's own overlay/Escape
    // handling dismisses it — an outside click here must not unmount the
    // component out from under the dialog.
    const onDown = (e: MouseEvent) => {
      if (confirmOpen) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (confirmOpen) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, confirmOpen]);

  if (!pos) return null;

  const handleDeleteClick = () => {
    if (isCurrent) return;
    // Do NOT call onClose() here: the parent unmounts this component on
    // close, which would destroy the confirmOpen state before the dialog
    // renders. The dropdown hides itself (confirmOpen) and onClose runs
    // when the dialog finishes (dismissed or deleted).
    setError(null);
    setConfirmOpen(true);
  };

  const closeConfirm = () => {
    setConfirmOpen(false);
    setError(null);
    onClose();
  };

  const handleConfirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete(sessionId);
      setConfirmOpen(false);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      {!confirmOpen && (
      <div
        ref={menuRef}
        role="menu"
        data-testid="session-menu"
        style={{ left: pos.x, top: pos.y }}
        className="fixed z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-card shadow-lg"
      >
        <button
          type="button"
          role="menuitem"
          data-testid="session-menu-delete"
          onClick={handleDeleteClick}
          disabled={isCurrent}
          title={isCurrent ? t("sessionMenu.cannotDeleteActive") : undefined}
          className={cn(
            "block w-full px-3 py-1.5 text-left text-xs",
            isCurrent
              ? "cursor-not-allowed text-muted-foreground opacity-50"
              : "text-foreground hover:bg-muted",
          )}
        >
          {t("sessionMenu.delete")}
        </button>
      </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o) closeConfirm(); }}>
        <DialogContent data-testid="session-delete-dialog">
          <DialogHeader>
            <DialogTitle>{t("sessionMenu.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("sessionMenu.confirmBody")}</DialogDescription>
          </DialogHeader>
          {error && (
            <p className="mt-2 text-xs text-destructive" data-testid="session-delete-error">
              {t("sessionMenu.deleteFailed", { error })}
            </p>
          )}
          <DialogFooter className="mt-4">
            <button
              type="button"
              onClick={() => { setConfirmOpen(false); setError(null); }}
              disabled={deleting}
              data-testid="session-delete-cancel"
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={deleting}
              data-testid="session-delete-confirm"
              className="rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
            >
              {t("common.delete")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
