/** Subagent types. See docs/12-subagents.html (pending). */

export interface AgentFrontmatter {
  /** Resolved agent name. Defaults to filename (minus `.md`) when omitted in YAML. */
  name: string;
  /** Required short description. Surfaced to the model in the Subagent tool's catalog. */
  description: string;
  /**
   * Optional tool allowlist. `undefined` or `["*"]` means "all tools available to the parent".
   * Normalized at load time: accepts an array of strings OR a comma-separated string.
   * `(...)` permission patterns are stripped (`"Bash(npm:*)"` → `"Bash"`); v1 has no per-arg permissions.
   */
  tools?: string[];
}

export interface AgentDefinition {
  /** == frontmatter.name. */
  name: string;
  /** Absolute path to the .md file. `"<built-in>"` for the default agent. */
  filePath: string;
  source: "disk" | "built-in";
  frontmatter: AgentFrontmatter;
  /** Raw markdown body (everything after the closing `---`). Used as the system prompt. */
  body: string;
}

export interface SkippedAgent {
  filePath: string;
  reason:
    | "invalid-frontmatter"
    | "missing-frontmatter"
    | "name-collision"
    | "io-error";
  detail: string;
}

export interface LoadAgentsResult {
  agents: AgentDefinition[];
  skipped: SkippedAgent[];
}
