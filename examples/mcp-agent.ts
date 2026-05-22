/**
 * skawld agent with an external MCP server.
 *
 * Requires:
 *   - ANTHROPIC_API_KEY in environment.
 *   - Network access + npx (this spawns `@modelcontextprotocol/server-everything`
 *     as a local stdio MCP server). This example makes real network/process
 *     calls and is NOT part of the test suite.
 *
 * Run with: bun run examples/mcp-agent.ts
 *
 * The MCP server's tools are exposed to the model as `mcp__everything__*`.
 * Servers connect on the first session() call and disconnect on agent.close().
 */

import { Agent } from "../src/sdk.js";
import { AnthropicProvider } from "../src/providers/index.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Error: ANTHROPIC_API_KEY is not set.\n" +
      "Export it before running:\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-...",
  );
  process.exit(1);
}

const agent = new Agent({
  provider: new AnthropicProvider(),
  model: "claude-opus-4-5",
  mcpServers: {
    // stdio server spawned via npx. Swap for an HTTP server with:
    //   docs: { type: "http", url: "https://...", headers: { Authorization: "Bearer ..." } }
    everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
  },
});

const session = await agent.session(); // connects the MCP server here

console.log("Running agent with MCP tools…\n");

for await (const event of session.run(
  "Use the available MCP tools to echo back the message 'hello from skawld'.",
)) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
  if (event.type === "tool_call_start") {
    console.log(`\n[tool] ${event.tool_name}`);
  }
  if (event.type === "result") {
    process.stdout.write("\n");
    break;
  }
  if (event.type === "error") {
    console.error("\nAgent error:", event.error.message);
    break;
  }
}

await agent.close(); // disconnects MCP servers and kills child processes
