/**
 * Mock tools for unit-testing the scheduler.
 * NOT exported from src/core/index.ts — test-only.
 */

import { AbortError } from "./errors.js";
import type { Tool, ToolContext, ToolResult } from "../tools/base.js";

// ---------------------------------------------------------------------------
// Deferred utility (local — avoids depending on MockProvider)
// ---------------------------------------------------------------------------

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function makeDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// MockReadTool — scope="read", parallelSafe=true
// ---------------------------------------------------------------------------

export class MockReadTool implements Tool<Record<string, unknown>> {
  readonly name: string = "MockRead";
  readonly description = "Mock read tool for tests";
  readonly scope = "read" as const;
  readonly parallelSafe = true;
  readonly input_schema = {
    type: "object" as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  };

  /** Externally controllable deferred. Resolve it to unblock execute(). */
  deferred: Deferred = makeDeferred();
  /** Timestamps recorded by execute(). */
  callTimestamps: Array<{ start: number; end: number }> = [];
  /** Captured inputs from each execute() call. */
  capturedInputs: Record<string, unknown>[] = [];
  /** Fixed result content. */
  resultContent: string;

  constructor(resultContent = "read result") {
    this.resultContent = resultContent;
  }

  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }

  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    this.capturedInputs.push(input);
    const start = Date.now();
    await this.deferred.promise;
    const end = Date.now();
    this.callTimestamps.push({ start, end });
    return { content: this.resultContent, summary: `Read: ${this.resultContent}` };
  }

  summarize(_input: Record<string, unknown>): string {
    return `MockRead(...)`;
  }
}

// ---------------------------------------------------------------------------
// MockWriteTool — scope="write", parallelSafe=false
// ---------------------------------------------------------------------------

export class MockWriteTool implements Tool<Record<string, unknown>> {
  readonly name: string = "MockWrite";
  readonly description = "Mock write tool for tests";
  readonly scope = "write" as const;
  readonly parallelSafe = false;
  readonly input_schema = {
    type: "object" as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  };

  /** Controllable deferred — by default resolves immediately. */
  deferred: Deferred = makeDeferred();
  callTimestamps: Array<{ start: number; end: number }> = [];
  capturedInputs: Record<string, unknown>[] = [];
  resultContent: string;

  constructor(resultContent = "write result") {
    this.resultContent = resultContent;
    // Default: resolve immediately so tests don't hang unless they override.
    this.deferred.resolve();
  }

  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }

  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    this.capturedInputs.push(input);
    const start = Date.now();
    await this.deferred.promise;
    const end = Date.now();
    this.callTimestamps.push({ start, end });
    return { content: this.resultContent, summary: `Write: ${this.resultContent}` };
  }

  summarize(_input: Record<string, unknown>): string {
    return `MockWrite(...)`;
  }
}

// ---------------------------------------------------------------------------
// MockExecTool — scope="exec", parallelSafe=false
// ---------------------------------------------------------------------------

export class MockExecTool implements Tool<Record<string, unknown>> {
  readonly name: string = "MockExec";
  readonly description = "Mock exec tool for tests";
  readonly scope = "exec" as const;
  readonly parallelSafe = false;
  readonly input_schema = {
    type: "object" as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  };

  deferred: Deferred = makeDeferred();
  callTimestamps: Array<{ start: number; end: number }> = [];
  capturedInputs: Record<string, unknown>[] = [];
  resultContent: string;

  constructor(resultContent = "exec result") {
    this.resultContent = resultContent;
    this.deferred.resolve();
  }

  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }

  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    this.capturedInputs.push(input);
    const start = Date.now();
    await this.deferred.promise;
    const end = Date.now();
    this.callTimestamps.push({ start, end });
    return { content: this.resultContent, summary: `Exec: ${this.resultContent}` };
  }

  summarize(_input: Record<string, unknown>): string {
    return `MockExec(...)`;
  }
}

// ---------------------------------------------------------------------------
// MockAlwaysFailTool — execute() always throws
// ---------------------------------------------------------------------------

export class MockAlwaysFailTool implements Tool<Record<string, unknown>> {
  readonly name: string = "MockAlwaysFail";
  readonly description = "Mock tool that always fails";
  readonly scope = "write" as const;
  readonly parallelSafe = false;
  readonly input_schema = {
    type: "object" as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  };

  errorMessage: string;

  constructor(errorMessage = "intentional failure") {
    this.errorMessage = errorMessage;
  }

  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }

  async execute(_input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    throw new Error(this.errorMessage);
  }

  summarize(_input: Record<string, unknown>): string {
    return "MockAlwaysFail(...)";
  }
}

// ---------------------------------------------------------------------------
// MockAbortAwareReadTool — scope="read", waits on signal, throws AbortError on abort
// ---------------------------------------------------------------------------

export class MockAbortAwareReadTool implements Tool<Record<string, unknown>> {
  readonly name: string = "MockAbortAwareRead";
  readonly description = "Mock read tool that respects abort signal";
  readonly scope = "read" as const;
  readonly parallelSafe = true;
  readonly input_schema = {
    type: "object" as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  };

  called = false;

  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }

  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    this.called = true;
    await new Promise<void>((_resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(new AbortError("aborted"));
        return;
      }
      ctx.signal.addEventListener(
        "abort",
        () => reject(new AbortError("aborted")),
        { once: true },
      );
    });
    return { content: "done", summary: "MockAbortAwareRead(...)" };
  }

  summarize(_input: Record<string, unknown>): string {
    return "MockAbortAwareRead(...)";
  }
}

// ---------------------------------------------------------------------------
// MockAbortAwareTool — execute() waits on signal, throws AbortError on abort
// ---------------------------------------------------------------------------

export class MockAbortAwareTool implements Tool<Record<string, unknown>> {
  readonly name: string = "MockAbortAware";
  readonly description = "Mock tool that respects abort signal";
  readonly scope = "write" as const;
  readonly parallelSafe = false;
  readonly input_schema = {
    type: "object" as const,
    properties: {} as Record<string, never>,
    required: [] as string[],
  };

  /** Whether execute() was called. */
  called = false;

  validate(raw: Record<string, unknown>): Record<string, unknown> {
    return raw;
  }

  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    this.called = true;
    // Wait indefinitely until abort fires
    await new Promise<void>((_resolve, reject) => {
      if (ctx.signal.aborted) {
        reject(new AbortError("aborted"));
        return;
      }
      ctx.signal.addEventListener(
        "abort",
        () => reject(new AbortError("aborted")),
        { once: true },
      );
    });
    return { content: "done", summary: "MockAbortAware(...)" };
  }

  summarize(_input: Record<string, unknown>): string {
    return "MockAbortAware(...)";
  }
}
