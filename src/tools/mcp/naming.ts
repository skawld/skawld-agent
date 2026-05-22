/**
 * MCP tool name construction.
 *
 * Tools from MCP servers are namespaced `mcp__<server>__<tool>` so they never
 * collide with built-in tools (or with each other across servers) and so
 * permission rules target them unambiguously by exact name. Mirrors Claude
 * Code's convention (`mcpStringUtils.ts`, `normalization.ts`).
 */

/** Replace any character outside [a-zA-Z0-9_-] with an underscore. */
export function normalizeNameForMcp(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Build the fully-qualified `mcp__server__tool` name. */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeNameForMcp(serverName)}__${normalizeNameForMcp(toolName)}`;
}
