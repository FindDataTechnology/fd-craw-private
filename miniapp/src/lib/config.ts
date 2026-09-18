// Mini-program runtime configuration: where the platform lives and the
// platform token, both persisted in mini-program storage. Dev default points
// at a local server (devtools with "不校验合法域名" on); production sets the
// gateway's HTTPS origin.

import Taro from "@tarojs/taro";

const BASE_KEY = "platform.baseUrl";
const TOKEN_KEY = "platform.mpToken";

// `localhost`, not `127.0.0.1`: the dev server binds the IPv6 localhost
// (::1) by default, and an IPv4 literal then gets connection-refused. In the
// devtools simulator `localhost` resolves to the host machine; on a real
// phone (真机调试) point this at the dev machine's LAN IP instead.
const DEFAULT_BASE = "http://localhost:3000";

export function baseUrl(): string {
  return Taro.getStorageSync(BASE_KEY) || DEFAULT_BASE;
}

export function setBaseUrl(url: string) {
  Taro.setStorageSync(BASE_KEY, String(url).replace(/\/+$/, ""));
}

export function token(): string {
  return Taro.getStorageSync(TOKEN_KEY) || "";
}

export function setToken(value: string) {
  Taro.setStorageSync(TOKEN_KEY, value);
}

export function clearToken() {
  Taro.removeStorageSync(TOKEN_KEY);
}
