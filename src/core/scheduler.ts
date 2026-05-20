/** Parallel tool execution scheduler. See docs/05-agent-loop.html#scheduler. */

import { AbortError } from "./errors.js";
import { throwIfAborted } from "./abort.js";
import type { Event } from "./events.js";
import type { ToolUseBlock, ToolResultBlock } from "./types.js";
import type { Tool, ToolResult } from "../tools/base.js";
import type { PermissionDecision } from "../permissions/engine.js";
import type { AgentInternal } from "./agent.js";
import type { SessionInternal } from "./session.js";

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface ResolvedCall {
  id: string;
  block: ToolUseBlock;
  tool: Tool<any> | null;
  input: Record<string, unknown>;
  summary: string;
  isImmediateError: boolean;
  immediateErrorReason?: string;
}

interface ExecResult {
  content: ToolResult["content"];
  is_error?: boolean;
  duration_ms: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// resolveCall
// ---------------------------------------------------------------------------

function resolveCall(block: ToolUseBlock, ai: AgentInternal): ResolvedCall {
  // 1. Invalid JSON from stream assembly
  if (block.input.__invalidJson === true) {
    const raw = typeof block.input.raw === "string" ? block.input.raw : String(block.input.raw ?? "");
    return {
      id: block.id,
      block,
      tool: null,
      input: block.input,
      summary: `${block.name}(invalid JSON)`,
      isImmediateError: true,
      immediateErrorReason: `Tool input was not valid JSON: ${raw}`,
    };
  }

  // 2. Unknown tool
  const tool = ai.tools.get(block.name) ?? null;
  if (tool === null) {
    return {
      id: block.id,
      block,
      tool: null,
      input: block.input,
      summary: `${block.name}(unknown)`,
      isImmediateError: true,
      immediateErrorReason: `Tool '${block.name}' is not registered`,
    };
  }

  // 3. Validate input
  let validated: Record<string, unknown>;
  try {
    validated = tool.validate(block.input) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: block.id,
      block,
      tool,
      input: block.input,
      summary: `${block.name}(invalid input)`,
      isImmediateError: true,
      immediateErrorReason: msg,
    };
  }

  // 4. Build summary from validated input
  let summary: string;
  try {
    summary = tool.summarize(validated);
  } catch {
    summary = `${block.name}(...)`;
  }

  return {
    id: block.id,
    block,
    tool,
    input: validated,
    summary,
    isImmediateError: false,
  };
}

// ---------------------------------------------------------------------------
// safeExecute
// ---------------------------------------------------------------------------

async function safeExecute(
  call: ResolvedCall,
  decision: PermissionDecision,
  ai: AgentInternal,
  si: SessionInternal,
  signal: AbortSignal,
): Promise<ExecResult> {
  const t0 = Date.now();

  if (call.isImmediateError) {
    return {
      content: call.immediateErrorReason!,
      is_error: true,
      duration_ms: Date.now() - t0,
      summary: call.summary,
    };
  }

  if (decision.decision === "deny") {
    return {
      content: `Tool call denied: ${decision.reason}`,
      is_error: true,
      duration_ms: Date.now() - t0,
      summary: call.summary,
    };
  }

  try {
    const ctx = {
      cwd: ai.cwd,
      signal,
      fileReadTracker: si.fileReadTracker,
      sessionId: si.id,
      runId: si.activeRunId ?? "unknown",
      sessionStore: ai.getStore(),
    };
    const input =
      decision.decision === "allow" && decision.updatedInput
        ? decision.updatedInput
        : call.input;
    const result = await call.tool!.execute(input, ctx);
    return {
      content: result.content,
      is_error: result.is_error,
      duration_ms: Date.now() - t0,
      summary: result.summary,
    };
  } catch (err) {
    if (err instanceof AbortError) throw err;
    return {
      content: `Tool failed: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
      duration_ms: Date.now() - t0,
      summary: call.summary,
    };
  }
}

// ---------------------------------------------------------------------------
// toToolResultBlock
// ---------------------------------------------------------------------------

function toToolResultBlock(call: ResolvedCall, result: ExecResult): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: result.content,
    is_error: result.is_error,
  };
}

// ---------------------------------------------------------------------------
// reorderByIndex
// ---------------------------------------------------------------------------

function reorderByIndex(pairs: Array<[number, ToolResultBlock]>, total: number): ToolResultBlock[] {
  const out: ToolResultBlock[] = new Array(total);
  for (const [i, block] of pairs) {
    out[i] = block;
  }
  return out;
}

// ---------------------------------------------------------------------------
// executeToolCalls — main export
//
// Ordering contract (per spec):
//   - PermissionRequestEvent (if any) precedes all start events for the turn.
//   - tool_call_start always precedes tool_call_end for the same tool_use_id.
//   - All read tool events precede all write/exec tool events.
//   - Within reads, per-call ordering is best-effort (FIFO of completion).
// ---------------------------------------------------------------------------

export async function* executeToolCalls(
  blocks: ToolUseBlock[],
  ai: AgentInternal,
  si: SessionInternal,
  signal: AbortSignal,
): AsyncGenerator<Event, ToolResultBlock[]> {
  // 1. Resolve every block
  const resolved: ResolvedCall[] = blocks.map(b => resolveCall(b, ai));

  // 2. Permission decisions — sequential, as resolve() may call canUseTool
  const askIndices: number[] = [];
  const decisions: PermissionDecision[] = [];

  for (let i = 0; i < resolved.length; i++) {
    const call = resolved[i]!;

    if (call.isImmediateError) {
      // Synthetic deny — permission resolution is skipped for immediate errors
      decisions.push({ decision: "deny", reason: call.immediateErrorReason! });
      continue;
    }

    // evaluate() is sync — used to detect "ask" before resolve() awaits canUseTool
    const initial = ai.permissionEngine.evaluate({
      tool_use_id: call.id,
      tool: call.tool!,
      input: call.input,
      cwd: ai.cwd,
    });

    if (initial.decision === "ask") {
      askIndices.push(i);
    }

    // resolve() returns the final decision (calls canUseTool for ask cases)
    let decision: PermissionDecision;
    try {
      decision = await ai.permissionEngine.resolve(
        { tool_use_id: call.id, tool: call.tool!, input: call.input, cwd: ai.cwd },
        signal,
      );
    } catch {
      // Permission resolution itself threw — treat as deny
      decision = {
        decision: "deny",
        reason: `Permission resolution failed for ${call.tool!.name}`,
      };
    }
    decisions.push(decision);
  }

  // 3. Emit a single PermissionRequestEvent for all ask-bound calls BEFORE any tool starts
  if (askIndices.length > 0) {
    yield {
      type: "permission_request",
      requests: askIndices.map(i => ({
        tool_use_id: resolved[i]!.id,
        tool_name: resolved[i]!.tool!.name,
        input: resolved[i]!.input,
        summary: resolved[i]!.summary,
      })),
    };
  }

  // 4. Bucket by scope: reads run in parallel, writes/execs run sequentially
  const reads: Array<[ResolvedCall, number, PermissionDecision]> = [];
  const writes: Array<[ResolvedCall, number, PermissionDecision]> = [];

  for (let i = 0; i < resolved.length; i++) {
    const call = resolved[i]!;
    const decision = decisions[i]!;
    // null-tool (unknown) or immediate-errors go to writes bucket so they serialize predictably
    if (!call.isImmediateError && call.tool?.scope === "read") {
      reads.push([call, i, decision]);
    } else {
      writes.push([call, i, decision]);
    }
  }

  // 5. Parallel reads — buffer events into FIFO queue, drain after Promise.allSettled.
  // Using allSettled (not all) so we always drain the event queue and emit tool_call_end
  // for every tool that had tool_call_start emitted, even when one read throws AbortError.
  const readEventQueue: Event[] = [];
  const settled = await Promise.allSettled(
    reads.map(async ([call, idx, decision]) => {
      const t0 = Date.now();
      readEventQueue.push({
        type: "tool_call_start",
        tool_use_id: call.id,
        tool_name: call.tool?.name ?? call.block.name,
        input: call.input,
      });
      try {
        const result = await safeExecute(call, decision, ai, si, signal);
        readEventQueue.push({
          type: "tool_call_end",
          tool_use_id: call.id,
          tool_name: call.tool?.name ?? call.block.name,
          is_error: result.is_error === true,
          duration_ms: result.duration_ms,
        });
        return [idx, toToolResultBlock(call, result)] as [number, ToolResultBlock];
      } catch (err) {
        // Always emit tool_call_end (with is_error: true) before propagating.
        readEventQueue.push({
          type: "tool_call_end",
          tool_use_id: call.id,
          tool_name: call.tool?.name ?? call.block.name,
          is_error: true,
          duration_ms: Date.now() - t0,
        });
        throw err;
      }
    }),
  );

  // Drain the event queue in FIFO order (arrival order) — always, even when some reads failed.
  for (const ev of readEventQueue) {
    yield ev;
  }

  // Re-throw the first AbortError encountered; collect results for non-errors.
  const readResultPairs: Array<[number, ToolResultBlock]> = [];
  let firstAbort: AbortError | undefined;
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      if (outcome.reason instanceof AbortError && firstAbort === undefined) {
        firstAbort = outcome.reason;
      }
    } else {
      readResultPairs.push(outcome.value);
    }
  }
  if (firstAbort !== undefined) throw firstAbort;

  // 6. Sequential writes/execs
  const writeResultPairs: Array<[number, ToolResultBlock]> = [];
  for (const [call, idx, decision] of writes) {
    throwIfAborted(signal);
    const t0Write = Date.now();
    yield {
      type: "tool_call_start",
      tool_use_id: call.id,
      tool_name: call.tool?.name ?? call.block.name,
      input: call.input,
    };
    let result: ExecResult;
    try {
      result = await safeExecute(call, decision, ai, si, signal);
    } catch (err) {
      // Always emit tool_call_end before propagating (covers AbortError mid-execute).
      yield {
        type: "tool_call_end",
        tool_use_id: call.id,
        tool_name: call.tool?.name ?? call.block.name,
        is_error: true,
        duration_ms: Date.now() - t0Write,
      };
      throw err;
    }
    yield {
      type: "tool_call_end",
      tool_use_id: call.id,
      tool_name: call.tool?.name ?? call.block.name,
      is_error: result.is_error === true,
      duration_ms: result.duration_ms,
    };
    writeResultPairs.push([idx, toToolResultBlock(call, result)]);
  }

  // 7. Reassemble results in original block order
  return reorderByIndex([...readResultPairs, ...writeResultPairs], blocks.length);
}
