// Message log. Renders turns; auto-scrolls to bottom unless the user scrolled up.
// Owns the message-level actions wiring: copy lives inside AssistantTurn;
// edit-and-resend goes to the LAST user turn; regenerate re-sends the last
// user prompt from the LAST assistant turn. Also owns the outline rail
// (add-chat-outline): a floating user-turn index over the transcript's right
// edge whose entries jump to a turn via jumpToTurn.
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import { ChatOutline } from "@/components/ChatOutline";
import { UserTurn } from "@/components/UserTurn";
import { AssistantTurn } from "@/components/AssistantTurn";
import type { ClientMessage } from "@platform/core";

interface Props {
  send: (m: ClientMessage) => void;
  onPrefill: (text: string) => void;
}

// Render the outline only past this many user turns — below it the rail is
// noise on a conversation the user can see whole (spec: threshold).
const OUTLINE_MIN_USER_TURNS = 3;

export function Chat({ send, onPrefill }: Props) {
  const { t } = useTranslation();
  const turns = useChatStore((s) => s.turns);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const flashTimerRef = useRef<number | null>(null);

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

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // Outline jump: release stick-to-bottom FIRST so streaming deltas cannot
  // yank the view back (the scroll listener re-arms it when the user returns
  // to the bottom), then smooth-scroll and flash the target turn.
  const jumpToTurn = (id: string) => {
    const el = document.getElementById(`turn-${id}`);
    if (!el) return;
    stickToBottomRef.current = false;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.remove("outline-jump-flash");
    // Force reflow so a rapid re-tap of the same turn restarts the animation.
    void el.offsetWidth;
    el.classList.add("outline-jump-flash");
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => el.classList.remove("outline-jump-flash"), 1200);
  };

  // The last user prompt: powers regenerate (re-send as a new prompt — dsh
  // has no replace-turn RPC, so this is honest regeneration, not mutation).
  const lastUserText = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t && t.role === "user") return t.text;
    }
    return null;
  }, [turns]);

  // Outline entries: user turns in order, keyed by turn id (jump target).
  const outlineEntries = useMemo(
    () => turns.filter((t): t is Extract<typeof t, { role: "user" }> => t?.role === "user"),
    [turns],
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
          <div className="mx-auto flex max-w-4xl flex-col gap-6">
            {turns.map((t, i) => {
              const isLastUser =
                t.role === "user" && !turns.slice(i + 1).some((x) => x.role === "user");
              const isLastAssistant =
                t.role === "assistant" && !turns.slice(i + 1).some((x) => x.role === "assistant");
              return (
                <div key={t.id} id={`turn-${t.id}`}>
                  {t.role === "user" ? (
                    <UserTurn
                      text={t.text}
                      onEdit={isLastUser ? () => onPrefill(t.text) : undefined}
                    />
                  ) : (
                    <AssistantTurn
                      turn={t}
                      onRegenerate={
                        isLastAssistant && lastUserText
                          ? () => send({ type: "prompt", text: lastUserText })
                          : undefined
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {outlineEntries.length >= OUTLINE_MIN_USER_TURNS ? (
        <ChatOutline entries={outlineEntries} onJump={jumpToTurn} />
      ) : null}
    </div>
  );
}
