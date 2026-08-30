import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
// Right-aligned pill for user text. Whitespace preserved. The LAST user turn
// carries an edit-and-resend action (revealed on hover, keyboard-accessible
// via focus-visible) — it prefills the composer instead of mutating history.
function UserTurnBase({ text, onEdit }: { text: string; onEdit?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-end justify-end gap-1" data-testid="turn-user">
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={t("turn.editResend")}
          data-testid="turn-edit"
          className="mb-0.5 grid h-6 w-6 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary-deep px-4 py-2 text-sm text-primary-foreground">
        {text}
      </div>
    </div>
  );
}

// Memoized: the store mutates turn objects in place and clones only the
// turns array, so a streaming delta re-renders just the tail turn's
// component instead of reconciling the whole transcript.
export const UserTurn = memo(UserTurnBase);
