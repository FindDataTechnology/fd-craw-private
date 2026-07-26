import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

interface Props {
  text: string;
  open: boolean;
  onToggle: () => void;
}

export function ThinkingBlock({ text, open, onToggle }: Props) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-muted/40" data-testid="thinking-block" data-open={open ? "true" : "false"}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        <span>{t("turn.thinking")}</span>
      </button>
      {open && (
        <div className="max-h-52 overflow-y-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}
