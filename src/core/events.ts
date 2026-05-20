/** Closed event union emitted by a Run. */

import type { Message, ModelId, PermissionMode, StopReason, Usage } from "./types.js";

export type Event =
  | SystemEvent
  | AssistantEvent
  | UserEvent
  | PartialAssistantEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | PermissionRequestEvent
  | UsageEvent
  | CompactionEvent
  | ResultEvent
  | ErrorEvent;

export interface SystemEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  run_id: string;
  model: ModelId;
  tools: string[];
  permission_mode: PermissionMode;
  cwd: string;
}

export interface AssistantEvent {
  type: "assistant";
  message: Message;
  stop_reason: StopReason;
}

export interface UserEvent {
  type: "user";
  message: Message;
}

export interface PartialAssistantEvent {
  type: "partial_assistant";
  delta:
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "tool_use_input"; tool_use_id: string; json_delta: string };
}

export interface ToolCallStartEvent {
  type: "tool_call_start";
  tool_use_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ToolCallEndEvent {
  type: "tool_call_end";
  tool_use_id: string;
  tool_name: string;
  is_error: boolean;
  duration_ms: number;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  requests: Array<{
    tool_use_id: string;
    tool_name: string;
    input: Record<string, unknown>;
    summary: string;
  }>;
}

export interface UsageEvent {
  type: "usage";
  usage: Usage;
  cumulative: Usage;
}

export interface CompactionEvent {
  type: "compaction";
  messages_before: number;
  messages_after: number;
  tokens_before: number;
  tokens_after: number;
  strategy: string;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "aborted" | "error";
  stop_reason: StopReason;
  total_usage: Usage;
  duration_ms: number;
  final_text?: string;
}

export interface ErrorEvent {
  type: "error";
  error: {
    name: string;
    message: string;
    retryable: boolean;
    cause?: unknown;
  };
}

export function isSystemEvent(e: Event): e is SystemEvent {
  return e.type === "system";
}
export function isAssistantEvent(e: Event): e is AssistantEvent {
  return e.type === "assistant";
}
export function isUserEvent(e: Event): e is UserEvent {
  return e.type === "user";
}
export function isPartialAssistantEvent(e: Event): e is PartialAssistantEvent {
  return e.type === "partial_assistant";
}
export function isToolCallStartEvent(e: Event): e is ToolCallStartEvent {
  return e.type === "tool_call_start";
}
export function isToolCallEndEvent(e: Event): e is ToolCallEndEvent {
  return e.type === "tool_call_end";
}
export function isPermissionRequestEvent(e: Event): e is PermissionRequestEvent {
  return e.type === "permission_request";
}
export function isUsageEvent(e: Event): e is UsageEvent {
  return e.type === "usage";
}
export function isCompactionEvent(e: Event): e is CompactionEvent {
  return e.type === "compaction";
}
export function isResultEvent(e: Event): e is ResultEvent {
  return e.type === "result";
}
export function isErrorEvent(e: Event): e is ErrorEvent {
  return e.type === "error";
}
