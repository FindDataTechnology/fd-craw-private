// Client wrappers for the /api/bots endpoints (social-bot-channels capability).
//
// Credential VALUES never cross this boundary: the server returns only the list
// of credential keys that are configured. Sending a blank value on edit means
// "keep the stored one".

export interface BotCredentialField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
}

export interface BotType {
  type: string;
  credentialFields: BotCredentialField[];
}

export interface Bot {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  configuredCredentials: string[];
  webhookUrl: string;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const send = (url: string, method: string, body?: unknown) =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export async function listBots(): Promise<{ bots: Bot[]; types: BotType[] }> {
  return jsonOrThrow(await fetch("/api/bots"));
}

export async function createBot(input: {
  type: string;
  name: string;
  credentials: Record<string, string>;
}): Promise<Bot> {
  return jsonOrThrow(await send("/api/bots", "POST", input));
}

export async function updateBot(
  id: string,
  patch: { name?: string; credentials?: Record<string, string>; enabled?: boolean },
): Promise<Bot> {
  return jsonOrThrow(await send(`/api/bots/${encodeURIComponent(id)}`, "PATCH", patch));
}

export async function deleteBot(id: string): Promise<void> {
  await jsonOrThrow(await send(`/api/bots/${encodeURIComponent(id)}`, "DELETE"));
}
