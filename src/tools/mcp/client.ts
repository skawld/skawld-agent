/**
 * Connect to MCP servers and expose their tools as skawld `Tool`s.
 *
 * `connectMcpServers` opens one client per configured server (stdio child
 * process or Streamable HTTP), lists each server's tools, and wraps them via
 * `makeMcpTool`. Connection is fail-fast: if any server fails, every
 * already-opened client is torn down and an aggregated error is thrown.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../base.js";
import { ConfigError } from "../../core/errors.js";
import { SKAWLD_VERSION } from "../../core/version.js";
import { type McpServerConfig, mcpServerType } from "./config.js";
import { normalizeNameForMcp } from "./naming.js";
import { makeMcpTool } from "./tool.js";

/** A live set of MCP connections and the tools they expose. */
export interface McpConnection {
  /** All wrapped tools across every connected server. */
  tools: Tool[];
  /** Disconnect every server and kill stdio child processes. Idempotent. */
  close(): Promise<void>;
}

function createTransport(config: McpServerConfig): Transport {
  if (mcpServerType(config) === "http") {
    const http = config as Extract<McpServerConfig, { type: "http" }>;
    return new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: http.headers ? { headers: http.headers } : undefined,
    });
  }
  const stdio = config as Extract<McpServerConfig, { type?: "stdio" }>;
  return new StdioClientTransport({
    command: stdio.command,
    args: stdio.args ?? [],
    env: { ...(process.env as Record<string, string>), ...(stdio.env ?? {}) },
    // Inherit so the child's diagnostics reach our stderr and no unread pipe
    // can fill and block a chatty server.
    stderr: "inherit",
  });
}

async function connectOne(
  name: string,
  config: McpServerConfig,
): Promise<{ client: Client; tools: Tool[] }> {
  const client = new Client({ name: "skawld", version: SKAWLD_VERSION }, { capabilities: {} });
  await client.connect(createTransport(config));
  try {
    const { tools: mcpTools } = await client.listTools();
    const tools = mcpTools.map((t) =>
      makeMcpTool(name, t, (toolName, args, signal): Promise<CallToolResult> =>
        client.callTool({ name: toolName, arguments: args }, undefined, { signal }) as Promise<CallToolResult>,
      ),
    );
    return { client, tools };
  } catch (err) {
    // The child process already spawned during connect(); close it so a
    // post-connect failure (e.g. listTools) does not leak it.
    await client.close().catch(() => {});
    throw err;
  }
}

/** Connect to every configured MCP server. Fail-fast with full teardown. */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<McpConnection> {
  const entries = Object.entries(servers);
  const normalized = new Set<string>();
  for (const [name] of entries) {
    if (name.trim() === "") throw new ConfigError("MCP server name must be non-empty");
    const key = normalizeNameForMcp(name);
    if (normalized.has(key)) {
      throw new ConfigError(`MCP server names collide after normalization: '${name}' → '${key}'`);
    }
    normalized.add(key);
  }

  const settled = await Promise.allSettled(entries.map(([name, cfg]) => connectOne(name, cfg)));

  const opened = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failures = entries.flatMap(([name], i) =>
    settled[i]!.status === "rejected"
      ? [`${name}: ${reason((settled[i] as PromiseRejectedResult).reason)}`]
      : [],
  );

  if (failures.length > 0) {
    await Promise.allSettled(opened.map((o) => o.client.close()));
    throw new ConfigError(`Failed to connect MCP server(s): ${failures.join("; ")}`);
  }

  const clients = opened.map((o) => o.client);
  let closed = false;
  return {
    tools: opened.flatMap((o) => o.tools),
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
