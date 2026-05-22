/**
 * Minimal stdio MCP server fixture for connection-manager tests.
 * Exposes a read-only `echo` tool and a `boom` tool that always errors.
 * Run as: bun run tests/fixtures/mcp-echo-server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-fixture", version: "0.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echoes the provided message",
    inputSchema: { msg: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ msg }) => ({ content: [{ type: "text", text: `echo: ${msg}` }] }),
);

server.registerTool(
  "boom",
  { description: "Always throws", inputSchema: {} },
  async () => {
    throw new Error("boom tool failed");
  },
);

await server.connect(new StdioServerTransport());
