// Chat page: connection banner, model/agent/preset pickers, the streaming
// transcript, and the composer (send / stop / attach). The protocol and state
// machine come from @platform/core — this file is rendering + input only.

import { useEffect, useRef, useState } from "react";
import { Input, Picker, ScrollView, Text, Textarea, View } from "@tarojs/components";
import Taro, { eventCenter, useDidShow } from "@tarojs/taro";
import { useChatStore } from "@platform/core";
import { TurnView } from "@/components/TurnView";
import { authHeaders, LOGIN_REQUIRED_EVENT } from "@/lib/auth";
import { baseUrl, setBaseUrl } from "@/lib/config";
import { drawAllCharts } from "@/lib/charts";
import { runtime } from "@/lib/runtime";

interface Attachment {
  key: string;
  id: string;
  name: string;
  state: "uploading" | "attached" | "error";
  error?: string;
}

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

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachSeq = useRef(0);
  const [showServer, setShowServer] = useState(false);
  const [serverDraft, setServerDraft] = useState(baseUrl());

  useEffect(() => {
    void runtime.boot();
  }, []);

  // A WeChat user with no bound platform account must sign in once. The
  // guard prevents re-navigating while the login page is already on top.
  useEffect(() => {
    const goLogin = () => {
      const stack = Taro.getCurrentPages();
      const current = stack[stack.length - 1]?.route ?? "";
      if (!current.includes("pages/login")) {
        Taro.navigateTo({ url: "/pages/login/index" });
      }
    };
    eventCenter.on(LOGIN_REQUIRED_EVENT, goLogin);
    return () => {
      eventCenter.off(LOGIN_REQUIRED_EVENT, goLogin);
    };
  }, []);

  // Returning from the login page (with a fresh token) lands here: re-boot /
  // reconnect as needed.
  useDidShow(() => {
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

  const modelNames = models.map((m) => m.name || m.id);
  const modelIndex = Math.max(0, models.findIndex((m) => m.id === currentModel));
  const agentNames = agents.map((a) => a.name || a.id);
  const agentIndex = Math.max(0, agents.findIndex((a) => a.id === currentAgent));
  const presetNames = presets.filter((p) => !p.broken).map((p) => p.name);
  const presetIds = presets.filter((p) => !p.broken).map((p) => p.id);
  const presetIndex = Math.max(0, presetIds.indexOf(currentPreset ?? ""));

  return (
    <View className="chat-page">
      {status !== "connected" ? (
        <View className="conn-banner">
          <Text className="conn-text">{status === "connecting" ? "连接中…" : "已断开"}</Text>
          <Text
            className="conn-retry"
            onClick={() => {
              runtime.reconnectNow();
            }}
          >
            重试
          </Text>
        </View>
      ) : null}

      <View className="picker-row">
        <Picker
          mode="selector"
          range={modelNames}
          value={modelIndex}
          disabled={isStreaming || models.length === 0}
          onChange={(e) => {
            const m = models[Number(e.detail.value)];
            if (m && m.id !== currentModel) {
              useChatStore.getState().setPendingConfig("model");
              runtime.send({ type: "set_model", id: m.id });
            }
          }}
        >
          <View className="picker-chip">
            <Text className="picker-chip-text">{models[modelIndex]?.name || "模型"}</Text>
          </View>
        </Picker>

        <Picker
          mode="selector"
          range={agentNames}
          value={agentIndex}
          disabled={isStreaming || agents.length === 0}
          onChange={(e) => {
            const a = agents[Number(e.detail.value)];
            if (a && a.id !== currentAgent) {
              useChatStore.getState().setPendingConfig("model");
              runtime.send({ type: "set_agent", id: a.id });
            }
          }}
        >
          <View className="picker-chip">
            <Text className="picker-chip-text">{agents[agentIndex]?.name || "智能体"}</Text>
          </View>
        </Picker>

        {turns.length === 0 && presets.length > 0 ? (
          <Picker
            mode="selector"
            range={presetNames}
            value={presetIndex}
            disabled={isStreaming}
            onChange={(e) => {
              const id = presetIds[Number(e.detail.value)];
              if (id && id !== currentPreset) {
                useChatStore.getState().setPendingConfig("preset");
                runtime.send({ type: "set_preset", id });
              }
            }}
          >
            <View className="picker-chip">
              <Text className="picker-chip-text">{presets.filter((p) => !p.broken)[presetIndex]?.name || "模式"}</Text>
            </View>
          </Picker>
        ) : null}

        <Text
          className="picker-link"
          onClick={() => {
            useChatStore.getState().clearView();
            runtime.send({ type: "new_session" });
          }}
        >
          新会话
        </Text>
        <Text
          className="picker-link"
          onClick={() => {
            Taro.navigateTo({ url: "/pages/sessions/index" });
          }}
        >
          历史
        </Text>
        <Text className="picker-link" onClick={() => setShowServer((v) => !v)}>
          ⚙
        </Text>
      </View>

      {showServer ? (
        <View className="server-row">
          <Text className="server-label">服务器</Text>
          <Input
            className="server-input"
            value={serverDraft}
            onInput={(e) => setServerDraft(e.detail.value)}
            placeholder="http://localhost:3080"
            placeholderClass="login-placeholder"
          />
          <Text
            className="picker-link"
            onClick={() => {
              const next = serverDraft.trim().replace(/\/+$/, "");
              if (!next) return;
              setBaseUrl(next);
              setServerDraft(next);
              setShowServer(false);
              Taro.showToast({ title: "已保存，重连中…", icon: "none" });
              runtime.reconnectNow();
            }}
          >
            保存
          </Text>
        </View>
      ) : null}

      <ScrollView scrollY className="msg-list" scrollIntoView="msg-bottom" scrollWithAnimation>
        {turns.length === 0 ? (
          <View className="welcome">
            <Text className="welcome-title">有什么可以帮你？</Text>
            <Text className="welcome-sub">输入消息开始对话</Text>
          </View>
        ) : null}
        {turns.map((t) => (
          <View key={t.id} id={t.id} className="turn-wrap">
            <TurnView turn={t} />
          </View>
        ))}
        <View id="msg-bottom" className="msg-bottom" />
      </ScrollView>

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

      <View className="composer">
        <Textarea
          className="composer-input"
          value={draft}
          onInput={(e) => setDraft(e.detail.value)}
          placeholder="输入消息…"
          autoHeight
          maxlength={-1}
          confirmType="send"
          onConfirm={handleSend}
          disabled={isStreaming}
        />
        <View className="composer-actions">
          <Text className="composer-attach" onClick={pickFile}>
            📎
          </Text>
          {isStreaming ? (
            <Text className="composer-stop" onClick={handleStop}>
              停止
            </Text>
          ) : (
            <Text className={`composer-send ${sendDisabled ? "composer-send-disabled" : ""}`} onClick={handleSend}>
              发送
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}
