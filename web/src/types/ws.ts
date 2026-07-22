// WebSocket message types.
//
// Source of truth for what the Node backend broadcasts and accepts. Mirrors
// server.js. When server.js grows a new type, add it here — the React store's
// exhaustive switch will fail to compile until the case is handled.

// ── Server → client ─────────────────────────────────────────────────────────

export type ServerMessage =
  | { type: "user"; text: string }
  | { type: "agent_start" }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; name: string; partialResult: unknown }
  | { type: "tool_end"; toolCallId: string; name: string; result: unknown; isError?: boolean }
  | { type: "skill_use"; name: string; args?: string }
  | { type: "command_use"; name: string; args?: string; message?: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "current_model"; id: string | null }
  | { type: "models"; models: ModelInfo[] }
  | { type: "model_changed"; id: string | null }
  | { type: "skills"; skills: SkillInfo[] }
  | { type: "documents_status"; [k: string]: unknown }
  | { type: "sessions"; sessions: SessionMeta[]; current?: string }
  | { type: "session_changed"; id: string }
  | { type: "session_loaded"; id: string; title?: string; messages: ChatMessage[] }
  | { type: "cron_jobs"; jobs: unknown[] }
  | { type: "cron_status"; job: unknown }
  | { type: "cron_removed"; id: string }
  | { type: "cron_fired"; id: string; prompt: string }
  | { type: "cron_completed"; id: string; success?: boolean }
  | { type: "cron_added"; job: unknown }
  | { type: "cron_paused"; jobId: string; success: boolean }
  | { type: "cron_resumed"; jobId: string; success: boolean }
  | { type: "cron_run_started"; jobId: string; success: boolean }
  | { type: "dashboard_update"; state: unknown }
  | { type: "dashboard_state"; state: unknown };

export interface ModelInfo {
  id: string;
  name?: string;
  provider?: string;
}

export interface SkillInfo {
  name: string;
  description?: string;
}

export interface SessionMeta {
  id: string;
  title?: string;
  createdAt?: string | number;
  updatedAt?: string | number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Client → server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "list_models" }
  | { type: "set_model"; id: string }
  | { type: "list_skills" }
  | { type: "list_sessions" }
  | { type: "new_session" }
  | { type: "switch_session"; id: string };
