import { describe, expect, it, mock } from "bun:test";
import { Agent } from "./agent.js";
import { getAgentInternals } from "./agent.js";
import { ConfigError } from "./errors.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { SKAWLD_VERSION } from "./version.js";
import type { BaseProvider } from "../providers/base.js";

// Minimal provider stub that satisfies the BaseProvider interface.
function makeProvider(): BaseProvider {
  return {
    id: "test-provider",
    contextWindow: (_model: string) => 200_000,
    stream: async function* () { /* never called in these tests */ },
  };
}

describe("Agent constructor", () => {
  it("throws ConfigError when provider is missing", () => {
    expect(
      () => new Agent({ provider: undefined as any, model: "test-model" })
    ).toThrow(ConfigError);
  });

  it("throws ConfigError when model is missing", () => {
    expect(
      () => new Agent({ provider: makeProvider(), model: "" as any })
    ).toThrow(ConfigError);
  });

  it("applies default values", () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "my-model", sessionStore: store });
    const internal = getAgentInternals(agent);

    expect(internal.maxRetries).toBe(5);
    expect(internal.maxOutputTokens).toBe(8192);
    expect(internal.includePartialMessages).toBe(false);
    expect(internal.maxTurns).toBe(Infinity);
    expect(internal.cwd).toBe(process.cwd());
    // Phase 5: defaultCompaction is now wired as the default
    expect(internal.compaction).toBeDefined();
    expect(internal.compaction!.id).toBe("default-keep-recent-10");
  });

  it("builds systemBlocks at construction", () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "my-model", sessionStore: store });
    const internal = getAgentInternals(agent);

    expect(internal.systemBlocks.length).toBeGreaterThan(0);
    // Every block should have type "text".
    for (const block of internal.systemBlocks) {
      expect(block.type).toBe("text");
    }
  });

  it("system prompt env block contains the real package version (not 0.0.0-dev)", () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "my-model", sessionStore: store });
    const internal = getAgentInternals(agent);

    const envBlock = internal.systemBlocks.find(b =>
      b.text.includes("skawld version:")
    );
    expect(envBlock).toBeDefined();
    expect(envBlock!.text).toContain(`skawld version: ${SKAWLD_VERSION}`);
    expect(envBlock!.text).not.toContain("0.0.0-dev");
    // Confirm the constant itself is a real semver-shaped string, not the fallback.
    expect(SKAWLD_VERSION).not.toBe("0.0.0-dev");
    expect(SKAWLD_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("populates default tools", () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });
    const internal = getAgentInternals(agent);

    const names = internal.tools.list().map(t => t.name);
    expect(names).toContain("Read");
    expect(names).toContain("Write");
    expect(names).toContain("Bash");
  });
});

describe("Agent.session()", () => {
  it("returns a Session with empty providerView for a new id", async () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });

    const sess = await agent.session();
    expect(sess.messageCount).toBe(0);
  });

  it("resumes an existing session by id with the right messageCount", async () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });

    // Create a session and append some messages.
    const sess1 = await agent.session();
    await store.appendMessages(sess1.id, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);

    // Resume the same session.
    const sess2 = await agent.session({ id: sess1.id });
    expect(sess2.messageCount).toBe(2);
  });

  it("passes custom meta to the store", async () => {
    const store = new InMemorySessionStore();
    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });

    const sess = await agent.session({ meta: { project: "skawld" } });
    const record = await store.load(sess.id);
    expect(record?.meta.project).toBe("skawld");
  });
});

describe("Agent.close()", () => {
  it("calls sessionStore.close() when a store was provided", async () => {
    const store = new InMemorySessionStore();
    const closeFn = mock(async () => {});
    (store as any).close = closeFn;

    const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });
    await agent.close();

    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it("does not throw when no explicit sessionStore was provided and session() was never called", async () => {
    const agent = new Agent({ provider: makeProvider(), model: "m" });
    // Should complete without creating a SQLite file or throwing.
    await expect(agent.close()).resolves.toBeUndefined();
  });
});
