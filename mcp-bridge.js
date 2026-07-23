// mcp-bridge.js
// Connects to MCP servers declared in mcp.json and exposes their tools as pi
// ToolDefinitions, so the agent can call MCP tools identically to built-in tools.
// The pi SDK has no native MCP support, so this module is the bridge.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "platform", version: "1.0.0" };

// Race a promise against a timeout. On timeout, abort the controller and reject.
function withTimeout(promise, ms, controller, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Build the transport for a server config. stdio (command) or http (url).
function buildHttpTransport(config) {
  const url = new URL(config.url);
  const opts = config.headers ? { requestInit: { headers: config.headers } } : {};
  return new StreamableHTTPClientTransport(url, opts);
}

function buildSseTransport(config) {
  const url = new URL(config.url);
  const opts = config.headers ? { requestInit: { headers: config.headers } } : {};
  return new SSEClientTransport(url, opts);
}

function buildStdioTransport(config) {
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
  });
}

// Connect a single MCP server. Returns a connected Client, or throws.
async function connectServer(name, config) {
  if (!config.command && !config.url) {
    throw new Error(`server "${name}" has neither "command" (stdio) nor "url" (http)`);
  }

  // stdio servers only have one transport.
  if (config.command) {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const controller = new AbortController();
    try {
      await withTimeout(
        client.connect(buildStdioTransport(config)),
        CONNECT_TIMEOUT_MS,
        controller,
        `stdio connect "${name}"`
      );
    } catch (err) {
      await safeClose(client);
      throw new Error(`stdio connect "${name}" failed: ${err.message}`);
    }
    return client;
  }

  // http/sse servers: try Streamable HTTP first, fall back to legacy SSE.
  let lastErr;
  for (const build of [buildHttpTransport, buildSseTransport]) {
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const controller = new AbortController();
    try {
      await withTimeout(
        client.connect(build(config)),
        CONNECT_TIMEOUT_MS,
        controller,
        `http connect "${name}"`
      );
      return client;
    } catch (err) {
      lastErr = err;
      await safeClose(client);
    }
  }
  throw new Error(`http connect "${name}" failed: ${lastErr?.message || "unknown error"}`);
}

// Map MCP callTool content blocks to pi AgentToolResult content blocks.
function mapContent(content) {
  if (!Array.isArray(content)) return [];
  return content
    .map((c) => {
      if (c.type === "text") return { type: "text", text: c.text };
      if (c.type === "image") return { type: "image", data: c.data, mimeType: c.mimeType };
      return { type: "text", text: JSON.stringify(c) };
    })
    .filter(Boolean);
}

// Build a pi ToolDefinition that proxies to an MCP tool.
function buildToolDefinition(serverName, tool, client) {
  const originalName = tool.name;
  const piName = `mcp__${serverName}__${originalName}`;
  const description = `[MCP:${serverName}] ${tool.description || originalName}`;
  return {
    name: piName,
    label: `${originalName} (${serverName})`,
    description,
    promptSnippet: description,
    // Wrap the MCP tool's JSON schema verbatim. Type.Unsafe skips pi-side
    // validation but preserves the schema so the LLM knows the parameter shape.
    parameters: Type.Unsafe(tool.inputSchema || { type: "object", properties: {} }),
    async execute(toolCallId, params, signal) {
      // Forward pi's abort signal and let the SDK enforce the call timeout.
      const result = await client.callTool(
        { name: originalName, arguments: params },
        undefined,
        { signal: signal ?? undefined, timeout: CALL_TIMEOUT_MS }
      );
      const content = mapContent(result.content);
      if (result.isError) {
        const text = content
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("\n")
          .trim();
        throw new Error(text || `MCP tool "${originalName}" returned an error`);
      }
      return { content, details: { server: serverName, tool: originalName } };
    },
  };
}

async function safeClose(client) {
  try {
    await client.close();
  } catch {
    // ignore
  }
}

// Connect every server in a { mcpServers } config object and return the flat
// tool list + clients. Failed servers are logged and skipped; they never abort
// the whole load. Extracted from connectMcpServers so callers can merge servers
// from multiple sources (the mcp.json file + an env-built OpenConnector server)
// into one connect pass.
//
// `retry` ({ retries, intervalMs }) retries each server's connect+listTools -
// used for servers that start in parallel with server.js (e.g. the bundled
// OpenConnector) and may not be ready on the first attempt.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function connectServers({ mcpServers } = {}, { retries = 0, intervalMs = 2000 } = {}) {
  const tools = [];
  const clients = [];

  const servers = mcpServers || {};
  for (const [name, serverConfig] of Object.entries(servers)) {
    let connected = false;
    for (let attempt = 0; attempt <= retries && !connected; attempt++) {
      try {
        const client = await connectServer(name, serverConfig);
        let toolList = [];
        try {
          const resp = await withTimeout(
            client.listTools(),
            CONNECT_TIMEOUT_MS,
            new AbortController(),
            `listTools "${name}"`
          );
          toolList = resp.tools || [];
        } catch (err) {
          await safeClose(client);
          throw new Error(`listTools "${name}" failed: ${err.message}`);
        }
        clients.push({ name, client });
        for (const tool of toolList) {
          tools.push(buildToolDefinition(name, tool, client));
        }
        console.log(`[mcp] Connected "${name}": ${toolList.length} tool(s)${attempt > 0 ? ` (after ${attempt} retr${attempt === 1 ? "y" : "ies"})` : ""}`);
        connected = true;
      } catch (err) {
        if (attempt < retries) {
          console.log(`[mcp] "${name}" connect failed (attempt ${attempt + 1}/${retries + 1}): ${err.message}; retrying in ${intervalMs}ms`);
          await sleep(intervalMs);
        } else {
          console.warn(`[mcp] ${err.message}; skipping after ${retries + 1} attempt(s)`);
        }
      }
    }
  }

  return { tools, clients };
}

// Read mcp.json, connect every server, and return the flat tool list + clients.
// Backward compatible: delegates to connectServers after reading the file.
export async function connectMcpServers(configPath) {
  let config;
  try {
    const raw = await readFile(configPath, "utf8");
    config = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("[mcp] No mcp.json found; MCP disabled");
    } else {
      console.warn(`[mcp] Failed to read ${configPath}: ${err.message}; MCP disabled`);
    }
    return { tools: [], clients: [] };
  }
  return connectServers(config);
}

export async function closeMcpClients(clients) {
  await Promise.all(clients.map(({ client }) => safeClose(client)));
}
