// Agent-session state machine: session create/switch, model list/refresh/
// switch, catalog-agent switch, remote-agent streaming, and the /model + /new
// command handlers. Attached onto ctx by attachAgentSession; ws.js and the
// chat-history routes consume them through ctx.

import * as chatHistory from "../chat-history.js";
import * as catalog from "../catalog.js";
import path from "node:path";
import fs, { constants as fsConstants } from "node:fs/promises";

// Resolve and vet a client-supplied workspace path. Symlinks are resolved
// FIRST so the thing we validate is the thing we hand to dsh — validating the
// link and spawning in the target is how a check gets bypassed.
//
// Deliberately not an allowlist: the server already runs with the user's full
// filesystem access and the agent's tools are unconstrained, so gating the
// picker alone would be theatre. Real sandboxing belongs with tool permissions.
export async function validateWorkspace(input) {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "Workspace path is required" };
  }
  const raw = input.trim();
  if (!path.isAbsolute(raw)) {
    return { ok: false, error: "Workspace path must be absolute" };
  }
  let resolved;
  try {
    resolved = await fs.realpath(raw);
  } catch (err) {
    return {
      ok: false,
      error: err.code === "ENOENT" ? `No such directory: ${raw}` : `Cannot read ${raw}: ${err.message}`,
    };
  }
  try {
    const st = await fs.stat(resolved);
    if (!st.isDirectory()) return { ok: false, error: `Not a directory: ${raw}` };
    await fs.access(resolved, fsConstants.R_OK | fsConstants.X_OK);
  } catch {
    return { ok: false, error: `Directory is not readable: ${raw}` };
  }
  return { ok: true, path: resolved };
}

export function attachAgentSession(ctx) {

function bumpSessionVersion() {
  ctx.sessionVersion = (ctx.sessionVersion || 0) + 1;
}

// Start a new chat session: create a fresh SDK session and reset the agent's
// in-memory messages. Rejected while streaming to avoid switching mid-turn.
async function createNewSession() {
  if (ctx.isStreaming) throw new Error("Cannot start a new chat while the agent is responding");
  ctx.session.sessionManager.newSession();
  const id = chatHistory.currentSessionId();
  chatHistory.createSession(id);
  bumpSessionVersion();
  // ponytail: dsh has no in-memory message state to reset — newSession() (shim)
  // already minted a fresh dshSessionId; the next prompt carries it.
  return id;
}

// Switch the live agent to an existing session by id: point the session manager at
// that file and reload the agent's in-memory messages from it so the conversation
// continues with full context. Rejected while streaming.
async function switchToSession(id) {
  if (ctx.isStreaming) throw new Error("Cannot switch chat while the agent is responding");
  const currentId = chatHistory.currentSessionId();
  if (id === currentId) {
    const sess = await chatHistory.getSession(id);
    return { id, title: sess?.title || "Chat", messages: sess?.messages || [] };
  }

  // Validate the target before changing the live session. dsh has no in-memory
  // message state to resync; switching the id is enough once SQLite confirms it.
  const version = ctx.sessionVersion;
  const sess = await chatHistory.getSession(id);
  if (ctx.sessionVersion !== version) throw new Error("Session changed while loading");
  if (!sess) throw new Error(`session ${id} not found`);
  ctx.session.sessionManager.setSessionId(id);
  bumpSessionVersion();
  return { id, title: sess.title || "Chat", messages: sess.messages || [] };
}

// ── Command + model/session helpers (used by the prompt dispatcher) ──────────

// The model list shown to clients. The profile generator's declared list IS the
// model list (no stock listModels RPC). Sourced once at initDshAgent from
// writeLlmProfile().
async function getAvailableModels() {
  return ctx.dshModels.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider: m.provider,
    ...(m.reasoningEfforts?.length ? { reasoningEfforts: m.reasoningEfforts } : {}),
  }));
}

// The thinking levels the given model declares (empty = no control for it).
function effortsForModel(id) {
  return ctx.dshModels.find((m) => m.id === id)?.reasoningEfforts || [];
}

// Persist a provider's thinking level (null clears it) and reproject the dsh
// profile. The prefs row is the source of truth; settings.yaml is the projection
// writeLlmProfile() rebuilds on every boot (design D3).
function persistEffort(provider, effort) {
  ctx.db.setPreference(`llm.effort.${provider}`, effort || "");
}

// Switch the active thinking level. dsh has no effort RPC — the generated
// settings.yaml IS the transport, so applying it is the same restart path as a
// model switch (design D1). Returns { ok, error? } like switchModelTo.
async function switchEffortToInner(effort) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot change the thinking level while the agent is responding" };
  }
  const modelId = ctx.session?.model?.id;
  const provider = ctx.session?.model?.provider || ctx.defaultModel?.provider;
  if (!modelId || !provider) return { ok: false, error: "No active model" };
  const allowed = effortsForModel(modelId);
  // null/"" = back to the provider default, always allowed.
  if (effort && !allowed.includes(effort)) {
    return { ok: false, error: `Model ${modelId} does not support thinking level "${effort}"` };
  }
  if ((ctx.currentEffort || null) === (effort || null)) return { ok: true };
  const level = effort || null;
  try {
    persistEffort(provider, level);
    if (!dshProfileMod) dshProfileMod = await import("../dsh-profile.js");
    await dshProfileMod.writeLlmProfile();
    await ctx.dshBridge.restart({ provider, model: modelId });
    ctx.currentEffort = level;
    ctx.broadcast({ type: "effort_changed", effort: level });
    return { ok: true };
  } catch (err) {
    console.error("[dsh] thinking-level switch failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function switchEffortTo(effort) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchEffortToInner(effort));
  }
  return switchEffortToInner(effort);
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

// Switch the active model by id, enforcing the streaming guard. Returns
// { ok, error? } — callers decide how to surface a failure: `/model` emits the
// command_use block FIRST so the error attaches to that turn, while `set_model`
// sends it bare (the client shows it as a toast: no run is open). Shared by
// the `set_model` WS handler and the `/model` command.
async function switchModelToInner(id) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot switch model while the agent is responding" };
  }
  // ponytail: no stock setModel RPC, so a live switch restarts the bridge with
  // the new provider/model baked into initialize. This drops the child's
  // in-memory session state (v1 ceiling); a non-disruptive switch needs a
  // custom dsh RPC. Unknown model → "Unknown model" error.
  const target = ctx.dshModels.find((m) => m.id === id);
  if (!target) {
    return { ok: false, error: `Unknown model: ${id}` };
  }
  if (ctx.session?.model?.id === id) return { ok: true };
  // The persisted effort belongs to a provider, but the offered set is the new
  // model's. An incompatible level falls back to the provider default rather
  // than reaching dispatch as UNSUPPORTED_REASONING_EFFORT.
  const carried = ctx.db.getPreference(`llm.effort.${target.provider}`) || null;
  const effort = carried && (target.reasoningEfforts || []).includes(carried) ? carried : null;
  if (carried && !effort) persistEffort(target.provider, null);
  try {
    if (effort !== ctx.currentEffort) {
      if (!dshProfileMod) dshProfileMod = await import("../dsh-profile.js");
      await dshProfileMod.writeLlmProfile();
    }
    await ctx.dshBridge.restart({ provider: target.provider, model: target.id });
    ctx.session.model = { id: target.id };
    ctx.defaultModel = { id: target.id, provider: target.provider, name: target.name || target.id };
    // Keep the effective runtime model in step: ws.js reports current_model and
    // runtime-bindings broadcasts runtime_binding from it, so an explicit switch
    // that left it stale would make both name the previous model.
    ctx.runtimeModel = { id: target.id, provider: target.provider, name: target.name || target.id };
    ctx.currentEffort = effort;
    ctx.broadcast({ type: "model_changed", id, effort });
    return { ok: true };
  } catch (err) {
    console.error("[dsh] model switch failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function switchModelTo(id) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchModelToInner(id));
  }
  return switchModelToInner(id);
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
  const result = await switchModelTo(id);
  ctx.broadcast({
    type: "command_use",
    name: "model",
    args: id,
    message: result.ok ? `Model switched to ${id}` : `Could not switch model to ${id}`,
  });
  // After the command_use block opens the turn, send the failure detail so it
  // renders as an in-turn error block (an error sent BEFORE the block would be
  // an orphan — the client would toast it and the transcript would lose it).
  if (!result.ok && result.error) {
    ws.send(JSON.stringify({ type: "error", message: result.error }));
  }
}

// Create a new session and broadcast the session_changed/session_loaded/sessions
// sequence. Shared by the `new_session` WS handler, the `/new` command, and the
// REST new-session route. Errors propagate to the caller.
async function startNewSession() {
  const id = await createNewSession();
  ctx.broadcast({ type: "session_changed", id });
  ctx.broadcast({ type: "session_loaded", id, title: "New chat", messages: [], workdir: null });
  const version = ctx.sessionVersion;
  const sessions = await chatHistory.listSessions();
  if (version === ctx.sessionVersion) {
    ctx.broadcast({ type: "sessions", sessions, current: id });
  }
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


// ── Agent preset (agent mode) ────────────────────────────────────────────────

// The preset roster the running dsh child composes, via the bridge's
// `presets/list` (cached per child generation inside the bridge). Null roster
// → empty list: the picker renders nothing and switching rejects. Also kept
// on ctx.presetRoster so connect-time syncs never re-query.
async function getAgentPresets() {
  if (!ctx.dshBridge?.isReady?.()) return [];
  try {
    const presets = await ctx.dshBridge.listPresets();
    ctx.presetRoster = Array.isArray(presets) ? presets : [];
    return ctx.presetRoster;
  } catch (err) {
    console.warn("[dsh] presets/list failed:", err.message);
    return ctx.presetRoster || [];
  }
}

// Switch the selected agent preset. dsh composes a session's capabilities from
// its preset at creation and refuses to recompose a session that has produced
// turns, so — exactly like a model or workspace switch, which share the same
// constraint — applying a choice means restarting the child with the preset
// baked into `initialize`; it then applies to the next (blank) session. The
// streaming guard matches set_model. Returns { ok, error? }.
async function switchPresetToInner(id) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot change the agent mode while the agent is responding" };
  }
  if (id === ctx.currentPreset) return { ok: true };
  const roster = await getAgentPresets();
  if (!roster.length) {
    return { ok: false, error: "No agent modes are available in this deployment" };
  }
  const target = roster.find((p) => p.id === id);
  if (!target) {
    return { ok: false, error: `Unknown agent mode: ${id}` };
  }
  if (target.broken) {
    return { ok: false, error: `Agent mode "${id}" is unavailable: ${target.broken}` };
  }
  try {
    await ctx.dshBridge.restart({ agentPreset: id });
    // Restart succeeded — the choice is now the deployment default. Persisted
    // AFTER the restart so a failed restart leaves the previous preference
    // (still reported as current) untouched.
    ctx.db.setPreference("agent.preset", id);
    ctx.currentPreset = id;
    ctx.broadcast({ type: "current_preset", id });
    return { ok: true };
  } catch (err) {
    console.error("[dsh] preset switch failed:", err.message);
    return { ok: false, error: err.message };
  }
}

async function switchPresetTo(id) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchPresetToInner(id));
  }
  return switchPresetToInner(id);
}

// ── Permission preset (sandbox + approval mode) ──────────────────────────────

// The composed permission preset table via the bridge's `permissions/list` —
// roster options with client labels plus the session's effective preset (the
// deployment default until a session pins one). NOT cached: the payload's
// `current` is live state, and calls are rare, user-triggered refreshes.
// Returns { options, current }; empty options = no permission service
// composed → the strip control stays hidden.
async function getPermissionPresets() {
  if (!ctx.dshBridge?.isReady?.()) return { options: [], current: ctx.currentPermission };
  try {
    const r = await ctx.dshBridge.listPermissionPresets(ctx.dshSessionId);
    ctx.permissionOptions = Array.isArray(r?.options) ? r.options : [];
    if (r?.current) ctx.currentPermission = r.current;
    return { options: ctx.permissionOptions, current: ctx.currentPermission };
  } catch (err) {
    console.warn("[dsh] permissions/list failed:", err.message);
    return { options: ctx.permissionOptions, current: ctx.currentPermission };
  }
}

// Switch the LIVE session's permission preset. Deliberately unlike
// set_model/set_workspace/set_preset: no child restart — the runtime appends
// a durable permission/preset session event and rewrites its sandbox/approval
// knobs in place. The streaming guard matches set_model (a loosening must
// never interleave with a turn it was not visible to). Returns { ok, error? }.
async function switchPermissionTo(name) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot change the permission mode while the agent is responding" };
  }
  if (name === ctx.currentPermission) return { ok: true };
  const { options } = await getPermissionPresets();
  if (!options.length) {
    return { ok: false, error: "No permission modes are available in this deployment" };
  }
  if (!options.some((o) => o.name === name)) {
    return { ok: false, error: `Unknown permission mode: ${name}` };
  }
  try {
    const r = await ctx.dshBridge.setPermissionPreset(ctx.dshSessionId, name);
    ctx.currentPermission = r?.current ?? name;
    ctx.broadcast({ type: "current_permission", name: ctx.currentPermission });
    return { ok: true };
  } catch (err) {
    console.error("[dsh] permission switch failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Workspace (dsh cwd) ─────────────────────────────────────────────────────

const WORKSPACE_RECENTS_KEY = "workspace.recents";
const WORKSPACE_RECENTS_MAX = 8;

function readRecents() {
  try {
    const raw = ctx.db.getPreference(WORKSPACE_RECENTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    // A corrupt prefs row must not brick the composer — start the list over.
    return [];
  }
}

function pushRecent(dir) {
  const next = [dir, ...readRecents().filter((p) => p !== dir)].slice(0, WORKSPACE_RECENTS_MAX);
  ctx.db.setPreference(WORKSPACE_RECENTS_KEY, JSON.stringify(next));
  return next;
}

function currentWorkspace() {
  return ctx.dshBridge?.getCwd?.() || process.cwd();
}

// Switch the dsh runtime's working directory. `cwd` is fixed in the initialize
// handshake with no RPC to change it, so this is the same restart path as a
// model or thinking-level switch. Returns { ok, error? }.
async function switchWorkspaceToInner(input) {
  if (ctx.isStreaming) {
    return { ok: false, error: "Cannot change the workspace while the agent is responding" };
  }
  const v = await validateWorkspace(input);
  // A bad path must not cost a restart, and must not half-switch the runtime.
  if (!v.ok) return v;
  const previous = currentWorkspace();
  if (v.path === previous) return { ok: true };
  try {
    await ctx.dshBridge.restart({ cwd: v.path });
  } catch (err) {
    console.error("[dsh] workspace switch failed:", err.message);
    // Best-effort return to the directory that was known to work; if that also
    // fails the bridge's own backoff ladder owns recovery from here.
    try {
      await ctx.dshBridge.restart({ cwd: previous });
    } catch (restoreErr) {
      console.error("[dsh] workspace restore failed:", restoreErr.message);
    }
    return { ok: false, error: `Could not start the agent in ${v.path}: ${err.message}` };
  }
  pushRecent(v.path);
  ctx.broadcast({ type: "workspace_changed", path: v.path });
  return { ok: true };
}

async function switchWorkspaceTo(input) {
  if (ctx.runExclusiveRuntimeMutation) {
    return ctx.runExclusiveRuntimeMutation(() => switchWorkspaceToInner(input));
  }
  return switchWorkspaceToInner(input);
}

function listWorkspaces() {
  const current = currentWorkspace();
  return { current, recents: [current, ...readRecents().filter((p) => p !== current)] };
}

  ctx.createNewSession = createNewSession;
  ctx.switchToSession = switchToSession;
  ctx.getAvailableModels = getAvailableModels;
  ctx.refreshDshModels = refreshDshModels;
  ctx.switchModelTo = switchModelTo;
  ctx.switchEffortTo = switchEffortTo;
  ctx.effortsForModel = effortsForModel;
  ctx.switchableAgents = switchableAgents;
  ctx.switchAgentTo = switchAgentTo;
  ctx.streamRemoteChat = streamRemoteChat;
  ctx.handleModelCommand = handleModelCommand;
  ctx.startNewSession = startNewSession;
  ctx.handleNewCommand = handleNewCommand;
  ctx.switchWorkspaceTo = switchWorkspaceTo;
  ctx.listWorkspaces = listWorkspaces;
  ctx.getAgentPresets = getAgentPresets;
  ctx.switchPresetTo = switchPresetTo;
  ctx.getPermissionPresets = getPermissionPresets;
  ctx.switchPermissionTo = switchPermissionTo;
}
