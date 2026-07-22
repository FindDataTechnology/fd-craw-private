// ── LiteLLM model discovery ───────────────────────────────────────────────────
//
// The LiteLLM proxy exposes an OpenAI-compatible GET /v1/models endpoint that
// lists every model routed through it. This is the authoritative, live source
// for the model selector and the /model command: models added via the LiteLLM
// admin UI appear here without a server restart. (`pi --list-models | grep
// litellm` confirms the pi-agent recognizes exactly these models.)
//
// Results are cached briefly (default 30s) so repeated list_models requests do
// not hammer the proxy. Concurrent calls coalesce onto a single fetch. On any
// failure/timeout the function returns null so the caller can fall back to the
// configured-provider models in the SDK model registry.

const DEFAULT_TTL_MS = 30_000;
const NEGATIVE_TTL_MS = 30_000; // cache "unreachable" for the same window
const FETCH_TIMEOUT_MS = 4_000;

let cache = null; // { at: number, models: Array } | null
let negativeCache = null; // { at: number } | null
let inflight = null; // Promise<Array | null> | null

// Fetch the LiteLLM model list. Returns an array of { id, name, provider:
// "litellm" } on success, or null on failure/timeout. Cached for ttlMs.
// Failures are also cached for NEGATIVE_TTL_MS so a downed proxy doesn't make
// every client hang for FETCH_TIMEOUT_MS on every list_models.
export async function fetchLitellmModels({ baseUrl, apiKey, ttlMs = DEFAULT_TTL_MS }) {
  if (!baseUrl || !apiKey) return null;
  const now = Date.now();
  if (cache && now - cache.at < ttlMs) return cache.models;
  if (negativeCache && now - negativeCache.at < NEGATIVE_TTL_MS) return null;
  // Coalesce concurrent calls onto one fetch.
  if (inflight) return inflight;

  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[litellm] /v1/models returned HTTP ${res.status}`);
        negativeCache = { at: Date.now() };
        return null;
      }
      const data = await res.json();
      const ids = Array.isArray(data?.data)
        ? data.data.map((m) => m?.id).filter(Boolean)
        : [];
      // Dedupe by id; provider is "litellm" for every proxy-routed model.
      const seen = new Set();
      const models = [];
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id, name: id, provider: "litellm" });
      }
      cache = { at: Date.now(), models };
      negativeCache = null;
      return models;
    } catch (err) {
      console.warn(`[litellm] /v1/models fetch failed: ${err.message}`);
      negativeCache = { at: Date.now() };
      return null;
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

export function clearLitellmModelCache() {
  cache = null;
  negativeCache = null;
}
