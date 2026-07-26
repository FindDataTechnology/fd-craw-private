// Message log. Renders turns; auto-scrolls to bottom unless the user scrolled up.
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import { UserTurn } from "@/components/UserTurn";
import { AssistantTurn } from "@/components/AssistantTurn";

export function Chat() {
  const { t } = useTranslation();
  const turns = useChatStore((s) => s.turns);
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

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  return (
    <div
      ref={containerRef}
      role="log"
      aria-live="polite"
      data-testid="chat-log"
      className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
    >
      {turns.length === 0 ? (
        <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
          {t("chat.empty")}
        </div>
      ) : (
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {turns.map((t) =>
            t.role === "user" ? (
              <UserTurn key={t.id} text={t.text} />
            ) : (
              <AssistantTurn key={t.id} turn={t} />
            ),
          )}
        </div>
      )}
    </div>
  );
}
