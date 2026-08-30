import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/hooks/useChatStore";
import { Chat } from "@/components/Chat";
import { ChatHeader } from "@/components/ChatHeader";
import { ChatWelcome } from "@/components/ChatWelcome";
import { Composer } from "@/components/Composer";
import type { ClientMessage } from "@/types/ws";

// Chat page: the empty state (ChatWelcome) and the in-session state
// (ChatHeader + Chat + Composer) are mutually exclusive — they never render
// together. The branch is keyed on `turns.length === 0` per design D1: the
// welcome is a "no turns" affordance, the header takes over once the user
// starts or resumes a conversation. `clearView` flips back to the welcome.
//
// The composer draft is owned HERE (not inside Composer) so it survives the
// welcome → in-session branch swap, and so ChatWelcome's suggested-prompt
// cards can prefill it: clicking a card fills the composer and focuses it —
// the user stays in control of what actually gets sent.
//
// Sessions are deep-linkable: /chat/:sessionId loads that session, and the
// URL follows the active session both ways (refresh and back keep context).
export function ChatPage({ send }: { send: (m: ClientMessage) => void }) {
  const { t } = useTranslation();
  const { sessionId: urlSessionId } = useParams();
  // Length-only subscription: this page branches on emptiness — subscribing
  // to the whole turns array would re-render it per streamed token.
  const isEmpty = useChatStore((s) => s.turns.length === 0);
  const status = useChatStore((s) => s.status);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  const [draft, setDraft] = useState("");
  const [focusTick, setFocusTick] = useState(0);
  const prefillComposer = (text: string) => {
    setDraft(text);
    setFocusTick((n) => n + 1);
  };

  // Deep link in: a session id in the URL that isn't current loads it. The URL
  // changes ONLY through user navigation (sidebar rows / new chat navigate
  // explicitly; refresh keeps its place) — a reactive URL-follows-session
  // effect here would race this one and ping-pong switch_session between the
  // stale URL and the fresh session id.
  useEffect(() => {
    if (urlSessionId && urlSessionId !== currentSessionId) {
      send({ type: "switch_session", id: urlSessionId });
    }
  }, [urlSessionId, currentSessionId, send]);

  return (
    <main className="flex min-h-0 min-w-0 flex-col">
      {/* A dropped socket used to be legible only in the sidebar's 6px status
          dot — and it stranded the streaming state. The store now finalizes
          the turn on disconnect; this banner names what happened while the
          WS hook's backoff reconnects. */}
      {status === "disconnected" && (
        <div
          data-testid="connection-banner"
          className="flex items-center gap-2 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" />
          {t("chat.connectionLost")}
          <button
            type="button"
            data-testid="connection-retry"
            onClick={() => window.dispatchEvent(new Event("platform:reconnect"))}
            className="ml-1 rounded-md border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted"
          >
            {t("chat.retry")}
          </button>
        </div>
      )}
      {isEmpty ? (
        <>
          <ChatWelcome onPrefill={prefillComposer} send={send} />
          <Composer send={send} value={draft} onChange={setDraft} focusTick={focusTick} />
        </>
      ) : (
        <>
          <ChatHeader send={send} />
          <Chat send={send} onPrefill={prefillComposer} />
          <Composer send={send} value={draft} onChange={setDraft} focusTick={focusTick} />
        </>
      )}
    </main>
  );
}

// Re-export for the Ctrl+O shortcut helper if needed elsewhere.
export const useChatToggleAll = useChatStore;
