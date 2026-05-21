import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WriteTool } from "./write.js";
import { FileReadTracker } from "./file-tracker.js";
import { InMemorySessionStore } from "../sessions/memory.js";
import { ToolExecutionError } from "../core/errors.js";
import type { ToolContext } from "./base.js";

function makeCtx(cwd: string, tracker?: FileReadTracker): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    fileReadTracker: tracker ?? new FileReadTracker(),
    sessionId: "test-session",
    runId: "test-run",
    sessionStore: new InMemorySessionStore(),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skawld-write-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("WriteTool — validate", () => {
  const tool = new WriteTool();

  test("accepts valid input", () => {
    expect(tool.validate({ file_path: "foo.ts", content: "hello" })).toEqual({
      file_path: "foo.ts",
      content: "hello",
    });
  });

  test("throws for missing file_path", () => {
    expect(() => tool.validate({ content: "x" })).toThrow(ToolExecutionError);
  });

  test("throws for empty file_path", () => {
    expect(() => tool.validate({ file_path: "", content: "x" })).toThrow(ToolExecutionError);
  });

  test("throws for non-string content", () => {
    expect(() => tool.validate({ file_path: "a.ts", content: 42 })).toThrow(ToolExecutionError);
  });
});

describe("WriteTool — summarize", () => {
  const tool = new WriteTool();

  test("includes byte count and path", () => {
    const s = tool.summarize({ file_path: "src/foo.ts", content: "hello" });
    expect(s).toMatch(/\d+B to src\/foo\.ts/);
  });
});

describe("WriteTool — happy path", () => {
  const tool = new WriteTool();

  test("creates a new file", async () => {
    const file = path.join(tmpDir, "new.ts");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file, content: "const x = 1;\n" }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("const x = 1;\n");
  });

  test("success message includes byte count", async () => {
    const file = path.join(tmpDir, "bytes.ts");
    const ctx = makeCtx(tmpDir);
    const content = "hello world\n";
    const result = await tool.execute({ file_path: file, content }, ctx);
    const byteCount = Buffer.byteLength(content, "utf8");
    expect(result.content as string).toContain(`${byteCount} bytes`);
  });

  test("marks file as read in tracker after write", async () => {
    const file = path.join(tmpDir, "mark.ts");
    const ctx = makeCtx(tmpDir);
    expect(ctx.fileReadTracker.hasRead(file)).toBe(false);
    await tool.execute({ file_path: file, content: "x\n" }, ctx);
    expect(ctx.fileReadTracker.hasRead(file)).toBe(true);
  });

  test("overwrites existing file if already read", async () => {
    const file = path.join(tmpDir, "overwrite.ts");
    fs.writeFileSync(file, "old content\n");
    const tracker = new FileReadTracker();
    tracker.markRead(file);
    const ctx = makeCtx(tmpDir, tracker);
    const result = await tool.execute({ file_path: file, content: "new content\n" }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("new content\n");
  });

  test("creates parent directories as needed", async () => {
    const file = path.join(tmpDir, "a", "b", "c.ts");
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: file, content: "nested\n" }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
  });

  test("relative path resolved against cwd", async () => {
    const ctx = makeCtx(tmpDir);
    const result = await tool.execute({ file_path: "relative.ts", content: "data\n" }, ctx);
    expect(result.is_error).toBeUndefined();
    expect(fs.existsSync(path.join(tmpDir, "relative.ts"))).toBe(true);
  });
});

describe("WriteTool — errors", () => {
  const tool = new WriteTool();

  test("refuses to overwrite existing file not in tracker", async () => {
    const file = path.join(tmpDir, "existing.ts");
    fs.writeFileSync(file, "original\n");
    const ctx = makeCtx(tmpDir); // fresh tracker, file not marked
    const result = await tool.execute({ file_path: file, content: "new\n" }, ctx);
    expect(result.is_error).toBe(true);
    expect(result.content as string).toMatch(/Read.*first|not been Read/i);
    // File must be unchanged
    expect(fs.readFileSync(file, "utf8")).toBe("original\n");
  });
});
