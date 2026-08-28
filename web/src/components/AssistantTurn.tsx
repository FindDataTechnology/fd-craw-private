// Full-width assistant turn. Blocks nest inside a left-rail so tool/thinking
// visibly belong to the same turn as the text. This is the "not siblings"
// design decision from proposal.md.
//
// The assistant name label, the streaming "Thinking…" placeholder, and the
// tool/thinking block labels resolve through the i18n bundle. Command and
// error block payloads (⚙️ /name, ⚠️ message) are server/agent output and
// stay literal.
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import type { Turn } from "@/hooks/useChatStore";
import { Markdown } from "@/components/Markdown";
import { ThinkingBlock } from "@/components/ThinkingBlock";
import { ToolBlock } from "@/components/ToolBlock";
import { SkillBlock } from "@/components/SkillBlock";
import { cn } from "@/lib/utils";

export function AssistantTurn({ turn }: { turn: Extract<Turn, { role: "assistant" }> }) {
  const { t } = useTranslation();
  const toggleBlock = useChatStore((s) => s.toggleBlock);
  return (
    <article
      className={cn("flex flex-col gap-3", turn.streaming && "opacity-100")}
      data-testid="turn-assistant"
      data-streaming={turn.streaming ? "true" : "false"}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/20 text-primary">
          ●
        </span>
        <span>{t("turn.assistantName")}</span>
      </div>
      <div className="flex flex-col gap-2 border-l border-border pl-4">
        {turn.blocks.map((b, i) => {
          const key = `${turn.id}-${i}`;
          const toggle = () => toggleBlock(turn.id, i);
          switch (b.kind) {
            case "text":
              return <Markdown key={key} text={b.text} />;
            case "thinking":
              return <ThinkingBlock key={key} text={b.text} open={b.open} onToggle={toggle} />;
            case "tool":
              return <ToolBlock key={key} block={b} onToggle={toggle} />;
            case "skill":
              return (
                <SkillBlock
                  key={key}
                  name={b.name}
                  args={b.args}
                  open={b.open}
                  onToggle={toggle}
                />
              );
            case "command":
              return (
                <div
                  key={key}
                  className="rounded-md border border-border bg-muted px-3 py-2 text-xs"
                >
                  <div className="font-mono text-muted-foreground">
                    ⚙️ /{b.name}
                    {b.args ? ` ${b.args}` : ""}
                  </div>
                  {b.message && (
                    <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">
                      {b.message}
                    </pre>
                  )}
                </div>
              );
            case "error":
              return (
                <div
                  key={key}
                  className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  ⚠️ {b.message}
                </div>
              );
            default:
              return null;
          }
        })}
        {turn.streaming && turn.blocks.length === 0 && (
          <div className="text-xs text-muted-foreground">{t("turn.thinkingStreaming")}</div>
        )}
      </div>
    </article>
  );
}
