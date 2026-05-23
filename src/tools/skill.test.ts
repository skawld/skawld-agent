import { describe, expect, it } from "bun:test";
import { SkillTool } from "./skill.js";
import { FileReadTracker } from "./file-tracker.js";
import type { Skill } from "../skills/types.js";
import type { SessionInternal } from "../core/session.js";
import type { ToolContext } from "./base.js";

function mkSkill(name: string, extras: Partial<Skill["frontmatter"]> = {}, body = "Body for $name"): Skill {
  return {
    name,
    dir: `/abs/${name}`,
    frontmatter: {
      name,
      description: `desc for ${name}`,
      disableModelInvocation: false,
      ...extras,
    },
    body,
  };
}

function mkSessionInternal(): SessionInternal {
  // Only the fields SkillTool touches matter; cast through unknown for the rest.
  return {
    id: "sid",
    invokedSkills: [],
    pendingSkillOverlay: undefined,
    currentTurnAllowedTools: undefined,
  } as unknown as SessionInternal;
}

function mkCtx(sessionId = "sid"): ToolContext {
  return {
    cwd: "/tmp",
    signal: new AbortController().signal,
    fileReadTracker: new FileReadTracker(),
    sessionId,
    runId: "run",
    sessionStore: {} as any,
  };
}

describe("SkillTool", () => {
  it("returns is_error for an unknown skill", async () => {
    const tool = new SkillTool({
      skills: new Map(),
      getSessionInternal: () => undefined,
      getSessionModel: () => "claude-opus-4-7",
    });
    const out = await tool.execute({ skill: "missing" }, mkCtx());
    expect(out.is_error).toBe(true);
    expect(out.content).toContain("Unknown skill");
  });

  it("returns is_error for a disabled skill", async () => {
    const skill = mkSkill("disabled", { disableModelInvocation: true });
    const tool = new SkillTool({
      skills: new Map([[skill.name, skill]]),
      getSessionInternal: () => undefined,
      getSessionModel: () => "claude-opus-4-7",
    });
    const out = await tool.execute({ skill: "disabled" }, mkCtx());
    expect(out.is_error).toBe(true);
    expect(out.content).toContain("not invokable");
  });

  it("returns substituted body and records invocation on happy path", async () => {
    const skill = mkSkill("greet", { arguments: ["who"] }, "Hello $who from ${SKAWLD_SKILL_DIR}.");
    const si = mkSessionInternal();
    const tool = new SkillTool({
      skills: new Map([[skill.name, skill]]),
      getSessionInternal: () => si,
      getSessionModel: () => "claude-opus-4-7",
    });
    const out = await tool.execute({ skill: "greet", args: "world" }, mkCtx());
    expect(out.is_error).toBe(false);
    expect(out.content).toContain("Hello world");
    expect(out.content).toContain("Skill base directory: /abs/greet");
    expect(si.invokedSkills).toHaveLength(1);
    expect(si.invokedSkills[0]!.name).toBe("greet");
    expect(si.pendingSkillOverlay).toBeUndefined();
  });

  it("strips leading slash from skill name", async () => {
    const skill = mkSkill("greet");
    const tool = new SkillTool({
      skills: new Map([[skill.name, skill]]),
      getSessionInternal: () => undefined,
      getSessionModel: () => "claude-opus-4-7",
    });
    const out = await tool.execute({ skill: "/greet" }, mkCtx());
    expect(out.is_error).toBe(false);
    expect(out.summary).toBe("Invoked skill: greet");
  });

  it("pushes allowed_tools overlay", async () => {
    const skill = mkSkill("with-tools", { allowedTools: ["Bash", "Read"] });
    const si = mkSessionInternal();
    const tool = new SkillTool({
      skills: new Map([[skill.name, skill]]),
      getSessionInternal: () => si,
      getSessionModel: () => "claude-opus-4-7",
    });
    await tool.execute({ skill: "with-tools" }, mkCtx());
    expect(si.pendingSkillOverlay).toEqual({ allowedTools: ["Bash", "Read"] });
  });

  it("pushes model overlay carrying [1m] suffix from session", async () => {
    const skill = mkSkill("with-model", { model: "claude-sonnet-4-6" });
    const si = mkSessionInternal();
    const tool = new SkillTool({
      skills: new Map([[skill.name, skill]]),
      getSessionInternal: () => si,
      getSessionModel: () => "claude-opus-4-7[1m]",
    });
    await tool.execute({ skill: "with-model" }, mkCtx());
    expect(si.pendingSkillOverlay).toEqual({ modelOverride: "claude-sonnet-4-6[1m]" });
  });

  it("pushes both allowed_tools and model overlays together", async () => {
    const skill = mkSkill("both", { allowedTools: ["Bash"], model: "claude-sonnet-4-6" });
    const si = mkSessionInternal();
    const tool = new SkillTool({
      skills: new Map([[skill.name, skill]]),
      getSessionInternal: () => si,
      getSessionModel: () => "claude-opus-4-7",
    });
    await tool.execute({ skill: "both" }, mkCtx());
    expect(si.pendingSkillOverlay).toEqual({
      allowedTools: ["Bash"],
      modelOverride: "claude-sonnet-4-6",
    });
  });

  it("validate rejects empty skill name", () => {
    const tool = new SkillTool({
      skills: new Map(),
      getSessionInternal: () => undefined,
      getSessionModel: () => "claude-opus-4-7",
    });
    expect(() => tool.validate({ skill: "" })).toThrow();
  });

  it("validate rejects non-string args", () => {
    const tool = new SkillTool({
      skills: new Map(),
      getSessionInternal: () => undefined,
      getSessionModel: () => "claude-opus-4-7",
    });
    expect(() => tool.validate({ skill: "x", args: 123 as unknown as string })).toThrow();
  });
});
