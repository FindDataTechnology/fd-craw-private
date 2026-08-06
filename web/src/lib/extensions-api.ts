// extensions-api.ts
// API client for extensions management (MCP servers + custom skills)

const BASE_URL = "/api/extensions";

export interface McpServer {
  id: string;
  name: string;
  type: string;
  config: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
  enabled: boolean;
  source: "user" | "startup";
  createdAt: string;
  updatedAt: string;
}

export interface CustomSkill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  name: string;
  description: string;
  source: "file" | "database";
  enabled: boolean;
}

export interface MarketMcpServer {
  name: string;
  displayName: string;
  description: string;
  category: string;
  icon: string;
  configTemplate: McpServer["config"];
  installInstructions: string;
}

export interface MarketSkill {
  name: string;
  displayName: string;
  description: string;
  category: string;
  icon: string;
  skillTemplate: {
    description: string;
    content: string;
  };
}

export interface MarketCatalog {
  mcpServers: MarketMcpServer[];
  skills: MarketSkill[];
}

// ── MCP Servers ──────────────────────────────────────────────────────────────

export async function fetchMcpServers(): Promise<McpServer[]> {
  const res = await fetch(`${BASE_URL}/mcp`);
  if (!res.ok) throw new Error(`Failed to fetch MCP servers: ${res.statusText}`);
  const data = await res.json();
  return data.servers || [];
}

export async function addMcpServer(
  name: string,
  config: McpServer["config"],
  enabled = true
): Promise<McpServer> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config, enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to add MCP server: ${res.statusText}`);
  }
  return res.json();
}

export async function updateMcpServer(
  name: string,
  config?: McpServer["config"],
  enabled?: boolean
): Promise<McpServer> {
  const res = await fetch(`${BASE_URL}/mcp/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config, enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to update MCP server: ${res.statusText}`);
  }
  return res.json();
}

export async function removeMcpServer(name: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/mcp/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to remove MCP server: ${res.statusText}`);
  }
}

export async function toggleMcpServer(name: string, enabled: boolean): Promise<McpServer> {
  const res = await fetch(`${BASE_URL}/mcp/${encodeURIComponent(name)}/enable`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to toggle MCP server: ${res.statusText}`);
  }
  return res.json();
}

// ── Skills ───────────────────────────────────────────────────────────────────

export async function fetchSkills(): Promise<Skill[]> {
  const res = await fetch(`${BASE_URL}/skills`);
  if (!res.ok) throw new Error(`Failed to fetch skills: ${res.statusText}`);
  const data = await res.json();
  return data.skills || [];
}

export async function addCustomSkill(
  name: string,
  description: string,
  content: string,
  enabled = true
): Promise<CustomSkill> {
  const res = await fetch(`${BASE_URL}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, content, enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to add skill: ${res.statusText}`);
  }
  return res.json();
}

export async function updateCustomSkill(
  name: string,
  description?: string,
  content?: string,
  enabled?: boolean
): Promise<CustomSkill> {
  const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description, content, enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to update skill: ${res.statusText}`);
  }
  return res.json();
}

export async function removeCustomSkill(name: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to remove skill: ${res.statusText}`);
  }
}

export async function toggleCustomSkill(name: string, enabled: boolean): Promise<CustomSkill> {
  const res = await fetch(`${BASE_URL}/skills/${encodeURIComponent(name)}/enable`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `Failed to toggle skill: ${res.statusText}`);
  }
  return res.json();
}

// ── Market Catalog ───────────────────────────────────────────────────────────

export async function fetchMarketCatalog(): Promise<MarketCatalog> {
  const res = await fetch(`${BASE_URL}/market`);
  if (!res.ok) throw new Error(`Failed to fetch market catalog: ${res.statusText}`);
  return res.json();
}
