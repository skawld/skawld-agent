import { describe, test, expect, beforeEach } from "bun:test";
import path from "node:path";
import { FileReadTracker } from "./file-tracker.js";

describe("FileReadTracker", () => {
  let tracker: FileReadTracker;

  beforeEach(() => {
    tracker = new FileReadTracker();
  });

  test("markRead → hasRead round-trip with absolute path", () => {
    const absPath = "/tmp/some/file.ts";
    expect(tracker.hasRead(absPath)).toBe(false);
    tracker.markRead(absPath);
    expect(tracker.hasRead(absPath)).toBe(true);
  });

  test("hasRead returns false for unrelated path", () => {
    tracker.markRead("/tmp/a.ts");
    expect(tracker.hasRead("/tmp/b.ts")).toBe(false);
  });

  test("normalizes relative path on markRead via path.resolve", () => {
    // path.resolve with no cwd argument uses process.cwd()
    const rel = "some/relative/file.ts";
    const abs = path.resolve(rel);
    tracker.markRead(rel);
    expect(tracker.hasRead(abs)).toBe(true);
  });

  test("normalizes relative path on hasRead via path.resolve", () => {
    const rel = "another/file.ts";
    const abs = path.resolve(rel);
    tracker.markRead(abs);
    expect(tracker.hasRead(rel)).toBe(true);
  });

  test("clear removes all tracked paths", () => {
    tracker.markRead("/tmp/a.ts");
    tracker.markRead("/tmp/b.ts");
    tracker.clear();
    expect(tracker.hasRead("/tmp/a.ts")).toBe(false);
    expect(tracker.hasRead("/tmp/b.ts")).toBe(false);
  });

  test("multiple markRead calls for same path are idempotent", () => {
    const p = "/tmp/dup.ts";
    tracker.markRead(p);
    tracker.markRead(p);
    expect(tracker.hasRead(p)).toBe(true);
  });
});
