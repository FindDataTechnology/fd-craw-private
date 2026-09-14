## 1. Fix

- [x] 1.1 In `server/logto-auth.js`, accept `RS256`/`ES256`/`ES384`/`ES512` and verify with the per-algorithm hash plus `dsaEncoding: "ieee-p1363"`. Verify: unit test — an ES384-signed token whose claims are valid verifies true; the same token with a flipped signature byte verifies false; an unsupported `alg` is rejected.
- [x] 1.2 Keep the RS256 path working. Verify: unit test — an RS256 token still verifies true after the change.

## 2. Verify online

- [ ] 2.1 Rebuild the image, redeploy via ArgoCD, and sign in at `https://craw.finddatatech.cloud`. Verify: the app shell renders authenticated (no `?auth_error=`) and `/api/auth/me` reports `authenticated: true` with the signed-in email.
- [ ] 2.2 Drive a real signed-in LLM turn that emits an `echarts` fence. Verify: the chart renders (canvas present) and no stray `pre` code block remains.
