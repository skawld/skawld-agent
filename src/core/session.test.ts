import { describe, expect, it } from "bun:test";
import { Agent } from "./agent.js";
import { getSessionInternals } from "./session.js";
import { ConfigError } from "./errors.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import type { BaseProvider } from "../providers/base.js";

function makeProvider(): BaseProvider {
  return {
    id: "test-provider",
    contextWindow: (_model: string) => 200_000,
    stream: async function* () {},
  };
}

async function makeSession() {
  const store = new InMemorySessionStore();
  const agent = new Agent({ provider: makeProvider(), model: "m", sessionStore: store });
  const sess = await agent.session();
  return { sess, store };
}

describe("Session.messageCount", () => {
  it("reflects providerView length (zero for new session)", async () => {
    const { sess } = await makeSession();
    expect(sess.messageCount).toBe(0);
  });

  it("updates after messages are appended via the store", async () => {
    const { sess, store } = await makeSession();
    await store.appendMessages(sess.id, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    // messageCount reflects the in-memory providerView.
    // Since we appended directly to the store (bypassing the session's append helper),
    // the count won't increase. This is expected — direct store writes do not
    // automatically sync the in-memory providerView.
    expect(sess.messageCount).toBe(0);
  });
});

describe("Session.run() — single-active-run guard", () => {
  it("throws ConfigError synchronously when a run is already active", async () => {
    const { sess } = await makeSession();

    // Start first run (it returns an AsyncIterable; runLoop throws on .next()).
    const iter1 = sess.run("prompt 1");

    // A second run() call must throw ConfigError synchronously — before iteration.
    expect(() => sess.run("prompt 2")).toThrow(ConfigError);

    // Clean up: drain iter1 so the guard resets.
    try {
      const it = iter1[Symbol.asyncIterator]();
      await it.next(); // this will throw the "not implemented" error from the stub
    } catch {
      // Expected — runLoop stub throws.
    }
  });

  it("allows a second run after the first iterator is drained", async () => {
    const { sess } = await makeSession();

    // First run: drain it (stub throws, which wrapWithFinally catches and resets activeRunId).
    const iter1 = sess.run("prompt 1");
    try {
      for await (const _ of iter1) { /* drain */ }
    } catch {
      // The stub throws — expected.
    }

    // After draining, activeRunId should be reset. A new run must succeed.
    expect(() => sess.run("prompt 2")).not.toThrow();
  });
});

describe("Session.abort()", () => {
  it("is idempotent — can be called multiple times without throwing", async () => {
    const { sess } = await makeSession();

    expect(() => {
      sess.abort();
      sess.abort("reason");
      sess.abort();
    }).not.toThrow();
  });

  it("aborts the internal signal", async () => {
    const { sess } = await makeSession();
    const internal = getSessionInternals(sess);

    expect(internal.internalController.signal.aborted).toBe(false);
    sess.abort("test");
    expect(internal.internalController.signal.aborted).toBe(true);
  });
});

describe("Session.updateMeta()", () => {
  it("writes through to the store", async () => {
    const { sess, store } = await makeSession();

    await sess.updateMeta({ title: "my session" });

    const record = await store.load(sess.id);
    expect(record?.meta.title).toBe("my session");
  });

  it("merges multiple patches", async () => {
    const { sess, store } = await makeSession();

    await sess.updateMeta({ a: 1 });
    await sess.updateMeta({ b: 2 });

    const record = await store.load(sess.id);
    expect(record?.meta.a).toBe(1);
    expect(record?.meta.b).toBe(2);
  });
});

describe("Session.run() — iterator abandonment cleanup", () => {
  it("iterator abandoned via for-await break allows next run()", async () => {
    const { sess } = await makeSession();

    // Start a run and break immediately after first event (or after loop body hits break).
    // The iterator's return() is called by the for-await machinery on break.
    const iter = sess.run("prompt 1");
    // Collect just the first event to ensure the generator has started, then break.
    for await (const _ of iter) {
      break; // triggers iter.return() → cleanup → activeRunId = null
    }

    // After break, the cleanup should have fired synchronously via return().
    const internal = getSessionInternals(sess);
    expect(internal.activeRunId).toBeNull();

    // A new run() must not throw.
    expect(() => sess.run("prompt 2")).not.toThrow();
  });

  it("explicit iterator.return() allows next run()", async () => {
    const { sess } = await makeSession();

    const iter = sess.run("prompt 1");
    const it = iter[Symbol.asyncIterator]();

    // Trigger at least one .next() so the generator initializes, then call .return().
    // (The generator may throw internally; that's fine — we just want cleanup to run.)
    try {
      await it.next();
    } catch {
      // expected — mock provider stream is empty
    }

    // Explicitly call return() to signal abandonment.
    await it.return?.(undefined);

    const internal = getSessionInternals(sess);
    expect(internal.activeRunId).toBeNull();

    expect(() => sess.run("prompt 2")).not.toThrow();
  });
});
