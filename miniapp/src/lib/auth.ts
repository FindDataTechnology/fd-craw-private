// Mini-program identity — account-binding model (openspec: miniprogram-auth).
//
// First launch: the user signs in once with their platform (Logto) account
// (username/phone + password) on the login page; the gateway verifies via
// the password grant and BINDS this WeChat openid to that account. Every
// later launch is silent: a fresh wx.login code exchanges for a platform
// JWT carrying the account identity (same cell/data as the web app).
//
// A deployment without the gateway (AUTH_MODE=none) needs no token at all —
// `ensureAuth` probes for that. On 401 the client retries once after a
// silent re-login; a dropped binding surfaces as a login-required event.

import Taro, { eventCenter } from "@tarojs/taro";
import { baseUrl, clearToken, setToken, token } from "./config";

export const LOGIN_REQUIRED_EVENT = "platform:login-required";

export function authHeaders(): Record<string, string> {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

type LoginOutcome = "token" | "binding_required" | "failed";

async function postJson(path: string, data: Record<string, string>) {
  return Taro.request({
    url: `${baseUrl()}${path}`,
    method: "POST",
    header: { "content-type": "application/json" },
    data,
  });
}

// POST /api/mp/login with a fresh wx.login code. Bound openid → token;
// unbound → the client should show the account-login page.
async function silentLogin(): Promise<LoginOutcome> {
  let code = "";
  try {
    ({ code } = await Taro.login());
  } catch {
    return "failed";
  }
  try {
    const res = await postJson("/api/mp/login", { code });
    const body = res.data as { token?: string; error?: string } | undefined;
    if (res.statusCode === 200 && body?.token) {
      setToken(body.token);
      return "token";
    }
    if (res.statusCode === 404 && body?.error === "binding_required") return "binding_required";
    return "failed";
  } catch {
    return "failed";
  }
}

// First sign-in: a 6-digit bind code (minted from the account's authenticated
// web session — open /api/mp/bindcode in a signed-in browser) + a fresh
// wx.login code. Throws with a server-provided reason on failure.
export async function loginWithBindCode(bindCode: string): Promise<void> {
  const { code } = await Taro.login();
  const res = await postJson("/api/mp/login-bindcode", { code, bindCode });
  const body = res.data as { token?: string; error?: string } | undefined;
  if (res.statusCode === 200 && body?.token) {
    setToken(body.token);
    return;
  }
  throw new Error(body?.error || `登录失败 (${res.statusCode})`);
}

// Logout: drop the local token and remove the server-side binding, so the
// next launch asks for credentials again.
export async function logout(): Promise<void> {
  const t = token();
  clearToken();
  if (!t) return;
  try {
    await Taro.request({
      url: `${baseUrl()}/api/mp/bind`,
      method: "DELETE",
      header: { Authorization: `Bearer ${t}` },
    });
  } catch {
    // Best effort — the local token is already gone, which is what matters.
  }
}

let refreshing: Promise<boolean> | null = null;

// One in-flight refresh at a time: concurrent 401s share a single exchange
// (WeChat login codes are single-use, so parallel attempts would race).
// A dropped binding raises LOGIN_REQUIRED_EVENT for the UI to answer.
export function refreshToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = silentLogin()
      .then((outcome) => {
        if (outcome === "binding_required") {
          eventCenter.trigger(LOGIN_REQUIRED_EVENT);
          return false;
        }
        return outcome === "token";
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

// Boot probe: an unauthenticated /api/config tells us which world we're in.
// 200 → no auth (local/self-host); 401 → WeChat exchange (silent when bound,
// login page when not).
export async function ensureAuth(): Promise<"none" | "token" | "binding_required" | "failed"> {
  try {
    const res = await Taro.request({ url: `${baseUrl()}/api/config`, method: "GET" });
    if (res.statusCode === 200) return "none";
    if (res.statusCode === 401) return silentLogin();
    return "failed";
  } catch {
    return "failed";
  }
}
