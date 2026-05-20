import { describe, test, expect, beforeEach } from "bun:test";
import { TaskGetTool } from "./task-get";
import { InMemorySessionStore } from "../sessions/memory";
import { makeToolCtx } from "./task-test-helpers";

describe("TaskGetTool", () => {
  let tool: TaskGetTool;
  let store: InMemorySessionStore;
  const SESSION = "sess-get";

  beforeEach(async () => {
    tool = new TaskGetTool();
    store = new InMemorySessionStore();
    await store.create({ id: SESSION });
  });

  // --- validate ---

  test("validate throws on missing task_id", () => {
    expect(() => tool.validate({})).toThrow();
  });

  test("validate throws on empty task_id", () => {
    expect(() => tool.validate({ task_id: "  " })).toThrow();
  });

  test("validate trims task_id", () => {
    const result = tool.validate({ task_id: " 1 " });
    expect(result.task_id).toBe("1");
  });

  // --- execute: not found ---

  test("returns is_error true for missing task", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const result = await tool.execute({ task_id: "999" }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toBe("Task not found.");
  });

  // --- execute: found ---

  test("returns full task render for existing task", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "Build it", description: "Do the work" });
    const result = await tool.execute({ task_id: "1" }, ctx);
    expect(result.is_error).toBeFalsy();
    const content = result.content as string;
    expect(content).toContain("Task #1");
    expect(content).toContain("Build it");
    expect(content).toContain("Do the work");
    expect(content).toContain("pending");
    expect(content).toContain("created_at");
    expect(content).toContain("updated_at");
  });

  test("render includes active_form when set", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "S", description: "d", active_form: "Doing it" });
    const result = await tool.execute({ task_id: "1" }, ctx);
    expect(result.content).toContain("active_form");
    expect(result.content).toContain("Doing it");
  });

  test("render includes owner when set", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "S", description: "d" });
    await store.updateTask(SESSION, "1", { owner: "bob" });
    const result = await tool.execute({ task_id: "1" }, ctx);
    expect(result.content).toContain("owner");
    expect(result.content).toContain("bob");
  });

  test("render includes blocks and blocked_by when set", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "A", description: "a" });
    await store.createTask(SESSION, { subject: "B", description: "b" });
    await store.updateTask(SESSION, "1", { add_blocks: ["2"] });
    const resultA = await tool.execute({ task_id: "1" }, ctx);
    expect(resultA.content).toContain("blocks");
    expect(resultA.content).toContain("#2");
    const resultB = await tool.execute({ task_id: "2" }, ctx);
    expect(resultB.content).toContain("blocked_by");
    expect(resultB.content).toContain("#1");
  });

  test("render includes metadata when present", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "S", description: "d", metadata: { x: 1 } });
    const result = await tool.execute({ task_id: "1" }, ctx);
    expect(result.content).toContain("metadata");
    expect(result.content).toContain('"x"');
  });

  test("render omits metadata line when metadata is empty/absent", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    await store.createTask(SESSION, { subject: "S", description: "d" });
    const result = await tool.execute({ task_id: "1" }, ctx);
    expect(result.content).not.toContain("metadata");
  });

  // --- metadata ---

  test("scope is 'read'", () => {
    expect(tool.scope).toBe("read");
  });

  test("parallelSafe is true", () => {
    expect(tool.parallelSafe).toBe(true);
  });

  test("summarize returns 'Get task #<id>'", () => {
    expect(tool.summarize({ task_id: "42" })).toBe("Get task #42");
  });
});
