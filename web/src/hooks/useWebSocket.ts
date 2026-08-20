// WebSocket lifecycle hook. One connection for the whole app.
//
// Direct port of connect()/scheduleReconnect() from public/app.js. On open,
// the client asks the server for models, skills, and sessions — same as vanilla.
//
// Returns `send()` for outgoing messages; incoming messages flow into the
// Zustand store via apply().

import { useEffect, useRef } from "react";
import { useChatStore } from "@/hooks/useChatStore";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
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
  const applyExtensions = useExtensionsStore((s) => s.applyEvent);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const MAX_ATTEMPTS = 20;

    // Exponential backoff (capped at 30s) + ±25% jitter. Stops after
    // MAX_ATTEMPTS so a dead server isn't hammered forever; resets to 0 on a
    // successful open and on the `online` event (network restored).
    const scheduleReconnect = () => {
      if (cancelled || attempt >= MAX_ATTEMPTS) return;
      const base = Math.min(30000, 1000 * 2 ** attempt);
      const delay = base * (0.75 + Math.random() * 0.5);
      attempt++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      setStatus("connecting");
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setStatus("connected");
        ws.send(JSON.stringify({ type: "list_models" } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: "list_agents" } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: "list_skills" } satisfies ClientMessage));
        ws.send(JSON.stringify({ type: "list_sessions" } satisfies ClientMessage));
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerMessage;
          apply(msg);
          applyExtensions(msg);
        } catch (err) {
          console.error("[ws] bad JSON", err);
        }
      };

      ws.onclose = () => {
        setStatus("disconnected");
        if (cancelled) return;
        if (!reconnectTimer) scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose fires after.
      };
    };

    sendRef.current = (msg) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    // Reconnect immediately when the network comes back (e.g. laptop wake),
    // bypassing the backoff timer and resetting the retry budget.
    const onOnline = () => {
      if (cancelled) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      attempt = 0;
      connect();
    };
    window.addEventListener("online", onOnline);

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener("online", onOnline);
      wsRef.current?.close();
    };
  }, [apply, applyExtensions, setStatus]);

  return { send: (msg: ClientMessage) => sendRef.current(msg) };
}
