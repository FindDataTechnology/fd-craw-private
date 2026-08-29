import { memo } from "react";
// Right-aligned pill for user text. Whitespace preserved.
function UserTurnBase({ text }: { text: string }) {
  return (
    <div className="flex justify-end" data-testid="turn-user">
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
