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
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "current_agent"; id: string }
  | { type: "agent_changed"; id: string }
  | { type: "catalog_changed" }
  | { type: "skills"; skills: SkillInfo[] }
  | { type: "documents_status"; [k: string]: unknown }
  | { type: "sessions"; sessions: SessionMeta[]; current?: string }
  | { type: "session_changed"; id: string }
  | { type: "session_loaded"; id: string; title?: string; messages: ChatMessage[] }
  | { type: "session_renamed"; id: string; title: string }
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
  | { type: "dashboard_state"; state: unknown }
  | { type: "extensions_changed"; resource: string; action: string; name: string; enabled?: boolean };

export interface ModelInfo {
  id: string;
  name?: string;
  provider?: string;
}

// Catalog agent (GET /api/catalog / the `agents` WS message). Serialized
// server-side — secrets (apiKey) never reach the client.
export interface AgentInfo {
  id: string;
  type: "agent-local" | "agent-remote";
  name?: string;
  description?: string;  // purpose / capability summary
  icon?: string;         // lucide icon name (resolved via <Icon name={icon} />)
  mode?: "chat" | "link";
  model?: string;
  url?: string;
  tags?: string[];       // categorization badges
  version?: string;      // semver for changelog reference
  featured?: boolean;    // show on Agents dashboard first
}

export interface AppInfo {
  id: string;
  name?: string;
  description?: string;  // purpose / capability summary
  icon?: string;         // lucide icon name
  kind: "link" | "nango-connect" | "external-service";
  url?: string;
  // external-service specific fields:
  features?: string[];   // capability bullets shown in card detail
  embedded?: boolean;    // true = embed in iframe via /external/:appId
  tags?: string[];
  version?: string;
  featured?: boolean;
}

export interface SkillInfo {
  name: string;
  description?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
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
  | { type: "list_agents" }
  | { type: "set_agent"; id: string }
  | { type: "list_skills" }
  | { type: "list_sessions" }
  | { type: "new_session" }
  | { type: "switch_session"; id: string }
  | { type: "rename_session"; id: string; title: string };
