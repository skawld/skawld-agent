/** The single built-in default subagent. See docs/12-subagents.html (pending). */

import type { AgentDefinition } from "./types.js";

/**
 * Internal agentType for the built-in default. NOT listed in the public catalog
 * shown to the model; used when `Subagent({...})` is called with no
 * `subagent_type` argument.
 */
export const DEFAULT_AGENT_TYPE = "_default";

export const DEFAULT_AGENT: AgentDefinition = {
  name: DEFAULT_AGENT_TYPE,
  filePath: "<built-in>",
  source: "built-in",
  frontmatter: {
    name: DEFAULT_AGENT_TYPE,
    description: "General-purpose subagent with full tool access.",
    tools: undefined,
  },
  body: [
    "You are a focused subagent. The parent agent delegated a single task to you.",
    "Use the tools available to complete the task fully. When done, respond with a",
    "concise text summary of what you did and any key findings — the parent will",
    "relay this to the user, so the response only needs the essentials.",
  ].join("\n"),
};
