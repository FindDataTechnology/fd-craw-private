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
  | { type: "current_model"; id: string | null; effort?: string | null }
  | { type: "models"; models: ModelInfo[] }
  | { type: "model_changed"; id: string | null; effort?: string | null }
  | { type: "effort_changed"; effort: string | null }
  | { type: "workspaces"; current: string | null; recents: string[] }
  | { type: "workspace_changed"; path: string }
  | { type: "agents"; agents: AgentInfo[] }
  | { type: "current_agent"; id: string }
  | { type: "agent_changed"; id: string }
  | { type: "presets"; presets: PresetInfo[]; current: string }
  | { type: "current_preset"; id: string }
  | { type: "permissions"; options: PermissionOption[]; current: string | null }
  | { type: "current_permission"; name: string }
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
  | { type: "extensions_changed"; resource: string; action: string; name: string; enabled?: boolean }
  | { type: "market_changed" }
  | { type: "user_bindings"; model: BindingModel | null; mcp: McpBindingState[] }
  | { type: "runtime_binding"; model: RuntimeModel | null; mcp: { name: string; enabled: boolean }[] }
  | { type: "runtime_binding_pending"; model: RuntimeModel | null; mcp: { name: string; enabled: boolean }[] };

// A personal model binding (source "personal") or the global fallback. Both
// sources carry the same {id, provider} shape.
export interface BindingModel {
  id?: string;
  provider?: string;
  name?: string;
  updatedAt?: string;
  source: "personal" | "global";
}

export interface RuntimeModel {
  id: string;
  provider: string;
}

// One global MCP server as seen through a user's personal overlay. `personalEnabled`
// is null when the user has expressed no preference; `effectiveEnabled` is what
// the shared runtime patch actually uses.
export interface McpBindingState {
  name: string;
  globalEnabled: boolean;
  personalEnabled: boolean | null;
  effectiveEnabled: boolean;
  locked: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider?: string;
  // Selectable thinking levels; absent when the model offers no control.
  reasoningEfforts?: string[];
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

// One dsh agent preset (agent mode) from the roster the runtime composes.
// `broken` carries the discovery-reported reason and marks the row unselectable.
export interface PresetInfo {
  id: string;
  name: string;
  description: string;
  trust: "system" | "user";
  broken?: string;
}

// One permission preset (sandbox + approval bundle) from the composed table.
// `name` is the stable table key; `label` is the server-provided display name
// (the raw key for the shipped table — the web bundle localizes those).
export interface PermissionOption {
  name: string;
  label: string;
  description: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  // Preset the session started under (best-effort; null = deployment default).
  agentPreset?: string | null;
  // Runtime workspace the session started in (best-effort; rows written before
  // the capability carry none and render under the sidebar's Ungrouped group).
  workspace?: string | null;
}

// Persisted block structure on assistant messages (chat history): the tool
// evidence trail survives reload. Absent on rows written before this field
// existed — clients fall back to plain content.
export type PersistedBlock =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: unknown;
      result?: unknown;
      state?: "done" | "error";
    };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  blocks?: PersistedBlock[];
}

// ── Client → server ─────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: "prompt"; text: string }
  | { type: "list_bindings" }
  | { type: "apply_bindings" }
  | { type: "list_models" }
  | { type: "set_model"; id: string }
  | { type: "set_effort"; effort: string | null }
  | { type: "list_workspaces" }
  | { type: "set_workspace"; path: string }
  | { type: "list_agents" }
  | { type: "set_agent"; id: string }
  | { type: "list_presets" }
  | { type: "set_preset"; id: string }
  | { type: "list_permissions" }
  | { type: "set_permission"; name: string }
  | { type: "list_skills" }
  | { type: "list_sessions" }
  | { type: "new_session" }
  | { type: "switch_session"; id: string }
  | { type: "rename_session"; id: string; title: string };
