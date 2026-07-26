import { ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Block } from "@/hooks/useChatStore";

interface Props {
  block: Extract<Block, { kind: "tool" }>;
  onToggle: () => void;
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function ToolBlock({ block, onToggle }: Props) {
  const { t } = useTranslation();
  const { name, args, state, result, partial, open } = block;
  const accent =
    state === "running"
      ? "border-l-primary"
      : state === "error"
        ? "border-l-destructive"
        : "border-l-[color:var(--color-success)]";
  const statusKey =
    state === "running" ? "turn.statusRunning" : state === "error" ? "turn.statusError" : "turn.statusDone";

  return (
    <div
      className={cn("overflow-hidden rounded-md border border-border border-l-2 bg-muted/40", accent)}
      data-testid="tool-block"
      data-tool-state={state}
      data-open={open ? "true" : "false"}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted"
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        <span className="font-mono text-muted-foreground">🔧</span>
        <span className="font-mono font-semibold text-foreground">{name}</span>
        <span
          className={cn(
            "ml-auto flex items-center gap-1 text-[11px] italic",
            state === "running" && "text-primary",
            state === "error" && "text-destructive",
            state === "done" && "text-[color:var(--color-success)]",
          )}
        >
          {state === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
          {t(statusKey)}
        </span>
      </button>
      {open && (
        <div className="max-h-72 space-y-2 overflow-y-auto border-t border-border px-3 py-2 text-[11px]">
          {args !== undefined && args !== null && (
            <Section label={t("turn.input")} body={stringify(args)} />
          )}
          {state === "running" && partial !== undefined && (
            <Section label={t("turn.partial")} body={stringify(partial)} />
          )}
          {state !== "running" && result !== undefined && (
            <Section
              label={state === "error" ? t("turn.outputError") : t("turn.output")}
              body={stringify(result)}
              error={state === "error"}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Section({ label, body, error }: { label: string; body: string; error?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <pre
        className={cn(
          "whitespace-pre-wrap break-words rounded-sm bg-background px-2 py-1 font-mono",
          error && "text-destructive",
        )}
      >
        {body}
      </pre>
    </div>
  );
}
