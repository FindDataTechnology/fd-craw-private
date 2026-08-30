// Routes for the React SPA. The new canonical tab set is
// Chat, Knowledge, Agents, MCP Servers, Skills, Models.
// Legacy paths (Extensions, Documents) redirect to their new homes.
//
// Code splitting: the chat surface (the product's primary view) and the
// dashboard stay in the eager entry chunk; every admin/one-off page loads
// lazily on first navigation (shiki's language chunks already split
// themselves the same way).

import { lazy, Suspense, useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useChatStore } from "@/hooks/useChatStore";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Sidebar } from "@/components/Sidebar";
import { ToastHost } from "@/components/Toast";
import { ChatPage } from "@/pages/ChatPage";
import { DashboardPage } from "@/pages/DashboardPage";

const DocumentsPage = lazy(() =>
  import("@/pages/DocumentsPage").then((m) => ({ default: m.DocumentsPage })),
);
const ExtensionsPage = lazy(() =>
  import("@/pages/ExtensionsPage").then((m) => ({ default: m.ExtensionsPage })),
);
const AgentsPage = lazy(() => import("@/pages/AgentsPage").then((m) => ({ default: m.AgentsPage })));
const ModelsPage = lazy(() => import("@/pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));
const OpenConnectorPage = lazy(() =>
  import("@/pages/EmbeddedServicePages").then((m) => ({ default: m.OpenConnectorPage })),
);
const ExternalServicePage = lazy(() =>
  import("@/pages/EmbeddedServicePages").then((m) => ({ default: m.ExternalServicePage })),
);

function RouteFallback() {
  return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
}

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
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          {/* One route with an OPTIONAL session param: navigating /chat ↔
              /chat/:id must NOT remount ChatPage — a remount re-runs the
              deep-link effect, which re-sends switch_session and fights the
              server's session_loaded broadcasts (turns clobbered to zero). */}
          <Route path="/chat/:sessionId?" element={<ChatPage send={send} />} />

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
      </Suspense>
      <ToastHost />
    </div>
  );
}
