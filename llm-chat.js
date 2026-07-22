// ── Minimal OpenAI-compatible chat helper ────────────────────────────────────
//
// A tiny stand-in for the `chatGPT` helper that used to come from the `pageindex`
// dependency. Calls the configured OpenAI-compatible chat/completions endpoint
// directly with retries, returning the assistant text (or the literal "Error"
// when retries are exhausted, mirroring the former chatGPT contract so callers
// can detect failure). Kept dependency-free (uses global fetch).

const DEFAULT_TIMEOUT_MS = 60_000;

// `opts`: { model, apiKey, baseUrl, prompt, temperature?, maxRetries?, system? }
// Returns the assistant message text, or "Error" if all retries fail.
export async function chat(opts) {
  const {
    model,
    apiKey,
    baseUrl,
    prompt,
    temperature = 0.2,
    maxRetries = 3,
    system,
  } = opts;

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        lastErr = new Error(`chat HTTP ${res.status}: ${await res.text().catch(() => "")}`);
        continue;
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.length > 0) return text;
      lastErr = new Error("chat returned empty content");
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  console.error("[llm-chat] failed after retries:", lastErr?.message);
  return "Error";
}
