/** Subagent module: internal barrel. NOT re-exported from src/sdk.ts in Phase 1. */

export type {
  AgentDefinition,
  AgentFrontmatter,
  LoadAgentsResult,
  SkippedAgent,
} from "./types.js";
export { loadAgentsFromDir, normalizeTools } from "./loader.js";
export type { LoadAgentsOptions } from "./loader.js";
export { buildAgentRegistry } from "./registry.js";
export type { AgentRegistry } from "./registry.js";
export { DEFAULT_AGENT, DEFAULT_AGENT_TYPE } from "./default-agent.js";
export { runSubagent, buildChildTools } from "./runner.js";
export type { RunSubagentArgs, RunSubagentResult } from "./runner.js";
