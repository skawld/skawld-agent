import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgentsFromDir, normalizeTools } from "./loader.js";

let configDir: string;
let agentsDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), "skawld-agents-"));
  agentsDir = path.join(configDir, "agents");
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

async function writeAgent(file: string, content: string): Promise<void> {
  await mkdir(agentsDir, { recursive: true });
  await writeFile(path.join(agentsDir, file), content);
}

describe("loadAgentsFromDir", () => {
  it("loads two valid agents, sorted by name", async () => {
    await writeAgent(
      "zeta.md",
      "---\ndescription: Zeta agent.\n---\nZeta body.\n",
    );
    await writeAgent(
      "alpha.md",
      "---\ndescription: Alpha agent.\n---\nAlpha body.\n",
    );

    const { agents, skipped } = await loadAgentsFromDir({ configDir });

    expect(skipped).toEqual([]);
    expect(agents.map((a) => a.name)).toEqual(["alpha", "zeta"]);
    expect(agents[0]!.frontmatter.description).toBe("Alpha agent.");
    expect(agents[0]!.body).toContain("Alpha body.");
    expect(agents[0]!.source).toBe("disk");
    expect(agents[0]!.frontmatter.tools).toBeUndefined();
    expect(path.isAbsolute(agents[0]!.filePath)).toBe(true);
  });

  it("returns empty when <configDir>/agents/ does not exist", async () => {
    // Don't create agentsDir at all.
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(agents).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("skips an agent missing the required description field", async () => {
    await writeAgent("broken.md", "---\nname: broken\n---\nBody.\n");
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(agents).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("invalid-frontmatter");
    expect(skipped[0]!.detail).toContain("description");
  });

  it("skips an agent with no frontmatter block at all", async () => {
    await writeAgent("nofm.md", "Just a body, no frontmatter.\n");
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(agents).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("missing-frontmatter");
  });

  it("ignores unknown frontmatter keys (Claude-compatible loading)", async () => {
    // Drop in a file that looks like it came from .claude/agents/ — lots of
    // fields Skawld doesn't consume. None of them should surface in the parsed
    // frontmatter, but the agent itself must still load cleanly.
    await writeAgent(
      "claude-style.md",
      [
        "---",
        "name: claude-style",
        "description: An agent ported from Claude Code unchanged.",
        "model: claude-opus-4-7",
        "provider: anthropic",
        "permissionMode: acceptEdits",
        "color: blue",
        "effort: high",
        "maxTurns: 20",
        "mcpServers:",
        "  - slack",
        "hooks:",
        "  SessionStart:",
        "    - command: echo hi",
        "memory: project",
        "isolation: worktree",
        "background: false",
        "---",
        "Body text.",
      ].join("\n"),
    );
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(skipped).toEqual([]);
    expect(agents).toHaveLength(1);
    const fm = agents[0]!.frontmatter;
    expect(fm.name).toBe("claude-style");
    expect(fm.description).toBe("An agent ported from Claude Code unchanged.");
    // None of the unknown keys leak through:
    expect(Object.keys(fm).sort()).toEqual(["description", "name"]);
  });

  it('normalizes a comma-string tools field: "Read, Grep, Bash"', async () => {
    await writeAgent(
      "narrow.md",
      "---\ndescription: Narrow.\ntools: 'Read, Grep, Bash'\n---\nBody.\n",
    );
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(skipped).toEqual([]);
    expect(agents[0]!.frontmatter.tools).toEqual(["Read", "Grep", "Bash"]);
  });

  it("strips permission patterns: Bash(npm:*) → Bash", async () => {
    await writeAgent(
      "perm.md",
      "---\ndescription: Perm.\ntools:\n  - Bash(npm:*)\n  - Read\n---\nBody.\n",
    );
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(skipped).toEqual([]);
    expect(agents[0]!.frontmatter.tools).toEqual(["Bash", "Read"]);
  });

  it("drops the tools field silently when it is the wrong type (lenient)", async () => {
    await writeAgent(
      "wrongtype.md",
      "---\ndescription: Wrongtype.\ntools: 42\n---\nBody.\n",
    );
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(skipped).toEqual([]);
    expect(agents[0]!.frontmatter.tools).toBeUndefined();
  });

  it("defaults name to the filename minus .md when name is omitted", async () => {
    await writeAgent(
      "filenamed.md",
      "---\ndescription: Filenamed.\n---\nBody.\n",
    );
    const { agents } = await loadAgentsFromDir({ configDir });
    expect(agents[0]!.name).toBe("filenamed");
    expect(agents[0]!.frontmatter.name).toBe("filenamed");
  });

  it("skips a second agent that uses an already-loaded name", async () => {
    await writeAgent(
      "first.md",
      "---\nname: twin\ndescription: First twin.\n---\nFirst.\n",
    );
    await writeAgent(
      "second.md",
      "---\nname: twin\ndescription: Second twin.\n---\nSecond.\n",
    );
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.frontmatter.description).toBe("First twin.");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("name-collision");
  });

  it("skips an agent with malformed YAML", async () => {
    await writeAgent("bad.md", "---\ndescription: ok\n  bad: : : indent\n---\nBody.\n");
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(agents).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("invalid-frontmatter");
  });

  it("skips symlink entries with an io-error reason (does not follow)", async () => {
    await writeAgent(
      "real.md",
      "---\ndescription: Real.\n---\nBody.\n",
    );
    // Create a symlink alongside; loader should NOT follow it.
    await symlink(path.join(agentsDir, "real.md"), path.join(agentsDir, "link.md"));
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("real");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBe("io-error");
    expect(skipped[0]!.detail).toContain("symlink");
  });

  it("ignores non-.md files in the agents directory", async () => {
    await writeAgent("notes.txt", "not an agent");
    await writeAgent(
      "real.md",
      "---\ndescription: Real.\n---\nBody.\n",
    );
    const { agents, skipped } = await loadAgentsFromDir({ configDir });
    expect(agents).toHaveLength(1);
    expect(skipped).toEqual([]);
  });
});

describe("normalizeTools", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeTools(undefined)).toBeUndefined();
  });

  it("passes through a string array", () => {
    expect(normalizeTools(["Read", "Grep"])).toEqual(["Read", "Grep"]);
  });

  it("splits a comma-separated string", () => {
    expect(normalizeTools("Read, Grep, Bash")).toEqual(["Read", "Grep", "Bash"]);
  });

  it("strips permission patterns", () => {
    expect(normalizeTools(["Bash(npm:*)", "Read"])).toEqual(["Bash", "Read"]);
  });

  it("returns undefined for non-string non-array input", () => {
    expect(normalizeTools(42)).toBeUndefined();
    expect(normalizeTools({})).toBeUndefined();
    expect(normalizeTools(null)).toBeUndefined();
  });

  it("filters out non-string array entries", () => {
    expect(normalizeTools(["Read", 42, "Grep"])).toEqual(["Read", "Grep"]);
  });
});
