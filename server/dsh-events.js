// dsh → WS event-translation layer. The dsh runtime emits an append-only
// session event log as `session.event` notifications plus `session.status`
// lifecycle notifications; this maps them onto the frozen WS protocol the
// React frontend already speaks:
//   turn/start          → agent_start (isStreaming already set at dispatch)
//   assistant/chunk     → text / thinking / (error capture on finish error)
//   assistant/message   → chat-history record (assistant turn persistence)
//   tool/call           → tool_start
//   tool/result         → tool_end
//   turn/end (error)    → error
//   session.status idle → finishTurn (done + sessions refresh)
// dsh has no partial-tool-result event, so tool_update is unmapped. Unmapped
// notifications log at debug (DSH_DEBUG) and never drop the turn.

import * as chatHistory from "../chat-history.js";

export function attachDshEvents(ctx) {
  // Mark the current agent turn finished: reset the streaming flag, broadcast
  // `done` (which re-enables the UI / model selector and finalizes tool
  // blocks), and refresh the sidebar session list. Idempotent per turn — it
  // no-ops if the turn is already finished — so it is safe to call from both
  // the session-status idle handler and the prompt() catch on failure, without
  // risking a double `done`. This is what unblocks model-switching /
  // new-session creation after a failed turn and keeps the sidebar in sync.
  ctx.finishTurn = () => {
    if (!ctx.isStreaming) return;
    ctx.isStreaming = false;
    ctx.broadcast({ type: "done" });
    chatHistory
      .listSessions()
      .then((sessions) =>
        ctx.broadcast({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
      )
      .catch((e) => console.error("[chat-history] list after done failed:", e.message));
  };

  ctx.handleDshEvent = (notif) => {
    const { method, params } = notif || {};
    if (method === "session.status") {
      if (params?.status === "idle") ctx.finishTurn();
      return;
    }
    if (method !== "session.event") {
      if (process.env.DSH_DEBUG)
        console.debug("[dsh] notification:", method, JSON.stringify(params)?.slice(0, 200));
      return;
    }
    const ev = params?.event;
    if (!ev) return;
    if (process.env.DSH_DEBUG) console.log("[dsh-debug] event:", ev.type, JSON.stringify(ev.data)?.slice(0, 600));
    switch (ev.type) {
      case "turn/start":
        // One agent_start per turn. isStreaming was already set synchronously at
        // prompt dispatch (see the WS prompt handler) so a concurrent prompt
        // observes it; re-affirm here idempotently.
        ctx.isStreaming = true;
        ctx.dshTurnError = null;
        ctx.dshToolNames.clear();
        ctx.broadcast({ type: "agent_start" });
        break;
      case "assistant/chunk": {
        const chunk = ev.data?.chunk;
        if (!chunk) break;
        if (chunk.type === "text-delta" && chunk.text) {
          ctx.broadcast({ type: "text", delta: chunk.text });
        } else if (chunk.type === "reasoning-delta" && chunk.text) {
          ctx.broadcast({ type: "thinking", delta: chunk.text });
        } else if (chunk.type === "finish" && chunk.reason?.kind === "error") {
          // Capture the LLM failure; broadcast on turn/end (the turn-completion
          // signal), then session.status idle → finishTurn → done.
          ctx.dshTurnError = chunk.reason.failure?.message || "LLM request failed";
        }
        break;
      }
      case "assistant/message": {
        // Mirror the assistant's final text into the SQLite project database
        // (on assistant/message). Only records when text was produced.
        const blocks = ev.data?.message?.content;
        if (Array.isArray(blocks)) {
          const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (text) chatHistory.recordMessage(chatHistory.currentSessionId(), "assistant", text);
        }
        break;
      }
      case "tool/call":
        ctx.dshToolNames.set(ev.data.callId, ev.data.name);
        ctx.broadcast({
          type: "tool_start",
          toolCallId: ev.data.callId,
          name: ev.data.name,
          // dsh carries raw JSON string arguments; parse to match the WS contract.
          args: (() => { try { return JSON.parse(ev.data.arguments); } catch { return ev.data.arguments; } })(),
        });
        break;
      case "tool/result": {
        const callId =
          ev.data?.message?.source?.callId ?? ev.data?.message?.content?.[0]?.toolCallId;
        const resultBlocks = ev.data?.message?.content?.[0]?.content;
        const resultText = Array.isArray(resultBlocks)
          ? resultBlocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null
          : null;
        ctx.broadcast({
          type: "tool_end",
          toolCallId: callId,
          name: ctx.dshToolNames.get(callId) ?? undefined,
          result: resultText,
          isError: !!ev.data?.error || !!ev.data?.message?.content?.[0]?.isError,
        });
        break;
      }
      case "turn/end":
        if (ev.data?.reason?.kind === "error" && ctx.dshTurnError) {
          ctx.broadcast({ type: "error", message: ctx.dshTurnError });
        }
        ctx.dshTurnError = null;
        break;
      default:
        if (process.env.DSH_DEBUG) console.debug("[dsh] unmapped event:", ev.type);
        break;
    }
  };
}
