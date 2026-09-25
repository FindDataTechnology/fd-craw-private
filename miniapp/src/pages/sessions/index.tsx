// Session history: a list from the chat-history REST endpoints and a
// read-only viewer for one session. REST (not the socket) so the page works
// even while the chat connection is down. Also hosts the server-address
// setting (moved here from the chat header by redesign-mp-chat-layout) —
// saving reconnects the shared runtime singleton, so the chat page follows.
// Session sharing (openspec: add-session-share): the viewer gets a share
// action (token + WeChat forward card); the list gets a share-manager section
// (list own tokens, revoke).

import { useCallback, useEffect, useRef, useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import { createShare, getChatSession, listChatSessions, listShares, revokeShare, type ChatMessage, type SessionMeta, type ShareInfo } from "@platform/core";
import { Markdown } from "@/components/Markdown";
import { baseUrl, setBaseUrl } from "@/lib/config";
import { runtime } from "@/lib/runtime";
import { getLastSeen, markSessionSeen, isSessionUnseen } from "@/lib/unread";

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
  const [serverDraft, setServerDraft] = useState(baseUrl());
  // Share state (openspec: add-session-share). tokens: the owner's active
  // shares for the manager section; shareTokenRef: the token the forward
  // card should carry (created when the user taps 分享; the WeChat hook reads
  // it via ref because onShareAppMessage fires when the sheet opens, not on
  // tap).
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const shareTokenRef = useRef<string | null>(null);
  // 每会话上次查看时间(spec: scheduled-task-notifications 的未读推导)。
  // 打开会话即标记;定时任务在别处产出时,这里点亮红点。
  const [lastSeen, setLastSeen] = useState<Record<string, string>>(() => getLastSeen());

  useShareAppMessage(() => ({
    title: "会话分享",
    path: shareTokenRef.current
      ? `/pages/share/index?token=${shareTokenRef.current}`
      : "/pages/sessions/index",
  }));

  const refreshShares = useCallback(() => {
    listShares()
      .then((list) => setShares(list))
      .catch(() => setShares([]));
  }, []);

  const handleShare = async (sessionId: string) => {
    try {
      const { token } = await createShare(sessionId);
      shareTokenRef.current = token;
      refreshShares();
      Taro.showToast({ title: "已生成卡片，点右上角 ⋯ 转发", icon: "none", duration: 2500 });
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || "分享失败", icon: "none" });
    }
  };

  const handleRevoke = async (token: string) => {
    try {
      await revokeShare(token);
      if (shareTokenRef.current === token) shareTokenRef.current = null;
      refreshShares();
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || "撤销失败", icon: "none" });
    }
  };

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

  useEffect(() => {
    refreshShares();
  }, [refreshShares]);

  const open = async (id: string) => {
    setLastSeen(markSessionSeen(id));
    setView({ kind: "loading" });
    try {
      const session = await getChatSession(id);
      setView({ kind: "session", id: session.id, title: session.title, messages: session.messages });
    } catch (err) {
      setView({ kind: "error", message: (err as Error).message });
    }
  };

  const saveServer = () => {
    const next = serverDraft.trim().replace(/\/+$/, "");
    if (!next) return;
    setBaseUrl(next);
    setServerDraft(next);
    Taro.showToast({ title: "已保存，重连中…", icon: "none" });
    runtime.reconnectNow();
  };

  if (view.kind === "session") {
    return (
      <View className="sessions-page">
        <View className="sessions-back" onClick={() => setView({ kind: "list" })}>
          <Text>‹ 返回列表</Text>
        </View>
        <View className="sessions-detail-head">
          {view.title ? <Text className="sessions-detail-title">{view.title}</Text> : null}
          <Text
            className="session-share-btn"
            onClick={() => {
              void handleShare(view.id);
            }}
          >
            分享此会话
          </Text>
        </View>
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
            data-testid="mp-session-item"
            data-unseen={isSessionUnseen(s, lastSeen) ? "true" : "false"}
            onClick={() => {
              void open(s.id);
            }}
          >
            <View className="session-title-row">
              {isSessionUnseen(s, lastSeen) ? <View className="session-unread-dot" /> : null}
              <Text className="session-title">{s.title || "未命名会话"}</Text>
            </View>
            <Text className="session-when">{when(s)}</Text>
          </View>
        ))}
        {view.kind === "list" && sessions.length === 0 ? (
          <View className="sessions-empty">
            <Text>还没有历史会话</Text>
          </View>
        ) : null}
        {view.kind === "list" && shares !== null && shares.length > 0 ? (
          <View className="share-manage">
            <Text className="share-manage-title">共享链接（点击撤销）</Text>
            {shares.map((s) => (
              <View
                key={s.token}
                className="share-row"
                onClick={() => {
                  void handleRevoke(s.token);
                }}
              >
                <Text className="share-row-title">{s.title || s.sessionId}</Text>
                <Text className="share-row-revoke">撤销</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View className="msg-bottom" />
      </ScrollView>
      <View className="sessions-cron-entry" onClick={() => Taro.navigateTo({ url: "/pages/cron/index" })}>
        <Text className="sessions-cron-link">⏰ 定时任务 ›</Text>
      </View>
      <View className="sessions-server">
        <Text className="server-label">服务器</Text>
        <Input
          className="server-input"
          value={serverDraft}
          onInput={(e) => setServerDraft(e.detail.value)}
          placeholder="http://localhost:3080"
          placeholderClass="login-placeholder"
        />
        <Text className="picker-link" onClick={saveServer}>
          保存
        </Text>
      </View>
    </View>
  );
}
