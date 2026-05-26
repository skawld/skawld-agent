import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "../core/agent.js";
import { getSessionInternals, type Session } from "../core/session.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "../core/_test-mock-provider.js";
import { ToolRegistry } from "../tools/registry.js";
import { ReadTool } from "../tools/read.js";
import { GrepTool } from "../tools/grep.js";
import { BashTool } from "../tools/bash.js";
import type { Tool, ToolResult } from "../tools/base.js";
import type { ProviderRequest, SystemBlock } from "../providers/base.js";
import type { Event, SubagentEvent } from "../core/events.js";
import type { AgentDefinition } from "./types.js";
import { buildChildTools, runSubagent } from "./runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefinition(
  name: string,
  body: string,
  tools?: string[],
): AgentDefinition {
  return {
    name,
    filePath: `/tmp/${name}.md`,
    source: "disk",
    frontmatter: { name, description: `${name} agent.`, tools },
    body,
  };
}

const fakeSubagentTool: Tool<Record<string, unknown>> = {
  name: "Subagent",
  description: "fake subagent tool",
  input_schema: { type: "object", properties: {} },
  scope: "exec",
  validate: (raw) => raw,
  summarize: () => "fake subagent",
  execute: async (): Promise<ToolResult> => ({ content: "unused", summary: "unused" }),
};

/** One-turn script: emit a final assistant message with the given text, no tool use. */
function singleTextTurn(text: string) {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" },
      { type: "text_delta" as const, text },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
  };
}

interface TestRig {
  agent: Agent;
  parentSession: Session;
  parentInternal: ReturnType<typeof getSessionInternals>;
  provider: MockProvider;
  capturedRequests: ProviderRequest[];
  store: InMemorySessionStore;
}

async function makeRig(tools?: ToolRegistry): Promise<TestRig> {
  const store = new InMemorySessionStore();
  const provider = new MockProvider();
  const capturedRequests: ProviderRequest[] = [];

  // Wrap MockProvider.stream so each call's request is captured for assertions.
  const origStream = provider.stream.bind(provider);
  provider.stream = (req: ProviderRequest) => {
    capturedRequests.push(req);
    return origStream(req);
  };

  // The parent's first session() call also needs ONE enqueued turn (the parent
  // never runs in these tests, but Agent.session() doesn't consume scripts).
  const agent = new Agent({
    provider,
    model: "test-model",
    sessionStore: store,
    tools: tools ?? new ToolRegistry(),
    permissions: { mode: "yolo" },
  });
  const parentSession = await agent.session();
  const parentInternal = getSessionInternals(parentSession);
  parentInternal.activeRunId = "parent-run-id";

  return { agent, parentSession, parentInternal, provider, capturedRequests, store };
}

// ---------------------------------------------------------------------------
// buildChildTools unit tests
// ---------------------------------------------------------------------------

describe("buildChildTools", () => {
  it("wildcard (undefined) includes parent tools but excludes Subagent", () => {
    const parent = new ToolRegistry();
    parent.register(new ReadTool());
    parent.register(new GrepTool());
    parent.register(fakeSubagentTool);
    const child = buildChildTools(parent, undefined);
    expect(child).not.toBe(parent);
    expect(child.list().map((t) => t.name).sort()).toEqual(["Grep", "Read"]);
  });

  it('explicit ["*"] includes parent tools but excludes Subagent', () => {
    const parent = new ToolRegistry();
    parent.register(new ReadTool());
    parent.register(fakeSubagentTool);
    const child = buildChildTools(parent, ["*"]);
    expect(child).not.toBe(parent);
    expect(child.list().map((t) => t.name)).toEqual(["Read"]);
  });

  it("filtered registry contains only the named tools that resolve in the parent", () => {
    const parent = new ToolRegistry();
    parent.register(new ReadTool());
    parent.register(new GrepTool());
    parent.register(new BashTool());
    const child = buildChildTools(parent, ["Read", "Grep"]);
    expect(child).not.toBe(parent);
    const names = child.list().map((t) => t.name).sort();
    expect(names).toEqual(["Grep", "Read"]);
  });

  it("explicit Subagent allowlist entries are ignored", () => {
    const parent = new ToolRegistry();
    parent.register(new ReadTool());
    parent.register(fakeSubagentTool);
    const child = buildChildTools(parent, ["Read", "Subagent"]);
    expect(child.list().map((t) => t.name)).toEqual(["Read"]);
  });

  it("silently drops tool names that don't resolve in the parent (matches Claude)", () => {
    const parent = new ToolRegistry();
    parent.register(new ReadTool());
    const child = buildChildTools(parent, ["Read", "NonExistent", "AlsoFake"]);
    const names = child.list().map((t) => t.name);
    expect(names).toEqual(["Read"]);
  });
});

// ---------------------------------------------------------------------------
// runSubagent end-to-end tests
// ---------------------------------------------------------------------------

let rig: TestRig;
let emittedEvents: Event[];
let emit: (e: Event) => void;

beforeEach(async () => {
  emittedEvents = [];
  emit = (e: Event) => emittedEvents.push(e);
});

afterEach(async () => {
  await rig?.agent.close();
});

describe("runSubagent — smoke", () => {
  it("returns the child's final assistant text", async () => {
    rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("Hello from the child."));

    const result = await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("greeter", "You greet the user."),
      prompt: "Say hello.",
      displayName: "Agent #1",
      subagentRunId: "sr-1",
      signal: new AbortController().signal,
      emit,
    });

    expect(result.errored).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.finalText).toBe("Hello from the child.");
    expect(result.childSessionId).toBeTruthy();
  });

  it("wraps every child event as SubagentEvent with correct envelope fields", async () => {
    rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("ok"));

    await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("greeter", "Greet."),
      prompt: "hi",
      displayName: "Agent #1",
      subagentRunId: "sr-x",
      signal: new AbortController().signal,
      emit,
    });

    // Every emitted event must be a SubagentEvent envelope with consistent metadata.
    expect(emittedEvents.length).toBeGreaterThan(0);
    for (const e of emittedEvents) {
      expect(e.type).toBe("subagent_event");
      const se = e as SubagentEvent;
      expect(se.parent_session_id).toBe(rig.parentInternal.id);
      expect(se.subagent_run_id).toBe("sr-x");
      expect(se.subagent_type).toBe("greeter");
      expect(se.display_name).toBe("Agent #1");
    }
    // At least one wrapped event should be an assistant message.
    const assistantInner = emittedEvents.find(
      (e) => (e as SubagentEvent).event.type === "assistant",
    );
    expect(assistantInner).toBeDefined();
  });
});

describe("runSubagent — tool filter", () => {
  it("narrows the child's tool registry to the frontmatter allowlist", async () => {
    const parentTools = new ToolRegistry();
    parentTools.register(new ReadTool());
    parentTools.register(new GrepTool());
    parentTools.register(new BashTool());
    rig = await makeRig(parentTools);
    rig.provider.enqueue(singleTextTurn("ok"));

    await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("narrow", "Body.", ["Read", "Grep"]),
      prompt: "x",
      displayName: "narrow",
      subagentRunId: "sr-2",
      signal: new AbortController().signal,
      emit,
    });

    // The SystemEvent emitted by the child's runLoop carries the effective tool list.
    const systemEvents = emittedEvents
      .map((e) => (e as SubagentEvent).event)
      .filter((e) => e.type === "system");
    expect(systemEvents).toHaveLength(1);
    const sys = systemEvents[0]!;
    expect(sys.type === "system" ? sys.tools : []).toEqual(["Grep", "Read"]);
  });

  it("wildcard tools (undefined) → child sees parent registry except Subagent", async () => {
    const parentTools = new ToolRegistry();
    parentTools.register(new ReadTool());
    parentTools.register(new BashTool());
    rig = await makeRig(parentTools);
    rig.provider.enqueue(singleTextTurn("ok"));

    await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("wide", "Body."),
      prompt: "x",
      displayName: "wide",
      subagentRunId: "sr-3",
      signal: new AbortController().signal,
      emit,
    });

    const sys = emittedEvents
      .map((e) => (e as SubagentEvent).event)
      .find((e) => e.type === "system")!;
    expect(sys.type === "system" ? sys.tools : []).toEqual(["Bash", "Read"]);
  });
});

describe("runSubagent — thinking/effort inheritance", () => {
  it("forwards parent's currentThinking + currentEffort into the child's provider request", async () => {
    rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("ok"));

    // Simulate the parent being mid-run with cost knobs set: Session.run()
    // captures these onto SessionInternal at run start; the runner reads them.
    rig.parentInternal.currentThinking = { type: "enabled", budget_tokens: 4096 };
    rig.parentInternal.currentEffort = "high";

    await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("inherit", "Body."),
      prompt: "x",
      displayName: "inherit",
      subagentRunId: "sr-inh",
      signal: new AbortController().signal,
      emit,
    });

    expect(rig.capturedRequests).toHaveLength(1);
    const childReq = rig.capturedRequests[0]!;
    expect(childReq.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(childReq.effort).toBe("high");
  });

  it("when parent has no thinking/effort set, child's request omits them", async () => {
    rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("ok"));

    // Defaults — currentThinking/currentEffort both undefined on parentInternal.
    await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("plain", "Body."),
      prompt: "x",
      displayName: "plain",
      subagentRunId: "sr-plain",
      signal: new AbortController().signal,
      emit,
    });

    const childReq = rig.capturedRequests[0]!;
    expect(childReq.thinking).toBeUndefined();
    expect(childReq.effort).toBeUndefined();
  });
});

describe("runSubagent — system prompt override", () => {
  it("child's provider request uses the agent body as user-instructions block", async () => {
    rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("ok"));

    const body = "You are a strict code reviewer. Reject any new dependency.";
    await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("reviewer", body),
      prompt: "review this",
      displayName: "reviewer",
      subagentRunId: "sr-4",
      signal: new AbortController().signal,
      emit,
    });

    // The captured request should carry the override blocks.
    expect(rig.capturedRequests).toHaveLength(1);
    const sys = rig.capturedRequests[0]!.system as SystemBlock[];
    const userInstructionsBlock = sys.find(
      (b): b is { type: "text"; text: string; cacheable?: boolean } =>
        b.type === "text" && b.text.includes("User-provided instructions"),
    );
    expect(userInstructionsBlock).toBeDefined();
    expect(userInstructionsBlock!.text).toContain(body);
  });
});

describe("runSubagent — abort propagation", () => {
  it("pre-aborted signal → child aborts before completing any turn", async () => {
    rig = await makeRig();
    // Enqueue one turn so the test setup is well-formed; the controller is
    // pre-aborted, so the loop should yield a result(aborted) without ever
    // hitting the provider.
    rig.provider.enqueue(singleTextTurn("should-not-appear"));

    const controller = new AbortController();
    controller.abort(); // pre-abort

    const result = await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("preabort", "Body."),
      prompt: "x",
      displayName: "preabort",
      subagentRunId: "sr-pre",
      signal: controller.signal,
      emit,
    });

    expect(result.aborted).toBe(true);
    expect(result.finalText).toBe("");
  });

  it("parent abort fires → child Session.abort → result.aborted true", async () => {
    rig = await makeRig();
    // Enqueue a turn that pauses mid-stream so we have a chance to abort.
    const deferred = rig.provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "partial " },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
      holdAt: 1,
    });

    const controller = new AbortController();

    // Schedule an abort once the provider is paused.
    const runPromise = runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("slow", "Body."),
      prompt: "x",
      displayName: "slow",
      subagentRunId: "sr-5",
      signal: controller.signal,
      emit,
    });

    // Give the provider a moment to start streaming + hit the hold point.
    await new Promise<void>((r) => setTimeout(r, 10));
    controller.abort();
    deferred.resolve(); // release the hold so the provider can observe abort

    const result = await runPromise;
    expect(result.aborted).toBe(true);
  });
});

describe("runSubagent — finalText semantics", () => {
  it("joins text blocks within the LAST assistant message (multi-block case)", async () => {
    rig = await makeRig();
    // One turn whose assistant message will accumulate two text blocks via
    // separate text_deltas split by an intervening thinking_delta.
    rig.provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "alpha " },
        { type: "thinking_delta", text: "(internal)" },
        { type: "text_delta", text: "beta" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });

    const result = await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("multi", "Body."),
      prompt: "x",
      displayName: "multi",
      subagentRunId: "sr-multi",
      signal: new AbortController().signal,
      emit,
    });

    // The assistant message ends up with two TextBlocks (alpha, beta) split by
    // a ThinkingBlock. finalText joins both text blocks of the LAST message.
    expect(result.finalText).toBe("alpha beta");
  });
});

describe("runSubagent — empty assistant text", () => {
  it("finalText is empty when the child produces no text content", async () => {
    rig = await makeRig();
    // A turn that produces NO text — message_start + message_end only.
    rig.provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });

    const result = await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("silent", "Body."),
      prompt: "x",
      displayName: "silent",
      subagentRunId: "sr-6",
      signal: new AbortController().signal,
      emit,
    });

    expect(result.finalText).toBe("");
    expect(result.errored).toBe(false);
  });
});

describe("runSubagent — finalText last-wins across turns", () => {
  // Regression for a bug where the runner used `if (text.length > 0)` before
  // updating lastAssistantText, causing an early non-empty text to leak when
  // the LAST assistant message had no text. Spec: docs/12-subagents.html#tool
  // says "the child's last assistant message's text" — literal "last", not
  // "last-non-empty".

  it("multi-turn: empty final text overrides earlier non-empty text", async () => {
    rig = await makeRig();
    // Turn 1: assistant emits text + a tool_use for an unknown tool (so the
    // scheduler returns an immediate-error tool_result and the loop continues).
    rig.provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "Reading the file..." },
        { type: "tool_use_start", id: "tu_1", name: "NoSuchTool" },
        { type: "tool_use_input_delta", id: "tu_1", json_delta: "{}" },
        { type: "tool_use_end", id: "tu_1" },
        {
          type: "message_end",
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });
    // Turn 2: assistant emits NO text (only message_start + message_end).
    rig.provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });

    const result = await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("late-silent", "Body."),
      prompt: "x",
      displayName: "late-silent",
      subagentRunId: "sr-late-silent",
      signal: new AbortController().signal,
      emit,
    });

    // The LAST assistant message had empty text → finalText must be "".
    // Before the fix this returned "Reading the file..." (stale).
    expect(result.finalText).toBe("");
    expect(result.errored).toBe(false);
  });

  it("multi-turn: each assistant message's text replaces the prior one", async () => {
    rig = await makeRig();
    rig.provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "hi" },
        { type: "tool_use_start", id: "tu_a", name: "NoSuchTool" },
        { type: "tool_use_input_delta", id: "tu_a", json_delta: "{}" },
        { type: "tool_use_end", id: "tu_a" },
        {
          type: "message_end",
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });
    rig.provider.enqueue({
      events: [
        { type: "message_start", model: "test-model" },
        { type: "text_delta", text: "bye" },
        {
          type: "message_end",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      ],
    });

    const result = await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("two-text", "Body."),
      prompt: "x",
      displayName: "two-text",
      subagentRunId: "sr-two-text",
      signal: new AbortController().signal,
      emit,
    });

    expect(result.finalText).toBe("bye");
  });
});

describe("runSubagent — SQLite linkage", () => {
  it("persists the child session record with parent linkage in meta", async () => {
    rig = await makeRig();
    rig.provider.enqueue(singleTextTurn("ok"));

    const result = await runSubagent({
      parent: rig.parentInternal,
      definition: makeDefinition("researcher", "Body."),
      prompt: "x",
      displayName: "researcher",
      subagentRunId: "sr-7",
      signal: new AbortController().signal,
      emit,
    });

    const stored = await rig.store.load(result.childSessionId);
    expect(stored).toBeDefined();
    expect(stored!.meta).toEqual({
      parentSessionId: rig.parentInternal.id,
      subagentType: "researcher",
      subagentRunId: "sr-7",
      displayName: "researcher",
    });
  });
});
