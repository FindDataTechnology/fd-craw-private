// dsh-bridge.js — stdio JSON-RPC bridge to a DeepSeek Harness runtime.
//
// Spawns `dsh --profile <name>` as a child process and drives it through the
// `@deepseek-ai/dsh-sdk-client` HarnessClient, which owns the wire-level
// concerns (spawn, newline-delimited JSON-RPC framing, request/response id
// correlation, notification subscription, the EOF→SIGTERM→SIGKILL close
// ladder). This module adds only what the SDK leaves to the host: process
// lifecycle (spawn on startup, unexpected-exit → restart-with-backoff,
// terminate on shutdown), a health/ready flag, and a single notification pump
// that fans every server notification into the `onEvent` callback. Task 2
// fills `onEvent` with the dsh→WS event-translation map.
//
// The command is `dsh --profile platform` rather than the `dsh-jsonrpc-agent`
// bin: the bin boots a bare cordis.yml and bypasses the profile's
// package.json bundles, so an empty tree exits 0 immediately. The `dsh` CLI
// applies the profile layers (dsh-base + cordis.patch.yml sdk-jsonrpc-server
// row), boots the `agents` service the server plugin injects, and serves
// clean JSON-RPC on stdio with no REPL/banner noise when stdin is a pipe.
//
// dsh is now the sole agent runtime — the pi path was removed in the
// migrate-pi-to-dsh change (no AGENT_RUNTIME branch left to roll back to).

import { HarnessClient, TransportClosedError } from "@deepseek-ai/dsh-sdk-client";
import { fileURLToPath } from "node:url";

const COMMAND = process.env.DSH_BIN || "dsh";
const PROFILE = process.env.DSH_PROFILE || "platform";
const REQUEST_TIMEOUT_MS = Number(process.env.DSH_REQUEST_TIMEOUT_MS) || 60_000;
const SHUTDOWN_TIMEOUT_MS = 5000;
// Backoff ceiling for restart-with-backoff (exponential, capped at 30s).
const MAX_RESTARTS = Number(process.env.DSH_MAX_RESTARTS) || 5;
// RACE: llm-pi-ai registers the volces/litellm adapter asynchronously via
// ctx.inject(["settings"]), which fires only AFTER the settings-file provider
// loads+publishes settings.yaml. An initialize arriving before that injection
// → "no adapter registered for provider X". Retry with a short backoff until
// the adapter registers (or this ceiling is hit). 20×500ms = 10s ceiling.
const INIT_RETRIES = Number(process.env.DSH_INIT_RETRIES) || 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DshBridge {
  #client = null;
  #subscription = null;
  #ready = false;
  #shuttingDown = false;
  #restarts = 0;
  // Spawn generation. A restart closes the old subscription and spawns a new
  // client; the old pump's pending next() rejects asynchronously and could
  // fire its catch AFTER the new client is live. The epoch lets an old pump
  // recognize its rejection belongs to a closed subscription and exit without
  // touching the new client or signaling a false crash.
  #epoch = 0;
  #onEvent = () => {};
  #onCrash = () => {};
  #provider;
  #model;
  #cwd;
  #mcpPatchPath;
  #skillsPatchPath;

  constructor({ onEvent, provider, model, cwd, mcpPatchPath, skillsPatchPath } = {}) {
    if (onEvent) this.#onEvent = onEvent;
    this.#provider = provider || "deepseek-official";
    this.#model = model || "deepseek-v4-flash";
    this.#cwd = cwd || process.cwd();
    this.#mcpPatchPath = mcpPatchPath || null;
    this.#skillsPatchPath = skillsPatchPath || null;
  }

  // Spawn the runtime, perform the initialize handshake, subscribe to
  // notifications, and start the fan-out pump. Idempotent while live.
  async start() {
    if (this.#client && this.#ready) return;
    return this.#spawn();
  }

  async #spawn() {
    // Build CLI args: profile + optional patch overlays (dsh-profile generators).
    // --patch is repeatable and applied after the profile layer; an absent patch
    // path (no MCP servers / no skills dir) just omits the flag. The skills patch
    // is static (set at construction); the mcp patch can be swapped on restart.
    const args = ["--profile", PROFILE];
    if (this.#mcpPatchPath) args.push("--patch", this.#mcpPatchPath);
    if (this.#skillsPatchPath) args.push("--patch", this.#skillsPatchPath);
    const client = new HarnessClient({
      command: COMMAND,
      args,
      cwd: this.#cwd,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    client.start();
    // Retry the initialize handshake — it may race the async adapter
    // registration (see INIT_RETRIES). Only the "no adapter" race is retried;
    // other failures throw immediately. The deepseek-official fallback path
    // (no provider route needed) never races.
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await client.initialize({
          cwd: this.#cwd,
          provider: this.#provider,
          model: this.#model,
        });
        break;
      } catch (e) {
        if (!/no adapter registered for provider/.test(e?.message || "") || attempt >= INIT_RETRIES) throw e;
        if (attempt === 0)
          console.warn(`[dsh-bridge] initialize racing adapter registration; retrying...`);
        await sleep(500);
      }
    }
    this.#client = client;
    this.#ready = true;
    this.#subscription = client.subscribe();
    this.#pump();
    return res;
  }

  // Drain notifications until the runtime dies; a rejection (TransportClosed)
  // from subscription.next() is the exit signal — HarnessClient fails all
  // subscriptions when the child exits.
  async #pump() {
    while (this.#client && this.#ready) {
      let notif;
      try {
        notif = await this.#subscription.next();
      } catch {
        // Child died mid-pump. Signal the host so a turn in flight is aborted
        // (error + done) rather than wedging on isStreaming=true; then restart.
        if (!this.#shuttingDown) {
          try { this.#onEvent({ method: "_bridge_crash", params: {} }); } catch {}
        }
        await this.#onExit();
        return;
      }
      try {
        this.#onEvent(notif);
      } catch (e) {
        console.error("[dsh-bridge] onEvent error:", e?.message || e);
      }
    }
  }

  // Unexpected-exit → restart-with-backoff (exponential, 30s ceiling, max
  // retries). Reset on a successful re-init. No-op during shutdown.
  async #onExit() {
    this.#ready = false;
    this.#client = null;
    if (this.#shuttingDown) return;
    // Signal the host so an in-flight turn (isStreaming wedged true) gets
    // error+done and the UI unwedges; the runtime is gone and won't emit
    // session.status idle itself. (Task 2.4 child-crash-mid-turn)
    try { this.#onEvent({ method: "bridge.exit" }); } catch { /* host callback best-effort */ }
    while (this.#restarts < MAX_RESTARTS) {
      const delay = Math.min(1000 * 2 ** this.#restarts, 30_000);
      this.#restarts += 1;
      console.warn(
        `[dsh-bridge] runtime exited; restarting in ${delay}ms (attempt ${this.#restarts}/${MAX_RESTARTS})`,
      );
      await sleep(delay);
      try {
        await this.#spawn();
        this.#restarts = 0;
        return;
      } catch (e) {
        console.error("[dsh-bridge] restart failed:", e?.message || e);
      }
    }
    console.error(`[dsh-bridge] gave up after ${MAX_RESTARTS} restarts`);
  }

  // Queue one prompt; returns the durable message id (fast — the turn plays
  // out as notifications, not as this request's result).
  async prompt(sessionId, contentBlocks) {
    this.#requireReady();
    return this.#client.prompt(sessionId, contentBlocks);
  }

  // Re-initialize the child with a new provider/model/patch. dsh bakes the model
  // into the `initialize` handshake and exposes no stock `setModel`/reload RPC, so
  // a live model switch OR an MCP add/remove (Task 4.5) means a fresh child.
  // ponytail: this drops the child's in-memory session state (v1 ceiling); a
  // non-disruptive switch needs a custom dsh RPC.
  async restart({ provider, model, mcpPatchPath } = {}) {
    await this.shutdown();
    this.#shuttingDown = false;
    this.#restarts = 0;
    if (provider) this.#provider = provider;
    if (model) this.#model = model;
    if (mcpPatchPath !== undefined) this.#mcpPatchPath = mcpPatchPath;
    return this.#spawn();
  }

  // One raw JSON-RPC request (for future setModel/listModels custom RPCs).
  async request(method, params, timeoutMs) {
    this.#requireReady();
    return this.#client.request(method, params, timeoutMs);
  }

  #requireReady() {
    if (!this.#ready || !this.#client) {
      throw new TransportClosedError("dsh runtime not ready");
    }
  }

  isReady() {
    return this.#ready;
  }

  // Terminate: best-effort protocol `shutdown` then the close ladder.
  async shutdown() {
    this.#shuttingDown = true;
    this.#ready = false;
    try { this.#subscription?.close(); } catch { /* closing a dead sub is fine */ }
    const client = this.#client;
    this.#client = null;
    try { await client?.close(); } catch (e) {
      console.error("[dsh-bridge] close error:", e?.message || e);
    }
  }
}

// Self-check: spawn, initialize, close. Proves the command, framing, and
// handshake without an LLM round-trip (Task 1.5 adds a real prompt).
// Usage: node dsh-bridge.js
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const b = new DshBridge();
  let serverInfo;
  try {
    serverInfo = await b.start();
    const name = serverInfo?.serverInfo?.name;
    if (name !== "deepseek-harness-sdk-runtime") {
      throw new Error(`unexpected serverInfo: ${JSON.stringify(serverInfo)}`);
    }
    console.log("OK initialize —", name);
  } catch (e) {
    console.error("FAIL:", e?.constructor?.name, e?.message || e);
    process.exitCode = 1;
  } finally {
    await b.shutdown();
    console.log("closed");
  }
}
