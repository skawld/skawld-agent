import { describe, expect, it } from "bun:test";
import type { Event } from "./events.js";
import { ToolEventQueue } from "./tool-event-queue.js";

function ev(text: string): Event {
  // Use a SubagentEvent shape so we exercise the type union end-to-end.
  return {
    type: "subagent_event",
    parent_session_id: "p",
    subagent_run_id: "r",
    subagent_type: "x",
    display_name: text,
    event: { type: "error", error: { name: "X", message: text, retryable: false } },
  };
}

describe("ToolEventQueue", () => {
  it("yields buffered events in push order, then ends after close()", async () => {
    const q = new ToolEventQueue();
    q.push(ev("a"));
    q.push(ev("b"));
    q.push(ev("c"));
    q.close();
    const out: string[] = [];
    for await (const e of q) {
      // Type guard inline so .display_name is safe.
      if (e.type === "subagent_event") out.push(e.display_name);
    }
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("a pending next() resolves on a subsequent push", async () => {
    const q = new ToolEventQueue();
    const iter = q[Symbol.asyncIterator]();
    const nextPromise = iter.next();
    // Schedule a push on a later microtask.
    queueMicrotask(() => q.push(ev("late")));
    const r = await nextPromise;
    expect(r.done).toBe(false);
    expect(r.value && r.value.type === "subagent_event" && r.value.display_name).toBe("late");
    q.close();
    const end = await iter.next();
    expect(end.done).toBe(true);
  });

  it("close() ends iteration even when no event was pushed", async () => {
    const q = new ToolEventQueue();
    q.close();
    let count = 0;
    for await (const _e of q) count++;
    expect(count).toBe(0);
  });

  it("push() after close() is silently dropped (no throw)", async () => {
    const q = new ToolEventQueue();
    q.close();
    // Should not throw.
    q.push(ev("after-close"));
    let count = 0;
    for await (const _e of q) count++;
    expect(count).toBe(0);
  });

  it("drains the buffer before signaling done after close()", async () => {
    const q = new ToolEventQueue();
    q.push(ev("a"));
    q.push(ev("b"));
    q.close();
    const out: string[] = [];
    for await (const e of q) {
      if (e.type === "subagent_event") out.push(e.display_name);
    }
    expect(out).toEqual(["a", "b"]);
  });

  it("close() is idempotent", async () => {
    const q = new ToolEventQueue();
    q.close();
    q.close();
    let count = 0;
    for await (const _e of q) count++;
    expect(count).toBe(0);
  });
});
