// Tests for the social-bot-channels inbound pipeline (tasks 6.1 + 6.3).
//
// Runs the real Express routes and the real bots module against an isolated
// DB_PATH and a STUB dsh bridge, so a full inbound turn — webhook → verify →
// parse → guards → prompt → collect → sendText — is exercised end to end with
// no LLM, no network, and no agent runtime.
//
// Covered contract scenarios:
//   - config CRUD, and that credential VALUES never appear in any response
//   - webhook 403 on a wrong secret / unknown bot / disabled bot
//   - a synthetic Telegram update drives a turn and records the sendText call
//   - oversized message rejected; per-chat rate limit trips
//   - BOTS_ALLOW_TOOLS unset ⇒ a tool-using turn's answer is withheld

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import express from "express";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bots-test-"));
process.env.DB_PATH = path.join(tmpRoot, "app.db");
delete process.env.BOTS_ALLOW_TOOLS;
delete process.env.PUBLIC_BASE_URL;

const db = await import("../db.js");
const bots = await import("../server/bots.js");
const { createAppContext } = await import("../server/context.js");
const { registerAuth } = await import("../server/auth.js");
const { registerBotRoutes, WEBHOOK_PREFIX } = await import("../server/routes/bots.js");

// Every sendText the telegram adapter would have made, captured instead of sent.
const sent = [];
// The next turn's scripted notification stream, replayed when prompt() is called.
let scriptedTurn = [];

let server;
let base;
let ctx;

before(async () => {
  await db.initDb();

  const app = express();
  // Same body-parser wiring as server.js: the webhook prefix must keep its raw
  // bytes, so the global JSON parser skips it. Getting this wrong silently
  // empties every webhook body.
  const jsonBodyParser = express.json();
  app.use((req, res, next) =>
    req.path.startsWith(WEBHOOK_PREFIX) ? next() : jsonBodyParser(req, res, next),
  );
  ctx = createAppContext({ AUTH_MODE: "none" });
  ctx.app = app;
  registerAuth(ctx);
  registerBotRoutes(ctx);

  // Stub bridge: prompt() replays the scripted notifications for the target
  // session through the same collector the real pump feeds, then goes idle.
  ctx.dshBridge = {
    isReady: () => true,
    prompts: [],
    async prompt(sessionId, blocks) {
      this.prompts.push({ sessionId, text: blocks[0].text });
      queueMicrotask(() => {
        const collector = ctx.sessionCollectors.get(sessionId);
        if (!collector) return;
        for (const ev of scriptedTurn) collector({ method: "session.event", params: { sessionId, event: ev } });
        collector({ method: "session.status", params: { sessionId, status: "idle" } });
      });
      return "msg-1";
    },
  };

  bots.initBots(ctx);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  bots.stopAll();
  server?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const api = (p, init) => fetch(`${base}${p}`, init);
const postJson = (p, body, method = "POST") =>
  api(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const assistantText = (text) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });
const toolCall = () => ({ type: "tool/call", data: { callId: "c1", name: "bash", arguments: "{}" } });

// Create a telegram bot whose sendText is captured rather than performed.
async function makeBot(name = "tg") {
  const res = await postJson("/api/bots", {
    type: "telegram",
    name,
    credentials: { token: "SECRET-BOT-TOKEN" },
  });
  const bot = await res.json();
  const entry = bots.getEntry(bot.id);
  entry.adapter = {
    ...entry.adapter,
    start: undefined,
    async sendText(_cred, chatKey, text) { sent.push({ chatKey, text }); },
  };
  return bot;
}

const update = (chatId, text) => ({
  update_id: Math.floor(Math.random() * 1e6),
  message: { message_id: 1, chat: { id: chatId }, from: { username: "u" }, date: 0, text },
});

// Deliver a webhook and wait for the turn it kicks off (the route acks first).
async function deliver(bot, secret, body) {
  const res = await postJson(`/api/bots/webhook/${bot.id}/${secret}`, body);
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

const secretOf = (bot) => bot.webhookUrl.split("/").pop();

test("config CRUD never leaks credential values", async () => {
  const bot = await makeBot("crud");
  assert.deepEqual(bot.configuredCredentials, ["token"]);
  assert.ok(!JSON.stringify(bot).includes("SECRET-BOT-TOKEN"));

  const list = await (await api("/api/bots")).json();
  assert.ok(!JSON.stringify(list).includes("SECRET-BOT-TOKEN"));
  assert.ok(list.types.some((t) => t.type === "telegram"));

  // A blank secret field on edit keeps the stored credential.
  await postJson(`/api/bots/${bot.id}`, { credentials: { token: "" } }, "PATCH");
  assert.equal(db.getBot(bot.id).credentials.token, "SECRET-BOT-TOKEN");

  assert.equal((await api(`/api/bots/${bot.id}`, { method: "DELETE" })).status, 200);
  assert.equal(db.getBot(bot.id), null);
});

test("webhook rejects a wrong secret, an unknown bot, and a disabled bot", async () => {
  const bot = await makeBot("auth");
  const secret = secretOf(bot);

  assert.equal((await postJson(`/api/bots/webhook/${bot.id}/wrong-secret`, {})).status, 403);
  assert.equal((await postJson(`/api/bots/webhook/does-not-exist/${secret}`, {})).status, 403);

  await postJson(`/api/bots/${bot.id}`, { enabled: false }, "PATCH");
  assert.equal((await postJson(`/api/bots/webhook/${bot.id}/${secret}`, {})).status, 403);
});

test("a verified update drives a full turn and delivers the reply", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("hello from the agent")];
  const bot = await makeBot("turn");

  const res = await deliver(bot, secretOf(bot), update(4242, "hi there"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "success");

  assert.deepEqual(sent, [{ chatKey: "4242", text: "hello from the agent" }]);

  // The turn ran on the derived per-(bot, chat) session, not the web session.
  const prompt = ctx.dshBridge.prompts.at(-1);
  assert.equal(prompt.sessionId, bots.sessionIdFor(bot.id, "4242"));
  assert.notEqual(prompt.sessionId, ctx.dshSessionId);
  assert.ok(prompt.text.endsWith("hi there"));
  // The collector is always unregistered, whatever the outcome.
  assert.equal(ctx.sessionCollectors.size, 0);
});

test("guard: an oversized message never reaches the agent", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("should not happen")];
  const bot = await makeBot("cap");
  const before = ctx.dshBridge.prompts.length;

  await deliver(bot, secretOf(bot), update(1, "x".repeat(4001)));

  assert.equal(ctx.dshBridge.prompts.length, before, "no prompt for an oversized message");
  assert.deepEqual(sent, []);
});

test("guard: the per-chat rate limit trips after the allowance", async () => {
  sent.length = 0;
  scriptedTurn = [assistantText("ok")];
  const bot = await makeBot("rate");
  const secret = secretOf(bot);

  // 10/min is the bucket; the 11th message in the same chat is dropped.
  for (let i = 0; i < 11; i++) await deliver(bot, secret, update(777, `m${i}`));
  assert.equal(sent.length, 10, "the 11th message must be dropped");

  // A different chat has its own bucket.
  await deliver(bot, secret, update(888, "other chat"));
  assert.equal(sent.length, 11);
});

test("guard: BOTS_ALLOW_TOOLS unset withholds a tool-derived answer", async () => {
  sent.length = 0;
  scriptedTurn = [toolCall(), assistantText("answer built from a tool")];
  const bot = await makeBot("tools");

  await deliver(bot, secretOf(bot), update(99, "run something"));

  assert.equal(sent.length, 1);
  assert.ok(!sent[0].text.includes("answer built from a tool"), "tool-derived text must not be delivered");
  // The prompt itself also carries the no-tools instruction.
  assert.ok(ctx.dshBridge.prompts.at(-1).text.startsWith("You are answering a message"));
});
