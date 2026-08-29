// LLM provider management (Models page) + runtime model-list refresh.

export function registerLlmRoutes(ctx) {
  const { app, broadcast } = ctx;

  // Refresh the dsh model list at runtime (design D3 / spike 2). Re-runs
  // writeLlmProfile; dsh-settings-file hot-reloads the llm-pi-ai: section so new
  // models reach the adapter without a restart. The active model is untouched.
  // Admin-gated under forward-auth (a config mutation).
  app.post("/api/models/refresh", async (req, res) => {
    if (ctx.authEnabled && !req.user?.groups?.includes("admin")) {
      return res.status(403).json({ error: "Admin group required" });
    }
    try {
      const models = await ctx.refreshDshModels();
      res.json({ models });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // After a provider add/edit/delete: refresh the credentials file + the
  // llm-pi-ai profile. Both are Chokidar-watched by dsh (settings-file +
  // credentials-local), so the new route and key hot-reload with no dsh
  // restart — the same path /api/models/refresh relies on. Then update
  // dshModels and broadcast so the sidebar/model chip and the Models page
  // pick up the new model ids immediately.
  async function reloadLlmProviders() {
    const dshProfile = await import("../../dsh-profile.js");
    await dshProfile.ensureCredentialsStore();
    const { models } = await dshProfile.writeLlmProfile();
    ctx.dshModels = models;
    broadcast({ type: "models", models: await ctx.getAvailableModels() });
  }

  app.get("/api/llm/providers", async (_req, res) => {
    try {
      const llmProviders = await import("../../llm-providers.js");
      // The env-generated Volces route is the reserved, always-present provider.
      const envProviders = process.env.LLM_API_KEY?.trim()
        ? [{
            id: "volces",
            name: "Volces",
            baseUrl: process.env.LLM_BASE_URL || "https://ark.cn-beijing.volces.com/api/coding/v3",
            type: "openai-completions",
            hasKey: true,
            reserved: true,
            models: ctx.dshModels.filter((m) => m.provider === "volces").map((m) => m.id),
            lastTest: null,
          }]
        : [];
      res.json({ providers: [...envProviders, ...llmProviders.listUserProviders()] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/llm/providers", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      const record = await llmProviders.tryWithWriteLock(async () => {
        const created = llmProviders.createProvider(req.body || {});
        await reloadLlmProviders();
        return created;
      });
      res.status(201).json({ provider: record });
    } catch (err) {
      const status =
        err?.code === "busy" ? 409 :
        err?.code === "duplicate" ? 409 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  app.put("/api/llm/providers/:id", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      const record = await llmProviders.tryWithWriteLock(async () => {
        const updated = llmProviders.updateProvider(req.params.id, req.body || {});
        await reloadLlmProviders();
        return updated;
      });
      res.json({ provider: record });
    } catch (err) {
      const status =
        err?.code === "busy" ? 409 :
        err?.code === "not_found" ? 404 :
        err?.code === "duplicate" ? 409 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  app.delete("/api/llm/providers/:id", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      await llmProviders.tryWithWriteLock(async () => {
        llmProviders.deleteProvider(req.params.id);
        await reloadLlmProviders();
      });
      res.json({ ok: true });
    } catch (err) {
      const status =
        err?.code === "busy" ? 409 :
        err?.code === "not_found" ? 404 :
        err?.code === "only_provider" ? 409 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  app.post("/api/llm/providers/:id/test", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      const result = await llmProviders.testProvider(req.params.id);
      res.json(result);
    } catch (err) {
      const status =
        err?.code === "not_found" ? 404 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  app.get("/api/llm/default", async (_req, res) => {
    try {
      const llmProviders = await import("../../llm-providers.js");
      const saved = llmProviders.getDefault();
      res.json({
        providerId: saved.providerId,
        modelId: saved.modelId || ctx.defaultModel?.id || null,
        activeModelId: ctx.session?.model?.id || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/llm/default", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      const { modelId, providerId } = req.body || {};
      const target = ctx.dshModels.find((m) => m.id === modelId);
      if (!target) return res.status(400).json({ error: `Unknown model: ${modelId}` });
      const saved = llmProviders.setDefault({ modelId, providerId: providerId || target.provider });
      ctx.defaultModel = { id: target.id, provider: target.provider, name: target.name || target.id };
      broadcast({ type: "model_changed", id: target.id });
      res.json({ providerId: saved.providerId, modelId: saved.modelId });
    } catch (err) {
      res.status(err?.code === "invalid" ? 400 : 500).json({ error: err.message, code: err?.code });
    }
  });
}
