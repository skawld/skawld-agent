// src/sessions/memory.test.ts
// Tests for InMemorySessionStore — session lifecycle, message appends, and list ordering.
import { describe, test, expect, beforeEach } from "bun:test";
import { InMemorySessionStore } from "./memory";

describe("InMemorySessionStore — session lifecycle", () => {
  let store: InMemorySessionStore;
  beforeEach(() => { store = new InMemorySessionStore(); });

  test("create/load roundtrip", async () => {
    const s = await store.create({ meta: { title: "test" } });
    expect(s.id).toBeTruthy();
    const loaded = await store.load(s.id);
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(s.id);
    expect(loaded!.meta).toEqual({ title: "test" });
  });

  test("create with provided id is idempotent", async () => {
    const s1 = await store.create({ id: "fixed-id" });
    const s2 = await store.create({ id: "fixed-id" });
    expect(s1.id).toBe("fixed-id");
    expect(s2.id).toBe("fixed-id");
    expect(s1.created_at).toBe(s2.created_at);
  });

  test("load returns undefined for missing session", async () => {
    const s = await store.load("nonexistent");
    expect(s).toBeUndefined();
  });

  test("appendMessages assigns strictly increasing seq starting at 1", async () => {
    const s = await store.create({});
    const msgs = await store.appendMessages(s.id, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[1].seq).toBe(2);
    const more = await store.appendMessages(s.id, [
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
    expect(more[0].seq).toBe(3);
  });

  test("loadMessages returns messages in seq order", async () => {
    const s = await store.create({});
    await store.appendMessages(s.id, [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ]);
    const msgs = await store.loadMessages(s.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[1].seq).toBe(2);
  });

  test("cross-session isolation: messages from different sessions are separate", async () => {
    const s1 = await store.create({});
    const s2 = await store.create({});
    await store.appendMessages(s1.id, [{ role: "user", content: [{ type: "text", text: "s1" }] }]);
    const s2msgs = await store.loadMessages(s2.id);
    expect(s2msgs).toHaveLength(0);
  });

  test("list ordered by updated_at DESC", async () => {
    const s1 = await store.create({});
    // Force small delay for reliable ordering
    await new Promise(r => setTimeout(r, 5));
    const s2 = await store.create({});
    await new Promise(r => setTimeout(r, 5));
    await store.appendMessages(s1.id, [{ role: "user", content: [{ type: "text", text: "x" }] }]);
    const all = await store.list();
    expect(all[0].id).toBe(s1.id); // s1 was updated most recently
    expect(all[1].id).toBe(s2.id);
  });

  test("list respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) await store.create({});
    const page1 = await store.list({ limit: 2, offset: 0 });
    const page2 = await store.list({ limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    const ids = new Set([...page1.map(s => s.id), ...page2.map(s => s.id)]);
    expect(ids.size).toBe(4);
  });

  test("delete cascades: messages removed", async () => {
    const s = await store.create({});
    await store.appendMessages(s.id, [{ role: "user", content: [{ type: "text", text: "x" }] }]);
    await store.delete(s.id);
    const loaded = await store.load(s.id);
    expect(loaded).toBeUndefined();
    const msgs = await store.loadMessages(s.id);
    expect(msgs).toHaveLength(0);
  });

  test("delete cascades: tasks and edges removed", async () => {
    const s = await store.create({});
    await store.createTask(s.id, { subject: "A", description: "d" });
    await store.createTask(s.id, { subject: "B", description: "d" });
    await store.updateTask(s.id, "1", { add_blocks: ["2"] });
    await store.delete(s.id);
    const tasks = await store.listTasks(s.id);
    expect(tasks).toHaveLength(0);
  });

  test("updateMeta shallow merges", async () => {
    const s = await store.create({ meta: { a: 1 } });
    const updated = await store.updateMeta(s.id, { b: 2 });
    expect(updated.meta).toEqual({ a: 1, b: 2 });
  });
});
