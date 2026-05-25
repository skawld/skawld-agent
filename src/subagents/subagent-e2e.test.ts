/**
 * End-to-end subagent tests.
 *
 * Each test exercises one of the 10 success criteria from
 * `plans/260525-2150-subagent-module/brainstorm-summary.md` through the full
 * Agent → Session → runLoop → Subagent tool → runner → child Session stack.
 * Uses MockProvider for deterministic, fast iteration.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "../core/agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "../core/_test-mock-provider.js";
import { ReadTool } from "../tools/read.js";
import { GrepTool } from "../tools/grep.js";
import { BashTool } from "../tools/bash.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ProviderRequest, ProviderStreamEvent } from "../providers/base.js";
import type { Event, SubagentEvent } from "../core/events.js";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

let configDir: string;
let agentsDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "skawld-subagent-e2e-"));
  agentsDir = path.join(configDir, "agents");
  await mkdir(agentsDir, { recursive: true });
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

async function writeAgent(file: string, content: string): Promise<void> {
  await writeFile(path.join(agentsDir, file), content);
}

/** Turn that produces a single assistant text message (no tool use). */
function textTurn(text: string): { events: ProviderStreamEvent[] } {
  return {
    events: [
      { type: "message_start", model: "test-model" },
      { type: "text_delta", text },
      {
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
  };
}

/**
 * Turn that emits an assistant message calling exactly one tool with the given
 * input. Pairs with a follow-up `textTurn` for the final text after the tool
 * result returns.
 */
function toolCallTurn(opts: {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}): { events: ProviderStreamEvent[] } {
  const json = JSON.stringify(opts.input);
  return {
    events: [
      { type: "message_start", model: "test-model" },
      { type: "tool_use_start", id: opts.toolUseId, name: opts.toolName },
      { type: "tool_use_input_delta", id: opts.toolUseId, json_delta: json },
      { type: "tool_use_end", id: opts.toolUseId },
      {
        type: "message_end",
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
  };
}

interface E2ERig {
  agent: Agent;
  provider: MockProvider;
  capturedRequests: ProviderRequest[];
  store: InMemorySessionStore;
}

async function makeRig(opts?: { tools?: ToolRegistry }): Promise<E2ERig> {
  const store = new InMemorySessionStore();
  const provider = new MockProvider();
  const capturedRequests: ProviderRequest[] = [];
  const origStream = provider.stream.bind(provider);
  provider.stream = (req: ProviderRequest) => {
    capturedRequests.push(req);
    return origStream(req);
  };

  const agent = new Agent({
    provider,
    model: "test-model",
    sessionStore: store,
    configDir,
    tools: opts?.tools,
    permissions: { mode: "yolo" },
  });
  return { agent, provider, capturedRequests, store };
}

async function collectEvents(
  iter: AsyncIterable<Event>,
): Promise<Event[]> {
  const out: Event[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

describe("subagent e2e — acceptance criteria from brainstorm summary", () => {
  it("SC#1: default Subagent({description, prompt}) — full tools; Agent #1", async () => {
    const rig = await makeRig();
    // Parent: 1 turn that calls Subagent, then 1 turn that yields final text.
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-1",
        toolName: "Subagent",
        input: { description: "go", prompt: "do work" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    // Child: 1 turn that produces text.
    rig.provider.enqueue(textTurn("Child output here."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    // Child's events arrive wrapped — first SubagentEvent's display name == Agent #1.
    const subEvents = events.filter(
      (e): e is SubagentEvent => e.type === "subagent_event",
    );
    expect(subEvents.length).toBeGreaterThan(0);
    expect(subEvents[0]!.display_name).toBe("Agent #1");
    expect(subEvents[0]!.subagent_type).toBe("_default");

    // Parent saw a tool_call_end for the Subagent tool with the child's text.
    const userMsg = events.find(
      (e) =>
        e.type === "user" &&
        Array.isArray(e.message.content) &&
        e.message.content.some(
          (b) => b.type === "tool_result" && b.tool_use_id === "tu-1",
        ),
    );
    expect(userMsg).toBeDefined();
  });

  it("SC#2: named subagent — resolves <configDir>/agents/researcher.md, uses body as system prompt", async () => {
    await writeAgent(
      "researcher.md",
      "---\ndescription: Researches things.\n---\nYou are a thorough researcher.\n",
    );
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-r",
        toolName: "Subagent",
        input: { description: "research", prompt: "x", subagent_type: "researcher" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Research output."));

    const session = await rig.agent.session();
    await collectEvents(session.run("start"));

    // The child's provider request carries the agent body as its
    // user-instructions block. Find it by content (request order is parent#1,
    // child, parent#2 — index 1 — but assert by content for robustness).
    const childReq = rig.capturedRequests.find((req) =>
      (req.system as Array<{ type: string; text: string }>).some(
        (b) => b.type === "text" && b.text.includes("You are a thorough researcher."),
      ),
    );
    expect(childReq).toBeDefined();
    const userInstr = (childReq!.system as Array<{ type: string; text: string }>).find(
      (b) => b.type === "text" && b.text.includes("User-provided instructions"),
    );
    expect(userInstr).toBeDefined();
    expect(userInstr!.text).toContain("You are a thorough researcher.");
  });

  it("SC#3: tools allowlist narrows child registry to exactly the named tools (no auto-Subagent)", async () => {
    await writeAgent(
      "narrow.md",
      "---\ndescription: Narrow tools.\ntools: [Read, Grep]\n---\nBody.\n",
    );
    // Give the parent Read + Grep + Bash so the filter actually narrows.
    const parentTools = new ToolRegistry();
    parentTools.register(new ReadTool());
    parentTools.register(new GrepTool());
    parentTools.register(new BashTool());
    const rig = await makeRig({ tools: parentTools });
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-n",
        toolName: "Subagent",
        input: { description: "x", prompt: "y", subagent_type: "narrow" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    // The child's SystemEvent (wrapped) carries the effective tool list.
    const sys = events
      .filter((e): e is SubagentEvent => e.type === "subagent_event")
      .map((e) => e.event)
      .find((e) => e.type === "system");
    expect(sys).toBeDefined();
    // Filter omits "Subagent" → child cannot recurse. Has exactly Grep + Read.
    expect(sys!.type === "system" ? sys!.tools : []).toEqual(["Grep", "Read"]);
  });

  it("SC#4: frontmatter with Claude-style unknown keys loads cleanly", async () => {
    await writeAgent(
      "claude-style.md",
      [
        "---",
        "name: claude-style",
        "description: Ported from Claude unedited.",
        "model: claude-opus-4-7",
        "provider: anthropic",
        "permissionMode: acceptEdits",
        "color: blue",
        "effort: high",
        "maxTurns: 20",
        "mcpServers: [slack]",
        "hooks:",
        "  SessionStart:",
        "    - command: echo",
        "memory: project",
        "isolation: worktree",
        "background: false",
        "---",
        "Body.",
      ].join("\n"),
    );
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-c",
        toolName: "Subagent",
        input: { description: "x", prompt: "y", subagent_type: "claude-style" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));
    // Just assert no error events and that the subagent ran successfully.
    expect(events.some((e) => e.type === "error")).toBe(false);
    const subEvents = events.filter(
      (e): e is SubagentEvent => e.type === "subagent_event",
    );
    expect(subEvents.length).toBeGreaterThan(0);
    expect(subEvents[0]!.subagent_type).toBe("claude-style");
  });

  it('SC#5: tools: ["Bash(npm:*)"] → child gets bare Bash (perm pattern stripped)', async () => {
    await writeAgent(
      "perm.md",
      "---\ndescription: Perm test.\ntools: ['Bash(npm:*)']\n---\nBody.\n",
    );
    const parentTools = new ToolRegistry();
    parentTools.register(new BashTool());
    parentTools.register(new ReadTool());
    const rig = await makeRig({ tools: parentTools });
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-p",
        toolName: "Subagent",
        input: { description: "x", prompt: "y", subagent_type: "perm" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));
    const sys = events
      .filter((e): e is SubagentEvent => e.type === "subagent_event")
      .map((e) => e.event)
      .find((e) => e.type === "system");
    expect(sys!.type === "system" ? sys!.tools : []).toEqual(["Bash"]);
  });

  it("SC#6: parent iterator yields wrapped SubagentEvent for every child event", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-6",
        toolName: "Subagent",
        input: { description: "x", prompt: "y" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child output."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    const sub = events.filter(
      (e): e is SubagentEvent => e.type === "subagent_event",
    );
    // Child loop emits at minimum: system, user, assistant, usage, result.
    const innerTypes = new Set(sub.map((e) => e.event.type));
    expect(innerTypes.has("system")).toBe(true);
    expect(innerTypes.has("user")).toBe(true);
    expect(innerTypes.has("assistant")).toBe(true);
    expect(innerTypes.has("result")).toBe(true);
  });

  it("SC#7: unknown subagent_type → is_error tool_result, no crash", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-7",
        toolName: "Subagent",
        input: { description: "x", prompt: "y", subagent_type: "nope" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    // Find the tool_result for tu-7 in the next user message.
    const userMsgWithResult = events.find(
      (e) =>
        e.type === "user" &&
        Array.isArray(e.message.content) &&
        e.message.content.some(
          (b) => b.type === "tool_result" && b.tool_use_id === "tu-7",
        ),
    );
    expect(userMsgWithResult).toBeDefined();
    const result = (
      userMsgWithResult!.type === "user" ? userMsgWithResult.message.content : []
    ) as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: string | unknown }>;
    const tr = result.find((b) => b.type === "tool_result" && b.tool_use_id === "tu-7")!;
    expect(tr.is_error).toBe(true);
    expect(typeof tr.content === "string" && tr.content).toContain("Unknown subagent_type 'nope'");
  });

  it("SC#8: child session row persists with parent linkage in meta", async () => {
    const rig = await makeRig();
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-8",
        toolName: "Subagent",
        input: { description: "x", prompt: "y" },
      }),
    );
    rig.provider.enqueue(textTurn("Parent done."));
    rig.provider.enqueue(textTurn("Child done."));

    const session = await rig.agent.session();
    await collectEvents(session.run("start"));

    // Walk the store: find a row whose meta.parentSessionId matches the parent.
    const all = await rig.store.list();
    const child = all.find(
      (r) => r.meta?.parentSessionId === session.id,
    );
    expect(child).toBeDefined();
    expect(child!.meta).toEqual({
      parentSessionId: session.id,
      subagentType: "_default",
      subagentRunId: expect.stringMatching(/^sa_/),
      displayName: "Agent #1",
    });
  });

  it("SC#9: recursion — child spawns grandchild, parent sees nested SubagentEvent wrappers", async () => {
    const rig = await makeRig();
    // MockProvider has one cursor shared across all loops, so the enqueue
    // order MUST match the actual call sequence:
    //   1) parent turn 1   — Subagent(outer)
    //   2) child  turn 1   — Subagent(inner)      ← runs synchronously inside (1)
    //   3) grandchild turn — text                  ← runs synchronously inside (2)
    //   4) child  turn 2   — text                  ← runs after (3) returns
    //   5) parent turn 2   — text                  ← runs after (1) returns
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-9-1",
        toolName: "Subagent",
        input: { description: "outer", prompt: "do nested work" },
      }),
    );
    rig.provider.enqueue(
      toolCallTurn({
        toolUseId: "tu-9-2",
        toolName: "Subagent",
        input: { description: "inner", prompt: "leaf work" },
      }),
    );
    rig.provider.enqueue(textTurn("Grandchild output."));
    rig.provider.enqueue(textTurn("Child done."));
    rig.provider.enqueue(textTurn("Parent done."));

    const session = await rig.agent.session();
    const events = await collectEvents(session.run("start"));

    const wrapped = events.filter(
      (e): e is SubagentEvent => e.type === "subagent_event",
    );
    // At least one nested wrapper should exist: a SubagentEvent whose inner
    // event is itself a SubagentEvent (the grandchild's events arriving via
    // the child's emit).
    const nested = wrapped.find(
      (e) => e.event.type === "subagent_event",
    );
    expect(nested).toBeDefined();
    // Outer wrapper carries the CHILD's run id; inner carries the GRANDCHILD's.
    const inner = nested!.event as SubagentEvent;
    expect(nested!.subagent_run_id).not.toBe(inner.subagent_run_id);
  });

  it("SC#10: public surface — Subagent tool name + SubagentEvent + runner exports remain importable", async () => {
    // Import smoke: build/typecheck regressions in the public exports would
    // surface here as TS errors at test compile time. Runtime asserts pin the
    // exact wire names that consumers depend on.
    const subagentsMod = await import("./index.js");
    const eventsMod = await import("../core/events.js");
    const sdkMod = await import("../sdk.js");
    const toolMod = await import("../tools/subagent.js");

    expect(typeof subagentsMod.runSubagent).toBe("function");
    expect(typeof subagentsMod.buildChildTools).toBe("function");
    expect(subagentsMod.DEFAULT_AGENT_TYPE).toBe("_default");
    expect(typeof eventsMod.isSubagentEvent).toBe("function");
    expect(typeof toolMod.SubagentTool).toBe("function");
    expect(toolMod.SUBAGENT_TOOL_NAME).toBe("Subagent");
    // Confirms the public Event union got SubagentEvent (type-level smoke
    // via the runtime guard).
    expect(eventsMod.isSubagentEvent({ type: "system" } as never)).toBe(false);
    // sdk barrel is value-side only (re-exports are types); just ensure import resolves.
    expect(typeof sdkMod.Agent).toBe("function");
  });
});
