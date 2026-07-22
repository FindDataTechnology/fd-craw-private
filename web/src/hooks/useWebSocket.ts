// WebSocket lifecycle hook. One connection for the whole app.
//
// Direct port of connect()/scheduleReconnect() from public/app.js. On open,
// the client asks the server for models, skills, and sessions — same as vanilla.
//
// Returns `send()` for outgoing messages; incoming messages flow into the
// Zustand store via apply().

import { useEffect, useRef } from "react";
import { useChatStore } from "@/hooks/useChatStore";
import type { ClientMessage, ServerMessage } from "@/types/ws";

// In dev (Vite on :5173), Vite doesn't proxy the root WS path — connect
// directly to the backend. In prod, use same-origin.
function wsUrl(): string {
  const dev = import.meta.env.DEV;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const host = dev ? "localhost:3000" : location.host;
  return `${proto}//${host}/`;
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const sendRef = useRef<(msg: ClientMessage) => void>(() => {});
  const setStatus = useChatStore((s) => s.setStatus);
  const apply = useChatStore((s) => s.apply);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setStatus("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        ws.send(JSON.stringify({ type: "list_models" } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: "list_skills" } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: "list_sessions" } satisfies ClientMessage));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerMessage;
          apply(msg);
          // Forward document status events to the documents store (live updates).
          if (msg.type === "documents_status") {
            import("@/hooks/useDocumentsStore").then(({ useDocumentsStore }) =>
              useDocumentsStore.getState().applyEvent(msg),
            );
          }
        } catch (err) {
          console.error("[ws] bad JSON", err);
        }
      };

      ws.onclose = () => {
        setStatus("disconnected");
        if (cancelled) return;
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 2000);
        }
      };

      ws.onerror = () => {
        // onclose fires after.
      };
    };

    sendRef.current = (msg) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [apply, setStatus]);

  return { send: (msg: ClientMessage) => sendRef.current(msg) };
}
