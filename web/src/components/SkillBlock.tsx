import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  name: string;
  args?: string;
  open: boolean;
  onToggle: () => void;
}

export function SkillBlock({ name, args, open, onToggle }: Props) {
  return (
    <div className="overflow-hidden rounded-md border border-border border-l-2 border-l-[oklch(0.65_0.20_300)] bg-muted/40">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        <span>✨</span>
        <span className="font-mono font-semibold text-foreground">/skill:{name}</span>
        {args && <span className="truncate font-mono text-muted-foreground">{args}</span>}
      </button>
      {open && args && (
        <pre className="whitespace-pre-wrap break-words border-t border-border bg-background px-3 py-2 font-mono text-[11px]">
          {args}
        </pre>
      )}
    </div>
  );
}
