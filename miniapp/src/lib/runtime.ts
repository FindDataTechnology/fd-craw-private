// The mini program's one runtime: boots auth, installs the HTTP transport,
// owns the single WsClient, and funnels protocol events into the shared
// chat store (the same state machine the web app runs).
//
// The lifecycle invariants are the whole point: the server broadcasts every
// event to EVERY connected socket, so two live connections would double every
// user echo and stream delta. boot() is therefore single-flight (concurrent
// callers await the same promise, and start() re-checks `client` after its
// async auth probe), and onShow can only ever reconnect the one client —
// never spawn a second.

import { eventCenter } from "@tarojs/taro";
import { WsClient, useChatStore, type ClientMessage, type ServerMessage } from "@platform/core";
import { ensureAuth, LOGIN_REQUIRED_EVENT } from "./auth";
import { baseUrl } from "./config";
import { installHttp } from "./taro-http";
import { taroSocketFactory } from "./taro-socket";

function wsUrl(): string {
  return `${baseUrl().replace(/^http/, "ws")}/`;
}

// The protocol's initial state queries — replayed on every (re)connect so a
// resumed socket re-syncs rosters and the session list.
const INITIAL_QUERIES = [
  "list_models",
  "list_agents",
  "list_skills",
  "list_presets",
  "list_sessions",
] as const;

let client: WsClient | null = null;
let starting: Promise<void> | null = null;
let authFailed = false;

function send(msg: ClientMessage) {
  client?.send(JSON.stringify(msg));
}

async function start(): Promise<void> {
  if (client || authFailed) {
    if (authFailed) useChatStore.getState().setStatus("disconnected");
    return;
  }
  installHttp();
  const auth = await ensureAuth();
  if (auth === "failed") {
    authFailed = true;
    useChatStore.getState().setStatus("disconnected");
    return;
  }
  if (auth === "binding_required") {
    // Not an error: this WeChat user has no bound platform account yet. The
    // login page answers the event; after a successful sign-in the page's
    // foreground hook re-boots us with the fresh token.
    useChatStore.getState().setStatus("disconnected");
    eventCenter.trigger(LOGIN_REQUIRED_EVENT);
    return;
  }
  // A concurrent start() may have won the race while we probed auth.
  if (client) return;
  client = new WsClient({
    url: wsUrl,
    factory: taroSocketFactory,
    onStatus: (s) => useChatStore.getState().setStatus(s),
    onMessage: (m) => useChatStore.getState().apply(m as ServerMessage),
    onOpen: () => {
      for (const type of INITIAL_QUERIES) send({ type } as ClientMessage);
    },
  });
  client.connect();
}

export const runtime = {
  // Single-flight boot; concurrent callers await the same start. Once a
  // client exists, later boot() calls are a no-op (start re-checks).
  boot(): Promise<void> {
    if (!starting) {
      starting = start()
        .catch(() => {
          useChatStore.getState().setStatus("disconnected");
        })
        .finally(() => {
          starting = null;
        });
    }
    return starting;
  },

  send,

  // REST-only readiness (the sessions page browses history without a socket):
  // installs the HTTP transport and resolves the identity, without connecting.
  async ensureReady(): Promise<boolean> {
    installHttp();
    const auth = await ensureAuth();
    return auth !== "failed";
  },

  // Manual retry (connection banner) — resets the backoff budget of the ONE
  // client; only boots from scratch when there is nothing to reconnect.
  reconnectNow() {
    authFailed = false;
    if (client) {
      client.reconnectNow();
      return;
    }
    void this.boot();
  },

  // Mini-program foreground: backgrounding kills sockets. Reconnect only when
  // the single client's socket is actually DOWN — a connecting or live socket
  // is left alone, and this path can never create a second client.
  onForeground() {
    if (client) {
      if (useChatStore.getState().status === "disconnected") client.reconnectNow();
      return;
    }
    void this.boot();
  },
};

export { send as wsSend };
export type { ClientMessage };
