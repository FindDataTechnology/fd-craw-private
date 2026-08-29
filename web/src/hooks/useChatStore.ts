// Chat store — single source of truth for the React chat surface.
//
// Holds the imperative chat state: WS status, models, skills, sessions,
// streaming flag, the message list. One reducer function per incoming WS type
// via `apply()`.
//
// A "turn" is one user prompt + one assistant response. All server events that
// arrive between agent_start and done attach to the current assistant turn
// (thinking, tools, skill, text) — this is what removes the "sibling blocks"
// visual problem the vanilla app has.

import { create } from "zustand";
import { showToast } from "@/components/Toast";
import type {
  AgentInfo,
  ChatMessage,
  ModelInfo,
  ServerMessage,
  SessionMeta,
  SkillInfo,
} from "@/types/ws";

export type ConnStatus = "connecting" | "connected" | "disconnected";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; open: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: unknown;
      state: "running" | "done" | "error";
      result?: unknown;
      partial?: unknown;
      open: boolean;
    }
  | { kind: "skill"; name: string; args?: string; open: boolean }
  | { kind: "command"; name: string; args?: string; message?: string; open: boolean }
  | { kind: "error"; message: string };

export type Turn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; blocks: Block[]; streaming: boolean };

interface State {
  status: ConnStatus;
  models: ModelInfo[];
  currentModel: string | null;
  agents: AgentInfo[];
  currentAgent: string | null;
  // Bumped on every `catalog_changed` so catalog-viewing pages refetch.
  catalogVersion: number;
  skills: SkillInfo[];
  sessions: SessionMeta[];
  currentSessionId: string | null;
  turns: Turn[];
  isStreaming: boolean;
  // True while the remainder of a dismissed run (user stop, or a socket drop
  // mid-stream) must be ignored. dsh has no interrupt RPC, so "stop" is a
  // view-level finalize; without this flag the orphaned run's late events
  // would open a fresh streaming turn and re-disable the composer.
  suppressed: boolean;
  // Setters used by the WS hook.
  setStatus: (s: ConnStatus) => void;
  apply: (m: ServerMessage) => void;
  // Local UI commands (never sent to server).
  addUserTurnOptimistic: (text: string) => void;
  clearView: () => void;
  renameSession: (id: string, title: string) => void;
  toggleAllThinking: () => void;
  toggleBlock: (turnId: string, index: number) => void;
  // Release an in-flight run locally: finalize the open turn, give the
  // composer back, and swallow the run's remaining events until its `done`.
  stopStreaming: () => void;
}

let uid = 0;
const nextId = () => `t${++uid}`;

// Grab-or-create the currently open assistant turn. If the tail of `turns`
// isn't a streaming assistant, push a new one. When it IS, return a shallow
// CLONE substituted into the array: every block mutation below then writes to
// a fresh object, so the memoized <AssistantTurn> re-renders the tail (new
// prop reference) while every earlier turn keeps its reference and bails —
// O(1) per streamed delta. Mutating the tail in place would leave the memo
// comparing identical references and the streaming turn would never update.
function currentAssistant(turns: Turn[]): Turn & { role: "assistant" } {
  const tail = turns[turns.length - 1];
  if (tail && tail.role === "assistant" && tail.streaming) {
    const clone = { ...tail, blocks: tail.blocks.slice() };
    turns[turns.length - 1] = clone;
    return clone;
  }
  const fresh: Turn = { id: nextId(), role: "assistant", blocks: [], streaming: true };
  turns.push(fresh);
  return fresh;
}

// Append a text delta to the LAST text block on the current assistant turn,
// or create one. Thinking/tool/skill blocks in between force a fresh text
// block on the next text delta — matches server contract (text streams in
// segments broken by tool calls).
function appendText(turns: Turn[], delta: string) {
  const a = currentAssistant(turns);
  const last = a.blocks[a.blocks.length - 1];
  if (last?.kind === "text") {
    last.text += delta;
  } else {
    a.blocks.push({ kind: "text", text: delta });
  }
}

function appendThinking(turns: Turn[], delta: string) {
  const a = currentAssistant(turns);
  const last = a.blocks[a.blocks.length - 1];
  if (last?.kind === "thinking") {
    last.text += delta;
  } else {
    a.blocks.push({ kind: "thinking", text: delta, open: true });
  }
}

// ── Streamed-delta batching ─────────────────────────────────────────────────
// Every text/thinking delta used to commit its own set(): a new turns array
// per token re-rendered the whole transcript and grew the streaming string
// quadratically. Deltas now accumulate in a small buffer and flush as one
// commit at most every DELTA_FLUSH_MS. Ordering is preserved exactly: any
// non-delta event first folds the pending buffer into the same set() call
// (tool blocks can never land before the text that preceded them), and
// session swaps / view clears discard the buffer (those deltas belong to the
// previous conversation).
const DELTA_FLUSH_MS = 50;
type PendingDeltas = { text: string | null; thinking: string | null };
let pending: PendingDeltas = { text: null, thinking: null };
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queueDelta(kind: "text" | "thinking", delta: string) {
  pending[kind] = (pending[kind] ?? "") + delta;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      useChatStore.setState((state) => flushIntoTurns(state) ?? {});
    }, DELTA_FLUSH_MS);
  }
}

// Returns the turns patch for the buffered deltas (and clears the buffer),
// or null when nothing is pending. Called inside a set()/setState() updater.
function flushIntoTurns(state: State): { turns: Turn[] } | null {
  if (!pending.text && !pending.thinking) return null;
  const p = pending;
  pending = { text: null, thinking: null };
  const turns = state.turns.slice();
  if (p.text) appendText(turns, p.text);
  if (p.thinking) appendThinking(turns, p.thinking);
  return { turns };
}

function discardDeltas() {
  pending = { text: null, thinking: null };
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

// Stream events that belong to one run. While `suppressed`, these are
// dropped; everything else (models, sessions, …) still applies.
const RUN_EVENT_TYPES = new Set([
  "agent_start",
  "text",
  "thinking",
  "tool_start",
  "tool_update",
  "tool_end",
  "skill_use",
  "command_use",
  "error",
]);

// Close every open assistant turn. Returns a NEW array (no in-place mutation —
// callers run inside set()).
function finalizeOpenTurns(turns: Turn[]): Turn[] {
  return turns.map((t) => (t.role === "assistant" && t.streaming ? { ...t, streaming: false } : t));
}

export const useChatStore = create<State>((set) => ({
  status: "connecting",
  models: [],
  currentModel: null,
  agents: [],
  currentAgent: null,
  catalogVersion: 0,
  skills: [],
  sessions: [],
  currentSessionId: null,
  turns: [],
  isStreaming: false,
  suppressed: false,

  setStatus: (s) =>
    set((state) => {
      if (s !== "disconnected") return { status: s };
      // A dropped socket used to strand `isStreaming` forever (only
      // done/session_loaded/clearView reset it) — the composer bricked until
      // the view was wiped. Finalize the open turn and suppress the orphaned
      // run's remaining events instead; the connection banner explains the
      // truncation while the WS hook reconnects.
      discardDeltas();
      return {
        status: s,
        turns: finalizeOpenTurns(state.turns),
        isStreaming: false,
        suppressed: true,
      };
    }),

  apply: (m) => {
    // A dismissed run's stream events are swallowed until the run's own
    // `done` (or the next prompt's `user` echo) clears the flag. Checked
    // before queueDelta so buffered text can't leak past the suppression.
    if (useChatStore.getState().suppressed && RUN_EVENT_TYPES.has(m.type)) return;
    // Streamed deltas are buffered (see DELTA_FLUSH_MS above) — no commit
    // per token.
    if (m.type === "text" || m.type === "thinking") {
      queueDelta(m.type, m.delta);
      return;
    }
    // A session swap discards buffered deltas (previous conversation); every
    // other message folds them in first, preserving event order exactly.
    if (m.type === "session_loaded") discardDeltas();

    set((state) => {
      const pre = flushIntoTurns(state);
      const turns = pre ? pre.turns : state.turns.slice();
      switch (m.type) {
        case "user":
          turns.push({ id: nextId(), role: "user", text: m.text });
          // A new prompt's echo ends any suppression from a prior stop.
          return { turns, suppressed: false };

        case "agent_start":
          // Fresh assistant turn only when there isn't already an open one.
          currentAssistant(turns);
          return { turns, isStreaming: true };

        case "tool_start": {
          const a = currentAssistant(turns);
          a.blocks.push({
            kind: "tool",
            id: m.toolCallId,
            name: m.name,
            args: m.args,
            state: "running",
            open: false,
          });
          return { turns };
        }

        case "tool_update": {
          const a = currentAssistant(turns);
          const b = a.blocks.find(
            (x): x is Extract<Block, { kind: "tool" }> =>
              x.kind === "tool" && x.id === m.toolCallId,
          );
          if (b) b.partial = m.partialResult;
          return { turns };
        }

        case "tool_end": {
          const a = currentAssistant(turns);
          const b = a.blocks.find(
            (x): x is Extract<Block, { kind: "tool" }> =>
              x.kind === "tool" && x.id === m.toolCallId,
          );
          if (b) {
            b.state = m.isError ? "error" : "done";
            b.result = m.result;
            if (m.isError) b.open = true;
          }
          return { turns };
        }

        case "skill_use": {
          const a = currentAssistant(turns);
          a.blocks.push({ kind: "skill", name: m.name, args: m.args, open: false });
          return { turns };
        }

        case "command_use": {
          const a = currentAssistant(turns);
          a.blocks.push({
            kind: "command",
            name: m.name,
            args: m.args,
            message: m.message,
            open: true,
          });
          return { turns };
        }

        case "done": {
          const tail = turns[turns.length - 1];
          // Clone (not mutate): the finalized turn needs a new reference so
          // the memoized <AssistantTurn> re-renders its closed state.
          if (tail && tail.role === "assistant" && tail.streaming) {
            turns[turns.length - 1] = { ...tail, streaming: false };
          }
          // The dismissed run (if any) has ended; stop swallowing events.
          return { turns, isStreaming: false, suppressed: false };
        }

        case "error": {
          // An error with no run in flight (e.g. "Agent is still
          // initializing" broadcast during cold boot, or a rejected
          // concurrent prompt) must not fabricate an empty assistant turn —
          // surface it as a toast instead. Errors during a live run still
          // attach to that turn (as a clone, so the turn re-renders).
          const tail = turns[turns.length - 1];
          if (!tail || tail.role !== "assistant" || !tail.streaming) {
            showToast(m.message);
            return {};
          }
          turns[turns.length - 1] = {
            ...tail,
            blocks: [...tail.blocks, { kind: "error", message: m.message }],
          };
          return { turns };
        }

        case "current_model":
        case "model_changed":
          return { currentModel: m.id };

        case "models":
          return { models: m.models };

        case "current_agent":
        case "agent_changed":
          return { currentAgent: m.id };

        case "agents":
          return { agents: m.agents };

        case "catalog_changed":
          return { catalogVersion: state.catalogVersion + 1 };

        case "skills":
          return { skills: m.skills };

        case "sessions":
          return {
            sessions: m.sessions,
            currentSessionId: m.current ?? state.currentSessionId,
          };

        case "session_changed":
          return { currentSessionId: m.id };

        case "session_renamed":
          return {
            sessions: state.sessions.map((s) => (s.id === m.id ? { ...s, title: m.title } : s)),
          };

        case "session_loaded":
          return {
            currentSessionId: m.id,
            turns: (m.messages || []).map<Turn>((msg: ChatMessage) =>
              msg.role === "user"
                ? { id: nextId(), role: "user", text: msg.content }
                : {
                    id: nextId(),
                    role: "assistant",
                    blocks: [{ kind: "text", text: msg.content }],
                    streaming: false,
                  },
            ),
            isStreaming: false,
            suppressed: false,
          };

        // Non-chat channels. Ignored for now — the owning views/stores
        // subscribe to these themselves (e.g. useExtensionsStore.applyEvent
        // handles extensions_changed).
        case "cron_jobs":
        case "cron_status":
        case "cron_removed":
        case "cron_fired":
        case "cron_completed":
        case "cron_added":
        case "cron_paused":
        case "cron_resumed":
        case "cron_run_started":
        case "dashboard_update":
        case "dashboard_state":
        case "documents_status":
        case "extensions_changed":
          return {};

        default:
          // CRITICAL: never fall through returning undefined. Zustand treats a
          // non-object partial as a FULL state replacement, so an unhandled
          // message type would blank the whole store and crash every
          // subscriber on the next render ("Cannot read properties of
          // undefined"). Ignore unknown types instead.
          return {};
      }
    });
  },

  addUserTurnOptimistic: (text) => {
    // Fold any buffered assistant deltas first so the optimistic user turn
    // lands after them in the transcript.
    set((state) => {
      const pre = flushIntoTurns(state);
      const turns = pre ? pre.turns : state.turns;
      return { turns: [...turns, { id: nextId(), role: "user", text }] };
    });
  },

  // Optimistic local rename; the broadcast `session_renamed` event reconciles
  // every other open client (and ours, in case the server's value trims).
  renameSession: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    })),

  clearView: () => {
    discardDeltas();
    set({ turns: [], isStreaming: false, suppressed: false });
  },

  stopStreaming: () => {
    // dsh's wire protocol has no interrupt RPC (initialize / session/prompt /
    // shutdown only), so stop is local: close the turn where it stands, hand
    // the composer back, and swallow the run's remaining events until `done`.
    set((state) => {
      discardDeltas();
      return {
        turns: finalizeOpenTurns(state.turns),
        isStreaming: false,
        suppressed: true,
      };
    });
  },

  toggleAllThinking: () =>
    set((state) => {
      // Flip all thinking blocks to the OPPOSITE of the majority state.
      // (Matches vanilla: if any is closed, opening all reads as the natural intent.)
      let anyClosed = false;
      for (const t of state.turns) {
        if (t.role !== "assistant") continue;
        for (const b of t.blocks) if (b.kind === "thinking" && !b.open) anyClosed = true;
      }
      const target = anyClosed; // open them if any is closed; else close all
      const turns = state.turns.map((t) => {
        if (t.role !== "assistant") return t;
        return {
          ...t,
          blocks: t.blocks.map((b) => (b.kind === "thinking" ? { ...b, open: target } : b)),
        };
      });
      return { turns };
    }),

  toggleBlock: (turnId, index) =>
    set((state) => ({
      turns: state.turns.map((t) => {
        if (t.id !== turnId || t.role !== "assistant") return t;
        return {
          ...t,
          blocks: t.blocks.map((b, i) => {
            if (i !== index) return b;
            if (b.kind === "text" || b.kind === "error") return b;
            return { ...b, open: !b.open };
          }),
        };
      }),
    })),
}));

// Dev/test hook: expose the store on window so it can be driven without a real
// WebSocket. Gated to dev builds, or to e2e builds (VITE_E2E_SEAM=1, used only
// for the Playwright dist — never in shipped/release builds) so the Zustand
// store is not globally readable/mutable in production.
if (typeof window !== "undefined" && (import.meta.env.DEV || import.meta.env.VITE_E2E_SEAM === "1")) {
  (window as unknown as { __chatStore?: typeof useChatStore }).__chatStore = useChatStore;
}
