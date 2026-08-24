// Client for the /api/llm/* endpoints (Models page). Types mirror the
// server records in llm-providers.js. The API key never appears here — the
// server exposes only `hasKey: boolean`.

export interface LastTest {
  ok: boolean;
  latencyMs: number;
  error?: string;
  at?: string;
}

export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  type: string;
  hasKey: boolean;
  reserved?: boolean;
  models: string[];
  lastTest: LastTest | null;
}

export interface LlmDefault {
  providerId: string | null;
  modelId: string | null;
  activeModelId: string | null;
}

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch { /* ignore */ }
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function listProviders(): Promise<LlmProvider[]> {
  const r = await fetch("/api/llm/providers");
  const body = await jsonOrThrow(r);
  return body.providers ?? [];
}

export async function createProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}): Promise<LlmProvider> {
  const r = await fetch("/api/llm/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrThrow(r);
  return body.provider;
}

export async function updateProvider(
  id: string,
  input: { name?: string; baseUrl?: string; apiKey?: string },
): Promise<LlmProvider> {
  const r = await fetch(`/api/llm/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrThrow(r);
  return body.provider;
}

export async function deleteProvider(id: string): Promise<void> {
  const r = await fetch(`/api/llm/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await jsonOrThrow(r);
}

export async function testProvider(id: string): Promise<LastTest & { ok: boolean }> {
  const r = await fetch(`/api/llm/providers/${encodeURIComponent(id)}/test`, {
    method: "POST",
  });
  return jsonOrThrow(r);
}

export async function getDefault(): Promise<LlmDefault> {
  const r = await fetch("/api/llm/default");
  return jsonOrThrow(r);
}

export async function setDefault(modelId: string, providerId: string): Promise<LlmDefault> {
  const r = await fetch("/api/llm/default", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, providerId }),
  });
  return jsonOrThrow(r);
}
