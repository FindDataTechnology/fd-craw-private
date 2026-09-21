// WebSocket layer: the upgrade gate (same forward-auth identity check as
// HTTP) and the connection handler with the full client message switch
// (prompt dispatch, models, agents, skills, cron, sessions).

import * as chatHistory from "../chat-history.js";
import * as cron from "../cron.js";
import * as catalog from "../catalog.js";
import * as skills from "./skills.js";
import { userFromHeaders } from "./auth.js";

export function authorizeUpgrade(ctx, req) {
  return ctx.authMode === "forward_auth"
    ? Boolean(userFromHeaders(req.headers, ctx.headerTrust))
    : ctx.authMode === "logto"
      ? Boolean(ctx.logtoAuth?.userFromCookie(req.headers.cookie))
      : true;
}

export function userForConnection(ctx, req) {
  return ctx.authMode === "forward_auth"
    ? userFromHeaders(req.headers, ctx.headerTrust)
    : ctx.authMode === "logto"
      ? ctx.logtoAuth?.userFromCookie(req.headers.cookie)
      : null;
}

export function attachWebSocket(ctx) {
  // noServer + manual handleUpgrade so WS upgrades pass the same forward-auth
  // gate as HTTP requests (missing identity ⇒ handshake rejected with 401).
  ctx.server.on("upgrade", (req, socket, head) => {
    if (!authorizeUpgrade(ctx, req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    ctx.wss.handleUpgrade(req, socket, head, (ws) => ctx.wss.emit("connection", ws, req));
  });

// ── WebSocket handling ───────────────────────────────────────────────────────

const sendIfOpen = (ws, payload) => {
  if (ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
};

const syncPermissionState = async (ws) => {
  const { options, current } = await ctx.getPermissionPresets();
  sendIfOpen(ws, { type: "permissions", options, current });
};

// Sync a client that connected mid-boot with everything the normal connect
// path sends, once the dsh agent is live (the "ready" broadcast's payload).
const syncReadyClient = async (ws) => {
  const version = ctx.sessionVersion;
  if (!sendIfOpen(ws, { type: "ready" })) return;
  if (!sendIfOpen(ws, { type: "current_model", id: ctx.runtimeModel?.id || ctx.session?.model?.id || null, effort: ctx.currentEffort })) return;
  if (!sendIfOpen(ws, { type: "current_agent", id: ctx.currentAgentId })) return;
  if (!sendIfOpen(ws, { type: "agents", agents: ctx.switchableAgents(ws.user) })) return;
  if (ws.identity) ctx.sendUserBindings?.(ws, ws.identity.email);

  const models = await ctx.getAvailableModels();
  if (!sendIfOpen(ws, { type: "models", models })) return;
  if (!sendIfOpen(ws, { type: "current_preset", id: ctx.currentPreset })) return;
  // Permission state: the roster arrives on the client's list_permissions
  // request (bridge round-trip), but the current value is pushed here so a
  // late-connecting client immediately agrees with any switch another client
  // already made.
  if (ctx.currentPermission) sendIfOpen(ws, { type: "current_permission", name: ctx.currentPermission });
  await syncPermissionState(ws);
  if (ws.readyState !== ws.OPEN) return;
  // The live plan (add-plan-progress-panel): pushed after a mid-boot connect
  // completes so the client agrees with the running session before any turn.
  if (!sendIfOpen(ws, ctx.planMessage(ctx.dshSessionId))) return;

  const sessions = await chatHistory.listSessions();
  if (version !== ctx.sessionVersion) return;
  sendIfOpen(ws, { type: "sessions", sessions, current: chatHistory.currentSessionId() });
};

ctx.wss.on("connection", (ws, req) => {
  // Identity is fixed at upgrade time (v1 ceiling: no re-auth mid-connection).
  ws.user = userForConnection(ctx, req);
  ws.identity = ctx.authEnabled ? ws.user : (ctx.ssoEnabled ? userFromHeaders(req.headers, ctx.headerTrust) : null);
  ctx.clients.add(ws);
  console.log(`Client connected (${ctx.clients.size} total)`);

  // Mid-boot connections learn the agent is still initializing; the ready
  // broadcast re-syncs them with models/sessions once the dsh agent is live.
  if (!ctx.ready.dsh) ws.send(JSON.stringify({ type: "initializing" }));
  // Tell the client which model is currently active so the dropdown can sync.
  const currentModelId = ctx.runtimeModel?.id || ctx.session?.model?.id || null;
  ws.send(JSON.stringify({ type: "current_model", id: currentModelId, effort: ctx.currentEffort }));
  // Sync the agent switcher: active catalog agent + switchable agent list.
  ws.send(JSON.stringify({ type: "current_agent", id: ctx.currentAgentId }));
  ws.send(JSON.stringify({ type: "agents", agents: ctx.switchableAgents(ws.user) }));
  if (ws.identity) ctx.sendUserBindings?.(ws, ws.identity.email);
  // Sync the agent-mode selection so the welcome picker can mark it.
  ws.send(JSON.stringify({ type: "current_preset", id: ctx.currentPreset }));
  // The live plan for the current session (add-plan-progress-panel). Sent
  // unconditionally — a session with no plan sends the empty list, which the
  // client treats as "hide the surface" rather than as a stale snapshot.
  ws.send(JSON.stringify(ctx.planMessage(ctx.dshSessionId)));
  if (ctx.ready.dsh) {
    void syncPermissionState(ws).catch((e) =>
      console.warn(`[chat-history] permission sync on connect failed: ${e.message}`)
    );
  }
  // Send the chat session list + current session so the sidebar syncs on connect.
  if (ctx.session) {
    const version = ctx.sessionVersion;
    chatHistory
      .listSessions()
      .then((sessions) => {
        if (version !== ctx.sessionVersion) return;
        sendIfOpen(ws, { type: "sessions", sessions, current: chatHistory.currentSessionId() });
      })
      .catch((e) => console.error("[chat-history] list on connect failed:", e.message));
  }
  // Send initial dashboard state on connect
  ws.send(JSON.stringify({ type: "dashboard_update", state: cron.getDashboardState() }));


  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    switch (data.type) {
      case "prompt": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const text = data.text?.trim();
        if (!text) return;

        // Parse a leading slash-command (/skill, /model, /new, …) if present.
        const cmd = skills.parseCommand(text);

        if (cmd && cmd.command === "skill") {
          if (ctx.isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }
          // Set in-flight synchronously (before the first await) so a concurrent
          // prompt is rejected. agent_start sets it again later (idempotent).
          ctx.isStreaming = true;
          try {
            // Skill invocation: emit a skill_use block and suppress the raw
            // /skill:... text from being echoed as a normal user message.
            ctx.broadcast({ type: "skill_use", name: cmd.name, args: cmd.args });
            // Mirror the user's skill invocation into the SQLite project database.
            chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);

            // Manually expand the skill content and send that to the agent. This
            // does not rely on session.prompt() expanding slash commands.
            // Scan the skills/ dir (same dir the skill-filesystem plugin's
            // customSkillDirs points at, Task 5.3).
            const fileSkills = skills.getFileSkills();
            const skill = fileSkills.find((s) => s.name === cmd.name);
            let promptText = text;
            if (skill) {
              promptText = await skills.expandSkillContent(skill, cmd.args);
            }
            // Expand @doc:<id> attachment references (design D4).
            promptText = await skills.expandDocRefs(ctx, promptText);
            await ctx.session.prompt(promptText);
          } catch (err) {
            console.error("Agent error:", err.message);
            ctx.broadcast({ type: "error", message: err.message });
            // Finish the turn (reset streaming, emit done, refresh sessions) so a
            // failed turn does not wedge the UI or block model-switch/new-session.
            ctx.finishTurn();
          }
        } else if (cmd && cmd.command === "model") {
          await ctx.handleModelCommand(cmd.args, ws);
        } else if (cmd && cmd.command === "new") {
          await ctx.handleNewCommand(ws);
        } else if (cmd && (cmd.command === "clear" || cmd.command === "help")) {
          // Client-handled commands; the UI should not forward them. Ignore.
          return;
        } else {
          // Normal prompt (includes unknown "/…" commands that fall through):
          // echo the user message and forward.
          if (ctx.isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }
          const entry =
            ctx.currentAgentId !== "local" ? catalog.getAgentEntry(ctx.currentAgentId) : null;
          if (ctx.currentAgentId !== "local" && !entry) {
            ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${ctx.currentAgentId}` }));
            break;
          }

          // No steer mechanism through the bridge; reject concurrent prompts
          // host-side (Task 2.7) rather than queueing a second turn. Set the
          // guard before the first await so a concurrent prompt cannot enter.
          ctx.isStreaming = true;
          try {
            ctx.broadcast({ type: "user", text });

            if (entry) {
              // Remote-agent fork: expand refs before streaming from its
              // OpenAI-compatible endpoint instead of the local session.
              const promptText = await skills.expandDocRefs(ctx, text);
              await ctx.streamRemoteChat(entry, promptText);
            } else {
              // Mirror the user prompt into the SQLite project database.
              chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);
              // Expand @doc:<id> attachment references into the document content the
              // agent sees (design D4); the user message above keeps the raw refs.
              const promptWithDocs = await skills.expandDocRefs(ctx, text);
              await ctx.session.prompt(promptWithDocs);
            }
          } catch (err) {
            console.error("Agent error:", err.message);
            ctx.broadcast({ type: "error", message: err.message });
            // Finish the turn (reset streaming, emit done, refresh sessions) so a
            // failed turn does not wedge the UI or block model-switch/new-session.
            ctx.finishTurn();
          }
        }
        break;
      }

      case "list_bindings": {
        if (!ws.identity) {
          ws.send(JSON.stringify({ type: "user_bindings", model: null, mcp: [] }));
          break;
        }
        ctx.sendUserBindings?.(ws, ws.identity.email);
        break;
      }

      case "list_models": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const models = await ctx.getAvailableModels();
        ws.send(JSON.stringify({ type: "models", models }));
        break;
      }

      case "set_model": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // No run is open for a select-control switch, so a failure reaches the
        // client as an orphan error — it renders as a toast, which is the
        // right weight for a transient control action.
        const r = await ctx.switchModelTo(data.id);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "set_effort": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const r = await ctx.switchEffortTo(data.effort || null);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_presets": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const presets = await ctx.getAgentPresets();
        ws.send(JSON.stringify({ type: "presets", presets, current: ctx.currentPreset }));
        break;
      }

      case "set_preset": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // Same contract as set_model: a failure is an orphan error → renders
        // as a toast, and the previous preset stays reported as current.
        const r = await ctx.switchPresetTo(data.id);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_permissions": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const { options, current } = await ctx.getPermissionPresets();
        ws.send(JSON.stringify({ type: "permissions", options, current }));
        break;
      }

      case "set_permission": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        // Live in-session switch — no restart, no pending window. A failure
        // (streaming guard, unknown name, bridge error) is an orphan error →
        // renders as a toast; the previous preset stays reported as current.
        const r = await ctx.switchPermissionTo(data.name);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_workspaces": {
        ws.send(JSON.stringify({ type: "workspaces", ...ctx.listWorkspaces() }));
        break;
      }

      case "set_workspace": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        const r = await ctx.switchWorkspaceTo(data.path);
        if (!r.ok && r.error) ws.send(JSON.stringify({ type: "error", message: r.error }));
        break;
      }

      case "list_agents": {
        ws.send(JSON.stringify({ type: "agents", agents: ctx.switchableAgents(ws.user) }));
        break;
      }

      case "set_agent": {
        ctx.switchAgentTo(data.id, ws);
        break;
      }

      case "list_skills": {
        const COMPUTER_USE_ENABLED = process.env.ENABLE_COMPUTER_USE === "true";
        const fileSkills = skills.getFileSkills()
          .filter((s) => {
            if (!COMPUTER_USE_ENABLED && s.name.startsWith("computer-")) {
              return false;
            }
            return true;
          })
          .map((s) => ({
            name: s.name,
            description: s.description,
          }));
        ws.send(JSON.stringify({ type: "skills", skills: fileSkills }));
        break;
      }

      case "cron_add": {
        try {
          const job = await cron.addJob({ cron: data.cron, when: data.when, prompt: data.prompt });
          ws.send(JSON.stringify({ type: "cron_added", job }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_remove": {
        try {
          const removed = await cron.removeJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_removed", jobId: data.jobId, success: removed }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_pause": {
        try {
          const paused = await cron.pauseJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_paused", jobId: data.jobId, success: paused }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_resume": {
        try {
          const resumed = await cron.resumeJob(data.jobId);
          ws.send(JSON.stringify({ type: "cron_resumed", jobId: data.jobId, success: resumed }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "cron_list": {
        ws.send(JSON.stringify({ type: "cron_jobs", jobs: cron.listJobs() }));
        break;
      }

      case "cron_run": {
        try {
          const ran = await cron.runJobNow(data.jobId);
          ws.send(JSON.stringify({ type: "cron_run_started", jobId: data.jobId, success: ran }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "dashboard_state": {
        ws.send(JSON.stringify({ type: "dashboard_state", state: cron.getDashboardState() }));
        break;
      }

      case "list_sessions": {
        const version = ctx.sessionVersion;
        const sessions = await chatHistory.listSessions();
        if (version === ctx.sessionVersion) {
          ws.send(
            JSON.stringify({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
          );
        }
        break;
      }

      case "new_session": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        try {
          await ctx.startNewSession();
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "switch_session": {
        if (!ctx.ready.dsh) {
          ws.send(JSON.stringify({ type: "error", message: "Agent is still initializing" }));
          break;
        }
        try {
          const result = await ctx.switchToSession(data.id);
          ctx.broadcast({
            type: "session_loaded",
            id: result.id,
            title: result.title,
            messages: result.messages,
          });
          // The target session's own plan (or the empty list). The client clears
          // the plan on session_loaded; this push is what restores it when the
          // user switches back to a session that had one (add-plan-progress-panel).
          ctx.broadcast(ctx.planMessage(result.id));
          ctx.broadcast({ type: "session_changed", id: result.id });
          const version = ctx.sessionVersion;
          const sessions = await chatHistory.listSessions();
          if (version === ctx.sessionVersion) {
            ctx.broadcast({ type: "sessions", sessions, current: result.id });
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "rename_session": {
        try {
          const title = chatHistory.setTitle(data.id, data.title);
          ctx.broadcast({ type: "session_renamed", id: data.id, title });
        } catch (err) {
          if (err?.code) {
            ws.send(JSON.stringify({ type: "rename_session_error", code: err.code, message: err.message }));
          } else {
            ws.send(JSON.stringify({ type: "error", message: err.message }));
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    ctx.clients.delete(ws);
    console.log(`Client disconnected (${ctx.clients.size} total)`);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
    ctx.clients.delete(ws);
  });
});

// Called by the composition root when the dsh agent finishes initializing:
// every connected client gets the ready event + the connect-time payloads.
ctx.onDshReady = () => {
  for (const ws of ctx.clients) void syncReadyClient(ws);
};
}
