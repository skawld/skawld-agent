import { describe, test, expect } from "bun:test";
import type { Tool as McpToolDefinition, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { makeMcpTool, type McpCallTool } from "./tool.js";
import type { ToolContext } from "../base.js";
import { AbortError } from "../../core/errors.js";

function ctx(signal: AbortSignal = new AbortController().signal): ToolContext {
  // execute() only reads ctx.signal; the rest is unused here.
  return { signal } as ToolContext;
}

const echoTool: McpToolDefinition = {
  name: "echo",
  description: "Echoes input",
  inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
  annotations: { readOnlyHint: true },
};

const mutateTool: McpToolDefinition = {
  name: "write_file",
  inputSchema: { type: "object" },
};

const okCall: McpCallTool = async (_n, args) =>
  ({ content: [{ type: "text", text: JSON.stringify(args) }] }) as CallToolResult;

describe("makeMcpTool", () => {
  test("namespaces the tool name", () => {
    const t = makeMcpTool("server", echoTool, okCall);
    expect(t.name).toBe("mcp__server__echo");
  });

  test("read-only hint → read scope + parallelSafe", () => {
    const t = makeMcpTool("s", echoTool, okCall);
    expect(t.scope).toBe("read");
    expect(t.parallelSafe).toBe(true);
  });

  test("absent/false hint → write scope, not parallelSafe", () => {
    const t = makeMcpTool("s", mutateTool, okCall);
    expect(t.scope).toBe("write");
    expect(t.parallelSafe).toBe(false);
  });

  test("input_schema coerced with properties default", () => {
    const t = makeMcpTool("s", mutateTool, okCall);
    expect(t.input_schema).toEqual({ type: "object", properties: {} });
  });

  test("input_schema preserves properties and required", () => {
    const t = makeMcpTool("s", echoTool, okCall);
    expect(t.input_schema.required).toEqual(["msg"]);
    expect(t.input_schema.properties).toHaveProperty("msg");
  });

  test("validate passes objects through", () => {
    const t = makeMcpTool("s", echoTool, okCall);
    expect(t.validate({ msg: "hi" })).toEqual({ msg: "hi" });
  });

  test("validate rejects non-objects", () => {
    const t = makeMcpTool("s", echoTool, okCall);
    expect(() => t.validate([] as unknown as Record<string, unknown>)).toThrow();
  });

  test("execute round-trips through callTool and maps result", async () => {
    const t = makeMcpTool("s", echoTool, okCall);
    const out = await t.execute({ msg: "hi" }, ctx());
    expect(out.content).toEqual([{ type: "text", text: '{"msg":"hi"}' }]);
    expect(out.is_error).toBeFalsy();
  });

  test("execute returns is_error on server failure (no throw)", async () => {
    const failing: McpCallTool = async () => {
      throw new Error("server exploded");
    };
    const t = makeMcpTool("s", echoTool, failing);
    const out = await t.execute({ msg: "hi" }, ctx());
    expect(out.is_error).toBe(true);
    expect(out.content).toContain("server exploded");
  });

  test("execute throws AbortError when signal already aborted", async () => {
    const t = makeMcpTool("s", echoTool, okCall);
    const ac = new AbortController();
    ac.abort();
    await expect(t.execute({ msg: "hi" }, ctx(ac.signal))).rejects.toThrow(AbortError);
  });
});
