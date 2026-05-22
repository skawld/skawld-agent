/**
 * Integration tests for connectMcpServers against a real stdio MCP server
 * (tests/fixtures/mcp-echo-server.ts), exercising the actual stdio transport,
 * connect/listTools/callTool/close path, and fail-fast teardown.
 */
import { describe, test, expect, afterEach } from "bun:test";
import path from "node:path";
import { connectMcpServers, type McpConnection } from "./client.js";
import type { ToolContext } from "../base.js";

const FIXTURE = path.resolve(import.meta.dir, "../../../tests/fixtures/mcp-echo-server.ts");

function ctx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return { signal } as ToolContext;
}

let conn: McpConnection | undefined;
afterEach(async () => {
  await conn?.close();
  conn = undefined;
});

describe("connectMcpServers (stdio)", () => {
  test("connects, lists, namespaces, and round-trips a tool call", async () => {
    conn = await connectMcpServers({ test: { command: "bun", args: ["run", FIXTURE] } });

    const names = conn.tools.map((t) => t.name).sort();
    expect(names).toEqual(["mcp__test__boom", "mcp__test__echo"]);

    const echo = conn.tools.find((t) => t.name === "mcp__test__echo")!;
    expect(echo.scope).toBe("read"); // readOnlyHint: true
    expect(echo.parallelSafe).toBe(true);

    const out = await echo.execute({ msg: "hi" }, ctx());
    expect(out.is_error).toBeFalsy();
    expect(out.content).toEqual([{ type: "text", text: "echo: hi" }]);
  });

  test("non-read-only tool gets write scope and surfaces errors as is_error", async () => {
    conn = await connectMcpServers({ test: { command: "bun", args: ["run", FIXTURE] } });
    const boom = conn.tools.find((t) => t.name === "mcp__test__boom")!;
    expect(boom.scope).toBe("write");

    const out = await boom.execute({}, ctx());
    expect(out.is_error).toBe(true);
  });

  test("close() is idempotent", async () => {
    conn = await connectMcpServers({ test: { command: "bun", args: ["run", FIXTURE] } });
    await conn.close();
    await conn.close(); // second call must not throw
    conn = undefined;
  });

  test("fail-fast: a bad server rejects and leaves nothing open", async () => {
    await expect(
      connectMcpServers({ bad: { command: "bun", args: ["run", "/no/such/server.ts"] } }),
    ).rejects.toThrow(/Failed to connect MCP server/);
  });

  test("rejects when server names collide after normalization", async () => {
    await expect(
      connectMcpServers({
        "my server": { command: "bun", args: ["run", FIXTURE] },
        "my_server": { command: "bun", args: ["run", FIXTURE] },
      }),
    ).rejects.toThrow(/collide after normalization/);
  });
});
