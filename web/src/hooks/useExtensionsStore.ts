// Extensions state (MCP servers + custom skills + market catalog).
// Fetches REST on mount; subscribes to the `extensions_changed` WS event.
import { create } from "zustand";
import * as api from "@platform/core";
import type {
  McpServer,
  Skill,
  MarketCatalog,
} from "@platform/core";
import type { ServerMessage } from "@platform/core";

interface ExtensionsState {
  mcpServers: McpServer[];
  skills: Skill[];
  marketCatalog: MarketCatalog | null;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  refreshMcpServers: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshMarketCatalog: () => Promise<void>;

  addMcpServer: (name: string, config: McpServer["config"], enabled?: boolean) => Promise<void>;
  updateMcpServer: (name: string, config?: McpServer["config"], enabled?: boolean) => Promise<void>;
  removeMcpServer: (name: string) => Promise<void>;
  toggleMcpServer: (name: string, enabled: boolean) => Promise<void>;

  addCustomSkill: (name: string, description: string, content: string, enabled?: boolean) => Promise<void>;
  updateCustomSkill: (name: string, description?: string, content?: string, enabled?: boolean) => Promise<void>;
  removeCustomSkill: (name: string) => Promise<void>;
  toggleCustomSkill: (name: string, enabled: boolean) => Promise<void>;
  installRegistrySkill: (name: string) => Promise<void>;

  applyEvent: (msg: ServerMessage) => void;
}

export const useExtensionsStore = create<ExtensionsState>((set, get) => ({
  mcpServers: [],
  skills: [],
  marketCatalog: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [mcpServers, skills] = await Promise.all([
        api.fetchMcpServers(),
        api.fetchSkills(),
      ]);
      set({ mcpServers, skills, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  refreshMcpServers: async () => {
    try {
      const mcpServers = await api.fetchMcpServers();
      set({ mcpServers });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  refreshSkills: async () => {
    try {
      const skills = await api.fetchSkills();
      set({ skills });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  refreshMarketCatalog: async () => {
    try {
      const marketCatalog = await api.fetchMarketCatalog();
      set({ marketCatalog });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  addMcpServer: async (name, config, enabled = true) => {
    await api.addMcpServer(name, config, enabled);
    await get().refreshMcpServers();
  },

  updateMcpServer: async (name, config, enabled) => {
    await api.updateMcpServer(name, config, enabled);
    await get().refreshMcpServers();
  },

  removeMcpServer: async (name) => {
    await api.removeMcpServer(name);
    await get().refreshMcpServers();
  },

  toggleMcpServer: async (name, enabled) => {
    await api.toggleMcpServer(name, enabled);
    await get().refreshMcpServers();
  },

  addCustomSkill: async (name, description, content, enabled = true) => {
    await api.addCustomSkill(name, description, content, enabled);
    await get().refreshSkills();
  },

  updateCustomSkill: async (name, description, content, enabled) => {
    await api.updateCustomSkill(name, description, content, enabled);
    await get().refreshSkills();
  },

  removeCustomSkill: async (name) => {
    await api.removeCustomSkill(name);
    await get().refreshSkills();
  },

  toggleCustomSkill: async (name, enabled) => {
    await api.toggleCustomSkill(name, enabled);
    await get().refreshSkills();
  },

  installRegistrySkill: async (name) => {
    await api.installRegistrySkill(name);
    await Promise.all([get().refreshSkills(), get().refreshMarketCatalog()]);
  },

  applyEvent: (msg) => {
    if (msg.type === "market_changed") {
      get().refreshMarketCatalog();
      return;
    }
    if (msg.type !== "extensions_changed") return;
    // Refresh the relevant resource on any change event.
    const { resource } = msg as { resource: string };
    if (resource === "mcp") {
      get().refreshMcpServers();
    } else if (resource === "skill") {
      get().refreshSkills();
    }
  },
}));
