// Right-aligned pill for user text. Whitespace preserved.
export function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end" data-testid="turn-user">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground">
        {text}
      </div>
    </div>
  );
}
