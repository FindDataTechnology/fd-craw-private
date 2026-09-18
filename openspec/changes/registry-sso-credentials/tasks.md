# Tasks — registry-sso-credentials

## 1. Ops prerequisites (registry side, no platform code)

- [ ] 1.1 Configure the registry to allow CORS with credentials from the platform origin and serve its session cookie `SameSite=None; Secure`. Verify: from the platform origin's devtools, `fetch("https://mcp.finddatatech.cloud/api/auth/csrf-token", {credentials:"include"})` succeeds after a logged-in popup round-trip.
- [ ] 1.2 Re-verify the mint API contract against the deployed registry version (endpoint path, CSRF header, request/response fields, TTL parameter). Verify: a scripted silent mint from the popup context returns a JWT with `exp` ≈ +168 h; record the exact shape in this change's implementation notes.

## 2. Credential store + API

- [ ] 2.1 DB migration: `user_registry_credentials(email PK, token, expires_at, updated_at)`; no backfill. Verify: migration runs idempotently on an existing DB; absence of a row reports "unconnected".
- [ ] 2.2 Routes: `GET /api/registry/connection` (state + expiry only), `POST /api/registry/credential` (mint handoff receipt / manual paste), `DELETE /api/registry/connection` (disconnect). All reject anonymous writes in hosted mode; auth-off writes allowed (owner semantics). Verify: route tests cover connected/unconnected/stale states and that no response ever contains the token.
- [ ] 2.3 Staleness: credential rows gain a stale flag; a 401 from a registry-origin MCP server marks the owner's credential stale. Verify: unit test simulating a 401 flips state and `GET connection` reports `stale`.

## 3. Install flow + injection

- [ ] 3.1 Install path: registry-origin market entries install with `credentialRef` instead of placeholder headers when a live credential exists; without one, the API rejects with a "credential required" error the UI maps to the connect prompt. Verify: API tests for both branches + group admission still enforced (intersection of both).
- [ ] 3.2 Effective-profile injection: at profile application, registry-origin servers resolve `Authorization` from the current user's credential; missing/stale credential omits the server with a warning (composes with requiredGroups filtering). Verify: profile-generation tests for live/stale/absent × gated/ungated.
- [ ] 3.3 Frontend: Store connect button + state badge, popup flow (login → mint fetch → postMessage → POST receipt), re-connect prompt on stale, install form conditional per the marketplace delta. Verify: Playwright e2e — connect with a real Logto session, install a registry entry with zero credential typing, chat reaches the MCP tool.

## 4. Fallback + regression

- [ ] 4.1 Manual paste path writes the same credential row (JWT expiry parsed when decodable). Verify: pasted 168 h token reports correct expiry and drives injection identically.
- [ ] 4.2 Auth-off/desktop regression: non-registry installs, bundled entries, mcp.json precedence, requiredGroups filtering all unchanged. Verify: existing extension/mcp e2e suites pass unmodified.

## 5. End-to-end + docs

- [ ] 5.1 Full flow on fd-prod with a demo account: login → connect (one click, silent) → install a pack MCP → tool call succeeds → token expires → re-connect prompt → restored. Verify: runbook-documented pass with Trace evidence of the MCP call.
- [ ] 5.2 Update `docs/vertical-packs.md` (add-vertical-sample-packs) to drop the V0 manual-token step once this ships. Verify: playbook shows the SSO path as primary with paste as fallback.
