import { describe, expect, it, afterEach } from "bun:test";
import path from "node:path";
import { Agent, getAgentInternals } from "./agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import type { BaseProvider } from "../providers/base.js";

const FIXTURE = path.resolve(import.meta.dir, "../../tests/fixtures/mcp-echo-server.ts");

function makeProvider(): BaseProvider {
  return {
    id: "test-provider",
    contextWindow: () => 200_000,
    stream: async function* () { /* loop never runs in these tests */ },
  };
}

function makeAgent(mcpServers?: Record<string, { command: string; args: string[] }>): Agent {
  return new Agent({
    provider: makeProvider(),
    model: "m",
    sessionStore: new InMemorySessionStore(),
    mcpServers,
  });
}

let agent: Agent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

describe("Agent MCP integration", () => {
  it("registers MCP tools and adds them to the system prompt after session()", async () => {
    agent = makeAgent({ test: { command: "bun", args: ["run", FIXTURE] } });
    const internal = getAgentInternals(agent);

    expect(internal.tools.get("mcp__test__echo")).toBeUndefined(); // not yet connected

    await agent.session();

    expect(internal.tools.get("mcp__test__echo")).toBeDefined();
    expect(internal.tools.get("mcp__test__boom")).toBeDefined();
    const envText = internal.systemBlocks.map((b) => b.text).join("\n");
    expect(envText).toContain("mcp__test__echo");
  });

  it("connects only once across multiple session() calls", async () => {
    agent = makeAgent({ test: { command: "bun", args: ["run", FIXTURE] } });
    const internal = getAgentInternals(agent);

    // A second connect would re-register tools and throw on duplicate names;
    // both sessions resolving proves the connect is memoized.
    await agent.session();
    await agent.session();

    const mcpTools = internal.tools.list().filter((t) => t.name.startsWith("mcp__"));
    expect(mcpTools).toHaveLength(2);
  });

  it("is inert when no mcpServers are configured", async () => {
    agent = makeAgent();
    const internal = getAgentInternals(agent);
    await agent.session();
    expect(internal.tools.list().some((t) => t.name.startsWith("mcp__"))).toBe(false);
  });

  it("session() rejects when a server fails to connect", async () => {
    agent = makeAgent({ bad: { command: "bun", args: ["run", "/no/such/server.ts"] } });
    await expect(agent.session()).rejects.toThrow(/Failed to connect MCP server/);
  });
});
