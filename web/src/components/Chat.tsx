// Message log. Renders turns; auto-scrolls to bottom unless the user scrolled up.
// Owns the message-level actions wiring: copy lives inside AssistantTurn;
// edit-and-resend goes to the LAST user turn; regenerate re-sends the last
// user prompt from the LAST assistant turn.
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import { UserTurn } from "@/components/UserTurn";
import { AssistantTurn } from "@/components/AssistantTurn";
import type { ClientMessage } from "@/types/ws";

interface Props {
  send: (m: ClientMessage) => void;
  onPrefill: (text: string) => void;
}

export function Chat({ send, onPrefill }: Props) {
  const { t } = useTranslation();
  const turns = useChatStore((s) => s.turns);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      // If we're within ~40px of the bottom, keep sticking.
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      stickToBottomRef.current = nearBottom;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `turns` is the deliberate trigger — scroll to bottom when a turn is added
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // The last user prompt: powers regenerate (re-send as a new prompt — dsh
  // has no replace-turn RPC, so this is honest regeneration, not mutation).
  const lastUserText = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t && t.role === "user") return t.text;
    }
    return null;
  }, [turns]);

  return (
    <div
      ref={containerRef}
      data-testid="chat-log"
      className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
    >
      {/* Scoped live region: announce only stream start/end. The container is
          deliberately NOT aria-live — a polite log would re-announce every
          50ms delta flush and flood screen readers. */}
      <span role="status" aria-live="polite" className="sr-only">
        {isStreaming ? t("chat.ariaStreaming") : turns.length > 0 ? t("chat.ariaDone") : ""}
      </span>
      {turns.length === 0 ? (
        <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
          {t("chat.empty")}
        </div>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {turns.map((t, i) => {
            const isLastUser =
              t.role === "user" && !turns.slice(i + 1).some((x) => x.role === "user");
            const isLastAssistant =
              t.role === "assistant" && !turns.slice(i + 1).some((x) => x.role === "assistant");
            if (t.role === "user") {
              const text = t.text;
              return (
                <UserTurn
                  key={t.id}
                  text={text}
                  onEdit={isLastUser ? () => onPrefill(text) : undefined}
                />
              );
            }
            return (
              <AssistantTurn
                key={t.id}
                turn={t}
                onRegenerate={
                  isLastAssistant && lastUserText
                    ? () => send({ type: "prompt", text: lastUserText })
                    : undefined
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
