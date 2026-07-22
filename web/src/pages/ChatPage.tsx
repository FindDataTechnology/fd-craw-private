import { useChatStore } from "@/hooks/useChatStore";
import { Chat } from "@/components/Chat";
import { Composer } from "@/components/Composer";
import type { ClientMessage } from "@/types/ws";

// Chat page: message log + composer. The sidebar + WS are owned by the shell (App).
export function ChatPage({ send }: { send: (m: ClientMessage) => void }) {
  return (
    <main className="flex min-h-0 min-w-0 flex-col">
      <Chat />
      <Composer send={send} />
    </main>
  );
}

// Re-export for the Ctrl+O shortcut helper if needed elsewhere.
export const useChatToggleAll = useChatStore;
