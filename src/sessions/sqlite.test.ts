// src/sessions/sqlite.test.ts
// Tests for SqliteSessionStore — session lifecycle, messages, list ordering, delete cascade, FK pragma.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { SqliteSessionStore } from "./sqlite.js";

function makeTmpStore(): { store: SqliteSessionStore; dir: string } {
  const dir = join(tmpdir(), `skawld-sqlite-test-${crypto.randomUUID()}`);
  const store = new SqliteSessionStore({ databasePath: join(dir, "sessions.db"), cwd: dir });
  return { store, dir };
}

describe("SqliteSessionStore — session lifecycle", () => {
  let ctx: ReturnType<typeof makeTmpStore>;
  let store: SqliteSessionStore;

  beforeEach(() => {
    ctx = makeTmpStore();
    store = ctx.store;
  });

  afterEach(async () => {
    await store.close?.();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  test("creates DB file with mkdir-p", () => {
    expect(existsSync(join(ctx.dir, "sessions.db"))).toBe(true);
  });

  test("create/load roundtrip", async () => {
    const s = await store.create({ meta: { project: "alpha" } });
    expect(s.id).toBeTruthy();
    const loaded = await store.load(s.id);
    expect(loaded?.id).toBe(s.id);
    expect(loaded?.meta).toEqual({ project: "alpha" });
  });

  test("create with provided id is idempotent", async () => {
    const s1 = await store.create({ id: "my-session" });
    const s2 = await store.create({ id: "my-session" });
    expect(s1.id).toBe("my-session");
    expect(s2.id).toBe("my-session");
    expect(s1.created_at).toBe(s2.created_at);
  });

  test("load returns undefined for missing session", async () => {
    expect(await store.load("nope")).toBeUndefined();
  });

  test("appendMessages assigns monotonic seq starting at 1", async () => {
    const s = await store.create({});
    const r1 = await store.appendMessages(s.id, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    const r2 = await store.appendMessages(s.id, [
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
    expect(r1[0].seq).toBe(1);
    expect(r2[0].seq).toBe(2);
    expect(r2[1].seq).toBe(3);
  });

  test("loadMessages returns messages in seq order", async () => {
    const s = await store.create({});
    await store.appendMessages(s.id, [
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ]);
    const msgs = await store.loadMessages(s.id);
    expect(msgs[0].seq).toBe(1);
    expect(msgs[1].seq).toBe(2);
    expect(msgs[0].message.role).toBe("user");
    expect(msgs[1].message.role).toBe("assistant");
  });

  test("cross-session seq isolation", async () => {
    const s1 = await store.create({});
    const s2 = await store.create({});
    await store.appendMessages(s1.id, [{ role: "user", content: [{ type: "text", text: "x" }] }]);
    await store.appendMessages(s1.id, [{ role: "user", content: [{ type: "text", text: "y" }] }]);
    const r = await store.appendMessages(s2.id, [{ role: "user", content: [{ type: "text", text: "z" }] }]);
    expect(r[0].seq).toBe(1); // s2 starts from 1, not 3
  });

  test("list ordered by updated_at DESC with limit/offset", async () => {
    const s1 = await store.create({});
    await new Promise(r => setTimeout(r, 5));
    const s2 = await store.create({});
    await new Promise(r => setTimeout(r, 5));
    const s3 = await store.create({});
    await new Promise(r => setTimeout(r, 5));
    // Touch s1 last
    await store.appendMessages(s1.id, [{ role: "user", content: [{ type: "text", text: "x" }] }]);
    const page1 = await store.list({ limit: 2, offset: 0 });
    expect(page1[0].id).toBe(s1.id); // most recently updated
    const page2 = await store.list({ limit: 2, offset: 2 });
    // s3 and s2 are older
    const allIds = [...page1, ...page2].map(s => s.id);
    expect(allIds).toContain(s2.id);
    expect(allIds).toContain(s3.id);
  });

  test("delete cascades: messages, tasks, edges, counters gone via FK cascade", async () => {
    const s = await store.create({});
    await store.appendMessages(s.id, [{ role: "user", content: [{ type: "text", text: "m" }] }]);
    await store.createTask(s.id, { subject: "T", description: "d" });
    await store.delete(s.id);
    // Session gone
    expect(await store.load(s.id)).toBeUndefined();
    // Messages gone (new store, same DB path — re-read)
    const msgs = await store.loadMessages(s.id);
    expect(msgs).toHaveLength(0);
    // Tasks gone
    const tasks = await store.listTasks(s.id);
    expect(tasks).toHaveLength(0);
  });

  test("updateMeta shallow merges", async () => {
    const s = await store.create({ meta: { x: 1 } });
    const updated = await store.updateMeta(s.id, { y: 2 });
    expect(updated.meta).toEqual({ x: 1, y: 2 });
  });

  test("concurrent appends preserve monotonicity (tight loop)", async () => {
    const s = await store.create({});
    const N = 20;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(store.appendMessages(s.id, [{ role: "user", content: [{ type: "text", text: `m${i}` }] }]));
    }
    await Promise.all(promises);
    const msgs = await store.loadMessages(s.id);
    expect(msgs).toHaveLength(N);
    const seqs = msgs.map(m => m.seq).sort((a, b) => a - b);
    for (let i = 0; i < N; i++) expect(seqs[i]).toBe(i + 1);
  });

  test("task ids monotonically increase and are not reused", async () => {
    const s = await store.create({});
    const t1 = await store.createTask(s.id, { subject: "A", description: "d" });
    const t2 = await store.createTask(s.id, { subject: "B", description: "d" });
    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    await store.deleteTask(s.id, "1");
    const t3 = await store.createTask(s.id, { subject: "C", description: "d" });
    expect(t3.id).toBe("3"); // not "1"
  });

  test("concurrent task creates assign unique monotonic ids (tight loop)", async () => {
    const s = await store.create({});
    const N = 20;
    const promises = Array.from({ length: N }, (_, i) =>
      store.createTask(s.id, { subject: `T${i}`, description: "d" })
    );
    const tasks = await Promise.all(promises);
    const ids = tasks.map(t => parseInt(t.id)).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});
