import { describe, expect, it } from "bun:test";
import {
  BLOCK_A_IDENTITY,
  BLOCK_A_TOOL_PROTOCOL,
  buildEnvUserPrefix,
  buildSystemBlocks,
  type SystemPromptInputs,
} from "./system-prompt.js";

const BASE_INP: SystemPromptInputs = {
  cwd: "/home/user/project",
  os: { platform: "linux", release: "5.15.0", arch: "x64" },
  shell: "/bin/bash",
  nodeVersion: "v20.10.0",
  skawldVersion: "0.1.0",
  toolNames: ["Read", "Write", "Edit", "Bash"],
  permissionMode: "default",
};

describe("BLOCK_A_IDENTITY", () => {
  it("is a non-empty trimmed string", () => {
    expect(BLOCK_A_IDENTITY.length).toBeGreaterThan(0);
    expect(BLOCK_A_IDENTITY).toBe(BLOCK_A_IDENTITY.trim());
  });

  it("contains key identity phrase", () => {
    expect(BLOCK_A_IDENTITY).toContain("You are skawld");
  });
});

describe("BLOCK_A_TOOL_PROTOCOL", () => {
  it("is a non-empty trimmed string", () => {
    expect(BLOCK_A_TOOL_PROTOCOL.length).toBeGreaterThan(0);
    expect(BLOCK_A_TOOL_PROTOCOL).toBe(BLOCK_A_TOOL_PROTOCOL.trim());
  });

  it("contains key tool-protocol phrase", () => {
    expect(BLOCK_A_TOOL_PROTOCOL).toContain("Read a file before you Edit it");
  });
});

describe("buildSystemBlocks", () => {
  it("returns 3 blocks when userInstructions is omitted", () => {
    const blocks = buildSystemBlocks(BASE_INP);
    expect(blocks).toHaveLength(3);
  });

  it("returns 4 blocks when userInstructions is provided", () => {
    const blocks = buildSystemBlocks({ ...BASE_INP, userInstructions: "Always use TypeScript." });
    expect(blocks).toHaveLength(4);
  });

  it("all blocks have cacheable === true", () => {
    const blocks = buildSystemBlocks({ ...BASE_INP, userInstructions: "some instructions" });
    for (const block of blocks) {
      expect(block.cacheable).toBe(true);
    }
  });

  it("all blocks have type === 'text'", () => {
    const blocks = buildSystemBlocks({ ...BASE_INP, userInstructions: "some instructions" });
    for (const block of blocks) {
      expect(block.type).toBe("text");
    }
  });

  it("block ordering: identity → tool protocol → env → user instructions", () => {
    const instructions = "Always use TypeScript.";
    const blocks = buildSystemBlocks({ ...BASE_INP, userInstructions: instructions });
    expect(blocks[0].text).toBe(BLOCK_A_IDENTITY);
    expect(blocks[1].text).toBe(BLOCK_A_TOOL_PROTOCOL);
    expect(blocks[2].text).toContain("Environment:");
    expect(blocks[3].text).toContain("User-provided instructions:");
    expect(blocks[3].text).toContain(instructions);
  });

  it("env block contains all required fields in stable order", () => {
    const blocks = buildSystemBlocks(BASE_INP);
    const env = blocks[2].text;
    // Check fields appear in the correct order
    const versionIdx = env.indexOf("skawld version: 0.1.0");
    const nodeIdx = env.indexOf("Node: v20.10.0");
    const osIdx = env.indexOf("OS: linux 5.15.0 (x64)");
    const shellIdx = env.indexOf("Shell: /bin/bash");
    const cwdIdx = env.indexOf("Working directory: /home/user/project");
    const modeIdx = env.indexOf("Permission mode: default");
    const toolsIdx = env.indexOf("Tools available: Read, Write, Edit, Bash");

    expect(versionIdx).toBeGreaterThan(-1);
    expect(nodeIdx).toBeGreaterThan(versionIdx);
    expect(osIdx).toBeGreaterThan(nodeIdx);
    expect(shellIdx).toBeGreaterThan(osIdx);
    expect(cwdIdx).toBeGreaterThan(shellIdx);
    expect(modeIdx).toBeGreaterThan(cwdIdx);
    expect(toolsIdx).toBeGreaterThan(modeIdx);
  });

  it("env block tool names reflect caller order exactly", () => {
    const inp: SystemPromptInputs = { ...BASE_INP, toolNames: ["Bash", "Edit", "Read"] };
    const blocks = buildSystemBlocks(inp);
    expect(blocks[2].text).toContain("Tools available: Bash, Edit, Read");
  });

  it("produces byte-identical output across two calls with identical inputs", () => {
    const first = buildSystemBlocks(BASE_INP);
    const second = buildSystemBlocks(BASE_INP);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("user instructions block wraps text correctly", () => {
    const instructions = "  Always use TypeScript.  ";
    const blocks = buildSystemBlocks({ ...BASE_INP, userInstructions: instructions });
    const userBlock = blocks[3].text;
    expect(userBlock).toContain("User-provided instructions:");
    expect(userBlock).toContain("Always use TypeScript.");
    // Outer should be trimmed
    expect(userBlock).toBe(userBlock.trim());
  });

  it("handles empty toolNames array", () => {
    const blocks = buildSystemBlocks({ ...BASE_INP, toolNames: [] });
    expect(blocks[2].text).toContain("Tools available:");
  });
});

describe("buildEnvUserPrefix", () => {
  it("matches expected format", () => {
    const result = buildEnvUserPrefix();
    expect(result).toMatch(/^<env>\nToday's date: \d{4}-\d{2}-\d{2}\n<\/env>$/);
  });

  it("is trimmed", () => {
    const result = buildEnvUserPrefix();
    expect(result).toBe(result.trim());
  });

  it("contains a valid ISO date", () => {
    const result = buildEnvUserPrefix();
    const match = result.match(/Today's date: (\d{4}-\d{2}-\d{2})/);
    expect(match).not.toBeNull();
    const date = new Date(match![1]);
    expect(isNaN(date.getTime())).toBe(false);
  });
});
