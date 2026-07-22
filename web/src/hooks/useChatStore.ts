// Chat store — single source of truth for the React chat surface.
//
// Direct port of the imperative state that lived across module-scoped variables
// in public/app.js: WS status, models, skills, sessions, streaming flag, the
// message list. One reducer function per incoming WS type via `apply()`.
//
// A "turn" is one user prompt + one assistant response. All server events that
// arrive between agent_start and done attach to the current assistant turn
// (thinking, tools, skill, text) — this is what removes the "sibling blocks"
// visual problem the vanilla app has.

import { create } from "zustand";
import type {
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
  skills: SkillInfo[];
  sessions: SessionMeta[];
  currentSessionId: string | null;
  turns: Turn[];
  isStreaming: boolean;
  // Setters used by the WS hook.
  setStatus: (s: ConnStatus) => void;
  apply: (m: ServerMessage) => void;
  // Local UI commands (never sent to server).
  addUserTurnOptimistic: (text: string) => void;
  clearView: () => void;
  toggleAllThinking: () => void;
  toggleBlock: (turnId: string, index: number) => void;
}

let uid = 0;
const nextId = () => `t${++uid}`;

// Grab-or-create the currently open assistant turn. If the tail of `turns`
// isn't a streaming assistant, push a new one.
function currentAssistant(turns: Turn[]): Turn & { role: "assistant" } {
  const tail = turns[turns.length - 1];
  if (tail && tail.role === "assistant" && tail.streaming) return tail;
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

export const useChatStore = create<State>((set) => ({
  status: "connecting",
  models: [],
  currentModel: null,
  skills: [],
  sessions: [],
  currentSessionId: null,
  turns: [],
  isStreaming: false,

  setStatus: (s) => set({ status: s }),

  apply: (m) =>
    set((state) => {
      // Mutate a shallow copy of turns for React's identity check.
      const turns = state.turns.slice();
      switch (m.type) {
        case "user":
          turns.push({ id: nextId(), role: "user", text: m.text });
          return { turns };

        case "agent_start":
          // Fresh assistant turn only when there isn't already an open one.
          currentAssistant(turns);
          return { turns, isStreaming: true };

        case "text":
          appendText(turns, m.delta);
          return { turns };

        case "thinking":
          appendThinking(turns, m.delta);
          return { turns };

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
          if (tail && tail.role === "assistant") tail.streaming = false;
          return { turns, isStreaming: false };
        }

        case "error": {
          const a = currentAssistant(turns);
          a.blocks.push({ kind: "error", message: m.message });
          return { turns };
        }

        case "current_model":
        case "model_changed":
          return { currentModel: m.id };

        case "models":
          return { models: m.models };

        case "skills":
          return { skills: m.skills };

        case "sessions":
          return {
            sessions: m.sessions,
            currentSessionId: m.current ?? state.currentSessionId,
          };

        case "session_changed":
          return { currentSessionId: m.id };

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
          };

        // Non-chat channels. Ignored for now — vanilla views own them.
        case "documents_status":
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
          return {};
      }
    }),

  addUserTurnOptimistic: (text) =>
    set((state) => ({ turns: [...state.turns, { id: nextId(), role: "user", text }] })),

  clearView: () => set({ turns: [], isStreaming: false }),

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

// Test hook: expose the store on window so Playwright can drive events
// without a real WebSocket. Harmless in production (nothing sensitive on the
// store; users could reach the same handlers by sending fake WS messages).
// ponytail: E2E hook, not gated by NODE_ENV to avoid a build-mode split.
if (typeof window !== "undefined") {
  (window as unknown as { __chatStore?: typeof useChatStore }).__chatStore = useChatStore;
}
