// Chat history endpoints. Sessions are persisted to SQLite; the UI lists and
// views them read-only.

import express from "express";

export function registerChatHistoryRoutes(ctx) {
  const { app, chatHistory, broadcast } = ctx;

  app.get("/api/chat-history/sessions", async (_req, res) => {
    try {
      res.json({ sessions: await chatHistory.listSessions(), current: chatHistory.currentSessionId() });
    } catch (err) {
      console.error("[chat-history] list error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/chat-history/sessions/:id", async (req, res) => {
    try {
      const sess = await chatHistory.getSession(req.params.id);
      if (!sess) return res.status(404).json({ error: "Not found" });
      res.json(sess);
    } catch (err) {
      console.error("[chat-history] get error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/chat-history/sessions", async (_req, res) => {
    try {
      const id = await ctx.startNewSession();
      res.json({ id });
    } catch (err) {
      console.error("[chat-history] new error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Hard-delete a session by id. 409 if the id is the currently-active session
  // (caller must switch first). 404 if the id does not exist. On success, the
  // refreshed `sessions` list is broadcast to all WS clients so the sidebar row
  // disappears without a manual refetch.
  app.delete("/api/chat-history/sessions/:id", async (req, res) => {
    const { id } = req.params;
    try {
      await chatHistory.deleteSession(id);
      res.json({ ok: true });
      chatHistory
        .listSessions()
        .then((sessions) =>
          broadcast({ type: "sessions", sessions, current: chatHistory.currentSessionId() })
        )
        .catch((e) => console.error("[chat-history] list after delete failed:", e.message));
    } catch (err) {
      if (err?.code === "active") return res.status(409).json({ error: err.message });
      if (err?.code === "not_found") return res.status(404).json({ error: err.message });
      console.error("[chat-history] delete error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Rename a session's title. 400 on validation (empty / overlong / control
  // chars); 404 if the id is unknown. Broadcasts a `session_renamed` event to
  // all WS clients so every open UI updates in lockstep.
  app.patch("/api/chat-history/sessions/:id", express.json(), async (req, res) => {
    const { id } = req.params;
    try {
      const title = chatHistory.setTitle(id, req.body?.title);
      res.json({ id, title });
      broadcast({ type: "session_renamed", id, title });
    } catch (err) {
      if (err?.code === "not_found") return res.status(404).json({ error: err.message, code: err.code });
      if (err?.code === "empty" || err?.code === "too_long" || err?.code === "control_chars") {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error("[chat-history] rename error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
