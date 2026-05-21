import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolvePath,
  findExecutable,
  formatNumberedLines,
  truncateOutput,
  atomicWriteFile,
  runRipgrep,
} from "./_helpers.js";

// ---------------------------------------------------------------------------
// resolvePath
// ---------------------------------------------------------------------------

describe("resolvePath", () => {
  test("returns absolute path unchanged", () => {
    expect(resolvePath("/abs/path/file.ts", "/cwd")).toBe("/abs/path/file.ts");
  });

  test("resolves relative path against cwd", () => {
    expect(resolvePath("src/foo.ts", "/project")).toBe("/project/src/foo.ts");
  });

  test("expands leading ~/", () => {
    const result = resolvePath("~/Documents/file.ts", "/cwd");
    expect(result).toBe(path.join(os.homedir(), "Documents/file.ts"));
  });

  test("normalizes .. segments", () => {
    expect(resolvePath("../sibling/file.ts", "/project/src")).toBe(
      "/project/sibling/file.ts"
    );
  });
});

// ---------------------------------------------------------------------------
// findExecutable
// ---------------------------------------------------------------------------

describe("findExecutable", () => {
  test("finds a known executable (sh or bash)", () => {
    // sh is universally present on POSIX systems
    const result = findExecutable("sh");
    expect(result).not.toBeNull();
    expect(result).toMatch(/sh/);
  });

  test("returns null for nonexistent executable", () => {
    expect(findExecutable("__definitely_not_a_real_binary_skawld__")).toBeNull();
  });

  test("caches result (same reference on second call)", () => {
    const first = findExecutable("sh");
    const second = findExecutable("sh");
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// formatNumberedLines
// ---------------------------------------------------------------------------

describe("formatNumberedLines", () => {
  test("formats single line with default startLine=1", () => {
    expect(formatNumberedLines("hello")).toBe("     1\thello");
  });

  test("formats multiple lines, right-aligned 6-wide", () => {
    const result = formatNumberedLines("a\nb\nc");
    expect(result).toBe("     1\ta\n     2\tb\n     3\tc");
  });

  test("uses custom startLine", () => {
    const result = formatNumberedLines("x\ny", 42);
    expect(result).toBe("    42\tx\n    43\ty");
  });

  test("preserves trailing newline", () => {
    const result = formatNumberedLines("a\nb\n");
    expect(result).toBe("     1\ta\n     2\tb\n");
  });

  test("returns empty string for empty input", () => {
    expect(formatNumberedLines("")).toBe("");
  });

  test("line numbers exceed 6 chars for large line numbers", () => {
    // Line number 1000000 is 7 digits — no truncation, just wider
    const result = formatNumberedLines("z", 1000000);
    expect(result).toBe("1000000\tz");
  });
});

// ---------------------------------------------------------------------------
// truncateOutput
// ---------------------------------------------------------------------------

describe("truncateOutput", () => {
  test("returns original string when within limit", () => {
    expect(truncateOutput("hello", 10)).toBe("hello");
  });

  test("returns original string when exactly at limit", () => {
    expect(truncateOutput("hello", 5)).toBe("hello");
  });

  test("truncates and appends marker when over limit", () => {
    const result = truncateOutput("hello world", 5);
    expect(result).toBe("hello\n… (6 chars truncated)");
  });

  test("marker includes correct omitted char count", () => {
    const text = "abcdefghij"; // 10 chars
    const result = truncateOutput(text, 3);
    expect(result).toContain("7 chars truncated");
    expect(result.startsWith("abc")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

describe("atomicWriteFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skawld-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates a new file with correct content", async () => {
    const target = path.join(tmpDir, "new-file.txt");
    await atomicWriteFile(target, "hello world");
    expect(fs.readFileSync(target, "utf8")).toBe("hello world");
  });

  test("overwrites existing file atomically", async () => {
    const target = path.join(tmpDir, "existing.txt");
    fs.writeFileSync(target, "old content");
    await atomicWriteFile(target, "new content");
    expect(fs.readFileSync(target, "utf8")).toBe("new content");
  });

  test("preserves existing file mode", async () => {
    const target = path.join(tmpDir, "mode-test.sh");
    fs.writeFileSync(target, "#!/bin/sh\n");
    fs.chmodSync(target, 0o755);
    const originalMode = fs.statSync(target).mode;

    await atomicWriteFile(target, "#!/bin/sh\necho hi\n");

    const newMode = fs.statSync(target).mode;
    expect(newMode).toBe(originalMode);
  });

  test("leaves no temp file behind on success", async () => {
    const target = path.join(tmpDir, "clean.txt");
    await atomicWriteFile(target, "data");
    const entries = fs.readdirSync(tmpDir);
    // Only the target file should exist; no .tmp-skawld-* files
    const tmpFiles = entries.filter(e => e.startsWith(".tmp-skawld-"));
    expect(tmpFiles).toHaveLength(0);
  });

  test("leaves no temp file behind on failure (unwritable dir)", async () => {
    // Make a subdirectory that we then make read-only so rename will fail
    const roDir = path.join(tmpDir, "readonly");
    fs.mkdirSync(roDir);
    const target = path.join(roDir, "file.txt");
    // Write once successfully so we have a target to overwrite
    await atomicWriteFile(target, "initial");
    // Make directory read-only to cause rename to fail
    fs.chmodSync(roDir, 0o555);

    try {
      await atomicWriteFile(target, "should fail");
    } catch {
      // expected
    } finally {
      // Restore so cleanup works
      fs.chmodSync(roDir, 0o755);
    }

    const entries = fs.readdirSync(roDir);
    const tmpFiles = entries.filter((e: string) => e.startsWith(".tmp-skawld-"));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runRipgrep
// ---------------------------------------------------------------------------

describe("runRipgrep", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skawld-rg-test-"));
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "hello world\nfoo bar\n");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "another line\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds matching content", async () => {
    const rg = findExecutable("rg");
    if (!rg) {
      // rg not available in this environment — skip
      return;
    }
    const result = await runRipgrep(["hello", tmpDir], tmpDir);
    expect(result.noMatches).toBe(false);
    expect(result.output).toContain("hello");
  });

  test("noMatches true when pattern not found", async () => {
    const rg = findExecutable("rg");
    if (!rg) return;
    const result = await runRipgrep(["__no_match_xyz__", tmpDir], tmpDir);
    expect(result.noMatches).toBe(true);
    expect(result.output).toBe("");
  });

  test("rejects when aborted before spawn", async () => {
    const rg = findExecutable("rg");
    if (!rg) return;
    const controller = new AbortController();
    controller.abort();
    await expect(
      runRipgrep(["hello", tmpDir], tmpDir, controller.signal)
    ).rejects.toThrow(/[Aa]bort/);
  });
});
