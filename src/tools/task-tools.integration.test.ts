import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SqliteSessionStore } from "../sessions/sqlite.js";
import { TaskCreateTool } from "./task-create.js";
import { TaskListTool } from "./task-list.js";
import { TaskGetTool } from "./task-get.js";
import { TaskUpdateTool } from "./task-update.js";
import { makeToolCtx } from "./task-test-helpers.js";

describe("Task tools integration (SqliteSessionStore)", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteSessionStore;
  const SESSION = "integ-session";

  const create = new TaskCreateTool();
  const list = new TaskListTool();
  const get = new TaskGetTool();
  const update = new TaskUpdateTool();

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skawld-integ-"));
    dbPath = path.join(tmpDir, "test.db");
    store = new SqliteSessionStore({ databasePath: dbPath });
    await store.create({ id: SESSION });
  });

  afterEach(async () => {
    await store.close?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("create → list → get → update → delete end-to-end", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });

    // --- Create 3 tasks ---
    const r1 = await create.execute(
      create.validate({ subject: "Setup env", description: "Install deps" }),
      ctx,
    );
    expect(r1.is_error).toBeFalsy();
    expect(r1.content).toBe("Task #1 created: Setup env");

    const r2 = await create.execute(
      create.validate({ subject: "Write tests", description: "Unit tests" }),
      ctx,
    );
    expect(r2.content).toBe("Task #2 created: Write tests");

    const r3 = await create.execute(
      create.validate({ subject: "Deploy", description: "Ship it" }),
      ctx,
    );
    expect(r3.content).toBe("Task #3 created: Deploy");

    // --- List → 3 tasks ---
    const listResult = await list.execute({}, ctx);
    expect(listResult.is_error).toBeFalsy();
    const lines = (listResult.content as string).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("#1 [pending] Setup env");
    expect(lines[1]).toContain("#2 [pending] Write tests");
    expect(lines[2]).toContain("#3 [pending] Deploy");

    // --- Update: status change + add edge ---
    const u1 = await update.execute(
      update.validate({ task_id: "1", status: "in_progress", owner: "alice" }),
      ctx,
    );
    expect(u1.is_error).toBeFalsy();
    expect(u1.content).toContain("status pending → in_progress");
    expect(u1.content).toContain("owner");
    expect(u1.content).toContain("alice");

    // Task 3 blocked by task 2
    const u2 = await update.execute(
      update.validate({ task_id: "3", add_blocked_by: ["2"] }),
      ctx,
    );
    expect(u2.is_error).toBeFalsy();
    expect(u2.content).toContain("blocked_by");

    // --- Get: verify full render ---
    const g1 = await get.execute(get.validate({ task_id: "1" }), ctx);
    expect(g1.is_error).toBeFalsy();
    expect(g1.content).toContain("in_progress");
    expect(g1.content).toContain("alice");

    const g3 = await get.execute(get.validate({ task_id: "3" }), ctx);
    expect(g3.content).toContain("blocked_by");
    expect(g3.content).toContain("#2");

    // --- Delete task 1 ---
    const del = await update.execute(
      update.validate({ task_id: "1", status: "deleted" }),
      ctx,
    );
    expect(del.is_error).toBeFalsy();
    expect(del.content).toContain("Task #1 deleted");

    // List now shows 2 tasks
    const listAfterDel = await list.execute({}, ctx);
    const linesAfter = (listAfterDel.content as string).split("\n");
    expect(linesAfter).toHaveLength(2);
    expect(linesAfter[0]).toContain("#2");
    expect(linesAfter[1]).toContain("#3");
  });

  test("resume: close and reopen store, tasks still present with original ids", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });

    await create.execute(create.validate({ subject: "Persist A", description: "a" }), ctx);
    await create.execute(create.validate({ subject: "Persist B", description: "b" }), ctx);
    await update.execute(update.validate({ task_id: "1", status: "completed" }), ctx);

    // Close and reopen
    await store.close?.();
    store = new SqliteSessionStore({ databasePath: dbPath });
    const ctx2 = makeToolCtx({ sessionStore: store, sessionId: SESSION });

    const listResult = await list.execute({}, ctx2);
    expect(listResult.is_error).toBeFalsy();
    const lines = (listResult.content as string).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("#1 [completed] Persist A");
    expect(lines[1]).toContain("#2 [pending] Persist B");
  });

  test("cascade: deleting session removes all tasks", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });

    await create.execute(create.validate({ subject: "A", description: "a" }), ctx);
    await create.execute(create.validate({ subject: "B", description: "b" }), ctx);

    // Verify tasks exist
    let tasks = await store.listTasks(SESSION);
    expect(tasks).toHaveLength(2);

    // Delete the session
    await store.delete(SESSION);

    // Tasks should be gone (FK cascade)
    tasks = await store.listTasks(SESSION);
    expect(tasks).toHaveLength(0);
  });

  test("cycle rejection via store surfaces as is_error", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });

    await create.execute(create.validate({ subject: "X", description: "x" }), ctx);
    await create.execute(create.validate({ subject: "Y", description: "y" }), ctx);

    // X blocks Y
    await update.execute(update.validate({ task_id: "1", add_blocks: ["2"] }), ctx);

    // Y → X would create a cycle
    const result = await update.execute(
      update.validate({ task_id: "2", add_blocks: ["1"] }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/cycle/i);
  });

  test("get on non-existent task returns is_error", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const result = await get.execute(get.validate({ task_id: "404" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Task not found.");
  });

  test("list with blocker suffix reflects active vs completed blockers", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });

    await create.execute(create.validate({ subject: "Blocker", description: "b" }), ctx);
    await create.execute(create.validate({ subject: "Blocked", description: "c" }), ctx);
    await update.execute(update.validate({ task_id: "2", add_blocked_by: ["1"] }), ctx);

    // Blocker pending → suffix shown
    let listResult = await list.execute({}, ctx);
    expect(listResult.content).toContain("[blocked by #1]");

    // Complete the blocker → suffix gone
    await update.execute(update.validate({ task_id: "1", status: "completed" }), ctx);
    listResult = await list.execute({}, ctx);
    expect(listResult.content).not.toContain("blocked by");
  });
});
