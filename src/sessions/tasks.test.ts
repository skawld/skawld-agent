// src/sessions/tasks.test.ts
// Parameterized task tests running against both SqliteSessionStore and InMemorySessionStore.
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { SqliteSessionStore } from "./sqlite";
import { InMemorySessionStore } from "./memory";
import type { SessionStore } from "./store";

function makeSqliteStore(): { store: SessionStore; cleanup: () => void } {
  const dir = join(tmpdir(), `skawld-test-tasks-${crypto.randomUUID()}`);
  const store = new SqliteSessionStore({ databasePath: join(dir, "sessions.db"), cwd: dir });
  return { store, cleanup: () => { store.close?.(); rmSync(dir, { recursive: true, force: true }); } };
}

function makeMemoryStore(): { store: SessionStore; cleanup: () => void } {
  return { store: new InMemorySessionStore(), cleanup: () => {} };
}

const factories: [string, () => { store: SessionStore; cleanup: () => void }][] = [
  ["SqliteSessionStore", makeSqliteStore],
  ["InMemorySessionStore", makeMemoryStore],
];

for (const [name, makeStore] of factories) {
  describe(`${name} — task tests`, () => {
    let ctx: ReturnType<typeof makeSqliteStore>;
    let store: SessionStore;
    let sessionId: string;

    beforeEach(async () => {
      ctx = makeStore();
      store = ctx.store;
      const s = await store.create({});
      sessionId = s.id;
    });

    afterAll(() => ctx.cleanup());

    test("task CRUD: create returns monotonic ids starting at 1", async () => {
      const t1 = await store.createTask(sessionId, { subject: "A", description: "desc A" });
      const t2 = await store.createTask(sessionId, { subject: "B", description: "desc B" });
      const t3 = await store.createTask(sessionId, { subject: "C", description: "desc C" });
      expect(t1.id).toBe("1");
      expect(t2.id).toBe("2");
      expect(t3.id).toBe("3");
    });

    test("task ids are not reused after deletion", async () => {
      const t1 = await store.createTask(sessionId, { subject: "A", description: "d" });
      await store.createTask(sessionId, { subject: "B", description: "d" });
      await store.deleteTask(sessionId, t1.id);
      const t3 = await store.createTask(sessionId, { subject: "C", description: "d" });
      expect(t3.id).toBe("3"); // not "1"
    });

    test("getTask returns undefined for missing task", async () => {
      const t = await store.getTask(sessionId, "999");
      expect(t).toBeUndefined();
    });

    test("listTasks returns tasks sorted by id ascending", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      await store.createTask(sessionId, { subject: "B", description: "d" });
      await store.createTask(sessionId, { subject: "C", description: "d" });
      const tasks = await store.listTasks(sessionId);
      expect(tasks.map(t => t.id)).toEqual(["1", "2", "3"]);
    });

    test("updateTask: scalar field updates", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      const updated = await store.updateTask(sessionId, "1", {
        subject: "Updated", status: "in_progress", owner: "alice",
      });
      expect(updated?.subject).toBe("Updated");
      expect(updated?.status).toBe("in_progress");
      expect(updated?.owner).toBe("alice");
    });

    test("updateTask: status=deleted removes the task and returns undefined", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      const result = await store.updateTask(sessionId, "1", { status: "deleted" });
      expect(result).toBeUndefined();
      const fetched = await store.getTask(sessionId, "1");
      expect(fetched).toBeUndefined();
    });

    test("edge consistency: add_blocks on task #1 shows up as blocked_by on task #3", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      await store.createTask(sessionId, { subject: "B", description: "d" });
      await store.createTask(sessionId, { subject: "C", description: "d" });
      await store.updateTask(sessionId, "1", { add_blocks: ["3"] });
      const t1 = await store.getTask(sessionId, "1");
      const t3 = await store.getTask(sessionId, "3");
      expect(t1?.blocks).toContain("3");
      expect(t3?.blocked_by).toContain("1");
    });

    test("edge consistency: add_blocked_by on task #2 shows up as blocks on task #1", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      await store.createTask(sessionId, { subject: "B", description: "d" });
      await store.updateTask(sessionId, "2", { add_blocked_by: ["1"] });
      const t1 = await store.getTask(sessionId, "1");
      const t2 = await store.getTask(sessionId, "2");
      expect(t1?.blocks).toContain("2");
      expect(t2?.blocked_by).toContain("1");
    });

    test("cycle rejection: #1 blocks #2, #2 blocks #3, #3 blocks #1 should throw", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      await store.createTask(sessionId, { subject: "B", description: "d" });
      await store.createTask(sessionId, { subject: "C", description: "d" });
      await store.updateTask(sessionId, "1", { add_blocks: ["2"] });
      await store.updateTask(sessionId, "2", { add_blocks: ["3"] });
      await expect(store.updateTask(sessionId, "3", { add_blocks: ["1"] })).rejects.toThrow();
    });

    test("cycle rejection: state unchanged after rejected cycle", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      await store.createTask(sessionId, { subject: "B", description: "d" });
      await store.updateTask(sessionId, "1", { add_blocks: ["2"] });
      await expect(store.updateTask(sessionId, "2", { add_blocks: ["1"] })).rejects.toThrow();
      // Task 2 should NOT have an edge to task 1
      const t2 = await store.getTask(sessionId, "2");
      expect(t2?.blocks).not.toContain("1");
    });

    test("metadata merge: null value deletes key", async () => {
      await store.createTask(sessionId, {
        subject: "A", description: "d",
        metadata: { a: 1, b: 2 },
      });
      const updated = await store.updateTask(sessionId, "1", {
        metadata: { a: 3, b: null },
      });
      expect(updated?.metadata).toEqual({ a: 3 });
      expect(updated?.metadata).not.toHaveProperty("b");
    });

    test("remove_blocks: removes existing edge", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      await store.createTask(sessionId, { subject: "B", description: "d" });
      await store.updateTask(sessionId, "1", { add_blocks: ["2"] });
      await store.updateTask(sessionId, "1", { remove_blocks: ["2"] });
      const t1 = await store.getTask(sessionId, "1");
      const t2 = await store.getTask(sessionId, "2");
      expect(t1?.blocks).not.toContain("2");
      expect(t2?.blocked_by).not.toContain("1");
    });

    test("deleteTask returns true on deletion, false on missing", async () => {
      await store.createTask(sessionId, { subject: "A", description: "d" });
      const r1 = await store.deleteTask(sessionId, "1");
      const r2 = await store.deleteTask(sessionId, "1");
      expect(r1).toBe(true);
      expect(r2).toBe(false);
    });

    test("cross-session task isolation", async () => {
      const s2 = await store.create({});
      await store.createTask(sessionId, { subject: "A", description: "d" });
      const tasks2 = await store.listTasks(s2.id);
      expect(tasks2).toHaveLength(0);
    });
  });
}
