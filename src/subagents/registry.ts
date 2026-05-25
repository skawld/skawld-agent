/** Subagent registry: in-memory map of agent definitions, including the built-in default. */

import { DEFAULT_AGENT, DEFAULT_AGENT_TYPE } from "./default-agent.js";
import type { AgentDefinition } from "./types.js";

export interface AgentRegistry {
  /** Look up by agentType. Returns the built-in default when name === DEFAULT_AGENT_TYPE. */
  get(name: string): AgentDefinition | undefined;
  /** Public listing (the model sees this) — disk-loaded only, sorted, EXCLUDES the built-in default. */
  list(): AgentDefinition[];
  /** Full list including the built-in default — used internally by the runner. Sorted by name. */
  listAll(): AgentDefinition[];
}

export function buildAgentRegistry(
  diskAgents: AgentDefinition[],
): AgentRegistry {
  const map = new Map<string, AgentDefinition>();
  // Insert disk agents first (case-insensitive key)
  for (const agent of diskAgents) {
    map.set(agent.name.toLowerCase(), agent);
  }
  // Built-in default is reserved — disk agents cannot override it.
  map.set(DEFAULT_AGENT_TYPE.toLowerCase(), DEFAULT_AGENT);

  const sortedDisk = diskAgents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const sortedAll = [...sortedDisk, DEFAULT_AGENT].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return {
    get(name: string): AgentDefinition | undefined {
      return map.get(name.toLowerCase());
    },
    list(): AgentDefinition[] {
      return sortedDisk;
    },
    listAll(): AgentDefinition[] {
      return sortedAll;
    },
  };
}
