/**
 * Tool interface scaffolding.
 *
 * Only the `ToolSchema` portion is defined here so the providers module can compile
 * standalone. The full `Tool` runtime interface ships in module 02.
 */

export type JSONSchema = Record<string, unknown>;

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, JSONSchema>;
    required?: string[];
  };
}

// --------------------------------------------------------------------------
// Runtime types — module 02
// --------------------------------------------------------------------------

import type { SessionStore } from "../sessions/store.js";
import type { FileReadTracker } from "./file-tracker.js";

/** Granular capability classification used by the permission engine and the parallel scheduler. */
export type ToolScope = "read" | "write" | "exec";

/** Read-only context passed to every tool execution. */
export interface ToolContext {
  /** Working directory for relative paths. */
  cwd: string;
  /** AbortSignal — tools must respect this and stop ASAP when fired. */
  signal: AbortSignal;
  /** Shared file-read tracker — required by Edit to enforce Read-before-Edit. */
  fileReadTracker: FileReadTracker;
  /** Session id, used by task tools and any session-scoped tool state. */
  sessionId: string;
  /** Run id, for logging/correlation. */
  runId: string;
  /** Persistent session store. Task tools use this for session-scoped task state. */
  sessionStore: SessionStore;
}

/** What a tool returns. */
export interface ToolResult {
  /** The content fed back to the model as a tool_result block. */
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  >;
  /** Short human-readable summary for permission prompts & UIs. */
  summary: string;
  /** Tool execution itself errored (the model will see is_error: true). */
  is_error?: boolean;
}

export interface Tool<Input = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly input_schema: ToolSchema["input_schema"];
  /** Permission scope. Used by the scheduler and the permission engine. */
  readonly scope: ToolScope;
  /** True if this tool is safe to run concurrently with other tools of the same scope. */
  readonly parallelSafe: boolean;
  /** Validate & coerce raw input into a typed Input. Throw a ToolExecutionError on bad shape. */
  validate(raw: Record<string, unknown>): Input;
  /** Run the tool. */
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Produce a one-line summary of what this call will do, used in PermissionRequestEvent.
   * Called BEFORE execute and BEFORE permission resolution.
   */
  summarize(input: Input): string;
}
