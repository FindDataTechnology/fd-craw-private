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
import * as trace from "./trace.js";

// Normalize a `todo/write` snapshot for the wire: keep only `content`/`status`,
// drop entries with no content, coerce an unrecognized status to "pending", and
// count the three states once here so every client renders its header without
// recounting. Returns null when the payload is not a list at all — the caller
// then ignores the event, as the protocol requires (a plan is UI state, never
// worth failing a turn over).
function normalizePlan(raw) {
  if (!Array.isArray(raw)) return null;
  const todos = [];
  for (const item of raw) {
    const content = typeof item?.content === "string" ? item.content : "";
    // Whitespace-only content would render as an invisible row; drop it rather
    // than send the UI a row nobody can read.
    if (!content.trim()) continue;
    const status =
      item.status === "in_progress" || item.status === "completed" ? item.status : "pending";
    todos.push({ content, status });
  }
  const counts = { pending: 0, inProgress: 0, completed: 0 };
  for (const t of todos) {
    if (t.status === "pending") counts.pending += 1;
    else if (t.status === "in_progress") counts.inProgress += 1;
    else counts.completed += 1;
  }
  return { todos, counts };
}

// A 401 from a registry-origin MCP endpoint means the stored market credential
// is no longer accepted (expiry, revocation, registry restart). Mark it stale —
// profile generation then treats it as absent — and ping the clients so the
// Store can prompt for a one-click re-connect (registry-sso-credentials).
// dsh names MCP tools `mcp__<serverName>__<toolName>` (dsh-profile), so the
// failing tool identifies the installed record to check for a credential ref.
const UNAUTHORIZED_RE = /\b401\b|unauthoriz/i;

function markRegistryCredentialStaleOn401(ctx, toolName, resultText) {
  if (!toolName || !resultText || !UNAUTHORIZED_RE.test(resultText)) return;
  const serverName = /^mcp__(.+?)__/.exec(toolName)?.[1];
  if (!serverName) return;
  Promise.all([import("../extension-store.js"), import("../registry-credentials.js")])
    .then(([extensionStore, credentials]) => {
      const server = extensionStore.getMcpServer(serverName);
      if (!credentials.isRegistryRef(server?.config)) return;
      const owner = ctx.runtimeOwnerEmail;
      // false ⇒ already stale: the profile was re-applied then, so a run of
      // 401s costs exactly one re-apply.
      if (!credentials.markStale(owner)) return;
      console.warn(
        `[registry] 401 from MCP server "${serverName}" — credential for ${owner || "the machine owner"} marked stale`,
      );
      ctx.broadcast?.({ type: "registry_credential_stale" });
      // The server cannot authenticate any more; drop it from the effective
      // profile now rather than leaving a call that fails every time. Groups
      // are the last-applied owner's, so the role filter is preserved.
      ctx
        .dshUpdateMcp?.(ctx.runtimeMcpOverlay ?? null, ctx.runtimeOwnerGroups ?? null, owner)
        ?.catch((e) => console.warn(`[registry] profile update after stale mark failed: ${e.message}`));
    })
    .catch((e) => console.warn(`[registry] stale detection failed: ${e.message}`));
}

export function attachDshEvents(ctx) {
  // The plan message for a session: the cached snapshot, or an explicit empty
  // list when the session has none. Sending the empty form (rather than
  // nothing) is what guarantees a client that just switched sessions can never
  // keep the previous session's plan on screen. Shared by the connect-time
  // syncs (ws.js) and the new-session/session-load paths (agent-session.js).
  ctx.planMessage = (sessionId) => {
    const plan = sessionId ? ctx.planBySession.get(sessionId) : null;
    return plan
      ? { type: "todos", todos: plan.todos, counts: plan.counts }
      : { type: "todos", todos: [], counts: { pending: 0, inProgress: 0, completed: 0 } };
  };

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
    const version = ctx.sessionVersion;
    chatHistory
      .listSessions()
      .then((sessions) => {
        if (version !== ctx.sessionVersion) return;
        ctx.broadcast({ type: "sessions", sessions, current: chatHistory.currentSessionId() });
      })
      .catch((e) => console.error("[chat-history] list after done failed:", e.message));
  };

  ctx.handleDshEvent = (notif) => {
    const { method } = notif || {};
    // Trace tap first: record everything (raw), before the WS translation
    // switch drops unknown event types. Failure-isolated inside record().
    trace.record(notif, { sessionId: ctx.dshSessionId, turnId: ctx.dshCurrentTurnId });

    if (method === "bridge.ready") {
      ctx.ready.dsh = true;
      // During initial boot the session shim is attached after the bridge starts;
      // the composition root performs the ready sync once that state exists.
      if (ctx.session) ctx.onDshReady?.();
      return;
    }
    // Bridge lifecycle notifications have no session id and must abort a live
    // web turn when the child exits before it can emit session.status idle.
    if (method === "bridge.exit" || method === "_bridge_crash") {
      ctx.ready.dsh = false;
      if (ctx.isStreaming) {
        ctx.broadcast({ type: "error", message: "Agent runtime exited unexpectedly" });
        ctx.finishTurn();
      }
      return;
    }

    // Session routing (design D2). One dsh runtime multiplexes the web chat and
    // every bot chat, so the pump can no longer assume THE session. A
    // notification for a non-web session goes to that session's registered
    // collector and NEVER to the WS broadcast path — that is what keeps bot
    // turns out of the web transcript. An unclaimed non-web session is dropped.
    // Bridge lifecycle notifications carry no sessionId and stay on the web path.
    const sid = notif?.params?.sessionId;
    if (sid && sid !== ctx.dshSessionId) {
      const collector = ctx.sessionCollectors.get(sid);
      if (collector) {
        try { collector(notif); }
        catch (e) { console.error(`[dsh] session collector ${sid} failed: ${e.message}`); }
      } else if (process.env.DSH_DEBUG) {
        console.debug("[dsh] notification for unclaimed session:", sid, notif.method);
      }
      return;
    }
    const { params } = notif || {};
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
        ctx.dshTurnBlocks = [];
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
        // (on assistant/message), now WITH the turn's block structure — the
        // tool calls accumulated below survive reload instead of flattening
        // to prose. Records when text OR tool evidence exists.
        const blocks = ev.data?.message?.content;
        let text = "";
        if (Array.isArray(blocks)) {
          text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
        }
        const persistBlocks = [
          ...ctx.dshTurnBlocks,
          ...(text ? [{ kind: "text", text }] : []),
        ];
        if (text || ctx.dshTurnBlocks.length) {
          chatHistory.recordMessage(
            chatHistory.currentSessionId(),
            "assistant",
            text,
            persistBlocks
          );
        }
        break;
      }
      case "tool/call": {
        ctx.dshToolNames.set(ev.data.callId, ev.data.name);
        // Accumulate for persistence (result/state filled by tool/result).
        ctx.dshTurnBlocks.push({
          kind: "tool",
          id: ev.data.callId,
          name: ev.data.name,
          // dsh carries raw JSON string arguments; parse to match the WS contract.
          args: (() => { try { return JSON.parse(ev.data.arguments); } catch { return ev.data.arguments; } })(),
        });
        ctx.broadcast({
          type: "tool_start",
          toolCallId: ev.data.callId,
          name: ev.data.name,
          args: ctx.dshTurnBlocks[ctx.dshTurnBlocks.length - 1].args,
        });
        break;
      }
      case "tool/result": {
        const callId =
          ev.data?.message?.source?.callId ?? ev.data?.message?.content?.[0]?.toolCallId;
        const resultBlocks = ev.data?.message?.content?.[0]?.content;
        const resultText = Array.isArray(resultBlocks)
          ? resultBlocks.filter((b) => b.type === "text").map((b) => b.text).join("") || null
          : null;
        const isError = !!ev.data?.error || !!ev.data?.message?.content?.[0]?.isError;
        // Fill the accumulated persistence block for this call.
        const acc = ctx.dshTurnBlocks.find((b) => b.id === callId);
        if (acc) {
          acc.result = resultText;
          acc.state = isError ? "error" : "done";
        }
        ctx.broadcast({
          type: "tool_end",
          toolCallId: callId,
          name: ctx.dshToolNames.get(callId) ?? undefined,
          result: resultText,
          isError,
        });
        if (isError) markRegistryCredentialStaleOn401(ctx, ctx.dshToolNames.get(callId), resultText);
        break;
      }
      case "turn/end": {
        // An errored turn must never end silently. LLM failures are captured
        // earlier (assistant/chunk finish → dshTurnError) and replayed here;
        // other failures — e.g. the dsh session-log id collision after a child
        // restart — arrive ONLY on turn/end itself, and without this fallback
        // the client sees the turn end with no output and no explanation.
        const reason = ev.data?.reason;
        if (reason?.kind === "error") {
          const message = ctx.dshTurnError || reason.error?.message || "The agent turn failed";
          ctx.broadcast({ type: "error", message });
        }
        ctx.dshTurnError = null;
        break;
      }
      case "todo/write": {
        // The agent's plan — a WHOLE-LIST snapshot (dsh-tool-todo replaces the
        // list on every call; last write wins). Cached per dsh session for the
        // rehydration push and broadcast to every web client. Deliberately NOT
        // cleared on turn boundaries: the plan outlives the turn that wrote it,
        // and only a new/loaded session resets it (agent-session.js / ws.js).
        const plan = normalizePlan(ev.data?.todos);
        if (!plan) {
          if (process.env.DSH_DEBUG) console.debug("[dsh] todo/write without a todos list; ignored");
          break;
        }
        if (ctx.dshSessionId) ctx.planBySession.set(ctx.dshSessionId, plan);
        ctx.broadcast({ type: "todos", todos: plan.todos, counts: plan.counts });
        break;
      }
      case "permission/preset": {
        // The session's permission preset changed (a live switch via the
        // strip, or the initial pin when a fresh session publishes). Keying on
        // the preset event — not the sandbox/approval knob events — because
        // the preset name is the user-facing truth; unmatched knob
        // combinations surface as `custom` on the roster read path instead.
        const preset = ev.data?.preset || null;
        if (preset && preset !== ctx.currentPermission) {
          ctx.currentPermission = preset;
          ctx.broadcast({ type: "current_permission", name: preset });
        }
        break;
      }
      default:
        if (process.env.DSH_DEBUG) console.debug("[dsh] unmapped event:", ev.type);
        break;
    }
  };
}
