/** Integration tests: ctx.emit forwarding through the scheduler's writes/exec path. */

import { describe, expect, it } from "bun:test";
import { Agent, getAgentInternals } from "./agent.js";
import { getSessionInternals } from "./session.js";
import { executeToolCalls } from "./scheduler.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { ToolRegistry } from "../tools/registry.js";
import type {
  Event,
  ToolCallEndEvent,
  ToolCallStartEvent,
  SubagentEvent,
} from "./events.js";
import type { Tool, ToolContext, ToolResult } from "../tools/base.js";
import type { ToolUseBlock, ToolResultBlock } from "./types.js";
import type { AgentInternal } from "./agent.js";
import type { SessionInternal } from "./session.js";

function makeToolUseBlock(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function neverSignal(): AbortSignal {
  return new AbortController().signal;
}

async function makeInternals(
  tools: ToolRegistry,
): Promise<{ ai: AgentInternal; si: SessionInternal }> {
  const store = new InMemorySessionStore();
  const provider: import("../providers/base.js").BaseProvider = {
    id: "test",
    contextWindow: () => 200_000,
    async *stream() {
      yield { type: "message_start" as const, model: "m" };
      yield { type: "text_delta" as const, text: "ok" };
      yield {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const agent = new Agent({
    provider,
    model: "m",
    sessionStore: store,
    tools,
    permissions: { mode: "yolo" },
  });
  const session = await agent.session();
  const ai = getAgentInternals(agent);
  const si = getSessionInternals(session);
  si.activeRunId = "test-run-id";
  return { ai, si };
}

async function collectGen(
  gen: AsyncGenerator<Event, ToolResultBlock[]>,
): Promise<{ events: Event[]; results: ToolResultBlock[] }> {
  const events: Event[] = [];
  let results: ToolResultBlock[] = [];
  while (true) {
    const next = await gen.next();
    if (next.done) {
      results = next.value ?? [];
      break;
    }
    events.push(next.value);
  }
  return { events, results };
}

function subagentEv(label: string): SubagentEvent {
  return {
    type: "subagent_event",
    parent_session_id: "p",
    subagent_run_id: "r",
    subagent_type: "x",
    display_name: label,
    event: {
      type: "error",
      error: { name: "ChildEvent", message: label, retryable: false },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock tools
// ---------------------------------------------------------------------------

/** Write-scope tool that emits 3 SubagentEvents during execute, then succeeds. */
class EmittingWriteTool implements Tool<Record<string, unknown>> {
  readonly name = "EmitWrite";
  readonly description = "Emits 3 child events during execute.";
  readonly input_schema = { type: "object" as const, properties: {} };
  readonly scope = "write" as const;
  readonly parallelSafe = false;
  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }
  summarize(): string {
    return "EmitWrite";
  }
  async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
    ctx.emit?.(subagentEv("a"));
    ctx.emit?.(subagentEv("b"));
    ctx.emit?.(subagentEv("c"));
    return { content: "done", summary: "EmitWrite", is_error: false };
  }
}

/** Write-scope tool that emits 2 events then throws (non-abort). */
class EmittingThenThrowTool implements Tool<Record<string, unknown>> {
  readonly name = "EmitThrow";
  readonly description = "Emits, then throws.";
  readonly input_schema = { type: "object" as const, properties: {} };
  readonly scope = "write" as const;
  readonly parallelSafe = false;
  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }
  summarize(): string {
    return "EmitThrow";
  }
  async execute(_input: unknown, ctx: ToolContext): Promise<ToolResult> {
    ctx.emit?.(subagentEv("before-throw"));
    ctx.emit?.(subagentEv("also-before-throw"));
    throw new Error("boom");
  }
}

/** Write-scope tool that never calls emit — regression check. */
class SilentWriteTool implements Tool<Record<string, unknown>> {
  readonly name = "Silent";
  readonly description = "Never emits.";
  readonly input_schema = { type: "object" as const, properties: {} };
  readonly scope = "write" as const;
  readonly parallelSafe = false;
  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }
  summarize(): string {
    return "Silent";
  }
  async execute(): Promise<ToolResult> {
    return { content: "quiet", summary: "Silent", is_error: false };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scheduler — ctx.emit forwarding (writes path)", () => {
  it("yields all emitted events between tool_call_start and tool_call_end", async () => {
    const tools = new ToolRegistry();
    tools.register(new EmittingWriteTool());
    const { ai, si } = await makeInternals(tools);

    const block = makeToolUseBlock("tu-1", "EmitWrite");
    const { events, results } = await collectGen(
      executeToolCalls([block], ai, si, neverSignal()),
    );

    const startIdx = events.findIndex((e) => e.type === "tool_call_start");
    const endIdx = events.findIndex((e) => e.type === "tool_call_end");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);

    const startEv = events[startIdx] as ToolCallStartEvent;
    const endEv = events[endIdx] as ToolCallEndEvent;
    expect(startEv.tool_name).toBe("EmitWrite");
    expect(endEv.tool_name).toBe("EmitWrite");
    expect(endEv.is_error).toBe(false);

    // Events between start and end must include the 3 SubagentEvents in order.
    const between = events.slice(startIdx + 1, endIdx);
    const subagentLabels = between
      .filter((e): e is SubagentEvent => e.type === "subagent_event")
      .map((e) => e.display_name);
    expect(subagentLabels).toEqual(["a", "b", "c"]);

    // Tool succeeded → result block has the content
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("done");
  });

  it("preserves events emitted BEFORE a throw, then yields tool_call_end (is_error)", async () => {
    const tools = new ToolRegistry();
    tools.register(new EmittingThenThrowTool());
    const { ai, si } = await makeInternals(tools);

    const block = makeToolUseBlock("tu-2", "EmitThrow");
    // The throw is a non-AbortError → safeExecute catches it and turns it into
    // an is_error result block; the scheduler emits a normal tool_call_end.
    const { events, results } = await collectGen(
      executeToolCalls([block], ai, si, neverSignal()),
    );

    const startIdx = events.findIndex((e) => e.type === "tool_call_start");
    const endIdx = events.findIndex((e) => e.type === "tool_call_end");
    expect(endIdx).toBeGreaterThan(startIdx);

    const between = events.slice(startIdx + 1, endIdx);
    const subagentLabels = between
      .filter((e): e is SubagentEvent => e.type === "subagent_event")
      .map((e) => e.display_name);
    // Both emits happen before the throw → both must surface.
    expect(subagentLabels).toEqual(["before-throw", "also-before-throw"]);

    // safeExecute catches non-abort errors → is_error result, not a re-throw.
    expect(results).toHaveLength(1);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool failed");
  });

  it("does NOT change behavior for tools that never call emit (regression)", async () => {
    const tools = new ToolRegistry();
    tools.register(new SilentWriteTool());
    const { ai, si } = await makeInternals(tools);

    const block = makeToolUseBlock("tu-3", "Silent");
    const { events, results } = await collectGen(
      executeToolCalls([block], ai, si, neverSignal()),
    );

    // Only the standard tool_call_start + tool_call_end pair — no SubagentEvents.
    expect(events.map((e) => e.type)).toEqual([
      "tool_call_start",
      "tool_call_end",
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("quiet");
  });
});
