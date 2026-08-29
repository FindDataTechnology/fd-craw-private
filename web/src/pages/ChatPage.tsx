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
export function ChatPage({ send }: { send: (m: ClientMessage) => void }) {
  const { t } = useTranslation();
  // Length-only subscription: this page branches on emptiness — subscribing
  // to the whole turns array would re-render it per streamed token.
  const isEmpty = useChatStore((s) => s.turns.length === 0);
  const status = useChatStore((s) => s.status);

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
        </div>
      )}
      {isEmpty ? (
        <>
          <ChatWelcome send={send} />
          <Composer send={send} />
        </>
      ) : (
        <>
          <ChatHeader send={send} />
          <Chat />
          <Composer send={send} />
        </>
      )}
    </main>
  );
}

// Re-export for the Ctrl+O shortcut helper if needed elsewhere.
export const useChatToggleAll = useChatStore;
