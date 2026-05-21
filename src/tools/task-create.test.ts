import { describe, test, expect, beforeEach } from "bun:test";
import { TaskCreateTool } from "./task-create.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { makeToolCtx } from "./task-test-helpers.js";

describe("TaskCreateTool", () => {
  let tool: TaskCreateTool;
  let store: InMemorySessionStore;
  const SESSION = "sess-create";

  beforeEach(async () => {
    tool = new TaskCreateTool();
    store = new InMemorySessionStore();
    await store.create({ id: SESSION });
  });

  // --- validate ---

  test("validate throws on missing subject", () => {
    expect(() => tool.validate({ description: "desc" })).toThrow();
  });

  test("validate throws on empty subject", () => {
    expect(() => tool.validate({ subject: "  ", description: "desc" })).toThrow();
  });

  test("validate throws on non-string description", () => {
    expect(() => tool.validate({ subject: "s", description: 42 })).toThrow();
  });

  test("validate accepts minimal valid input", () => {
    const result = tool.validate({ subject: "Do something", description: "Details here" });
    expect(result.subject).toBe("Do something");
    expect(result.description).toBe("Details here");
    expect(result.active_form).toBeUndefined();
    expect(result.metadata).toBeUndefined();
  });

  test("validate trims subject", () => {
    const result = tool.validate({ subject: "  padded  ", description: "" });
    expect(result.subject).toBe("padded");
  });

  test("validate passes through active_form and metadata", () => {
    const result = tool.validate({
      subject: "Task",
      description: "desc",
      active_form: "Doing task",
      metadata: { priority: 1 },
    });
    expect(result.active_form).toBe("Doing task");
    expect(result.metadata).toEqual({ priority: 1 });
  });

  // --- execute ---

  test("first task returns 'Task #1 created: ...'", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const input = tool.validate({ subject: "First task", description: "Do it" });
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBeFalsy();
    expect(result.content).toBe("Task #1 created: First task");
  });

  test("second task returns 'Task #2 created: ...'", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const i1 = tool.validate({ subject: "Task one", description: "a" });
    await tool.execute(i1, ctx);
    const i2 = tool.validate({ subject: "Task two", description: "b" });
    const result = await tool.execute(i2, ctx);
    expect(result.content).toBe("Task #2 created: Task two");
  });

  test("task is actually persisted", async () => {
    const ctx = makeToolCtx({ sessionStore: store, sessionId: SESSION });
    const input = tool.validate({ subject: "Persistent", description: "stored" });
    await tool.execute(input, ctx);
    const task = await store.getTask(SESSION, "1");
    expect(task).toBeDefined();
    expect(task!.subject).toBe("Persistent");
  });

  // --- metadata ---

  test("scope is 'write'", () => {
    expect(tool.scope).toBe("write");
  });

  test("parallelSafe is true", () => {
    expect(tool.parallelSafe).toBe(true);
  });

  test("summarize returns expected string", () => {
    const input = tool.validate({ subject: "My task", description: "desc" });
    expect(tool.summarize(input)).toBe("Create task: My task");
  });
});
