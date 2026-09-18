// Session history: a list from the chat-history REST endpoints and a
// read-only viewer for one session. REST (not the socket) so the page works
// even while the chat connection is down.

import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "@tarojs/components";
import { getChatSession, listChatSessions, type ChatMessage, type SessionMeta } from "@platform/core";
import { Markdown } from "@/components/Markdown";
import { runtime } from "@/lib/runtime";

type ViewState =
  | { kind: "list" }
  | { kind: "loading" }
  | { kind: "session"; id: string; title?: string; messages: ChatMessage[] }
  | { kind: "error"; message: string };

function when(meta: SessionMeta): string {
  const raw = meta.updatedAt ?? meta.createdAt;
  if (raw === undefined || raw === null) return "";
  const ms = typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ready = await runtime.ensureReady();
      if (!ready) {
        if (!cancelled) setView({ kind: "error", message: "无法连接服务器" });
        return;
      }
      try {
        const list = await listChatSessions();
        if (!cancelled) {
          setSessions(list);
          setView({ kind: "list" });
        }
      } catch (err) {
        if (!cancelled) setView({ kind: "error", message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const open = async (id: string) => {
    setView({ kind: "loading" });
    try {
      const session = await getChatSession(id);
      setView({ kind: "session", id: session.id, title: session.title, messages: session.messages });
    } catch (err) {
      setView({ kind: "error", message: (err as Error).message });
    }
  };

  if (view.kind === "session") {
    return (
      <View className="sessions-page">
        <View className="sessions-back" onClick={() => setView({ kind: "list" })}>
          <Text>‹ 返回列表</Text>
        </View>
        {view.title ? <Text className="sessions-detail-title">{view.title}</Text> : null}
        <ScrollView scrollY className="sessions-detail">
          {view.messages.map((m, i) =>
            m.role === "user" ? (
              <View key={i} className="turn turn-user">
                <Text className="turn-user-text" selectable userSelect>
                  {m.content}
                </Text>
              </View>
            ) : (
              <View key={i} className="turn turn-assistant">
                <View className="blk blk-text">
                  <Markdown text={m.content} />
                </View>
              </View>
            ),
          )}
          <View className="msg-bottom" />
        </ScrollView>
      </View>
    );
  }

  return (
    <View className="sessions-page">
      {view.kind === "error" ? (
        <View className="sessions-error">
          <Text>{view.message}</Text>
        </View>
      ) : null}
      {view.kind === "loading" ? (
        <View className="sessions-loading">
          <Text>加载中…</Text>
        </View>
      ) : null}
      <ScrollView scrollY className="sessions-list">
        {sessions.map((s) => (
          <View
            key={s.id}
            className="session-item"
            onClick={() => {
              void open(s.id);
            }}
          >
            <Text className="session-title">{s.title || "未命名会话"}</Text>
            <Text className="session-when">{when(s)}</Text>
          </View>
        ))}
        {view.kind === "list" && sessions.length === 0 ? (
          <View className="sessions-empty">
            <Text>还没有历史会话</Text>
          </View>
        ) : null}
        <View className="msg-bottom" />
      </ScrollView>
    </View>
  );
}
