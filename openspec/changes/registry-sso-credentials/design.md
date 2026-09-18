# Design — registry-sso-credentials

## Context

Verified live (2026-09-19): every registry `/mcp` endpoint 401s without a Bearer JWT (`visibility: public` affects listing only); the registry auth chain is `mcp-auth-server:logto` — the same Logto the platform authenticates against via oauth2-proxy; the registry mints personal MCP JWTs via a session+CSRF token API with TTL up to 168 h; install templates for registry entries currently embed `Bearer <your_token>` placeholders. Platform mechanisms already in place: registry-bridge market snapshot, group admission at install, requiredGroups runtime filtering in effective-profile generation, per-cell DB in cloud mode, agent-remote chat routing. `add-vertical-sample-packs` defines the demo need (V0 manual paste) this change automates away.

## Goals / Non-Goals

Goals: one-click silent connect per user; credentials never in browser storage nor in installed-config records; credential refresh flows without reinstall; manual paste survives as fallback; auth-off behavior unchanged.

Non-Goals: V2 Logto-access-token pass-through (mcpgw trusting Logto-issued JWTs — recorded below as successor spike); registry-side code changes (CORS/SameSite are ops config); platform-side OAuth client against the registry; token auto-refresh without a user gesture (mint rate limits: 100/user/hour make silent re-connect-on-401 feasible later, not v1).

## Decisions

### D1: Browser-mediated silent SSO mint, not server-side OAuth
The mint API requires the user's registry session cookie, which only the browser can hold after the registry's own OAuth login. Flow: popup → registry login URL (instant redirect via shared Logto session) → back to a platform popup page on the platform origin → cross-origin `fetch` to the mint API with `credentials: "include"` (registry CORS must allow-list the platform origin; session cookie must be `SameSite=None; Secure`) → token → `postMessage` to opener → `POST` to backend → stored server-side. Alternatives rejected: server-side authorization-code flow (the platform would need to be an OAuth client of the registry's auth server — registry feature, plus token lives outside user's browser session); Logto token pass-through (blocked on mcpgw issuer config, spike pending); M2M service token for everyone (loses per-user identity at the gateway: no per-user audit/rate limits, contradicts group scoping).

### D2: One credential row per user, referenced — not embedded — by installs
`user_registry_credentials(email PK, token, expires_at, updated_at)`; installed registry-origin MCP records carry `credentialRef: "registry"` (constant) instead of headers containing secrets. Injection happens at effective-profile generation, the single choke point that already applies requiredGroups filtering — credential state composes with role gating in one place. Alternative rejected: stamping the token into the installed record's headers at install time — expiry then bricks the record until reinstall, violating the refresh-without-reinstall requirement.

### D3: 401 → stale is a detected state, not a background refresher
The MCP session layer marks the credential stale on 401 from a registry-origin server; the Store shows re-connect; the user's one click runs the same silent flow. No background auto-mint in v1 (background silent OAuth without a user gesture is fragile — popup blockers — and unnecessary at 168 h TTL). Rejected: proactive refresh timers (extra state for little gain).

### D4: Popup handoff, not iframe
The login leg must be top-frame (OAuth redirects, Logto policy); only the mint fetch is cross-origin XHR from the platform popup page. `postMessage` targets the opener with the platform's own origin checked. If registry CORS/SameSite cannot be configured (ops blocker), the connect flow degrades to instructing a manual paste of a UI-minted token — the V0 path remains fully functional; this is the designed fallback, documented in the runbook.

### D5: Manual paste stores into the same row
The fallback writes the same credential row (parsed for expiry if the JWT is decodable, else flagged unknown-expiry) so downstream injection semantics are uniform. Bring-your-own tokens for non-registry MCP entries are untouched — this design only governs registry-origin entries.

## Risks / Trade-offs

- [Registry CORS/SameSite config is an ops dependency on a stack we don't code] → D4 fallback keeps V0 working; ops steps documented as prerequisite with a verification curl.
- [Token passes through browser memory during handoff] → transient only (postMessage → immediate POST → no browser persistence); consistent with "secrets stay server-side" as persisted state.
- [Rate limit on mints (100/user/hour)] → v1 mints on explicit user gestures only; far below limit.
- [Multi-user shared deployment: one dsh session serves all clients] → injection is resolved per effective-profile application against the requesting user — same shape as requiredGroups; cell deployments are naturally isolated.
- [Registry token API shape changes (self-hosted, versioned image)] → mint call isolated in one client module; version-pinned deployment docs.

## Migration Plan

1. DB migration adds `user_registry_credentials` (no backfill; empty = unconnected, installs offer connect/paste).
2. Ops: registry CORS allow-list + `SameSite=None` cookie; verify with a curl from the platform origin.
3. Ship connect UI + injection behind no flag (absent credential = previous behavior for non-registry entries; registry entries previously required manual paste anyway).
4. Rollback: revert deploy; table left in place harmlessly; manually pasted installs from V0 continue to work.

## Open Questions

- Exact registry mint endpoint response shape (confirmed `POST /api/tokens/generate` + CSRF from archived spike notes; re-verify at implementation against the deployed registry version).
- Whether mcpgw can be configured to trust Logto-issued JWTs directly (V2 successor — would delete the mint entirely; 30-minute spike when convenient, does not block this change).
