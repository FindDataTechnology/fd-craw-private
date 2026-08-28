// Agent-session state machine: session create/switch, model list/refresh/
// switch, catalog-agent switch, remote-agent streaming, and the /model + /new
// command handlers. Attached onto ctx by attachAgentSession; ws.js and the
// chat-history routes consume them through ctx.

import * as chatHistory from "../chat-history.js";
import * as catalog from "../catalog.js";

export function attachAgentSession(ctx) {

// Start a new chat session: create a fresh SDK session and reset the agent's
// in-memory messages. Rejected while streaming to avoid switching mid-turn.
async function createNewSession() {
  if (ctx.isStreaming) throw new Error("Cannot start a new chat while the agent is responding");
  ctx.session.sessionManager.newSession();
  // ponytail: dsh has no in-memory message state to reset — newSession() (shim)
  // already minted a fresh dshSessionId; the next prompt carries it.
  return chatHistory.currentSessionId();
}

// Switch the live agent to an existing session by id: point the session manager at
// that file and reload the agent's in-memory messages from it so the conversation
// continues with full context. Rejected while streaming.
async function switchToSession(id) {
  if (ctx.isStreaming) throw new Error("Cannot switch chat while the agent is responding");
  const currentId = chatHistory.currentSessionId();
  // ponytail: dsh has no in-memory message state to resync — switching the
  // session id is enough; the next prompt carries the new id, and chat-history
  // serves the sidebar's message list from SQLite.
  if (id !== currentId) ctx.session.sessionManager.setSessionId(id);
  // Read the resumed transcript from SQLite so session_loaded carries the real
  // turns into the view (dsh keeps no in-memory message state to resync).
  const sess = await chatHistory.getSession(id);
  return { id, title: sess?.title || "Chat", messages: sess?.messages || [] };
}

// ── Command + model/session helpers (used by the prompt dispatcher) ──────────

// The model list shown to clients. The profile generator's declared list IS the
// model list (no stock listModels RPC). Sourced once at initDshAgent from
// writeLlmProfile().
async function getAvailableModels() {
  return ctx.dshModels.map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider }));
}

// Refresh the model list at runtime (design D3 / spike 2). Re-runs writeLlmProfile
// so settings.yaml is rewritten; dsh-settings-file hot-reloads the
// llm-pi-ai: section and dsh-llm-pi-ai's onChange re-registers the adapter
// routes + model directory live (no restart). dshModels is updated from the
// fresh declared list and clients are told to refetch.
// ponytail: the active model is left as-is; a switch to a newly-appeared model
// still goes through switchModelTo (which restarts — the per-session model is an
// initialize arg, a genuine ceiling). This only refreshes the *selector*.
let dshProfileMod = null;
async function refreshDshModels() {
  if (!dshProfileMod) dshProfileMod = await import("../dsh-profile.js");
  const { models } = await dshProfileMod.writeLlmProfile();
  const before = ctx.dshModels.map((m) => m.id).join(",");
  ctx.dshModels = models;
  const after = ctx.dshModels.map((m) => m.id).join(",");
  if (before !== after) console.log(`[dsh] model list refreshed: ${after || "(none)"}`);
  ctx.broadcast({ type: "models", models: await getAvailableModels() });
  return ctx.dshModels.map((m) => ({ id: m.id, name: m.name || m.id, provider: m.provider }));
}

// Switch the active model by id, enforcing the streaming guard. Sends any error
// to the requesting client and returns true on success. Shared by the
// `set_model` WS handler and the `/model` command.
async function switchModelTo(id, ws) {
  if (ctx.isStreaming) {
    ws.send(JSON.stringify({ type: "error", message: "Cannot switch model while the agent is responding" }));
    return false;
  }
  // ponytail: no stock setModel RPC, so a live switch restarts the bridge with
  // the new provider/model baked into initialize. This drops the child's
  // in-memory session state (v1 ceiling); a non-disruptive switch needs a
  // custom dsh RPC. Unknown model → "Unknown model" error.
  const target = ctx.dshModels.find((m) => m.id === id);
  if (!target) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown model: ${id}` }));
    return false;
  }
  if (ctx.session?.model?.id === id) return true;
  try {
    await ctx.dshBridge.restart({ provider: target.provider, model: target.id });
    ctx.session.model = { id: target.id };
    ctx.defaultModel = { id: target.id, provider: target.provider, name: target.name || target.id };
    ctx.broadcast({ type: "model_changed", id });
    return true;
  } catch (err) {
    console.error("[dsh] model switch failed:", err.message);
    ws.send(JSON.stringify({ type: "error", message: err.message }));
    return false;
  }
}

// ── Catalog agent switching (mirrors the model-selection messages) ───────────

// Agents the agent switcher offers: the local dsh session plus visible
// chat-mode remote agents (link agents are external pages, not chat targets).
function switchableAgents(user) {
  return catalog
    .getCatalogFor(user ?? null)
    .agents.filter((a) => a.type === "agent-local" || (a.type === "agent-remote" && a.mode === "chat"));
}

// Switch the active catalog agent by id. Same contract as switchModelTo:
// rejected while streaming, errors go to the requesting client only.
function switchAgentTo(id, ws) {
  if (ctx.isStreaming) {
    ws.send(JSON.stringify({ type: "error", message: "Cannot switch agent while the agent is responding" }));
    return false;
  }
  const target = switchableAgents(ws.user).find((a) => a.id === id);
  if (!target) {
    ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${id}` }));
    return false;
  }
  if (id === ctx.currentAgentId) return true;
  ctx.currentAgentId = id;
  ctx.broadcast({ type: "agent_changed", id });
  return true;
}

// Fork a prompt to a remote OpenAI-compat endpoint: POST <baseUrl>/chat/completions
// with stream:true and translate SSE deltas into the existing text events, so the
// frontend renders remote agents exactly like the local one. v1 ceiling: remote
// turns are broadcast-only (no chat-history persistence) and one at a time — a
// prompt while a remote turn is streaming is rejected instead of steered.
async function streamRemoteChat(entry, text) {
  ctx.isStreaming = true; // set synchronously (same contract as the local prompt path)
  ctx.broadcast({ type: "agent_start" });
  // Persist the user turn to the SQLite mirror (design D6) — closes the v1
  // ceiling where remote turns were broadcast-only and a browser close/reopen
  // left a dangling user message with no reply.
  chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);
  let assistantText = "";
  try {
    const headers = { "Content-Type": "application/json" };
    if (entry.apiKey) headers.Authorization = `Bearer ${entry.apiKey}`;
    const r = await fetch(`${entry.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: entry.model, messages: [{ role: "user", content: text }], stream: true }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!r.ok) throw new Error(`${entry.id} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (payload === "[DONE]") continue;
        let delta;
        try {
          delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        } catch {
          continue; // ponytail: skip malformed SSE lines rather than kill the stream
        }
        if (delta) {
          assistantText += delta;
          ctx.broadcast({ type: "text", delta });
        }
      }
    }
  } catch (err) {
    console.error(`Remote agent '${entry.id}' error:`, err.message);
    ctx.broadcast({ type: "error", message: err.message });
  } finally {
    // Persist the assistant's final aggregated text (design D6).
    if (assistantText) chatHistory.recordMessage(chatHistory.currentSessionId(), "assistant", assistantText);
    ctx.finishTurn();
  }
}

// Handle `/model [id]`: with no id, report the current model + available models;
// with an id, switch (via switchModelTo) and emit a command_use block describing the result.
async function handleModelCommand(args, ws) {
  const id = (args || "").trim();
  const current = ctx.session?.model?.id || "(none)";
  if (!id) {
    const models = await getAvailableModels();
    const modelList = models.map((m) => `  ${m.id}${m.id === current ? " (active)" : ""}`).join("\n");
    ctx.broadcast({
      type: "command_use",
      name: "model",
      args: "",
      message: `Current model: ${current}\n\nAvailable models (${models.length}):\n${modelList}`,
    });
    return;
  }
  const ok = await switchModelTo(id, ws);
  ctx.broadcast({
    type: "command_use",
    name: "model",
    args: id,
    message: ok ? `Model switched to ${id}` : `Could not switch model to ${id}`,
  });
}

// Create a new session and broadcast the session_changed/session_loaded/sessions
// sequence. Shared by the `new_session` WS handler, the `/new` command, and the
// REST new-session route. Errors propagate to the caller.
async function startNewSession() {
  const id = await createNewSession();
  ctx.broadcast({ type: "session_changed", id });
  ctx.broadcast({ type: "session_loaded", id, title: "New chat", messages: [], workdir: null });
  const sessions = await chatHistory.listSessions();
  ctx.broadcast({ type: "sessions", sessions, current: id });
  return id;
}

// Handle `/new`: start a new session, then emit a command_use block (after the
// session_loaded clear so the block renders in the fresh chat).
async function handleNewCommand(ws) {
  try {
    await startNewSession();
    ctx.broadcast({ type: "command_use", name: "new", args: "", message: "Started a new chat" });
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", message: err.message }));
  }
}


  ctx.createNewSession = createNewSession;
  ctx.switchToSession = switchToSession;
  ctx.getAvailableModels = getAvailableModels;
  ctx.refreshDshModels = refreshDshModels;
  ctx.switchModelTo = switchModelTo;
  ctx.switchableAgents = switchableAgents;
  ctx.switchAgentTo = switchAgentTo;
  ctx.streamRemoteChat = streamRemoteChat;
  ctx.handleModelCommand = handleModelCommand;
  ctx.startNewSession = startNewSession;
  ctx.handleNewCommand = handleNewCommand;
}
