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
import { WsClient, useChatStore, useCronStore, type ClientMessage, type ServerMessage } from "@platform/core";
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
  "cron_list",
] as const;

let client: WsClient | null = null;
let starting: Promise<void> | null = null;
let authFailed = false;
// Bumped by switchBase(): an in-flight start() from before the switch must
// not install its (stale-auth, old-base) client after the reset.
let bootGen = 0;
// Whether the current boot stopped at "no bound account" (binding_required).
// The chat page renders a user-initiated sign-in affordance for this state —
// NEVER an automatic jump to the login page (openspec: mp-demo-mode;
// WeChat rejects forced login before the user has browsed).
let loginRequired = false;

export function loginRequiredNow(): boolean {
  return loginRequired;
}

function send(msg: ClientMessage) {
  client?.send(JSON.stringify(msg));
}

async function start(): Promise<void> {
  const gen = bootGen;
  if (client || authFailed) {
    if (authFailed) useChatStore.getState().setStatus("disconnected");
    return;
  }
  installHttp();
  const auth = await ensureAuth();
  if (gen !== bootGen) return;
  if (auth === "failed") {
    authFailed = true;
    useChatStore.getState().setStatus("disconnected");
    return;
  }
  if (auth === "binding_required") {
    // Not an error: this WeChat user has no bound platform account yet and
    // the deployment has no demo mode. The page shows a "登录后开始使用"
    // banner (user-initiated sign-in); after a successful sign-in the page's
    // foreground hook re-boots us with the fresh token.
    loginRequired = true;
    useChatStore.getState().setStatus("disconnected");
    eventCenter.trigger(LOGIN_REQUIRED_EVENT);
    return;
  }
  loginRequired = false;
  // A concurrent start() may have won the race while we probed auth.
  if (client) return;
  client = new WsClient({
    url: wsUrl,
    factory: taroSocketFactory,
    onStatus: (s) => useChatStore.getState().setStatus(s),
    onMessage: (m) => {
      useChatStore.getState().apply(m as ServerMessage);
      useCronStore.getState().apply(m as ServerMessage);
    },
    onOpen: () => {
      for (const type of INITIAL_QUERIES) send({ type } as ClientMessage);
    },
  });
  client.connect();
}

export const runtime = {
  // Whether the current boot stopped at "no bound account" — the chat page's
  // sign-in banner and send guard key off this.
  loginRequiredNow,

  // Base switch (openspec: mp-demo-sandbox): final-close the one client,
  // reset boot state, and boot fresh — the new persisted base drives both the
  // auth probe and the next WS url. Used by 先体验/退出演示.
  switchBase(): Promise<void> {
    bootGen += 1;
    client?.close();
    client = null;
    starting = null;
    authFailed = false;
    loginRequired = false;
    useChatStore.getState().setStatus("disconnected");
    return this.boot();
  },

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
