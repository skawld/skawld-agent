import { describe, test, expect, beforeEach } from "bun:test";
import { TaskListTool } from "./task-list";
import { InMemorySessionStore } from "../sessions/memory";
import { makeToolCtx } from "./task-test-helpers";

describe("TaskListTool", () => {
  let tool: TaskListTool;
  let store: InMemorySessionStore;
  const SESSION = "sess-list";

  beforeEach(async () => {
    tool = new TaskListTool();
    store = new InMemorySessionStore();
    await store.create({ id: SESSION });
  });

  test("empty session returns 'No tasks found.' as success", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const result = await tool.execute({}, ctx);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toBe("No tasks found.");
  });

  test("lists tasks in id order", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "Alpha", description: "a" });
    await store.createTask(SESSION, { subject: "Beta", description: "b" });
    await store.createTask(SESSION, { subject: "Gamma", description: "c" });
    const result = await tool.execute({}, ctx);
    expect(result.is_error).toBeFalsy();
    const lines = (result.content as string).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("#1");
    expect(lines[1]).toContain("#2");
    expect(lines[2]).toContain("#3");
  });

  test("line format: #id [status] subject", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "My Task", description: "desc" });
    const result = await tool.execute({}, ctx);
    expect(result.content).toBe("#1 [pending] My Task");
  });

  test("includes owner in parens when set", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "Owned", description: "d" });
    await store.updateTask(SESSION, "1", { owner: "alice" });
    const result = await tool.execute({}, ctx);
    expect(result.content).toContain("(alice)");
  });

  test("blocked_by suffix only for active (non-completed) blockers", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    // Task 1 blocks task 2; task 1 is pending → blocker suffix shown
    await store.createTask(SESSION, { subject: "Blocker", description: "b" });
    await store.createTask(SESSION, { subject: "Blocked", description: "c" });
    await store.updateTask(SESSION, "2", { add_blocked_by: ["1"] });
    const result = await tool.execute({}, ctx);
    const lines = (result.content as string).split("\n");
    expect(lines[1]).toContain("[blocked by #1]");
  });

  test("blocked_by suffix omitted when blocker is completed", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "Blocker", description: "b" });
    await store.createTask(SESSION, { subject: "Blocked", description: "c" });
    await store.updateTask(SESSION, "2", { add_blocked_by: ["1"] });
    // Complete the blocker
    await store.updateTask(SESSION, "1", { status: "completed" });
    const result = await tool.execute({}, ctx);
    const lines = (result.content as string).split("\n");
    expect(lines[1]).not.toContain("blocked by");
  });

  test("scope is 'read'", () => {
    expect(tool.scope).toBe("read");
  });

  test("parallelSafe is true", () => {
    expect(tool.parallelSafe).toBe(true);
  });

  test("summarize returns 'List tasks'", () => {
    expect(tool.summarize({})).toBe("List tasks");
  });

  test("validate accepts empty object", () => {
    expect(tool.validate({})).toEqual({});
  });
});
