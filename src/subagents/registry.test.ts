import { describe, expect, it } from "bun:test";
import { DEFAULT_AGENT_TYPE } from "./default-agent.js";
import { buildAgentRegistry } from "./registry.js";
import type { AgentDefinition } from "./types.js";

function fixture(name: string, description = `${name} agent.`): AgentDefinition {
  return {
    name,
    filePath: `/tmp/${name}.md`,
    source: "disk",
    frontmatter: { name, description },
    body: `${name} body.`,
  };
}

describe("buildAgentRegistry", () => {
  it("looks up the built-in default by DEFAULT_AGENT_TYPE", () => {
    const reg = buildAgentRegistry([]);
    const def = reg.get(DEFAULT_AGENT_TYPE);
    expect(def).toBeDefined();
    expect(def!.source).toBe("built-in");
    expect(def!.name).toBe(DEFAULT_AGENT_TYPE);
  });

  it("excludes the built-in default from list() — model-facing catalog", () => {
    const reg = buildAgentRegistry([fixture("researcher"), fixture("reviewer")]);
    const list = reg.list();
    expect(list.map((a) => a.name)).toEqual(["researcher", "reviewer"]);
    // Built-in must NOT be in the public listing.
    expect(list.some((a) => a.name === DEFAULT_AGENT_TYPE)).toBe(false);
  });

  it("includes the built-in default in listAll() sorted by name", () => {
    const reg = buildAgentRegistry([fixture("zeta"), fixture("alpha")]);
    const all = reg.listAll();
    // localeCompare puts '_default' before alphabetic names (ASCII underscore < lowercase).
    expect(all.map((a) => a.name)).toEqual([DEFAULT_AGENT_TYPE, "alpha", "zeta"]);
  });

  it("returns undefined for an unknown agent type", () => {
    const reg = buildAgentRegistry([fixture("researcher")]);
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("look-up is case-insensitive on the agent name", () => {
    const reg = buildAgentRegistry([fixture("researcher")]);
    expect(reg.get("Researcher")).toBeDefined();
    expect(reg.get("RESEARCHER")).toBeDefined();
  });

  it("the built-in default cannot be overridden by a disk agent of the same name", () => {
    // Even if (somehow — would normally be blocked by the name regex) a disk
    // agent claimed '_default', the registry must keep the built-in.
    const sneaky: AgentDefinition = {
      name: DEFAULT_AGENT_TYPE,
      filePath: "/tmp/sneaky.md",
      source: "disk",
      frontmatter: { name: DEFAULT_AGENT_TYPE, description: "sneaky" },
      body: "sneaky",
    };
    const reg = buildAgentRegistry([sneaky]);
    const got = reg.get(DEFAULT_AGENT_TYPE);
    expect(got).toBeDefined();
    expect(got!.source).toBe("built-in");
  });
});
