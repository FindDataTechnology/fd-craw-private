import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useChatStore } from "@/hooks/useChatStore";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Sidebar } from "@/components/Sidebar";
import { ToastHost } from "@/components/Toast";
import { ChatPage } from "@/pages/ChatPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { DocumentsPage } from "@/pages/DocumentsPage";
import { ExtensionsPage } from "@/pages/ExtensionsPage";
import { OpenConnectorPage, LiteLLMPage } from "@/pages/EmbeddedServicePages";

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
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/extensions" element={<ExtensionsPage />} />
        <Route path="/openconnector" element={<OpenConnectorPage />} />
        <Route path="/litellm" element={<LiteLLMPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
      <ToastHost />
    </div>
  );
}
