import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateKeyPairSync,
  randomBytes,
  sign as signJwt,
} from "node:crypto";
import { createLogtoAuth, mapGroups } from "../server/logto-auth.js";
import { parseCookies, signSession, verifySessionCookie, verifySignedCookie } from "../server/session.js";

const issuer = "https://logto.test/oidc";
const secret = "test-secret";
const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/auth`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
  end_session_endpoint: `${issuer}/logout`,
};
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" });
const jwks = { keys: [{ ...jwk, kid: "test-key", use: "sig", alg: "ES256" }] };

function response(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

function config(overrides = {}) {
  return {
    AUTH_MODE: "logto",
    LOGTO_ENDPOINT: issuer,
    LOGTO_APP_ID: "client",
    LOGTO_APP_SECRET: secret,
    LOGTO_CLIENT_TYPE: "confidential",
    SESSION_TTL_HRS: "1",
    resolveSessionSecret: async () => secret,
    ...overrides,
  };
}

function idToken({ nonce, exp = Math.floor(Date.now() / 1000) + 60, claims = {} } = {}) {
  const header = JSON.stringify({ alg: "ES256", kid: "test-key", typ: "JWT" });
  const payload = JSON.stringify({
    iss: issuer,
    aud: "client",
    exp,
    nonce,
    email: "user@example.com",
    organizations: ["finddata"],
    organization_roles: ["finddata:admin"],
    ...claims,
  });
  const body = `${Buffer.from(header).toString("base64url")}.${Buffer.from(payload).toString("base64url")}`;
  const signature = signJwt("sha256", Buffer.from(body), privateKey).toString("base64url");
  return `${body}.${signature}`;
}

function responseStub({ tokenBody = {}, tokenOk = true, jwksBody = jwks } = {}) {
  return async (url) => {
    if (url === discovery.jwks_uri) return response(jwksBody);
    if (url === discovery.token_endpoint) return response(tokenBody, tokenOk);
    return response(discovery);
  };
}

function request(path = "/", headers = {}) {
  const url = new URL(path, "https://paas.test");
  return {
    headers: { host: "paas.test", cookie: "", ...headers },
    protocol: "http",
    query: Object.fromEntries(url.searchParams),
  };
}

function responseRecorder() {
  return {
    appendCalls: [],
    redirectUrl: null,
    append(name, value) {
      this.appendCalls.push({ name, value });
    },
    redirect(value) {
      this.redirectUrl = value;
    },
  };
}

function registerHandlers(auth) {
  const handlers = {};
  auth.register({
    get(path, handler) { handlers[path] = handler; },
    post(path, handler) { handlers[path] = handler; },
  });
  return handlers;
}

function sessionCookie(res) {
  return res.appendCalls.find((call) => call.name === "Set-Cookie" && call.value.startsWith("paas_session="))?.value;
}

test("confidential login and callback issue a verifiable session", async () => {
  const nonce = "nonce";
  const token = idToken({ nonce });
  const calls = [];
  const auth = await createLogtoAuth(config({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return responseStub({ tokenBody: { id_token: token } })(url, options);
  } }), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responseStub({ tokenBody: { id_token: token } })(url, options);
    },
  });
  const req = request("/auth/callback?code=code&state=state");
  const stateCookie = signSession({ state: "state", nonce, exp: Math.floor(Date.now() / 1000) + 60 }, secret);
  req.headers.cookie = `paas_oauth_state=${stateCookie}`;
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/callback"](req, res);

  assert.equal(res.redirectUrl, "/");
  const cookie = sessionCookie(res);
  assert.ok(cookie);
  const payload = verifySessionCookie(cookie.split(";")[0].split("=").slice(1).join("="), secret);
  assert.deepEqual(payload, {
    email: "user@example.com",
    groups: ["finddata", "admin"],
    exp: payload.exp,
  });
  assert.equal(calls.some((call) => call.url === discovery.jwks_uri), true);
  const exchange = calls.find((call) => call.url === discovery.token_endpoint);
  assert.equal(exchange.options.body.get("client_secret"), secret);
  assert.equal(exchange.options.body.get("code_verifier"), null);
});

test("state mismatch redirects to auth error without a session", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub() });
  const req = request("/auth/callback?code=code&state=wrong");
  req.headers.cookie = `paas_oauth_state=${signSession({ state: "right", nonce: "nonce", exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/callback"](req, res);
  assert.equal(res.redirectUrl, "/?auth_error=state");
  assert.equal(sessionCookie(res), undefined);
});

test("token failure redirects to auth error without a session", async () => {
  const auth = await createLogtoAuth(config(), {
    fetchImpl: responseStub({ tokenBody: { error: "bad code" }, tokenOk: false }),
  });
  const req = request("/auth/callback?code=code&state=state");
  req.headers.cookie = `paas_oauth_state=${signSession({ state: "state", nonce: "nonce", exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/callback"](req, res);
  assert.equal(res.redirectUrl, "/?auth_error=token");
  assert.equal(sessionCookie(res), undefined);
});

test("public client adds PKCE and omits client secret", async () => {
  const auth = await createLogtoAuth(config({ LOGTO_CLIENT_TYPE: "public", LOGTO_APP_SECRET: "" }), {
    fetchImpl: responseStub(),
  });
  const req = request("/auth/login");
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/login"](req, res);
  const url = new URL(res.redirectUrl);
  const state = url.searchParams.get("state");
  const stateCookie = res.appendCalls.find((call) => call.name === "Set-Cookie" && call.value.startsWith("paas_oauth_state="))?.value;
  assert.ok(stateCookie);
  const statePayload = verifySignedCookie(stateCookie.split(";")[0].split("=").slice(1).join("="), secret);
  assert.equal(statePayload.state, state);
  assert.equal(typeof statePayload.codeVerifier, "string");
});

test("public callback exchanges code without a secret", async () => {
  const nonce = "nonce";
  const verifier = "verifier";
  const calls = [];
  const auth = await createLogtoAuth(config({ LOGTO_CLIENT_TYPE: "public", LOGTO_APP_SECRET: "" }), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responseStub({ tokenBody: { id_token: idToken({ nonce }) } })(url, options);
    },
  });
  const req = request("/auth/callback?code=code&state=state");
  req.headers.cookie = `paas_oauth_state=${signSession({ state: "state", nonce, codeVerifier: verifier, exp: Math.floor(Date.now() / 1000) + 60 }, secret)}`;
  const res = responseRecorder();
  const handlers = registerHandlers(auth);
  await handlers["/auth/callback"](req, res);
  const exchange = calls.find((call) => call.url === discovery.token_endpoint);
  assert.equal(exchange.options.body.get("code_verifier"), verifier);
  assert.equal(exchange.options.body.get("client_secret"), null);
  assert.ok(sessionCookie(res));
});

test("sliding renewal refreshes near-expiry cookies only", async () => {
  const auth = await createLogtoAuth(config(), { fetchImpl: responseStub() });
  const nearExpiry = signSession({ email: "user@example.com", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 30 * 60 }, secret);
  const fresh = signSession({ email: "user@example.com", groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 60 * 60 }, secret);
  const nearRes = responseRecorder();
  const freshRes = responseRecorder();
  auth.authenticate(request("/", { cookie: `paas_session=${nearExpiry}` }), nearRes);
  auth.authenticate(request("/", { cookie: `paas_session=${fresh}` }), freshRes);
  assert.ok(sessionCookie(nearRes));
  assert.equal(sessionCookie(freshRes), undefined);
});

test("organization claims map to groups", () => {
  assert.deepEqual(mapGroups({ organizations: ["finddata"], organization_roles: ["finddata:admin"] }), ["finddata", "admin"]);
});
