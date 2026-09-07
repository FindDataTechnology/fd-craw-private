// Routes for the React SPA.
//
// Two kinds of surface, and the split is the whole point of the shell:
//   - Work surfaces (Chat, Knowledge, Agents, Bots, Trace) are nav tabs. You
//     come here to look at or produce something.
//   - Configuration lives in the Settings modal at /settings/:section. You come
//     to change a setting and leave — so it overlays rather than replaces, and
//     dismissing puts you back where you were.
// Legacy standalone config routes (/models, /mcp, /skills, /dashboard, and the
// older /extensions/*) redirect into their Settings section so bookmarks live.
//
// Code splitting: the chat surface (the product's primary view) stays in the
// eager entry chunk; every other page loads lazily on first navigation.

import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useChatStore } from "@/hooks/useChatStore";
import { useWebSocket } from "@/hooks/useWebSocket";
import { Sidebar } from "@/components/Sidebar";
import { ToastHost } from "@/components/Toast";
import { ChatPage } from "@/pages/ChatPage";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { settingsPath } from "@/components/settings/sections";

const DocumentsPage = lazy(() =>
  import("@/pages/DocumentsPage").then((m) => ({ default: m.DocumentsPage })),
);
const AgentsPage = lazy(() => import("@/pages/AgentsPage").then((m) => ({ default: m.AgentsPage })));
const BotsPage = lazy(() => import("@/pages/BotsPage").then((m) => ({ default: m.BotsPage })));
const TracePage = lazy(() => import("@/pages/TracePage").then((m) => ({ default: m.TracePage })));
const TraceDetailPage = lazy(() =>
  import("@/pages/TracePage").then((m) => ({ default: m.TraceDetailPage })),
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
  const location = useLocation();
  const navigate = useNavigate();
  // Off-canvas nav drawer (below md the 240px rail would starve the content
  // column to a sliver — the drawer restores it without a second layout).
  const [navOpen, setNavOpen] = useState(false);

  // Ctrl/Cmd + O toggles all thinking blocks (foldable-observation-shortcut).
  // Ctrl/Cmd + , opens Settings — the universal shortcut for it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "o") {
        e.preventDefault();
        toggleAllThinking();
      } else if (e.key === ",") {
        e.preventDefault();
        // Already open? The modal owns its section state; do not stack.
        if (location.pathname.startsWith("/settings")) return;
        navigate(settingsPath("general"), { state: { backgroundLocation: location } });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleAllThinking, navigate, location]);

  // The modal renders over whatever the user was looking at. On a direct load
  // of /settings/* there is no background, so /chat stands in — the same
  // resolution `/` and unmatched paths already use.
  const state = location.state as { backgroundLocation?: typeof location } | null;
  const settingsOpen = location.pathname.startsWith("/settings");
  const backgroundLocation = state?.backgroundLocation;
  const routedLocation = settingsOpen
    ? (backgroundLocation ?? { ...location, pathname: "/chat", search: "", hash: "" })
    : location;
  const backgroundPath = backgroundLocation
    ? `${backgroundLocation.pathname}${backgroundLocation.search ?? ""}`
    : "/chat";

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {/* md+: the permanent 240px rail. */}
      <div className="hidden w-[240px] shrink-0 md:block">
        <Sidebar send={send} />
      </div>
      {/* Below md: the same rail as an overlay drawer (toggle lives in the
          chat header). Backdrop click dismisses. */}
      {navOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-scrim md:hidden"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-y-0 left-0 z-50 w-[240px] md:hidden">
            <Sidebar send={send} onNavigate={() => setNavOpen(false)} />
          </div>
        </>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<RouteFallback />}>
          <Routes location={routedLocation}>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            {/* One route with an OPTIONAL session param: navigating /chat ↔
                /chat/:id must NOT remount ChatPage — a remount re-runs the
                deep-link effect, which re-sends switch_session and fights the
                server's session_loaded broadcasts (turns clobbered to zero). */}
            <Route
              path="/chat/:sessionId?"
              element={<ChatPage send={send} onToggleNav={() => setNavOpen((v) => !v)} />}
            />

            {/* Work surfaces — the five nav tabs. */}
            <Route path="/knowledge" element={<DocumentsPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/bots" element={<BotsPage />} />
            <Route path="/trace" element={<TracePage />} />
            <Route path="/trace/:turnId" element={<TraceDetailPage />} />

            <Route path="/documents" element={<Navigate to="/knowledge" replace />} />
            <Route path="/external/:appId" element={<ExternalServicePage />} />

            {/* Configuration moved into the Settings modal. These redirects
                keep existing deep links and bookmarks resolving. */}
            <Route path="/models" element={<Navigate to={settingsPath("models")} replace />} />
            <Route path="/mcp" element={<Navigate to={settingsPath("mcp")} replace />} />
            <Route path="/skills" element={<Navigate to={settingsPath("skills")} replace />} />
            <Route path="/extensions" element={<Navigate to={settingsPath("mcp")} replace />} />
            <Route path="/extensions/mcp" element={<Navigate to={settingsPath("mcp")} replace />} />
            <Route
              path="/extensions/skills"
              element={<Navigate to={settingsPath("skills")} replace />}
            />
            <Route path="/dashboard" element={<Navigate to={settingsPath("status")} replace />} />

            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </Suspense>
        <ToastHost />
      </div>

      {settingsOpen && (
        <Routes>
          <Route
            path="/settings"
            element={<Navigate to={settingsPath("general")} replace state={location.state} />}
          />
          <Route
            path="/settings/:section"
            element={<SettingsDialog backgroundPath={backgroundPath} />}
          />
        </Routes>
      )}
    </div>
  );
}
