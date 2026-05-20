/** Unit tests for the scheduler (Phase 4). */

import { describe, expect, it } from "bun:test";
import { executeToolCalls } from "./scheduler.js";
import { Agent, getAgentInternals } from "./agent.js";
import { getSessionInternals } from "./session.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  MockReadTool,
  MockWriteTool,
  MockAlwaysFailTool,
  MockAbortAwareTool,
  MockAbortAwareReadTool,
} from "./_test-mock-tools.js";
import type { Event, ToolCallStartEvent, ToolCallEndEvent, PermissionRequestEvent } from "./events.js";
import type { ToolUseBlock, ToolResultBlock } from "./types.js";
import type { CanUseTool } from "../permissions/engine.js";
import type { AgentInternal } from "./agent.js";
import type { SessionInternal } from "./session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolUseBlock(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function makeAbortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

function neverSignal(): AbortSignal {
  return new AbortController().signal;
}

interface Internals {
  ai: AgentInternal;
  si: SessionInternal;
}

async function makeInternals(opts: {
  tools?: ToolRegistry;
  permMode?: "default" | "acceptEdits" | "yolo";
  canUseTool?: CanUseTool;
} = {}): Promise<Internals> {
  const store = new InMemorySessionStore();

  const capturingProvider: import("../providers/base.js").BaseProvider = {
    id: "capturing",
    contextWindow: () => 200_000,
    async *stream() {
      yield { type: "message_start" as const, model: "test-model" };
      yield { type: "text_delta" as const, text: "ok" };
      yield {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };

  const agent = new Agent({
    provider: capturingProvider,
    model: "test-model",
    sessionStore: store,
    tools: opts.tools,
    permissions: {
      mode: opts.permMode ?? "yolo",
      canUseTool: opts.canUseTool,
    },
  });

  const session = await agent.session();
  const ai = getAgentInternals(agent);
  const si = getSessionInternals(session);
  // Simulate what runLoop does: set an activeRunId
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

// ---------------------------------------------------------------------------
// Test: Unknown tool name
// ---------------------------------------------------------------------------

describe("scheduler — unknown tool", () => {
  it("returns is_error tool_result with correct message; emits start+end events", async () => {
    const tools = new ToolRegistry();
    const { ai, si } = await makeInternals({ tools });
    const blocks = [makeToolUseBlock("tu-1", "NonExistentTool")];

    const gen = executeToolCalls(blocks, ai, si, neverSignal());
    const { events, results } = await collectGen(gen);

    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(starts[0]!.tool_name).toBe("NonExistentTool");
    expect(ends[0]!.is_error).toBe(true);

    expect(results).toHaveLength(1);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("NonExistentTool");
    expect(results[0]!.content).toContain("not registered");
  });
});

// ---------------------------------------------------------------------------
// Test: Invalid JSON input
// ---------------------------------------------------------------------------

describe("scheduler — invalid JSON input", () => {
  it("returns is_error with 'Tool input was not valid JSON' message", async () => {
    const tools = new ToolRegistry();
    const { ai, si } = await makeInternals({ tools });
    const block = makeToolUseBlock("tu-bad", "MockRead", {
      __invalidJson: true,
      raw: "{not json",
    });
    const { events, results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];
    expect(ends[0]!.is_error).toBe(true);

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool input was not valid JSON");
    expect(results[0]!.content).toContain("{not json");
  });
});

// ---------------------------------------------------------------------------
// Test: Validation failure
// ---------------------------------------------------------------------------

describe("scheduler — validate throws", () => {
  it("returns is_error result with validation message; execute never called", async () => {
    const validateFail: import("../tools/base.js").Tool<Record<string, unknown>> = {
      name: "MockValidateFail",
      description: "fails validate",
      scope: "write",
      parallelSafe: false,
      input_schema: { type: "object", properties: {}, required: [] },
      validate(): Record<string, unknown> {
        throw new Error("bad input shape");
      },
      async execute(): Promise<import("../tools/base.js").ToolResult> {
        throw new Error("should not be called");
      },
      summarize(): string {
        return "MockValidateFail(...)";
      },
    };

    const tools = new ToolRegistry();
    tools.register(validateFail);
    const { ai, si } = await makeInternals({ tools });
    const block = makeToolUseBlock("tu-v", "MockValidateFail");
    const { results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("bad input shape");
  });
});

// ---------------------------------------------------------------------------
// Test: Permission deny
// ---------------------------------------------------------------------------

describe("scheduler — permission deny", () => {
  it("is_error result 'Tool call denied'; execute not called", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async () => ({
      behavior: "deny",
      message: "nope",
    });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });
    const block = makeToolUseBlock("tu-d", "MockWrite");
    const { events, results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    // A PermissionRequestEvent should have been emitted (the call went to "ask" path)
    const permReq = events.filter(e => e.type === "permission_request") as PermissionRequestEvent[];
    expect(permReq).toHaveLength(1);

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool call denied");
    expect(results[0]!.content).toContain("nope");

    // execute never called
    expect(write.callTimestamps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Permission ask → allow (PermissionRequestEvent emitted)
// ---------------------------------------------------------------------------

describe("scheduler — permission ask → allow", () => {
  it("emits PermissionRequestEvent then runs the tool", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async () => ({ behavior: "allow" });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });
    const block = makeToolUseBlock("tu-ask", "MockWrite");
    const { events, results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    const permReqs = events.filter(e => e.type === "permission_request") as PermissionRequestEvent[];
    expect(permReqs).toHaveLength(1);
    expect(permReqs[0]!.requests).toHaveLength(1);
    expect(permReqs[0]!.requests[0]!.tool_use_id).toBe("tu-ask");

    // PermissionRequestEvent must come before any start event
    const permIdx = events.findIndex(e => e.type === "permission_request");
    const startIdx = events.findIndex(e => e.type === "tool_call_start");
    expect(permIdx).toBeLessThan(startIdx);

    expect(results[0]!.is_error).toBeFalsy();
    expect(write.callTimestamps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test: Permission ask → allow with updatedInput
// ---------------------------------------------------------------------------

describe("scheduler — permission updatedInput", () => {
  it("execute receives the updatedInput from canUseTool", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const canUseTool: CanUseTool = async () => ({
      behavior: "allow",
      updatedInput: { injected: true },
    });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });
    const block = makeToolUseBlock("tu-upd", "MockWrite");
    await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    expect(write.capturedInputs[0]).toEqual({ injected: true });
  });
});

// ---------------------------------------------------------------------------
// Test: Tool execute throws non-AbortError
// ---------------------------------------------------------------------------

describe("scheduler — tool throws non-AbortError", () => {
  it("synthesizes is_error 'Tool failed: <msg>' without propagating", async () => {
    const fail = new MockAlwaysFailTool("intentional failure");
    const tools = new ToolRegistry();
    tools.register(fail);

    const { ai, si } = await makeInternals({ tools });
    const block = makeToolUseBlock("tu-fail", "MockAlwaysFail");
    const { results } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain("Tool failed: intentional failure");
  });
});

// ---------------------------------------------------------------------------
// Test: All reads — parallel execution, results in original order
// ---------------------------------------------------------------------------

describe("scheduler — all reads (parallel)", () => {
  it("runs 3 reads in parallel; results in original order; start precedes end per id", async () => {
    const r0 = new MockReadTool("result-0");
    const r1 = new MockReadTool("result-1");
    const r2 = new MockReadTool("result-2");

    Object.defineProperty(r0, "name", { value: "Read0", writable: false });
    Object.defineProperty(r1, "name", { value: "Read1", writable: false });
    Object.defineProperty(r2, "name", { value: "Read2", writable: false });

    const tools = new ToolRegistry();
    tools.register(r0);
    tools.register(r1);
    tools.register(r2);

    const { ai, si } = await makeInternals({ tools });

    const blocks = [
      makeToolUseBlock("tu-0", "Read0"),
      makeToolUseBlock("tu-1", "Read1"),
      makeToolUseBlock("tu-2", "Read2"),
    ];

    // Resolve in reverse order: r2 first, then r1, then r0
    const genProm = collectGen(executeToolCalls(blocks, ai, si, neverSignal()));

    await new Promise(r => setTimeout(r, 10));
    r2.deferred.resolve();
    await new Promise(r => setTimeout(r, 5));
    r1.deferred.resolve();
    await new Promise(r => setTimeout(r, 5));
    r0.deferred.resolve();

    const { events, results } = await genProm;

    // Results in original block order (not completion order)
    expect(results).toHaveLength(3);
    expect(results[0]!.tool_use_id).toBe("tu-0");
    expect(results[1]!.tool_use_id).toBe("tu-1");
    expect(results[2]!.tool_use_id).toBe("tu-2");

    expect(results[0]!.content).toBe("result-0");
    expect(results[1]!.content).toBe("result-1");
    expect(results[2]!.content).toBe("result-2");

    // For each tool_use_id, its start precedes its end
    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);

    for (const start of starts) {
      const sIdx = events.indexOf(start);
      const end = ends.find(e => e.tool_use_id === start.tool_use_id);
      expect(end).toBeDefined();
      const eIdx = events.indexOf(end!);
      expect(sIdx).toBeLessThan(eIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Mixed reads + writes — reads precede writes in event stream
// ---------------------------------------------------------------------------

describe("scheduler — mixed reads + writes", () => {
  it("read events all precede write events; writes run strictly sequentially", async () => {
    const read0 = new MockReadTool("read-result-0");
    const read1 = new MockReadTool("read-result-1");
    const write0 = new MockWriteTool("write-result-0");
    const write1 = new MockWriteTool("write-result-1");

    Object.defineProperty(read0, "name", { value: "MixRead0", writable: false });
    Object.defineProperty(read1, "name", { value: "MixRead1", writable: false });
    Object.defineProperty(write0, "name", { value: "MixWrite0", writable: false });
    Object.defineProperty(write1, "name", { value: "MixWrite1", writable: false });

    const tools = new ToolRegistry();
    tools.register(read0);
    tools.register(read1);
    tools.register(write0);
    tools.register(write1);

    const { ai, si } = await makeInternals({ tools });

    // Interleaved: read0, write0, read1, write1 (original order)
    const blocks = [
      makeToolUseBlock("tu-r0", "MixRead0"),
      makeToolUseBlock("tu-w0", "MixWrite0"),
      makeToolUseBlock("tu-r1", "MixRead1"),
      makeToolUseBlock("tu-w1", "MixWrite1"),
    ];

    const genProm = collectGen(executeToolCalls(blocks, ai, si, neverSignal()));
    await new Promise(r => setTimeout(r, 5));
    read0.deferred.resolve();
    read1.deferred.resolve();

    const { events, results } = await genProm;

    // Results in original block order
    expect(results[0]!.tool_use_id).toBe("tu-r0");
    expect(results[1]!.tool_use_id).toBe("tu-w0");
    expect(results[2]!.tool_use_id).toBe("tu-r1");
    expect(results[3]!.tool_use_id).toBe("tu-w1");

    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];

    // All read tool events must come before all write tool events in the stream
    const readEventIndices = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        if (e.type === "tool_call_start" || e.type === "tool_call_end") {
          const name = (e as ToolCallStartEvent | ToolCallEndEvent).tool_name;
          return name.startsWith("MixRead");
        }
        return false;
      })
      .map(({ i }) => i);

    const writeEventIndices = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => {
        if (e.type === "tool_call_start" || e.type === "tool_call_end") {
          const name = (e as ToolCallStartEvent | ToolCallEndEvent).tool_name;
          return name.startsWith("MixWrite");
        }
        return false;
      })
      .map(({ i }) => i);

    const maxReadIdx = Math.max(...readEventIndices);
    const minWriteIdx = Math.min(...writeEventIndices);
    expect(maxReadIdx).toBeLessThan(minWriteIdx);

    // Writes are sequential: write1.start must come after write0.end
    const w0Start = starts.find(e => e.tool_use_id === "tu-w0")!;
    const w0End = ends.find(e => e.tool_use_id === "tu-w0")!;
    const w1Start = starts.find(e => e.tool_use_id === "tu-w1")!;

    const w0StartIdx = events.indexOf(w0Start);
    const w0EndIdx = events.indexOf(w0End);
    const w1StartIdx = events.indexOf(w1Start);

    expect(w0StartIdx).toBeLessThan(w0EndIdx);
    expect(w0EndIdx).toBeLessThan(w1StartIdx);
  });
});

// ---------------------------------------------------------------------------
// Test: Abort between sequential writes
// ---------------------------------------------------------------------------

describe("scheduler — abort between sequential writes", () => {
  it("second write does not start after first completes and signal is aborted", async () => {
    const write0 = new MockWriteTool();
    const abortAware = new MockAbortAwareTool();

    Object.defineProperty(write0, "name", { value: "AbortWrite0", writable: false });

    const tools = new ToolRegistry();
    tools.register(write0);
    tools.register(abortAware);

    const { ai, si } = await makeInternals({ tools });

    const controller = new AbortController();

    const blocks = [
      makeToolUseBlock("tu-aw0", "AbortWrite0"),
      makeToolUseBlock("tu-aa", "MockAbortAware"),
    ];

    // write0 resolves immediately (constructor default), then we abort before MockAbortAware
    const genProm = collectGen(executeToolCalls(blocks, ai, si, controller.signal));

    await new Promise(r => setTimeout(r, 20));
    controller.abort();

    await expect(genProm).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: Multiple asks aggregated into single PermissionRequestEvent
// ---------------------------------------------------------------------------

describe("scheduler — multiple asks aggregated", () => {
  it("emits one PermissionRequestEvent with all ask requests", async () => {
    const write0 = new MockWriteTool();
    const write1 = new MockWriteTool();

    Object.defineProperty(write0, "name", { value: "MultiAsk0", writable: false });
    Object.defineProperty(write1, "name", { value: "MultiAsk1", writable: false });

    const tools = new ToolRegistry();
    tools.register(write0);
    tools.register(write1);

    const canUseTool: CanUseTool = async () => ({ behavior: "allow" });

    const { ai, si } = await makeInternals({ tools, permMode: "default", canUseTool });

    const blocks = [
      makeToolUseBlock("tu-ma0", "MultiAsk0"),
      makeToolUseBlock("tu-ma1", "MultiAsk1"),
    ];

    const { events } = await collectGen(executeToolCalls(blocks, ai, si, neverSignal()));

    const permReqs = events.filter(e => e.type === "permission_request") as PermissionRequestEvent[];
    expect(permReqs).toHaveLength(1);
    expect(permReqs[0]!.requests).toHaveLength(2);

    const ids = permReqs[0]!.requests.map(r => r.tool_use_id);
    expect(ids).toContain("tu-ma0");
    expect(ids).toContain("tu-ma1");

    // PermissionRequestEvent must precede all tool_call_start events
    const permIdx = events.findIndex(e => e.type === "permission_request");
    const firstStartIdx = events.findIndex(e => e.type === "tool_call_start");
    expect(permIdx).toBeLessThan(firstStartIdx);
  });
});

// ---------------------------------------------------------------------------
// Test: No PermissionRequestEvent when no asks
// ---------------------------------------------------------------------------

describe("scheduler — no asks in yolo mode", () => {
  it("does not emit PermissionRequestEvent when all tools allowed without asking", async () => {
    const write = new MockWriteTool();
    const tools = new ToolRegistry();
    tools.register(write);

    const { ai, si } = await makeInternals({ tools, permMode: "yolo" });
    const block = makeToolUseBlock("tu-yolo", "MockWrite");
    const { events } = await collectGen(executeToolCalls([block], ai, si, neverSignal()));

    const permReqs = events.filter(e => e.type === "permission_request");
    expect(permReqs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Empty blocks array
// ---------------------------------------------------------------------------

describe("scheduler — empty blocks", () => {
  it("returns empty results with no events when blocks is empty", async () => {
    const { ai, si } = await makeInternals();
    const { events, results } = await collectGen(executeToolCalls([], ai, si, neverSignal()));
    expect(events).toHaveLength(0);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test: Already-aborted signal with sequential writes
// ---------------------------------------------------------------------------

describe("scheduler — pre-aborted signal with sequential write", () => {
  it("throws AbortError immediately when signal is already aborted (sequential writes)", async () => {
    const write = new MockWriteTool();
    const write2 = new MockWriteTool();

    Object.defineProperty(write, "name", { value: "PAbort0", writable: false });
    Object.defineProperty(write2, "name", { value: "PAbort1", writable: false });

    const tools = new ToolRegistry();
    tools.register(write);
    tools.register(write2);

    const { ai, si } = await makeInternals({ tools });
    const signal = makeAbortedSignal();

    const blocks = [
      makeToolUseBlock("tu-pa0", "PAbort0"),
      makeToolUseBlock("tu-pa1", "PAbort1"),
    ];

    await expect(collectGen(executeToolCalls(blocks, ai, si, signal))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test: abort during parallel reads emits tool_call_end with is_error before propagating
// ---------------------------------------------------------------------------

describe("scheduler — abort during parallel reads emits tool_call_end before propagating", () => {
  it("both tool_call_end events (is_error:true) are yielded before AbortError escapes", async () => {
    const read0 = new MockAbortAwareReadTool();
    const read1 = new MockAbortAwareReadTool();

    Object.defineProperty(read0, "name", { value: "AbortRead0", writable: false });
    Object.defineProperty(read1, "name", { value: "AbortRead1", writable: false });

    const tools = new ToolRegistry();
    tools.register(read0);
    tools.register(read1);

    const { ai, si } = await makeInternals({ tools });
    const controller = new AbortController();

    const blocks = [
      makeToolUseBlock("tu-ar0", "AbortRead0"),
      makeToolUseBlock("tu-ar1", "AbortRead1"),
    ];

    const gen = executeToolCalls(blocks, ai, si, controller.signal);
    const events: Event[] = [];

    // Collect events and catch the expected AbortError
    const drainPromise = (async () => {
      while (true) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value);
      }
    })();

    // Let the reads start, then abort
    await new Promise(r => setTimeout(r, 20));
    controller.abort();

    await expect(drainPromise).rejects.toThrow();

    // Both tool_call_start and tool_call_end must be in the emitted events
    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];

    // Both reads should have started
    expect(starts).toHaveLength(2);
    // Both reads should have emitted tool_call_end with is_error: true
    expect(ends).toHaveLength(2);
    for (const end of ends) {
      expect(end.is_error).toBe(true);
    }

    // Each start precedes its matching end
    for (const start of starts) {
      const sIdx = events.indexOf(start);
      const end = ends.find(e => e.tool_use_id === start.tool_use_id);
      expect(end).toBeDefined();
      const eIdx = events.indexOf(end!);
      expect(sIdx).toBeLessThan(eIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: abort during sequential write emits tool_call_end with is_error before propagating
// ---------------------------------------------------------------------------

describe("scheduler — abort during sequential write emits tool_call_end before propagating", () => {
  it("tool_call_end { is_error: true } is yielded before AbortError escapes", async () => {
    const abortAware = new MockAbortAwareTool();
    const tools = new ToolRegistry();
    tools.register(abortAware);

    const { ai, si } = await makeInternals({ tools });
    const controller = new AbortController();

    const blocks = [makeToolUseBlock("tu-aw", "MockAbortAware")];

    const gen = executeToolCalls(blocks, ai, si, controller.signal);
    const events: Event[] = [];

    const drainPromise = (async () => {
      while (true) {
        const next = await gen.next();
        if (next.done) break;
        events.push(next.value);
      }
    })();

    // Let the write start executing, then abort
    await new Promise(r => setTimeout(r, 20));
    controller.abort();

    await expect(drainPromise).rejects.toThrow();

    const starts = events.filter(e => e.type === "tool_call_start") as ToolCallStartEvent[];
    const ends = events.filter(e => e.type === "tool_call_end") as ToolCallEndEvent[];

    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.is_error).toBe(true);
    expect(ends[0]!.tool_use_id).toBe("tu-aw");

    // start precedes end in event order
    const sIdx = events.indexOf(starts[0]!);
    const eIdx = events.indexOf(ends[0]!);
    expect(sIdx).toBeLessThan(eIdx);
  });
});
