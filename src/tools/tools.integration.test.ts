import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileReadTracker } from "./file-tracker";
import { InMemorySessionStore } from "../sessions/memory";
import { ReadTool } from "./read";
import { WriteTool } from "./write";
import { EditTool } from "./edit";
import { BashTool } from "./bash";
import { GlobTool } from "./glob";
import { defaultTools } from "./registry";
import type { ToolContext } from "./base";

function makeCtx(cwd: string, tracker: FileReadTracker): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    fileReadTracker: tracker,
    sessionId: "integ-session",
    runId: "integ-run",
    sessionStore: new InMemorySessionStore(),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skawld-integ-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// defaultTools registry
// ---------------------------------------------------------------------------

describe("defaultTools()", () => {
  test("registers exactly 10 tools", () => {
    const reg = defaultTools();
    expect(reg.list().length).toBe(10);
  });

  test("canonical order: Read Write Edit Bash Glob Grep TaskCreate TaskList TaskGet TaskUpdate", () => {
    const names = defaultTools().list().map(t => t.name);
    expect(names).toEqual([
      "Read", "Write", "Edit", "Bash", "Glob", "Grep",
      "TaskCreate", "TaskList", "TaskGet", "TaskUpdate",
    ]);
  });

  test("each tool is retrievable by name", () => {
    const reg = defaultTools();
    for (const tool of reg.list()) {
      expect(reg.get(tool.name)).toBe(tool);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 1: Read → Edit → Read
// ---------------------------------------------------------------------------

describe("Scenario 1: Read → Edit → Read", () => {
  test("edit succeeds after read; second read sees updated content", async () => {
    const fixture = path.join(tmpDir, "s1.txt");
    fs.writeFileSync(fixture, "hello world\n");

    const tracker = new FileReadTracker();
    const ctx = makeCtx(tmpDir, tracker);
    const read = new ReadTool();
    const edit = new EditTool();

    // Read
    const r1 = await read.execute(read.validate({ file_path: fixture }), ctx);
    expect(r1.is_error).toBeFalsy();
    expect(r1.content).toContain("hello world");

    // Edit
    const editResult = await edit.execute(
      edit.validate({ file_path: fixture, old_string: "hello world", new_string: "goodbye world" }),
      ctx,
    );
    expect(editResult.is_error).toBeFalsy();

    // Read again — new content must be visible
    const r2 = await read.execute(read.validate({ file_path: fixture }), ctx);
    expect(r2.is_error).toBeFalsy();
    expect(r2.content).toContain("goodbye world");
    expect(r2.content).not.toContain("hello world");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Edit without prior Read → is_error: true
// ---------------------------------------------------------------------------

describe("Scenario 2: Edit without Read", () => {
  test("returns is_error: true with Read-before-Edit message", async () => {
    const fixture = path.join(tmpDir, "s2.txt");
    fs.writeFileSync(fixture, "original content\n");

    const tracker = new FileReadTracker(); // fresh — no reads recorded
    const ctx = makeCtx(tmpDir, tracker);
    const edit = new EditTool();

    const result = await edit.execute(
      edit.validate({ file_path: fixture, old_string: "original content", new_string: "changed" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Read");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Write → Edit (tracker carried over from Write)
// ---------------------------------------------------------------------------

describe("Scenario 3: Write → Edit", () => {
  test("edit succeeds immediately after write without a separate read", async () => {
    const newFile = path.join(tmpDir, "s3.txt");
    const tracker = new FileReadTracker();
    const ctx = makeCtx(tmpDir, tracker);
    const write = new WriteTool();
    const edit = new EditTool();

    // Write creates the file and marks it as read in the tracker
    const writeResult = await write.execute(
      write.validate({ file_path: newFile, content: "line one\nline two\n" }),
      ctx,
    );
    expect(writeResult.is_error).toBeFalsy();

    // Edit should succeed because Write marks the file in the tracker
    const editResult = await edit.execute(
      edit.validate({ file_path: newFile, old_string: "line one", new_string: "line ONE" }),
      ctx,
    );
    expect(editResult.is_error).toBeFalsy();
    expect(fs.readFileSync(newFile, "utf8")).toContain("line ONE");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Glob → Read → Edit
// ---------------------------------------------------------------------------

describe("Scenario 4: Glob → Read → Edit", () => {
  test("glob finds files; reading the first match enables editing it", async () => {
    // Create three .txt files
    for (const name of ["alpha.txt", "beta.txt", "gamma.txt"]) {
      fs.writeFileSync(path.join(tmpDir, name), `content of ${name}\n`);
    }

    const tracker = new FileReadTracker();
    const ctx = makeCtx(tmpDir, tracker);
    const glob = new GlobTool();
    const read = new ReadTool();
    const edit = new EditTool();

    // Glob
    const globResult = await glob.execute(
      glob.validate({ pattern: "**/*.txt", cwd: tmpDir }),
      ctx,
    );
    expect(globResult.is_error).toBeFalsy();
    // At least one result
    const listed = (globResult.content as string).trim().split("\n").filter(Boolean);
    expect(listed.length).toBeGreaterThanOrEqual(1);

    // Read the first matched file
    const firstMatch = path.isAbsolute(listed[0]) ? listed[0] : path.join(tmpDir, listed[0]);
    const readResult = await read.execute(read.validate({ file_path: firstMatch }), ctx);
    expect(readResult.is_error).toBeFalsy();

    // Edit it
    const originalName = path.basename(firstMatch, ".txt");
    const editResult = await edit.execute(
      edit.validate({
        file_path: firstMatch,
        old_string: `content of ${originalName}.txt`,
        new_string: `UPDATED content of ${originalName}.txt`,
      }),
      ctx,
    );
    expect(editResult.is_error).toBeFalsy();
    expect(fs.readFileSync(firstMatch, "utf8")).toContain("UPDATED content");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Bash creates file → Read succeeds
// ---------------------------------------------------------------------------

describe("Scenario 5: Bash creates file → Read", () => {
  test("reading a file created by Bash succeeds (Read requires no pre-existing tracker entry)", async () => {
    const tracker = new FileReadTracker();
    const ctx = makeCtx(tmpDir, tracker);
    const bash = new BashTool();
    const read = new ReadTool();

    const target = path.join(tmpDir, "bash-created.txt");

    // Bash creates the file (opaque FS mutation)
    const bashResult = await bash.execute(
      bash.validate({ command: `printf 'hi\\n' > '${target}'` }),
      ctx,
    );
    expect(bashResult.is_error).toBeFalsy();

    // Read must succeed — Read does NOT require a prior tracker entry
    const readResult = await read.execute(read.validate({ file_path: target }), ctx);
    expect(readResult.is_error).toBeFalsy();
    expect(readResult.content).toContain("hi");
  });
});
