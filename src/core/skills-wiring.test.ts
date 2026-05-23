/** Integration tests for skill wiring across Agent, Session, loop, scheduler, and compaction. */

import { describe, expect, it } from "bun:test";
import path from "node:path";
import { Agent, getAgentInternals } from "./agent.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { MockProvider } from "./_test-mock-provider.js";
import type { Event } from "./events.js";
import type { Message } from "./types.js";

const FIXTURE_DIR = path.resolve(import.meta.dir, "..", "..", "tests", "fixtures", "skills", "integration");

async function collect(iter: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function endTurnTextScript(text: string) {
  return {
    events: [
      { type: "message_start" as const, model: "test-model" },
      { type: "text_delta" as const, text },
      {
        type: "message_end" as const,
        stop_reason: "end_turn" as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

function skillCallScript(skillName: string, args?: string) {
  const input = args !== undefined ? { skill: skillName, args } : { skill: skillName };
  return {
    events: [
      { type: "message_start" as const, model: "test-model" },
      { type: "tool_use_start" as const, id: "tu_1", name: "Skill" },
      { type: "tool_use_input_delta" as const, id: "tu_1", json_delta: JSON.stringify(input) },
      { type: "tool_use_end" as const, id: "tu_1" },
      {
        type: "message_end" as const,
        stop_reason: "tool_use" as const,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      },
    ],
  };
}

describe("skills wiring — Agent + Session", () => {
  it("loads skills from configDir and registers the Skill tool", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      configDir: FIXTURE_DIR,
    });
    // Skills load lazily on first session() call.
    await agent.session();
    const ai = getAgentInternals(agent);
    expect(ai.skills.size).toBe(2);
    expect(ai.tools.get("Skill")).toBeDefined();
    expect(ai.skillListingText).toBeDefined();
    expect(ai.skillListingText).toContain("- commit:");
    expect(ai.skillListingText).toContain("- deploy:");
  });

  it("does not register the Skill tool when no skills exist", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider();
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      configDir: "/tmp/skawld-no-such-dir",
    });
    await agent.session();
    const ai = getAgentInternals(agent);
    expect(ai.skills.size).toBe(0);
    expect(ai.tools.get("Skill")).toBeUndefined();
    expect(ai.skillListingText).toBeUndefined();
  });

  it("emits SkillsLoadedEvent once per session, after SystemEvent", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider();
    provider.enqueue(endTurnTextScript("done"));
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      configDir: FIXTURE_DIR,
    });
    const session = await agent.session();
    const events = await collect(session.run("hi"));
    const types = events.map(e => e.type);
    expect(types[0]).toBe("system");
    expect(types[1]).toBe("skills_loaded");
    const loaded = events[1] as Extract<Event, { type: "skills_loaded" }>;
    expect(loaded.skills.map(s => s.name).sort()).toEqual(["commit", "deploy"]);
  });

  it("prepends skill_listing as a system-reminder block in the first user message", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider();
    provider.enqueue(endTurnTextScript("ok"));
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      configDir: FIXTURE_DIR,
    });
    const session = await agent.session();
    const events = await collect(session.run("first run"));
    const userEvt = events.find(e => e.type === "user") as Extract<Event, { type: "user" }>;
    const firstBlock = (userEvt.message.content[0] as { type: string; text: string });
    expect(firstBlock.type).toBe("text");
    expect(firstBlock.text).toContain("<system-reminder>");
    expect(firstBlock.text).toContain("<skill_listing>");
    expect(firstBlock.text).toContain("- commit:");
  });

  it("emits skill_invoked + skill_completed around a Skill tool call", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider();
    provider.enqueue(skillCallScript("commit", "fix bug"));
    provider.enqueue(endTurnTextScript("committed"));
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      configDir: FIXTURE_DIR,
      permissions: { mode: "yolo" },
    });
    const session = await agent.session();
    const events = await collect(session.run("commit my changes"));
    const invokedIdx = events.findIndex(e => e.type === "skill_invoked");
    const completedIdx = events.findIndex(e => e.type === "skill_completed");
    expect(invokedIdx).toBeGreaterThan(0);
    expect(completedIdx).toBeGreaterThan(invokedIdx);
    const invoked = events[invokedIdx] as Extract<Event, { type: "skill_invoked" }>;
    const completed = events[completedIdx] as Extract<Event, { type: "skill_completed" }>;
    expect(invoked.name).toBe("commit");
    expect(invoked.args).toBe("fix bug");
    expect(completed.is_error).toBe(false);
    // Tool result message should carry the substituted body verbatim.
    const userMsgs = events.filter(e => e.type === "user");
    const toolResultMsg = userMsgs[userMsgs.length - 1] as Extract<Event, { type: "user" }>;
    const trBlock = toolResultMsg.message.content[0] as { type: string; content: string };
    expect(trBlock.type).toBe("tool_result");
    expect(trBlock.content).toContain("Skill base directory:");
    // The skill body uses $message — shell-split tokens map positionally, so
    // `args: "fix bug"` populates $message="fix" (the second token is unused).
    expect(trBlock.content).toContain('Run `git commit -m "fix"`');
  });

  it("persists invokedSkills via the store and exposes them on resume", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider();
    provider.enqueue(skillCallScript("commit", "bump"));
    provider.enqueue(endTurnTextScript("ok"));
    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      configDir: FIXTURE_DIR,
      permissions: { mode: "yolo" },
    });
    const session = await agent.session();
    await collect(session.run("commit"));

    const reloaded = await store.load(session.id);
    expect(reloaded?.invokedSkills?.length).toBe(1);
    expect(reloaded?.invokedSkills?.[0]?.name).toBe("commit");
  });

  it("re-emits skill_listing + invoked skill bodies after compaction", async () => {
    const store = new InMemorySessionStore();
    const provider = new MockProvider();
    // turn 1: skill call. turn 2: tool result + end_turn text. then we trigger
    // forced compaction by issuing a ContextLengthError on a follow-up run...
    // Simpler: directly invoke the compaction logic via a tiny strategy and a
    // forced provider error.
    provider.enqueue(skillCallScript("commit", "ship"));
    provider.enqueue(endTurnTextScript("done"));

    const agent = new Agent({
      provider,
      model: "test-model",
      sessionStore: store,
      configDir: FIXTURE_DIR,
      permissions: { mode: "yolo" },
      compaction: {
        id: "test-compact",
        async compact({ messages }) {
          // Replace older messages with a single synthetic summary; keep last 2.
          if (messages.length <= 2) return messages;
          const kept = messages.slice(-2);
          return [
            { role: "user", content: [{ type: "text", text: "<summary>prior turn condensed</summary>" }] } satisfies Message,
            ...kept,
          ];
        },
      },
      maxOutputTokens: 16,
    });
    const session = await agent.session();
    await collect(session.run("first"));

    // Force the second run to compact: prime lastUsage past 80% threshold by
    // setting it manually on the SessionInternal — provider.contextWindow=200_000,
    // 0.8 * 200_000 = 160_000, so set lastUsage to 200_000 - maxOutputTokens.
    const { getSessionInternals } = await import("./session.js");
    const si = getSessionInternals(session);
    si.lastUsage = { input_tokens: 199_999, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };

    provider.enqueue(endTurnTextScript("post-compact"));
    const events = await collect(session.run("second"));

    expect(events.some(e => e.type === "compaction")).toBe(true);
    // After compaction we push directly to providerView; this is visible by
    // checking the SessionInternal messages now contain wrapped listing+bodies.
    const tailTexts = si.providerView
      .flatMap(m => m.content.filter(c => c.type === "text").map(c => (c as { text: string }).text));
    expect(tailTexts.some(t => t.includes("<skill_listing>"))).toBe(true);
    expect(tailTexts.some(t => t.includes("Skill base directory:"))).toBe(true);
  });
});
