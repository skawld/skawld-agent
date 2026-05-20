import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { GlobTool } from "./glob";
import type { ToolContext } from "./base";
import { FileReadTracker } from "./file-tracker";

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let fixtureDir: string;

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    fileReadTracker: new FileReadTracker(),
    sessionId: "test-session",
    runId: "test-run",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionStore: null as any,
  };
}

beforeAll(async () => {
  fixtureDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "skawld-glob-"));

  // Create a small fixture tree:
  //  a/
  //    foo.ts
  //    bar.ts
  //  b/
  //    baz.js
  //  c/
  //    hidden-sub/
  //      deep.ts
  //  .hidden.ts     (dot-file — should be excluded from fallback)
  //  README.md
  const dirs = ["a", "b", "c", "c/hidden-sub"];
  for (const d of dirs) {
    await fs.promises.mkdir(path.join(fixtureDir, d), { recursive: true });
  }
  const files: Record<string, string> = {
    "a/foo.ts": "export const foo = 1;",
    "a/bar.ts": "export const bar = 2;",
    "b/baz.js": "const baz = 3;",
    "c/hidden-sub/deep.ts": "export const deep = 4;",
    ".hidden.ts": "// hidden",
    "README.md": "# readme",
  };
  // Stagger mtimes so sorting is deterministic
  let t = Date.now() - 10000;
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(fixtureDir, rel);
    await fs.promises.writeFile(abs, content, "utf8");
    await fs.promises.utimes(abs, new Date(t), new Date(t));
    t += 1000; // each file 1s newer than the previous
  }
});

afterAll(async () => {
  await fs.promises.rm(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tool = new GlobTool();

describe("GlobTool", () => {
  it("matches .ts files recursively", async () => {
    const input = tool.validate({ pattern: "**/*.ts" });
    const ctx = makeCtx(fixtureDir);
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBeUndefined();
    const lines = (result.content as string).split("\n").filter(Boolean);
    // .hidden.ts should NOT appear (dot: false)
    expect(lines.some((l) => l.includes(".hidden.ts"))).toBe(false);
    // should include the 3 .ts files
    const tsFiles = lines.filter((l) => l.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThanOrEqual(3);
  });

  it("returns 'No matches found.' for zero matches", async () => {
    const input = tool.validate({ pattern: "**/*.xyz" });
    const ctx = makeCtx(fixtureDir);
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("No matches found.");
  });

  it("respects explicit path parameter", async () => {
    const input = tool.validate({ pattern: "**/*.ts", path: path.join(fixtureDir, "a") });
    const ctx = makeCtx(fixtureDir);
    const result = await tool.execute(input, ctx);
    expect(result.is_error).toBeUndefined();
    const lines = (result.content as string).split("\n").filter(Boolean);
    // Only a/foo.ts and a/bar.ts — no deep.ts
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.endsWith(".ts"))).toBe(true);
    expect(lines.some((l) => l.includes("deep"))).toBe(false);
  });

  it("sorts by mtime descending (most recent first)", async () => {
    const input = tool.validate({ pattern: "**/*.ts" });
    const ctx = makeCtx(fixtureDir);
    const result = await tool.execute(input, ctx);
    const lines = (result.content as string).split("\n").filter((l) => l.endsWith(".ts"));
    // The last file written was deep.ts — it should appear first
    expect(lines[0]).toContain("deep");
  });

  it("matches .md files with a specific pattern", async () => {
    const input = tool.validate({ pattern: "**/*.md" });
    const ctx = makeCtx(fixtureDir);
    const result = await tool.execute(input, ctx);
    expect(result.content).toContain("README.md");
  });

  it("validate throws on missing pattern", () => {
    expect(() => tool.validate({})).toThrow();
  });

  it("validate throws on non-string pattern", () => {
    expect(() => tool.validate({ pattern: 42 })).toThrow();
  });

  it("validate throws on non-string path", () => {
    expect(() => tool.validate({ pattern: "**/*.ts", path: 99 })).toThrow();
  });

  it("summarize returns a readable string", () => {
    const input = tool.validate({ pattern: "**/*.ts", path: "/some/dir" });
    expect(tool.summarize(input)).toMatch(/Glob/);
    expect(tool.summarize(input)).toContain("**/*.ts");
  });

  it("does not follow symlinks (fallback path)", async () => {
    // Create a symlink pointing into 'a' from root
    const linkPath = path.join(fixtureDir, "symlink-a");
    try {
      await fs.promises.symlink(path.join(fixtureDir, "a"), linkPath);
    } catch {
      // symlink may not be supported in all CI environments — skip
      return;
    }
    // When we glob *.ts from root with fast-glob (followSymbolicLinks: false),
    // symlink-a/ entries should not appear
    const input = tool.validate({ pattern: "**/*.ts" });
    const ctx = makeCtx(fixtureDir);
    const result = await tool.execute(input, ctx);
    const lines = (result.content as string).split("\n").filter(Boolean);
    // symlink-a/foo.ts and symlink-a/bar.ts should not appear
    const hasSymlinkEntry = lines.some((l) => l.startsWith("symlink-a"));
    // cleanup regardless
    await fs.promises.unlink(linkPath).catch(() => {});
    expect(hasSymlinkEntry).toBe(false);
  });
});
