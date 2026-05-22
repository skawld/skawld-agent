/**
 * End-to-end: a model turn calls an MCP tool, the agent loop executes it
 * against a real stdio MCP server, and the mapped result flows back. Also
 * checks scope→permission behavior (read-only auto-allows, mutating prompts).
 */
import { describe, expect, test, afterEach } from "bun:test";
import path from "node:path";
import { Agent } from "./agent.js";
import { MockProvider } from "./_test-mock-provider.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import type { Event } from "./events.js";
import type { CanUseTool } from "../permissions/engine.js";
import type { ToolResultBlock } from "./types.js";

const FIXTURE = path.resolve(import.meta.dir, "../../tests/fixtures/mcp-echo-server.ts");

async function collect(iter: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function toolUseTurn(id: string, name: string, inputJson: string) {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" as const },
      { type: "tool_use_start" as const, id, name },
      { type: "tool_use_input_delta" as const, id, json_delta: inputJson },
      { type: "tool_use_end" as const, id },
      {
        type: "message_end" as const,
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

function endTurn() {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" as const },
      { type: "text_delta" as const, text: "done" },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

let agent: Agent | undefined;
afterEach(async () => {
  await agent?.close();
  agent = undefined;
});

describe("MCP end-to-end through the agent loop", () => {
  test("read-only MCP tool auto-allows in default mode and returns mapped result", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-1", "mcp__test__echo", '{"msg":"hi"}'));
    provider.enqueue(endTurn());

    agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: new InMemorySessionStore(),
      mcpServers: { test: { command: "bun", args: ["run", FIXTURE] } },
      permissions: { mode: "default" }, // no canUseTool: a write tool would be denied
    });

    const session = await agent.session();
    const events = await collect(session.run("please echo"));

    const start = events.find(
      (e): e is Extract<Event, { type: "tool_call_start" }> =>
        e.type === "tool_call_start" && e.tool_name === "mcp__test__echo",
    );
    expect(start).toBeDefined();

    const user = events.find(
      (e): e is Extract<Event, { type: "user" }> =>
        e.type === "user" && e.message.content.some((b) => (b as ToolResultBlock).type === "tool_result"),
    );
    const toolResult = user!.message.content.find(
      (b): b is ToolResultBlock => (b as ToolResultBlock).type === "tool_result",
    )!;
    expect(toolResult.content).toEqual([{ type: "text", text: "echo: hi" }]);
    expect(toolResult.is_error).toBeFalsy();

    const result = events.find((e) => e.type === "result")!;
    expect(result.type).toBe("result");
  });

  test("mutating MCP tool routes through the permission callback", async () => {
    const provider = new MockProvider();
    provider.enqueue(toolUseTurn("tu-1", "mcp__test__boom", "{}"));
    provider.enqueue(endTurn());

    const seen: string[] = [];
    const canUseTool: CanUseTool = async (req) => {
      seen.push(req.tool_name);
      return { behavior: "allow" };
    };

    agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: new InMemorySessionStore(),
      mcpServers: { test: { command: "bun", args: ["run", FIXTURE] } },
      permissions: { mode: "default", canUseTool },
    });

    const session = await agent.session();
    const events = await collect(session.run("please boom"));

    expect(seen).toContain("mcp__test__boom"); // write scope → permission path
    const end = events.find(
      (e): e is Extract<Event, { type: "tool_call_end" }> =>
        e.type === "tool_call_end" && e.tool_name === "mcp__test__boom",
    );
    expect(end?.is_error).toBe(true); // boom throws server-side → is_error result
  });
});
