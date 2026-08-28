// WebSocket layer: the upgrade gate (same forward-auth identity check as
// HTTP) and the connection handler with the full client message switch
// (prompt dispatch, models, agents, skills, cron, sessions).

import * as chatHistory from "../chat-history.js";
import * as cron from "../cron.js";
import * as catalog from "../catalog.js";
import * as skills from "./skills.js";
import { userFromHeaders } from "./auth.js";

export function attachWebSocket(ctx) {
  // noServer + manual handleUpgrade so WS upgrades pass the same forward-auth
  // gate as HTTP requests (missing identity ⇒ handshake rejected with 401).
  ctx.server.on("upgrade", (req, socket, head) => {
    if (ctx.authEnabled && !userFromHeaders(req.headers)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    ctx.wss.handleUpgrade(req, socket, head, (ws) => ctx.wss.emit("connection", ws, req));
  });

// ── WebSocket handling ───────────────────────────────────────────────────────

ctx.wss.on("connection", (ws, req) => {
  // Identity is fixed at upgrade time (v1 ceiling: no re-auth mid-connection).
  ws.user = ctx.authEnabled ? userFromHeaders(req.headers) : null;
  ctx.clients.add(ws);
  console.log(`Client connected (${ctx.clients.size} total)`);

  // Tell the client which model is currently active so the dropdown can sync.
  const currentModelId = ctx.session?.model?.id || null;
  ws.send(JSON.stringify({ type: "current_model", id: currentModelId }));
  // Sync the agent switcher: active catalog agent + switchable agent list.
  ws.send(JSON.stringify({ type: "current_agent", id: ctx.currentAgentId }));
  ws.send(JSON.stringify({ type: "agents", agents: ctx.switchableAgents(ws.user) }));
  // Send the chat session list + current session so the sidebar syncs on connect.
  if (ctx.session) {
    chatHistory
      .listSessions()
      .then((sessions) =>
        ws.send(
          JSON.stringify({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
        )
      )
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
        const text = data.text?.trim();
        if (!text) return;

        // Parse a leading slash-command (/skill, /model, /new, …) if present.
        const cmd = skills.parseCommand(text);

        if (cmd && cmd.command === "skill") {
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
            try {
              promptText = await skills.expandSkillContent(skill, cmd.args);
            } catch (err) {
              console.warn(`[skill] Failed to expand "${cmd.name}": ${err.message}`);
            }
          }
          // Expand @doc:<id> attachment references (design D4).
          promptText = await skills.expandDocRefs(ctx, promptText);

          // No steer mechanism through the bridge; reject concurrent prompts
          // host-side (Task 2.7) rather than queueing a second turn.
          if (ctx.isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }

          // Set in-flight synchronously (before the first await) so a concurrent
          // prompt is rejected. agent_start sets it again later (idempotent).
          ctx.isStreaming = true;
          try {
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
          ctx.broadcast({ type: "user", text });

          // Remote-agent fork: when a chat-mode catalog agent is active, stream
          // from its OpenAI-compat endpoint instead of the local session. The
          // user message is echoed above; streamRemoteChat persists both the
          // user and assistant turns to chat-history (design D6).
          if (ctx.currentAgentId !== "local") {
            if (ctx.isStreaming) {
              ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
              break;
            }
            const entry = catalog.getAgentEntry(ctx.currentAgentId);
            if (!entry) {
              // Catalog changed under us (entry removed / no longer visible).
              ws.send(JSON.stringify({ type: "error", message: `Unknown agent: ${ctx.currentAgentId}` }));
              break;
            }
            // Expand @doc:<id> attachment references for the remote agent too.
            await ctx.streamRemoteChat(entry, await skills.expandDocRefs(ctx, text));
            break;
          }

          // No steer mechanism through the bridge; reject concurrent prompts
          // host-side (Task 2.7) rather than queueing a second turn.
          if (ctx.isStreaming) {
            ws.send(JSON.stringify({ type: "error", message: "The agent is still responding" }));
            break;
          }

          // Mirror the user prompt into the SQLite project database.
          chatHistory.recordMessage(chatHistory.currentSessionId(), "user", text);

          // Set in-flight synchronously (before the first await) so a concurrent
          // prompt is rejected. agent_start sets it again later (idempotent).
          ctx.isStreaming = true;
          // Expand @doc:<id> attachment references into the document content the
          // agent sees (design D4); the user message above keeps the raw refs.
          const promptWithDocs = await skills.expandDocRefs(ctx, text);
          try {
            await ctx.session.prompt(promptWithDocs);
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

      case "list_models": {
        const models = await ctx.getAvailableModels();
        ws.send(JSON.stringify({ type: "models", models }));
        break;
      }

      case "set_model": {
        await ctx.switchModelTo(data.id, ws);
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
        const sessions = await chatHistory.listSessions();
        ws.send(
          JSON.stringify({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
        );
        break;
      }

      case "new_session": {
        try {
          await ctx.startNewSession();
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
        break;
      }

      case "switch_session": {
        try {
          const result = await ctx.switchToSession(data.id);
          ctx.broadcast({
            type: "session_loaded",
            id: result.id,
            title: result.title,
            messages: result.messages,
          });
          ctx.broadcast({ type: "session_changed", id: result.id });
          const sessions = await chatHistory.listSessions();
          ctx.broadcast({ type: "sessions", sessions, current: result.id });
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







}
