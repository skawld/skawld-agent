import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { ToolContext } from "./base";
import type { SessionStore } from "../sessions/store";
import { FileReadTracker } from "./file-tracker";

export interface MakeToolCtxOpts {
  sessionStore: SessionStore;
  sessionId: string;
}

export function makeToolCtx(opts: MakeToolCtxOpts): ToolContext {
  return {
    cwd: os.tmpdir(),
    signal: new AbortController().signal,
    fileReadTracker: new FileReadTracker(),
    sessionId: opts.sessionId,
    runId: "test-run",
    sessionStore: opts.sessionStore,
  };
}

export function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skawld-task-test-"));
}
