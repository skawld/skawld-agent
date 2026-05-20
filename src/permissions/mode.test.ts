import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext, ToolResult, ToolScope } from "../tools/base.js";
import { PermissionEngine, type PendingToolCall, type PermissionEngineOptions } from "./engine.js";
import type { PermissionMode } from "./mode.js";

const projectRoot = "/repo";

function makeTool(name: string, scope: ToolScope): Tool<Record<string, unknown>> {
  return {
    name,
    description: `${name} description`,
    input_schema: { type: "object", properties: {}, required: [] },
    scope,
    parallelSafe: true,
    validate(raw) { return raw; },
    async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { content: "ok", summary: "ok" };
    },
    summarize() { return `run ${name}`; },
  };
}

function engine(opts: Partial<PermissionEngineOptions>): PermissionEngine {
  return new PermissionEngine({ mode: "default", rules: [], projectRoot, ...opts });
}

function call(tool: Tool<Record<string, unknown>>, input: Record<string, unknown> = {}): PendingToolCall {
  return { tool_use_id: "toolu_1", tool, input };
}

const readTool = makeTool("Read", "read");
const writeTool = makeTool("Write", "write");
const editTool = makeTool("Edit", "write");
const bashTool = makeTool("Bash", "exec");
const taskCreateTool = makeTool("TaskCreate", "write");

describe("PermissionEngine mode defaults", () => {
  test("allows read tools in every mode", () => {
    for (const mode of ["default", "acceptEdits", "yolo"] satisfies PermissionMode[]) {
      expect(engine({ mode }).evaluate(call(readTool, { file_path: "README.md" }))).toEqual({ decision: "allow" });
    }
  });

  test("asks for Write and Edit in default mode and allows them in acceptEdits and yolo", () => {
    expect(engine({ mode: "default" }).evaluate(call(writeTool))).toEqual({ decision: "ask" });
    expect(engine({ mode: "default" }).evaluate(call(editTool))).toEqual({ decision: "ask" });

    for (const mode of ["acceptEdits", "yolo"] satisfies PermissionMode[]) {
      expect(engine({ mode }).evaluate(call(writeTool))).toEqual({ decision: "allow" });
      expect(engine({ mode }).evaluate(call(editTool))).toEqual({ decision: "allow" });
    }
  });

  test("asks for Bash except in yolo mode", () => {
    expect(engine({ mode: "default" }).evaluate(call(bashTool, { command: "git status" }))).toEqual({ decision: "ask" });
    expect(engine({ mode: "acceptEdits" }).evaluate(call(bashTool, { command: "git status" }))).toEqual({ decision: "ask" });
    expect(engine({ mode: "yolo" }).evaluate(call(bashTool, { command: "git status" }))).toEqual({ decision: "allow" });
  });

  test("allows task tools unless an explicit rule denies them", () => {
    expect(engine({ mode: "default" }).evaluate(call(taskCreateTool))).toEqual({ decision: "allow" });

    const decision = engine({
      mode: "default",
      rules: [{ kind: "tool", tool: "TaskCreate", decision: "deny" }],
    }).evaluate(call(taskCreateTool));

    expect(decision.decision).toBe("deny");
  });
});
