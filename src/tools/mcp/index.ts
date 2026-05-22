/** MCP client support: connect to external MCP servers and expose their tools. */

export { connectMcpServers } from "./client.js";
export type { McpConnection } from "./client.js";
export { makeMcpTool } from "./tool.js";
export type { McpCallTool } from "./tool.js";
export type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig } from "./config.js";
export { buildMcpToolName, normalizeNameForMcp } from "./naming.js";
