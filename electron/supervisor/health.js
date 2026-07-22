// ── Health probes ────────────────────────────────────────────────────────────
//
// Transport-appropriate health checks (spec: "Health checking per transport").
// HTTP probe for port-speaking and http-external servers. RPC ping for stdio
// servers is added in Phase 2 alongside the pi-agent bridge.

import http from "node:http";
import https from "node:https";

// Returns true on a 2xx/3xx response, false on error/timeout/4xx/5xx.
export function httpProbe(urlStr, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const fin = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    let url;
    try { url = new URL(urlStr); } catch { return fin(false); }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      fin(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("error", () => fin(false));
    req.on("timeout", () => { req.destroy(); fin(false); });
  });
}
