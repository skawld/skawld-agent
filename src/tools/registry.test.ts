import { describe, test, expect } from "bun:test";
import { ToolRegistry, defaultTools } from "./registry";
import { ConfigError } from "../core/errors";
import type { Tool, ToolContext, ToolResult } from "./base";

// Minimal stub tool for testing
function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    input_schema: { type: "object", properties: {}, required: [] },
    scope: "read",
    parallelSafe: true,
    validate(raw) { return raw; },
    async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { content: "ok", summary: "ok" };
    },
    summarize() { return `run ${name}`; },
  };
}

describe("ToolRegistry", () => {
  test("register and get a tool", () => {
    const reg = new ToolRegistry();
    const tool = makeTool("read");
    reg.register(tool);
    expect(reg.get("read")).toBe(tool);
  });

  test("get returns undefined for unknown tool", () => {
    const reg = new ToolRegistry();
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  test("list returns all registered tools", () => {
    const reg = new ToolRegistry();
    const a = makeTool("a");
    const b = makeTool("b");
    reg.register(a);
    reg.register(b);
    expect(reg.list()).toHaveLength(2);
    expect(reg.list()).toContain(a);
    expect(reg.list()).toContain(b);
  });

  test("duplicate registration throws ConfigError", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("write"));
    expect(() => reg.register(makeTool("write"))).toThrow(ConfigError);
  });

  test("duplicate registration error message contains tool name", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("bash"));
    expect(() => reg.register(makeTool("bash"))).toThrow(/bash/);
  });

  test("schemas() returns plain ToolSchema objects without runtime methods", () => {
    const reg = new ToolRegistry();
    reg.register(makeTool("glob"));
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(1);
    const s = schemas[0];
    expect(s.name).toBe("glob");
    expect(s.description).toBe("glob description");
    expect(s.input_schema).toEqual({ type: "object", properties: {}, required: [] });
    // Runtime methods must NOT appear on the schema object
    expect((s as unknown as Record<string, unknown>).execute).toBeUndefined();
    expect((s as unknown as Record<string, unknown>).validate).toBeUndefined();
  });

  test("schemas() returns empty array when nothing registered", () => {
    const reg = new ToolRegistry();
    expect(reg.schemas()).toEqual([]);
  });
});

describe("defaultTools", () => {
  test("returns a ToolRegistry instance", () => {
    const reg = defaultTools();
    expect(reg).toBeInstanceOf(ToolRegistry);
  });

  test("contains exactly 10 tools", () => {
    const reg = defaultTools();
    expect(reg.list()).toHaveLength(10);
  });
});
