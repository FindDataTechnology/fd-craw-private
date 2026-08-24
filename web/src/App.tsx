// Routes for the React SPA. The new canonical tab set is
// Chat, Knowledge, Agents, MCP Servers, Skills, Models.
// Legacy paths (Extensions, Documents) redirect to their new homes.

import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useChatStore } from "@/hooks/useChatStore";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Sidebar } from "@/components/Sidebar";
import { ToastHost } from "@/components/Toast";
import { ChatPage } from "@/pages/ChatPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { DocumentsPage } from "@/pages/DocumentsPage";
import { OpenConnectorPage, ExternalServicePage } from "@/pages/EmbeddedServicePages";
import { ExtensionsPage } from "@/pages/ExtensionsPage";
import { AgentsPage } from "@/pages/AgentsPage";
import { ModelsPage } from "@/pages/ModelsPage";

export default function App() {
  const { send } = useWebSocket();
  const toggleAllThinking = useChatStore((s) => s.toggleAllThinking);

  // Ctrl/Cmd + O toggles all thinking blocks (foldable-observation-shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        toggleAllThinking();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAllThinking]);

  return (
    <div className="grid h-dvh grid-cols-[240px_1fr] overflow-hidden bg-background text-foreground">
      <Sidebar send={send} />
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage send={send} />} />
        <Route path="/chat/:sessionId" element={<ChatPage send={send} />} />

        {/* Knowledge (was Documents) — same page, new label + route. */}
        <Route path="/knowledge" element={<DocumentsPage />} />
        <Route path="/documents" element={<Navigate to="/knowledge" replace />} />

        <Route path="/dashboard" element={<DashboardPage />} />

        {/* Top-level extension management — was nested under /extensions. */}
        <Route path="/mcp" element={<ExtensionsPage type="mcp" />} />
        <Route path="/skills" element={<ExtensionsPage type="skills" />} />
        <Route path="/extensions" element={<Navigate to="/mcp" replace />} />
        <Route path="/extensions/mcp" element={<Navigate to="/mcp" replace />} />
        <Route path="/extensions/skills" element={<Navigate to="/skills" replace />} />

        <Route path="/models" element={<ModelsPage />} />

        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/openconnector" element={<OpenConnectorPage />} />
        <Route path="/external/:appId" element={<ExternalServicePage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
      <ToastHost />
    </div>
  );
}
