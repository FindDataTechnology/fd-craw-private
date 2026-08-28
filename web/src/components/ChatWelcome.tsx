// ChatWelcome — the empty-state surface for the chat page.
//
// Rendered when `turns.length === 0` (mutually exclusive with `<Chat /> +
// <ChatHeader /> + <Composer />`). Greets the user, surfaces 4 suggested prompt
// cards, lists the last 5 sessions, and shows the active model/agent as a
// subtle footer. The prompts are hard-coded for v1; a `prompts` prop lets a
// future change override from config (`agents.json` or a dedicated welcome-
// prompts.json) without touching this component.

import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Code2, BarChart3, FileText, Search } from "lucide-react";
import { useChatStore } from "@/hooks/useChatStore";
import type { ClientMessage } from "@/types/ws";
import type { LucideIcon } from "lucide-react";

export interface SuggestedPrompt {
  title: string;
  prompt: string;
  icon: LucideIcon;
  i18nKey?: string; // optional override for the title (otherwise title is literal)
}

const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  { title: "Write code", prompt: "Help me write a function that ", icon: Code2 },
  { title: "Analyze data", prompt: "Analyze this data: ", icon: BarChart3 },
  { title: "Summarize a document", prompt: "Summarize the key points of ", icon: FileText },
  { title: "Research a topic", prompt: "Research the following topic: ", icon: Search },
];

interface Props {
  prompts?: SuggestedPrompt[];
  // The Composer-level `send` is plumbed through the page; the welcome
  // component reuses it so clicking a suggested prompt behaves like hitting
  // Enter on the composer (no extra WS plumbing).
  send: (m: ClientMessage) => void;
}

export function ChatWelcome({ prompts = DEFAULT_PROMPTS, send }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sessions = useChatStore((s) => s.sessions);
  const currentModel = useChatStore((s) => s.currentModel);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const agents = useChatStore((s) => s.agents);

  // Most-recently-updated first; cap at 5. updatedAt is string | number
  // (legacy stores used epoch ms); coerce to a string for the comparison.
  const recent = useMemo(
    () =>
      sessions
        .slice()
        .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
        .slice(0, 5),
    [sessions],
  );

  const agentName = useMemo(() => {
    if (!currentAgent || currentAgent === "local") return null;
    return agents.find((a) => a.id === currentAgent)?.name || currentAgent;
  }, [currentAgent, agents]);

  return (
    <div
      data-testid="chat-welcome"
      className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-10"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        {/* Greeting */}
        <h1 className="text-2xl font-semibold text-foreground">
          {t("chat.welcome.greeting")}
        </h1>

        {/* Suggested prompts */}
        <section aria-labelledby="welcome-prompts-heading" className="flex flex-col gap-3">
          <h2 id="welcome-prompts-heading" className="text-sm font-medium text-muted-foreground">
            {t("chat.welcome.suggestedPrompts")}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {prompts.map((p) => {
              const Icon = p.icon;
              return (
                <button
                  key={p.prompt}
                  type="button"
                  data-testid="welcome-prompt-card"
                  onClick={() => {
                    if (send) send({ type: "prompt", text: p.prompt });
                  }}
                  className="group flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/50"
                >
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                  <div className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium text-foreground">{p.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{p.prompt}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Recent chats — hidden when empty */}
        {recent.length > 0 && (
          <section aria-labelledby="welcome-recent-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 id="welcome-recent-heading" className="text-sm font-medium text-muted-foreground">
                {t("chat.welcome.recentChats")}
              </h2>
              <button
                type="button"
                data-testid="welcome-view-all"
                onClick={() => navigate("/chat")}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t("chat.welcome.viewAll")}
              </button>
            </div>
            <ul className="flex flex-col gap-1">
              {recent.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    data-testid="welcome-recent-row"
                    data-session-id={s.id}
                    onClick={() => send({ type: "switch_session", id: s.id })}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="truncate text-foreground">{s.title}</span>
                    {s.updatedAt && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {new Date(s.updatedAt).toLocaleString()}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Footer: model + agent */}
        <footer className="flex items-center gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
          {currentModel && (
            <button
              type="button"
              data-testid="welcome-model-footer"
              onClick={() => navigate("/models")}
              className="rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
            >
              {t("chat.welcome.modelFooter", { model: currentModel })}
            </button>
          )}
          {agentName && (
            <button
              type="button"
              data-testid="welcome-agent-footer"
              onClick={() => navigate("/agents")}
              className="rounded-md px-2 py-1 hover:bg-muted hover:text-foreground"
            >
              {t("chat.welcome.agentFooter", { agent: agentName })}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
