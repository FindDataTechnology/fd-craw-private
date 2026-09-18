// First sign-in on a device: enter the 6-digit BIND CODE minted from your
// authenticated web session. Open the platform in a browser (signed in),
// visit /api/mp/bindcode, and type the code here once — after that the
// openid stays bound and every later launch is silent. No password is ever
// entered in (or reachable from) the mini program.

import { useState } from "react";
import { Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { loginWithBindCode, logout } from "@/lib/auth";
import { baseUrl as currentBaseUrl, setBaseUrl, token } from "@/lib/config";
import { runtime } from "@/lib/runtime";

export default function LoginPage() {
  const [bindCode, setBindCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showServer, setShowServer] = useState(false);
  const [serverDraft, setServerDraft] = useState(currentBaseUrl());
  const hasToken = Boolean(token());

  const submit = async () => {
    if (busy) return;
    const normalized = bindCode.trim();
    if (!/^\d{6}$/.test(normalized)) {
      setError("请输入 6 位数字绑定码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await loginWithBindCode(normalized);
      Taro.showToast({ title: "绑定成功", icon: "success" });
      // Returning to the chat page fires its foreground hook, which re-boots
      // the runtime with the fresh token.
      setTimeout(() => Taro.navigateBack({ fail: () => Taro.reLaunch({ url: "/pages/chat/index" }) }), 400);
    } catch (err) {
      setError((err as Error).message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  const unbind = async () => {
    await logout();
    Taro.showToast({ title: "已退出登录", icon: "none" });
    setBindCode("");
  };

  return (
    <View className="login-page">
      <View className="login-card">
        <Text className="login-title">登录 Platform</Text>
        <Text className="login-sub">
          在电脑浏览器登录平台后，打开「/api/mp/bindcode」获取 6 位绑定码，在此输入一次即完成绑定。之后打开小程序将自动登录，无需再输。
        </Text>

        <View className="login-field">
          <Text className="login-label">绑定码</Text>
          <Input
            className="login-input login-code-input"
            type="number"
            value={bindCode}
            onInput={(e) => setBindCode(e.detail.value)}
            placeholder="6 位数字"
            placeholderClass="login-placeholder"
            maxlength={6}
          />
        </View>

        {error ? <Text className="login-error">{error}</Text> : null}

        <View className={`login-submit ${busy ? "login-submit-disabled" : ""}`} onClick={submit}>
          <Text className="login-submit-text">{busy ? "绑定中…" : "绑定当前微信"}</Text>
        </View>

        <Text className="login-unbind" onClick={() => setShowServer((v) => !v)}>
          服务器地址：{currentBaseUrl()}
        </Text>
        {showServer ? (
          <View className="login-field">
            <Input
              className="login-input"
              value={serverDraft}
              onInput={(e) => setServerDraft(e.detail.value)}
              placeholder="http://localhost:3000 或网关地址"
              placeholderClass="login-placeholder"
            />
            <Text
              className="picker-link"
              onClick={() => {
                setBaseUrl(serverDraft.trim());
                Taro.showToast({ title: "已保存，重连中…", icon: "none" });
                setShowServer(false);
                runtime.reconnectNow();
              }}
            >
              保存并重连
            </Text>
          </View>
        ) : null}

        {hasToken ? (
          <Text className="login-unbind" onClick={unbind}>
            退出登录并解绑当前微信
          </Text>
        ) : null}
      </View>
    </View>
  );
}
