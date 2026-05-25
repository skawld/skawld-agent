/**
 * Wrap a single MCP server tool as a skawld `Tool`.
 *
 * The actual transport call is injected (`callTool`) so this module stays
 * connection-free and unit-testable. Scope and parallel-safety derive from the
 * MCP `readOnlyHint` annotation, matching Claude Code (`client.ts` isReadOnly /
 * isConcurrencySafe). Input validation is pass-through: the MCP server owns its
 * schema, so we only ensure the input is an object.
 */

import type { Tool as McpToolDefinition, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext, ToolResult, ToolSchema } from "../base.js";
import { ToolExecutionError, AbortError } from "../../core/errors.js";
import { buildMcpToolName } from "./naming.js";
import { mapMcpResult } from "./result.js";

/** Transport-bound call function injected by the connection layer. */
export type McpCallTool = (
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<CallToolResult>;

/** Coerce an MCP inputSchema into skawld's tool input_schema shape. */
function toInputSchema(mcpSchema: McpToolDefinition["inputSchema"]): ToolSchema["input_schema"] {
  const schema = mcpSchema as { properties?: Record<string, unknown>; required?: string[] };
  return {
    type: "object",
    properties: (schema.properties ?? {}) as ToolSchema["input_schema"]["properties"],
    ...(schema.required ? { required: schema.required } : {}),
  };
}

function compactArgs(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (json === undefined || json === "{}") return "";
  return json.length > 80 ? json.slice(0, 80) + "…" : json;
}

export function makeMcpTool(
  serverName: string,
  mcpTool: McpToolDefinition,
  callTool: McpCallTool,
): Tool {
  const name = buildMcpToolName(serverName, mcpTool.name);
  const readOnly = mcpTool.annotations?.readOnlyHint ?? false;

  return {
    name,
    description: mcpTool.description ?? "",
    input_schema: toInputSchema(mcpTool.inputSchema),
    scope: readOnly ? "read" : "write",
    // Concurrent calls on a read-only MCP tool are safe: @modelcontextprotocol/sdk's
    // Client uses JSON-RPC with per-request ids; each `callTool` resolves via its
    // own request awaiter so two in-flight calls on the same connection don't
    // interleave at the transport layer. Verified for the post-refactor parallel
    // scheduler lane (see plans/260526-0055-subagent-followup-fixes/phase-03).
    parallelSafe: readOnly,

    validate(raw: Record<string, unknown>): Record<string, unknown> {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new ToolExecutionError("MCP tool input must be an object", { tool_name: name });
      }
      // Pass-through: the MCP server validates against its own schema.
      return raw;
    },

    summarize(input: Record<string, unknown>): string {
      return `${name}(${compactArgs(input)})`;
    },

    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.signal.aborted) throw new AbortError(`${name} aborted`);
      try {
        const result = await callTool(mcpTool.name, input, ctx.signal);
        return mapMcpResult(result);
      } catch (err) {
        if (err instanceof AbortError) throw err;
        if (ctx.signal.aborted) throw new AbortError(`${name} aborted`);
        return {
          content: `MCP tool failed: ${err instanceof Error ? err.message : String(err)}`,
          summary: "mcp error",
          is_error: true,
        };
      }
    },
  };
}
