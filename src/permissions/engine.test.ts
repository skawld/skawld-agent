import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext, ToolResult, ToolScope } from "../tools/base.js";
import { PermissionEngine, type CanUseTool, type CanUseToolRequest, type PendingToolCall, type PermissionDecision, type PermissionEngineOptions } from "./engine.js";
import type { PermissionRule } from "./rules.js";

const projectRoot = "/repo";

function makeTool(
  name: string,
  scope: ToolScope,
  validate: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw,
): Tool<Record<string, unknown>> {
  return {
    name,
    description: `${name} description`,
    input_schema: { type: "object", properties: {}, required: [] },
    scope,
    parallelSafe: true,
    validate,
    async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { content: "ok", summary: "ok" };
    },
    summarize(input: Record<string, unknown>): string {
      return `${name} ${JSON.stringify(input)}`;
    },
  };
}

function engine(opts: Partial<PermissionEngineOptions>): PermissionEngine {
  return new PermissionEngine({
    mode: "default",
    rules: [],
    projectRoot,
    ...opts,
  });
}

function call(tool: Tool<Record<string, unknown>>, input: Record<string, unknown> = {}): PendingToolCall {
  return { tool_use_id: "toolu_1", tool, input };
}

const bashTool = makeTool("Bash", "exec");

describe("PermissionEngine rule precedence", () => {
  test("uses first-match-wins when an allow appears before a deny", () => {
    const rules: PermissionRule[] = [
      { kind: "tool", tool: "Bash", decision: "allow" },
      { kind: "tool", tool: "Bash", decision: "deny" },
    ];

    expect(engine({ mode: "default", rules }).evaluate(call(bashTool, { command: "rm -rf dist" }))).toEqual({ decision: "allow" });
  });

  test("uses first-match-wins when a deny appears before an allow", () => {
    const rules: PermissionRule[] = [
      { kind: "tool", tool: "Bash", decision: "deny" },
      { kind: "tool", tool: "Bash", decision: "allow" },
    ];

    const decision = engine({ mode: "yolo", rules }).evaluate(call(bashTool, { command: "git status" }));

    expect(decision.decision).toBe("deny");
  });

  test("explicit deny blocks yolo mode", () => {
    const decision = engine({
      mode: "yolo",
      rules: [{ kind: "bash", pattern: "git push", decision: "deny" }],
    }).evaluate(call(bashTool, { command: "git push origin main" }));

    expect(decision.decision).toBe("deny");
  });

  test("explicit allow overrides the default ask decision", () => {
    expect(engine({
      mode: "default",
      rules: [{ kind: "bash", pattern: "git status", decision: "allow" }],
    }).evaluate(call(bashTool, { command: "git status --short" }))).toEqual({ decision: "allow" });
  });
});

describe("PermissionEngine canUseTool callback", () => {
  test("invokes canUseTool for ask decisions with the required request fields", async () => {
    let captured: CanUseToolRequest | undefined;
    let capturedSignal: AbortSignal | undefined;
    const input = { command: "git status" };
    const signal = new AbortController().signal;
    const canUseTool: CanUseTool = async (req, reqSignal) => {
      captured = req;
      capturedSignal = reqSignal;
      return { behavior: "allow" };
    };

    const decision = await engine({ mode: "default", canUseTool }).resolve(call(bashTool, input), signal);

    expect(decision).toEqual({ decision: "allow" });
    expect(captured).toEqual({
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      input,
      summary: 'Bash {"command":"git status"}',
      mode: "default",
    });
    expect(capturedSignal).toBe(signal);
  });

  test("fails closed when canUseTool is missing", async () => {
    const decision = await engine({ mode: "default" }).resolve(call(bashTool, { command: "git status" }), new AbortController().signal);

    expect(decision.decision).toBe("deny");
    expect((decision as Extract<PermissionDecision, { decision: "deny" }>).reason).toContain("canUseTool callback is not configured");
  });

  test("uses deny callback messages", async () => {
    const canUseTool: CanUseTool = async () => ({ behavior: "deny", message: "user declined" });

    await expect(engine({ canUseTool }).resolve(call(bashTool, { command: "git status" }), new AbortController().signal)).resolves.toEqual({
      decision: "deny",
      reason: "user declined",
    });
  });

  test("denies when the callback throws", async () => {
    const canUseTool: CanUseTool = async () => {
      throw new Error("boom");
    };

    const decision = await engine({ canUseTool }).resolve(call(bashTool, { command: "git status" }), new AbortController().signal);

    expect(decision.decision).toBe("deny");
    expect((decision as Extract<PermissionDecision, { decision: "deny" }>).reason).toContain("permission callback failed or aborted");
  });

  test("denies when the abort signal is already aborted", async () => {
    let invoked = false;
    const canUseTool: CanUseTool = async () => {
      invoked = true;
      return { behavior: "allow" };
    };
    const controller = new AbortController();
    controller.abort();

    const decision = await engine({ canUseTool }).resolve(call(bashTool, { command: "git status" }), controller.signal);

    expect(decision.decision).toBe("deny");
    expect(invoked).toBe(false);
  });

  test("denies when the abort signal fires while waiting for the callback", async () => {
    const controller = new AbortController();
    const canUseTool: CanUseTool = async (_req, _signal) => {
      controller.abort();
      await new Promise(() => {});
      return { behavior: "allow" };
    };

    const decision = await engine({ canUseTool }).resolve(call(bashTool, { command: "git status" }), controller.signal);

    expect(decision.decision).toBe("deny");
  });

  test("validates and canonicalizes updatedInput before allowing", async () => {
    const canonicalTool = makeTool("Bash", "exec", (raw) => {
      if (typeof raw.command !== "string") throw new Error("missing command");
      return { command: raw.command.trim(), canonical: true };
    });
    const canUseTool: CanUseTool = async () => ({ behavior: "allow", updatedInput: { command: "  git status  " } });

    await expect(engine({ canUseTool }).resolve(call(canonicalTool, { command: "git diff" }), new AbortController().signal)).resolves.toEqual({
      decision: "allow",
      updatedInput: { command: "git status", canonical: true },
    });
  });

  test("denies invalid updatedInput", async () => {
    const strictTool = makeTool("Bash", "exec", (raw) => {
      if (raw.command !== "git status") throw new Error("invalid command");
      return raw;
    });
    const canUseTool: CanUseTool = async () => ({ behavior: "allow", updatedInput: { command: "rm -rf dist" } });

    const decision = await engine({ canUseTool }).resolve(call(strictTool, { command: "git diff" }), new AbortController().signal);

    expect(decision.decision).toBe("deny");
    expect((decision as Extract<PermissionDecision, { decision: "deny" }>).reason).toContain("updated input is invalid");
  });

  test("denies malformed callback responses", async () => {
    const malformedResponses: unknown[] = [null, [], {}, { behavior: "maybe" }, { behavior: "deny" }, { behavior: "deny", message: 123 }, { behavior: "allow", updatedInput: [] }];

    for (const response of malformedResponses) {
      const canUseTool = (async () => response) as CanUseTool;
      const decision = await engine({ canUseTool }).resolve(call(bashTool, { command: "git status" }), new AbortController().signal);

      expect(decision.decision).toBe("deny");
      expect((decision as Extract<PermissionDecision, { decision: "deny" }>).reason).toContain("permission callback returned an invalid response");
    }
  });
});
