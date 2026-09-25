// Session history (revise-mp-history-ux): the list is a SWITCHER — tapping
// a row continues that conversation in the live chat (switch_session +
// navigate back); the old in-page read-only viewer is retired, so live and
// past transcripts share the chat page's single renderer. Secondary surfaces
// (share tokens, scheduled tasks, server settings) live in collapsed groups
// under the list. REST (not the socket) still feeds the LIST itself, so the
// page works while the chat connection is down.

import { useCallback, useEffect, useRef, useState } from "react";
import { Input, ScrollView, Text, View } from "@tarojs/components";
import Taro, { useShareAppMessage } from "@tarojs/taro";
import { createShare, listChatSessions, listShares, revokeShare, useCronStore, type SessionMeta, type ShareInfo } from "@platform/core";
import { baseUrl, setBaseUrl } from "@/lib/config";
import { runtime } from "@/lib/runtime";
import { getLastSeen, markSessionSeen, isSessionUnseen } from "@/lib/unread";

type ViewState = { kind: "list" } | { kind: "loading" } | { kind: "error"; message: string };

function when(meta: SessionMeta): string {
  const raw = meta.updatedAt ?? meta.createdAt;
  if (raw === undefined || raw === null) return "";
  const ms = typeof raw === "number" ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Collapsed-by-default section under the session list (design D3). Header
// carries the optional count and unread badge; the body renders on expand.
// Collapse state is per-page-visit — nothing persists.
function Group({
  title,
  count,
  badge,
  children,
}: {
  title: string;
  count?: number;
  badge?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="grp-sec">
      <View className="grp-sec-hd" onClick={() => setOpen((v) => !v)}>
        {badge ? <View className="session-unread-dot" /> : null}
        <Text className="grp-sec-title">{title}</Text>
        {typeof count === "number" && count > 0 ? <Text className="grp-sec-count">{count}</Text> : null}
        <Text className="grp-sec-caret">{open ? "▾" : "▸"}</Text>
      </View>
      {open ? <View className="grp-sec-body">{children}</View> : null}
    </View>
  );
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [serverDraft, setServerDraft] = useState(baseUrl());
  // Share state (openspec: add-session-share). tokens: the owner's active
  // shares for the 我的分享 group; shareTokenRef: the token the forward card
  // should carry (created on a row's ↗ tap; the WeChat hook reads it via ref
  // because onShareAppMessage fires when the sheet opens, not on tap).
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const shareTokenRef = useRef<string | null>(null);
  // 每会话上次查看时间(spec: scheduled-task-notifications 的未读推导)。
  // 打开会话即标记;定时任务在别处产出时,组头/☰ 点亮红点。
  const [lastSeen, setLastSeen] = useState<Record<string, string>>(() => getLastSeen());
  const cronJobs = useCronStore((s) => s.jobs);

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

  // Tap-to-continue (route B): one action views AND continues the past. The
  // WS switch drives the chat store; the chat page renders the loaded turns
  // with the live transcript renderer. Navigating back lands the user there
  // with the composer ready.
  const open = (id: string) => {
    setLastSeen(markSessionSeen(id));
    runtime.send({ type: "switch_session", id });
    Taro.navigateBack({
      fail: () => Taro.reLaunch({ url: "/pages/chat/index" }),
    });
  };

  const saveServer = () => {
    const next = serverDraft.trim().replace(/\/+$/, "");
    if (!next) return;
    setBaseUrl(next);
    setServerDraft(next);
    Taro.showToast({ title: "已保存，重连中…", icon: "none" });
    runtime.reconnectNow();
  };

  const unseenCount = sessions.filter((s) => isSessionUnseen(s, lastSeen)).length;

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
              open(s.id);
            }}
          >
            <View className="session-title-row">
              {isSessionUnseen(s, lastSeen) ? <View className="session-unread-dot" /> : null}
              <Text className="session-title">{s.title || "未命名会话"}</Text>
            </View>
            <View className="session-meta-row">
              <Text className="session-when">{when(s)}</Text>
              <Text
                className="session-share-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleShare(s.id);
                }}
              >
                ↗
              </Text>
            </View>
          </View>
        ))}
        {view.kind === "list" && sessions.length === 0 ? (
          <View className="sessions-empty">
            <Text>还没有历史会话</Text>
          </View>
        ) : null}

        <View className="grp-groups">
          <Group title="我的分享" count={shares?.length ?? 0}>
            {shares !== null && shares.length > 0 ? (
              shares.map((s) => (
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
              ))
            ) : (
              <Text className="grp-sec-empty">暂无分享链接</Text>
            )}
          </Group>
          <Group title="⏰ 定时任务" count={cronJobs.length} badge={unseenCount > 0}>
            <View
              className="grp-sec-link"
              onClick={() => Taro.navigateTo({ url: "/pages/cron/index" })}
            >
              <Text>打开定时任务 ›</Text>
            </View>
          </Group>
          <Group title="服务器与高级设置">
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
          </Group>
        </View>
        <View className="msg-bottom" />
      </ScrollView>
    </View>
  );
}
