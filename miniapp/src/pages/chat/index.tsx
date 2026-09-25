// Chat page: connection banner, three-zone header (history / combined
// agent·model chip / new session), the streaming transcript with suggested
// prompts on the empty state, and the card composer (attach / send / stop).
// The protocol and state machine come from @platform/core — this file is
// rendering + input only.

import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro, { eventCenter, useDidShow, useShareAppMessage } from "@tarojs/taro";
import { createShare, useChatStore } from "@platform/core";
import { OutlineRail, type OutlineEntry } from "@/components/OutlineRail";
import { SelectionPanel, type PanelPickKind, type PanelRow } from "@/components/SelectionPanel";
import { recentStrip, relativeTime, showcaseCards } from "@/lib/showcase";
import { TurnView } from "@/components/TurnView";
import { authHeaders, isDemoAccount, LOGIN_REQUIRED_EVENT, recordEmail } from "@/lib/auth";
import { clearToken, enterDemoBase, exitDemoBase, isDemoBase } from "@/lib/config";
import { baseUrl } from "@/lib/config";
import { drawAllCharts } from "@/lib/charts";
import { runtime } from "@/lib/runtime";
import { getLastSeen, isSessionUnseen } from "@/lib/unread";

interface Attachment {
  key: string;
  id: string;
  name: string;
  state: "uploading" | "attached" | "error";
  error?: string;
}

// Welcome suggested prompts: prefills the draft, never auto-sends (the web
// ChatWelcome contract). Texts mirror web/src/locales/zh-CN/common.json —
// the MP has no i18n runtime, so they live here as literals.
const PROMPTS: { title: string; text: string }[] = [
  { title: "检索文档库", text: "总结文档库中最近上传文档的关键要点" },
  { title: "发现技能", text: "列出当前可用的技能，并说明各自的用途" },
  { title: "查证问题", text: "帮我查证一个技术问题，并给出信息来源" },
  { title: "整理写作", text: "帮我把下面的要点整理成一份简洁的周报：\n- 要点一\n- 要点二" },
];

export default function ChatPage() {
  const status = useChatStore((s) => s.status);
  const turns = useChatStore((s) => s.turns);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const pendingConfig = useChatStore((s) => s.pendingConfig);
  const models = useChatStore((s) => s.models);
  const currentModel = useChatStore((s) => s.currentModel);
  const agents = useChatStore((s) => s.agents);
  const currentAgent = useChatStore((s) => s.currentAgent);
  const presets = useChatStore((s) => s.presets);
  const currentPreset = useChatStore((s) => s.currentPreset);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  // 入口浮现(spec: scheduled-task-notifications):任何会话有未看新内容时,
  // ☰ 上点亮红点。lastSeen 随 sessions 变化重读(点开会话后 sessions 广播
  // 会刷新,红点随之熄灭)。
  const historyUnread = useMemo(() => {
    const seen = getLastSeen();
    return sessions.some((s) => s.id !== useChatStore.getState().currentSessionId && isSessionUnseen(s, seen));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachSeq = useRef(0);
  const [panelOpen, setPanelOpen] = useState(false);
  // No-bound-account state (non-demo deployments): the page stays browsable
  // with a sign-in banner — never an automatic jump to the login page
  // (openspec: mp-demo-mode; WeChat's forced-login rule). Demo deployments
  // never reach this state (every openid gets a demo token).
  const [unbound, setUnbound] = useState(runtime.loginRequiredNow());
  const [demo, setDemo] = useState(isDemoAccount() || isDemoBase());
  // Keyboard handling: adjustPosition (WeChat's default page-push) does not
  // move the bottom-docked composer reliably, so the keyboard callback lifts
  // the composer itself (padding = keyboard height) and re-sticks the
  // transcript to the bottom.
  const [kbHeight, setKbHeight] = useState(0);
  const [scrollAnchor, setScrollAnchor] = useState(true);
  // ── outline navigation (add-chat-outline) ─────────────────────────────
  // jumpTarget: the turn id a tap is scrolling to; cleared after the scroll
  // settles so the same entry can be re-tapped. stickBottom: the stickiness
  // a jump releases — while false, streaming renders never point
  // scrollIntoView at msg-bottom, so deltas cannot yank the view; the
  // onScroll listener re-arms it when the user returns near the bottom.
  // flashId: the turn-wrap highlight class carrier (~1.2s).
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [stickBottom, setStickBottom] = useState(true);
  const [flashId, setFlashId] = useState<string | null>(null);
  const listViewH = useRef(0);

  useEffect(() => {
    void runtime.boot();
  }, []);

  // Outline jumps need the ScrollView's viewport height to detect "back at
  // the bottom" (onScroll gives scrollHeight/scrollTop, not the view size).
  useEffect(() => {
    const q = Taro.createSelectorQuery();
    q.select(".msg-list").boundingClientRect((r) => {
      const rect = Array.isArray(r) ? r[0] : r;
      if (rect && typeof rect.height === "number") listViewH.current = rect.height;
    });
    q.exec();
  }, []);

  // Jump to a user turn: release stickiness FIRST (streaming deltas must not
  // yank the view back), point scrollIntoView at the target, flash the turn
  // wrap, then clear the jump target so the entry is re-tappable.
  const jumpToTurn = (id: string) => {
    setStickBottom(false);
    setJumpTarget(id);
    setFlashId(id);
    setTimeout(() => setJumpTarget((cur) => (cur === id ? null : cur)), 600);
    setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1300);
  };

  const handleListScroll = (e: { detail: { scrollTop: number; scrollHeight: number } }) => {
    const d = e.detail;
    const viewH = listViewH.current;
    if (viewH > 0 && d.scrollHeight - d.scrollTop - viewH < 80) setStickBottom(true);
  };

  // The outline: user turns, first line only (CSS ellipsis truncates).
  const outlineEntries: OutlineEntry[] = useMemo(
    () =>
      turns
        .filter((t) => t.role === "user")
        .map((t) => ({ id: t.id, text: t.text.split("\n")[0] })),
    [turns],
  );

  // A WeChat user with no bound platform account signs in voluntarily: the
  // event only flips banner state; navigation happens on the user's tap
  // (banner or send). WeChat rejects forced login before browsing.
  useEffect(() => {
    const markUnbound = () => setUnbound(true);
    eventCenter.on(LOGIN_REQUIRED_EVENT, markUnbound);
    return () => {
      eventCenter.off(LOGIN_REQUIRED_EVENT, markUnbound);
    };
  }, []);

  // A completed sign-in (or demo login) clears the banner once the socket is
  // actually up; returning from the login page re-checks demo-ness with the
  // fresh identity.
  useEffect(() => {
    if (status === "connected") setUnbound(false);
  }, [status]);

  // ── session share (openspec: add-session-share) ─────────────────────────
  // The forward card needs a token, but WeChat calls onShareAppMessage when
  // the sheet opens — so the header button pre-creates the token (awaited,
  // toast confirms) and the hook reads the latest one via ref. Before any
  // token exists the card falls back to the chat page itself.
  const shareTokenRef = useRef<string | null>(null);
  const sessionId = useChatStore((s) => s.currentSessionId);

  useShareAppMessage(() => ({
    title: "会话分享",
    path: shareTokenRef.current
      ? `/pages/share/index?token=${shareTokenRef.current}`
      : "/pages/chat/index",
  }));

  const handleShare = async () => {
    if (runtime.loginRequiredNow()) {
      goLogin();
      return;
    }
    if (!sessionId) {
      Taro.showToast({ title: "还没有可分享的会话", icon: "none" });
      return;
    }
    try {
      const { token } = await createShare(sessionId);
      shareTokenRef.current = token;
      Taro.showToast({ title: "已生成卡片，点右上角 ⋯ 转发", icon: "none", duration: 2500 });
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || "分享失败", icon: "none" });
    }
  };

  const goLogin = () => {
    const stack = Taro.getCurrentPages();
    const current = stack[stack.length - 1]?.route ?? "";
    if (!current.includes("pages/login")) {
      Taro.navigateTo({ url: "/pages/login/index" });
    }
  };

  // Demo sandbox entry/exit (openspec: mp-demo-sandbox): switching origins is
  // a full runtime re-boot; the platform token is meaningless on the authless
  // demo pod, and restoring the origin re-runs the (unbound) login probe.
  const enterDemo = () => {
    enterDemoBase();
    clearToken();
    recordEmail("");
    setUnbound(false);
    setDemo(true);
    void runtime.switchBase();
  };

  const exitDemo = () => {
    exitDemoBase();
    setDemo(false);
    void runtime.switchBase();
  };

  // Returning from the login page (with a fresh token) lands here: re-boot /
  // reconnect as needed.
  useDidShow(() => {
    setDemo(isDemoAccount() || isDemoBase());
    runtime.onForeground();
  });

  // Charts live in `echarts` fences of COMPLETED assistant turns; draw any
  // freshly registered canvases once layout has settled.
  useEffect(() => {
    const timer = setTimeout(() => drawAllCharts(), 50);
    return () => clearTimeout(timer);
  }, [turns]);

  const sendDisabled = isStreaming || pendingConfig !== null;

  const handleSend = () => {
    if (isStreaming) return;
    // Sending without a bound account is the voluntary sign-in trigger.
    if (runtime.loginRequiredNow()) {
      goLogin();
      return;
    }
    const text = draft.trim();
    const attached = attachments.filter((a) => a.state === "attached");
    if (!text && attached.length === 0) return;
    // @doc:<id> refs — the server expands the ingested document into the
    // agent's context (the web composer's exact contract).
    const refs = attached.map((a) => `@doc:${a.id}`).join(" ");
    const full = refs ? (text ? `${text} ${refs}` : refs) : text;
    runtime.send({ type: "prompt", text: full });
    setDraft("");
    setAttachments([]);
    // A fresh prompt belongs at the bottom — re-arm stickiness even if an
    // earlier outline jump released it.
    setStickBottom(true);
  };

  const handleStop = () => {
    // Local finalize: dsh has no interrupt RPC — the store closes the open
    // turn and swallows the orphaned run's remaining events.
    useChatStore.getState().stopStreaming();
  };

  const pickFile = async () => {
    let picked: Taro.chooseMessageFile.SuccessCallbackResult | null = null;
    try {
      picked = await Taro.chooseMessageFile({ count: 1, type: "file" });
    } catch {
      return; // picker cancelled
    }
    const file = picked.tempFiles?.[0];
    if (!file) return;
    const key = `att-${++attachSeq.current}`;
    const name = file.name || "文件";
    setAttachments((a) => [...a, { key, id: "", name, state: "uploading" }]);
    try {
      const up = await Taro.uploadFile({
        url: `${baseUrl()}/api/documents`,
        filePath: file.path,
        name: "file",
        header: authHeaders(),
      });
      let body: { id?: string; name?: string; error?: string } = {};
      try {
        body = JSON.parse(up.data || "{}");
      } catch {
        /* non-JSON error body */
      }
      if (up.statusCode >= 200 && up.statusCode < 300 && body.id) {
        setAttachments((a) =>
          a.map((x) => (x.key === key ? { ...x, id: body.id ?? "", name: body.name || name, state: "attached" } : x)),
        );
      } else {
        const message = String(body.error || `HTTP ${up.statusCode}`).slice(0, 120);
        setAttachments((a) => a.map((x) => (x.key === key ? { ...x, state: "error", error: message } : x)));
        Taro.showToast({ title: message, icon: "none" });
      }
    } catch (err) {
      const message = String((err as Error)?.message || "上传失败").slice(0, 120);
      setAttachments((a) => a.map((x) => (x.key === key ? { ...x, state: "error", error: message } : x)));
      Taro.showToast({ title: message, icon: "none" });
    }
  };

  const removeAttachment = (key: string) => {
    setAttachments((a) => a.filter((x) => x.key !== key));
  };

  // ── header + selection panel ──────────────────────────────────────────

  const agentName = agents.find((a) => a.id === currentAgent)?.name;
  // Agent-first label (openspec: redesign-mp-home): the collapsed chip names
  // WHO you're talking to; the model stays inside the selection panel
  // (modelRows already carries it there).
  const chipLabel = agentName || "FD";

  const modelRows: PanelRow[] = models.map((m) => ({ id: m.id, label: m.name || m.id }));
  const agentRows: PanelRow[] = agents.map((a) => ({ id: a.id, label: a.name || a.id }));
  const okPresets = presets.filter((p) => !p.broken);
  const presetRows: PanelRow[] = okPresets.map((p) => ({ id: p.id, label: p.name }));
  // Preset switching bakes into a fresh dsh child — offered on blank
  // sessions only, matching the web welcome surface.
  const showPresets = turns.length === 0 && presets.length > 0;

  const openPanel = () => {
    if (isStreaming || pendingConfig !== null) return;
    try {
      const r = Taro.hideKeyboard() as unknown;
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(() => {});
    } catch {
      /* keyboard not up / API unavailable */
    }
    setPanelOpen(true);
  };

  const handlePick = (kind: PanelPickKind, id: string) => {
    if (isStreaming || pendingConfig !== null) return;
    const store = useChatStore.getState();
    if (kind === "model" && id !== currentModel) {
      store.setPendingConfig("model");
      runtime.send({ type: "set_model", id });
    } else if (kind === "agent" && id !== currentAgent) {
      store.setPendingConfig("agent");
      runtime.send({ type: "set_agent", id });
    } else if (kind === "preset" && id !== currentPreset) {
      store.setPendingConfig("preset");
      runtime.send({ type: "set_preset", id });
    }
  };

  // ── regenerate: the web Chat.tsx contract — re-send the last user prompt
  // as a new appended turn (dsh has no replace-turn RPC); offered only on
  // the latest assistant turn while idle.
  const lastUserText = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "user") return t.text;
    }
    return null;
  }, [turns]);
  const lastAssistantId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.role === "assistant") return t.id;
    }
    return null;
  }, [turns]);
  const regenerate =
    !isStreaming && lastUserText
      ? () => {
          runtime.send({ type: "prompt", text: lastUserText });
        }
      : undefined;

  // ── home showcase (openspec: redesign-mp-home) ────────────────────────
  const cards = useMemo(() => showcaseCards(agents), [agents]);
  const recent = useMemo(() => recentStrip(sessions, currentSessionId), [sessions, currentSessionId]);

  // A bound user's prompt tap prefills; an unbound user's tap is the one-hop
  // try-out — enter the demo with the prompt carried into the draft (the
  // page stays mounted across the base switch, so setState carries it over).
  const handlePromptTap = (text: string) => {
    setDraft(text);
    if (runtime.loginRequiredNow()) enterDemo();
  };

  return (
    <View className="chat-page">
      {/* One quiet status area (openspec: redesign-mp-home): connection
          trouble is a slim tap-to-retry line, the demo origin is one notice
          line — never stacked full-width banners. The unbound sign-in
          affordance lives INSIDE the welcome as its CTA. */}
      {status !== "connected" ? (
        <View className="conn-line" onClick={() => runtime.reconnectNow()}>
          <Text className="conn-line-dot" />
          <Text className="conn-line-text">
            {status === "connecting" ? "连接中…" : "已断开 · 点击重试"}
          </Text>
        </View>
      ) : null}

      {demo && status === "connected" ? (
        isDemoBase() ? (
          <View className="demo-line">
            <Text className="demo-line-text">演示环境 · 数据定期清空</Text>
            <Text className="demo-line-link" onClick={exitDemo}>
              退出演示 ›
            </Text>
          </View>
        ) : (
          <View className="demo-line">
            <Text className="demo-line-text">体验模式 · 额度有限</Text>
            <Text className="demo-line-link" onClick={goLogin}>
              绑定账号解锁完整功能 ›
            </Text>
          </View>
        )
      ) : null}

      <View className="chat-header">
        <View className="hd-side">
          <Text
            className="hd-btn"
            onClick={() => {
              Taro.navigateTo({ url: "/pages/sessions/index" });
            }}
          >
            ☰{historyUnread ? <Text className="hd-unread-dot" /> : null}
          </Text>
          <Text className="hd-btn" onClick={() => void handleShare()}>
            ↗
          </Text>
        </View>
        <View
          className={`hd-chip${sendDisabled ? " hd-chip-disabled" : ""}`}
          onClick={openPanel}
        >
          <Text className="hd-chip-text">{chipLabel}</Text>
          <Text className="hd-chip-caret">▾</Text>
        </View>
        <View className="hd-side hd-side-right">
          <Text
            className="hd-btn"
            onClick={() => {
              // Every tap answers (openspec: revise-mp-history-ux): the
              // button must never read as broken. Blank-session taps stay
              // idempotent (no duplicate session) — they just say so now.
              if (turns.length === 0) {
                Taro.showToast({ title: "已是新对话", icon: "none" });
                return;
              }
              useChatStore.getState().clearView();
              runtime.send({ type: "new_session" });
              Taro.showToast({ title: "已开启新对话", icon: "none" });
            }}
          >
            ＋
          </Text>
        </View>
      </View>

      <ScrollView
        scrollY
        className="msg-list"
        scrollIntoView={jumpTarget ?? (scrollAnchor && stickBottom ? "msg-bottom" : "")}
        scrollWithAnimation
        onScroll={(e) => handleListScroll(e)}
      >
        {turns.length === 0 ? (
          <View className="welcome">
            <Text className="welcome-brand">FD · 你的行业 AI 助手</Text>

            {unbound && status !== "connected" ? (
              <View className="welcome-cta">
                <View className="cta-primary" onClick={enterDemo}>
                  <Text className="cta-primary-text">先体验 · 免登录直接对话</Text>
                </View>
                <Text className="cta-secondary" onClick={goLogin}>
                  已有平台账号？去登录 ›
                </Text>
              </View>
            ) : null}

            {cards.length > 0 ? (
              <View className="showcase-grid">
                {cards.map((c) => (
                  <View
                    key={c.id}
                    className={`showcase-card${c.general ? " showcase-card-general" : ""}`}
                    onClick={() => handlePick("agent", c.id)}
                  >
                    <Text className="showcase-card-name">{c.name}</Text>
                    {c.description ? <Text className="showcase-card-desc">{c.description}</Text> : null}
                  </View>
                ))}
              </View>
            ) : null}

            <View className="welcome-cards">
              {PROMPTS.map((p) => (
                <View
                  key={p.title}
                  className="welcome-card"
                  onClick={() => {
                    handlePromptTap(p.text);
                  }}
                >
                  <Text className="welcome-card-title">{p.title}</Text>
                  <Text className="welcome-card-text">{p.text}</Text>
                </View>
              ))}
            </View>

            {recent.length > 0 ? (
              <View className="recent-strip">
                {recent.map((s) => (
                  <View
                    key={s.id}
                    className="recent-item"
                    onClick={() => runtime.send({ type: "switch_session", id: s.id })}
                  >
                    <Text className="recent-title">{s.title || "新对话"}</Text>
                    <Text className="recent-time">{relativeTime(s.updatedAt ?? s.createdAt)}</Text>
                  </View>
                ))}
              </View>
            ) : null}

            <Text
              className="welcome-history"
              onClick={() => {
                Taro.navigateTo({ url: "/pages/sessions/index" });
              }}
            >
              查看历史 ›
            </Text>
          </View>
        ) : null}
        {turns.map((t) => (
          <View key={t.id} id={t.id} className={t.id === flashId ? "turn-wrap turn-flash" : "turn-wrap"}>
            <TurnView turn={t} onRegenerate={t.id === lastAssistantId ? regenerate : undefined} />
          </View>
        ))}
        <View id="msg-bottom" className="msg-bottom" />
      </ScrollView>

      <View
        className="composer"
        style={kbHeight > 0 ? { paddingBottom: `${kbHeight + 8}px` } : undefined}
      >
        <View className="composer-card">
          {attachments.length > 0 ? (
            <View className="chips">
              {attachments.map((a) => (
                <View key={a.key} className={`chip chip-${a.state}`}>
                  <Text className="chip-name">
                    {a.name}
                    {a.state === "uploading" ? " · 上传中" : a.state === "error" ? " · 失败" : ""}
                  </Text>
                  <Text className="chip-x" onClick={() => removeAttachment(a.key)}>
                    ✕
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          <Textarea
            className="composer-input"
            value={draft}
            onInput={(e) => setDraft(e.detail.value)}
            placeholder="输入消息…"
            autoHeight
            maxlength={-1}
            confirmType="send"
            onConfirm={handleSend}
            adjustPosition={false}
            onKeyboardHeightChange={(e) => {
              const h = e.detail.height || 0;
              setKbHeight(h);
              if (h > 0) {
                setScrollAnchor(false);
                setTimeout(() => setScrollAnchor(true), 80);
              }
            }}
          />
          <View className="composer-actions">
            <Text className="composer-attach" onClick={pickFile}>
              📎
            </Text>
            {isStreaming ? (
              <View className="composer-stop" onClick={handleStop}>
                <Text className="composer-stop-glyph">■</Text>
              </View>
            ) : (
              <View
                className={`composer-send${pendingConfig !== null ? " composer-send-disabled" : ""}`}
                onClick={handleSend}
              >
                <Text className="composer-send-glyph">↑</Text>
              </View>
            )}
          </View>
        </View>
      </View>

      <SelectionPanel
        visible={panelOpen}
        agents={agentRows}
        models={modelRows}
        presets={presetRows}
        showPresets={showPresets}
        currentAgent={currentAgent}
        currentModel={currentModel}
        currentPreset={currentPreset}
        disabled={sendDisabled}
        onPick={handlePick}
        onClose={() => setPanelOpen(false)}
      />

      {outlineEntries.length >= 3 ? (
        <OutlineRail entries={outlineEntries} onJump={jumpToTurn} />
      ) : null}
    </View>
  );
}
