// Social chat-platform bots: registry, inbound pipeline, and reply delivery.
//
// One dsh runtime serves the web chat and every bot chat. A bot chat is bound
// to its own dsh session (`bot-<botId>-<sha1(chatKey)16>`), which dsh persists
// and resumes from disk — so a conversation survives a runtime restart and a
// model switch. Notifications for those sessions are routed to a per-turn
// collector by the session-aware pump (server/dsh-events.js), never to the WS
// broadcast path.
//
// Graceful degradation, per the project convention: the module is inert with
// no bots configured, every adapter call is failure-isolated, and a broken bot
// is logged and skipped rather than crashing the server or stalling the others.

import crypto from "node:crypto";
import { getAdapter, validateCredentials } from "./bots/adapter.js";

// Trust-boundary guards (design D3). These bound an untrusted external caller's
// reach into an agent, so they live here — before prompt() — not in the adapters.
const MAX_MESSAGE_CHARS = 4000;
const RATE_LIMIT_PER_MIN = 10;
const TURN_TIMEOUT_MS = Number(process.env.BOTS_TURN_TIMEOUT_MS) || 180_000;

// v1 posture: bot turns are answer-only. dsh exposes no per-session tool
// control (tools are auto-allowed by the profile's plugins), so this is
// enforced in two places that ARE available: an explicit instruction on the
// prompt, and a reply-side check that refuses to forward an answer derived
// from tool calls. `BOTS_ALLOW_TOOLS=1` lifts both.
// ponytail: prompt-level posture is the ceiling until dsh grows a per-prompt
// tool allowlist; the reply-side check is what makes it observable.
const NO_TOOLS_PREFIX =
  "You are answering a message from an external chat platform. Answer directly from " +
  "your own knowledge. Do not call any tools.\n\n";

const state = {
  ctx: null,
  bots: new Map(), // id → { bot, adapter, stopPoll }
  queues: new Map(), // sessionId → tail promise (serializes turns within a chat)
  buckets: new Map(), // `${botId}:${chatKey}` → { tokens, refilledAt }
};

const allowTools = () => process.env.BOTS_ALLOW_TOOLS === "1";

export function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || null;
}

// Stable per-(bot, external chat) dsh session id (design D2). Derived, not
// stored: the conversation itself lives in dsh's session store.
export function sessionIdFor(botId, chatKey) {
  const hash = crypto.createHash("sha1").update(String(chatKey)).digest("hex").slice(0, 16);
  return `bot-${botId}-${hash}`;
}

export function webhookUrlFor(bot) {
  const base = publicBaseUrl() ?? "";
  return `${base}/api/bots/webhook/${bot.id}/${bot.secret}`;
}

// Browser-facing shape. Credential VALUES never leave the server — only the
// set of keys that are configured, so the UI can show "configured" hints.
export function maskBot(bot) {
  return {
    id: bot.id,
    type: bot.type,
    name: bot.name,
    enabled: bot.enabled,
    createdAt: bot.createdAt,
    configuredCredentials: Object.entries(bot.credentials ?? {})
      .filter(([, v]) => String(v ?? "").trim())
      .map(([k]) => k),
    webhookUrl: webhookUrlFor(bot),
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function initBots(ctx) {
  state.ctx = ctx;
  if (!ctx.db.isDbReady()) {
    console.warn("[bots] disabled: database unavailable");
    return;
  }
  for (const bot of ctx.db.listBots()) reload(bot);
  const live = [...state.bots.values()].filter((e) => e.bot.enabled).length;
  if (live) console.log(`[bots] ${live} bot(s) active`);
}

// (Re)build one bot's runtime entry from its row: stop whatever was running,
// then start the new config. Called on every config mutation, so changes take
// effect without a server restart.
export function reload(bot) {
  stop(bot.id);
  const adapter = getAdapter(bot.type);
  if (!adapter) {
    console.warn(`[bots] "${bot.name}" has unknown type "${bot.type}"; skipped`);
    return;
  }
  const entry = { bot, adapter, stopPoll: null };
  state.bots.set(bot.id, entry);
  if (!bot.enabled) return;
  // Polling fallback: adapters that support it (telegram) run a long-poll loop
  // when the server has no public URL for the platform to call back to.
  if (adapter.start && !publicBaseUrl()) {
    try {
      entry.stopPoll = adapter.start(bot, (msg) => {
        void handleMessage(bot.id, msg).catch((e) =>
          console.warn(`[bots] "${bot.name}" polled turn failed: ${e.message}`),
        );
      });
      console.log(`[bots] "${bot.name}" polling (no PUBLIC_BASE_URL)`);
    } catch (e) {
      console.warn(`[bots] "${bot.name}" poll start failed: ${e.message}`);
    }
  }
}

export function stop(botId) {
  const entry = state.bots.get(botId);
  if (!entry) return;
  try { entry.stopPoll?.(); } catch (e) { console.warn(`[bots] stop failed: ${e.message}`); }
  state.bots.delete(botId);
}

export function stopAll() {
  for (const id of [...state.bots.keys()]) stop(id);
}

export function getEntry(botId) {
  return state.bots.get(botId) ?? null;
}

export { validateCredentials };

// ── Guards ───────────────────────────────────────────────────────────────────

// Per-chat token bucket, refilled continuously. Returns false when the chat has
// exhausted its allowance for the current window.
function takeToken(botId, chatKey) {
  const key = `${botId}:${chatKey}`;
  const now = Date.now();
  const b = state.buckets.get(key) ?? { tokens: RATE_LIMIT_PER_MIN, refilledAt: now };
  b.tokens = Math.min(RATE_LIMIT_PER_MIN, b.tokens + ((now - b.refilledAt) / 60_000) * RATE_LIMIT_PER_MIN);
  b.refilledAt = now;
  state.buckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// ── Turn runner ──────────────────────────────────────────────────────────────

// Collect one turn's outcome off the session's notification stream. Registered
// BEFORE prompt() so no early event is missed; always unregistered.
function collectTurn(ctx, sessionId) {
  return new Promise((resolve, reject) => {
    let text = "";
    let error = null;
    let usedTools = false;
    const settle = (fn, arg) => {
      clearTimeout(timer);
      ctx.sessionCollectors.delete(sessionId);
      fn(arg);
    };
    const timer = setTimeout(() => settle(reject, new Error("turn timed out")), TURN_TIMEOUT_MS);

    ctx.sessionCollectors.set(sessionId, (notif) => {
      const { method, params } = notif;
      if (method === "session.status" && params.status === "idle") {
        return settle(resolve, { text, error, usedTools });
      }
      if (method !== "session.event") return;
      const ev = params.event;
      if (ev?.type === "assistant/message") {
        const blocks = ev.data?.message?.content;
        if (Array.isArray(blocks)) {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) text = t;
        }
      } else if (ev?.type === "tool/call") {
        usedTools = true;
      } else if (
        ev?.type === "assistant/chunk" &&
        ev.data?.chunk?.type === "finish" &&
        ev.data.chunk.reason?.kind === "error"
      ) {
        error = ev.data.chunk.reason.failure?.message || "LLM request failed";
      }
    });
  });
}

// Run one agent turn for an inbound message and deliver the reply. Turns within
// a chat are serialized (queued on the session id); different chats run in
// parallel. Every failure path still tries to tell the user something.
export async function handleMessage(botId, { chatKey, text }) {
  const entry = state.bots.get(botId);
  if (!entry || !entry.bot.enabled) return;
  const { bot, adapter } = entry;

  if (!text || text.length > MAX_MESSAGE_CHARS) {
    console.warn(`[bots] "${bot.name}" dropped an oversized/empty message from a chat`);
    return;
  }
  if (!takeToken(botId, chatKey)) {
    console.warn(`[bots] "${bot.name}" rate limit hit for a chat; message dropped`);
    return;
  }

  const sessionId = sessionIdFor(botId, chatKey);
  const tail = state.queues.get(sessionId) ?? Promise.resolve();
  const run = tail.then(() => runTurn(entry, sessionId, chatKey, text));
  // Keep the chain alive past a failed turn, and drop the entry once idle so
  // the map does not grow without bound across many chats.
  state.queues.set(
    sessionId,
    run.then(
      () => { if (state.queues.get(sessionId) === run) state.queues.delete(sessionId); },
      () => { if (state.queues.get(sessionId) === run) state.queues.delete(sessionId); },
    ),
  );
  return run;
}

async function runTurn({ bot, adapter }, sessionId, chatKey, text) {
  const ctx = state.ctx;
  const reply = async (body) => {
    try { await adapter.sendText(bot.credentials, chatKey, body); }
    catch (e) { console.warn(`[bots] "${bot.name}" send failed: ${e.message}`); }
  };
  if (!ctx?.dshBridge?.isReady()) return reply("The assistant is starting up. Please try again shortly.");

  const collected = collectTurn(ctx, sessionId);
  const prompt = allowTools() ? text : NO_TOOLS_PREFIX + text;
  let result;
  try {
    await ctx.dshBridge.prompt(sessionId, [{ type: "text", text: prompt }]);
    result = await collected;
  } catch (e) {
    ctx.sessionCollectors.delete(sessionId);
    console.warn(`[bots] "${bot.name}" turn failed: ${e.message}`);
    return reply("Sorry — I could not complete that request.");
  }

  if (result.error) return reply(`Sorry — ${result.error}`);
  if (result.usedTools && !allowTools()) {
    console.warn(`[bots] "${bot.name}" turn used tools under the no-tools posture; reply withheld`);
    return reply("Sorry — I cannot answer that from this channel.");
  }
  // Assistant final text only — never tool output or raw events (design D3.4).
  if (result.text) await reply(result.text);
}

// Proactive outbound send (admin-gated at the route).
export async function sendTo(botId, chatKey, text) {
  const entry = state.bots.get(botId);
  if (!entry) throw new Error("Bot not found or not running");
  await entry.adapter.sendText(entry.bot.credentials, chatKey, text);
}
