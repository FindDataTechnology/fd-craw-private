// Optional SSO users can persist a model and MCP availability overlay. The
// runtime is still shared, so the effective profile is applied only while idle.

import * as db from "../db.js";

function sameModel(a, b) {
  return !!a && !!b && a.id === b.id && a.provider === b.provider;
}

function publicMcpState(ctx, email) {
  const personal = email ? db.getUserMcpBindings(email) : {};
  return (ctx.extensionStore?.listMcpServers?.() || []).map((server) => {
    const personalEnabled = personal[server.name];
    return {
      name: server.name,
      globalEnabled: server.enabled,
      personalEnabled: personalEnabled ?? null,
      effectiveEnabled: server.enabled && personalEnabled !== false,
      locked: server.locked,
    };
  });
}

function bindingSnapshot(ctx, email) {
  const model = email ? db.getUserModelBinding(email) : null;
  return {
    model: model ? { ...model, source: "personal" } : { ...ctx.defaultModel, source: "global" },
    mcp: publicMcpState(ctx, email),
  };
}

function pendingPayload(ctx, email) {
  const model = ctx.pendingBindings.get(email)?.model ?? db.getUserModelBinding(email);
  return {
    model: model ? { id: model.id, provider: model.provider } : null,
    mcp: ctx.pendingBindings.get(email)?.mcp || db.getUserMcpBindings(email),
  };
}

export function attachRuntimeBindings(ctx) {
  let applying = false;

  ctx.runtimeApplying = () => applying;

  ctx.getUserBindings = (email) => bindingSnapshot(ctx, email);

  ctx.sendUserBindings = (ws, email) => {
    if (!ws || !email) return false;
    return ctx.send(ws, { type: "user_bindings", ...bindingSnapshot(ctx, email) });
  };

  ctx.broadcastRuntimeBinding = () => {
    ctx.broadcast({
      type: "runtime_binding",
      model: ctx.runtimeModel ? { id: ctx.runtimeModel.id, provider: ctx.runtimeModel.provider } : null,
      mcp: Object.entries(ctx.runtimeMcpOverlay || {})
        .filter(([, enabled]) => enabled === false)
        .map(([name]) => ({ name, enabled: false })),
    });
  };

  ctx.broadcastRuntimePending = (email) => {
    const pending = pendingPayload(ctx, email);
    ctx.broadcast({
      type: "runtime_binding_pending",
      model: pending.model,
      mcp: Object.entries(pending.mcp || {})
        .filter(([, enabled]) => enabled === false)
        .map(([name]) => ({ name, enabled: false })),
    });
  };

  ctx.runExclusiveRuntimeMutation = async (fn) => {
    const run = ctx.runtimeMutationChain.then(async () => {
      applying = true;
      try {
        return await fn();
      } finally {
        applying = false;
      }
    });
    ctx.runtimeMutationChain = run.then(() => {}, () => {});
    return run;
  };

  // Runs inside runExclusiveRuntimeMutation, so `applying` is already true for
  // the whole call — the busy check lives in applyUserBindings.
  async function applyProfile(email) {
    if (!email || ctx.isStreaming) {
      const model = db.getUserModelBinding(email);
      const mcp = email ? db.getUserMcpBindings(email) : {};
      if (email) ctx.pendingBindings.set(email, { model, mcp });
      if (email) ctx.broadcastRuntimePending(email);
      return { ok: false, pending: true, error: "The runtime is busy; the profile will be applied when it is idle" };
    }

    const previous = {
      model: ctx.runtimeModel,
      owner: ctx.runtimeOwner,
      mcp: { ...(ctx.runtimeMcpOverlay || {}) },
    };
    try {
      const modelBinding = db.getUserModelBinding(email);
      const target = modelBinding
        ? ctx.dshModels.find((m) => m.id === modelBinding.id && m.provider === modelBinding.provider)
        : ctx.defaultModel;
      if (modelBinding && !target) {
        return { ok: false, error: `Unknown personal model: ${modelBinding.id}` };
      }

      const personalMcp = db.getUserMcpBindings(email) || {};
      if (target && !sameModel(ctx.runtimeModel, target)) {
        await ctx.dshBridge.restart({ provider: target.provider, model: target.id });
        ctx.session.model = { id: target.id, provider: target.provider };
        ctx.runtimeModel = { id: target.id, provider: target.provider, name: target.name || target.id };
        ctx.broadcast({ type: "model_changed", id: target.id, provider: target.provider });
      }

      await ctx.dshUpdateMcp?.(personalMcp);
      ctx.runtimeMcpOverlay = personalMcp;
      ctx.runtimeOwner = email;
      ctx.broadcastRuntimeBinding();
      ctx.pendingBindings.delete(email);
      return { ok: true, pending: false };
    } catch (err) {
      ctx.runtimeModel = previous.model;
      ctx.runtimeOwner = previous.owner;
      ctx.runtimeMcpOverlay = previous.mcp;
      if (ctx.session) ctx.session.model = previous.model ? { id: previous.model.id, provider: previous.model.provider } : ctx.session.model;
      return { ok: false, error: err.message };
    }
  }

  ctx.applyUserBindings = async (email) => {
    if (!email) return { ok: false, error: "Authentication is required" };
    if (ctx.isStreaming || applying) {
      const model = db.getUserModelBinding(email);
      const mcp = db.getUserMcpBindings(email);
      ctx.pendingBindings.set(email, { model, mcp });
      ctx.broadcastRuntimePending(email);
      return { ok: false, pending: true, error: "The runtime is busy; the profile will be applied when it is idle" };
    }
    return ctx.runExclusiveRuntimeMutation(() => applyProfile(email));
  };

  ctx.applyPendingBindings = async () => {
    if (ctx.isStreaming || applying) return;
    const next = ctx.pendingBindings.entries().next().value;
    if (!next) return;
    await ctx.applyUserBindings(next[0]);
  };

  const originalFinishTurn = ctx.finishTurn;
  ctx.finishTurn = () => {
    const result = originalFinishTurn?.();
    queueMicrotask(() => ctx.applyPendingBindings().catch((err) => console.warn(`[bindings] idle apply failed: ${err.message}`)));
    return result;
  };

  return ctx;
}
