import { describe, expect, it } from "bun:test";
import { substituteSkillBody } from "./substitute.js";
import type { Skill } from "./types.js";

function mkSkill(body: string, args?: string[]): Skill {
  return {
    name: "s",
    dir: "/abs/path/to/s",
    frontmatter: {
      name: "s",
      description: "d",
      disableModelInvocation: false,
      ...(args ? { arguments: args } : {}),
    },
    body,
  };
}

describe("substituteSkillBody", () => {
  it("substitutes a single named arg", () => {
    const out = substituteSkillBody({
      skill: mkSkill("hello $name", ["name"]),
      args: "world",
      sessionId: "sid",
    });
    expect(out).toBe("Skill base directory: /abs/path/to/s\n\nhello world");
  });

  it("substitutes multiple named args", () => {
    const out = substituteSkillBody({
      skill: mkSkill("$a + $b = ?", ["a", "b"]),
      args: "1 2",
      sessionId: "sid",
    });
    expect(out).toContain("1 + 2 = ?");
  });

  it("missing args become empty strings", () => {
    const out = substituteSkillBody({
      skill: mkSkill("$a-$b", ["a", "b"]),
      args: "only",
      sessionId: "sid",
    });
    expect(out).toContain("only-");
  });

  it("substitutes $ARGUMENTS with the raw args string", () => {
    const out = substituteSkillBody({
      skill: mkSkill("got: $ARGUMENTS"),
      args: 'a "b c"',
      sessionId: "sid",
    });
    expect(out).toContain('got: a "b c"');
  });

  it("substitutes ${SKAWLD_SKILL_DIR} and ${SKAWLD_SESSION_ID}", () => {
    const out = substituteSkillBody({
      skill: mkSkill("dir=${SKAWLD_SKILL_DIR} sid=${SKAWLD_SESSION_ID}"),
      args: "",
      sessionId: "abc-123",
    });
    expect(out).toContain("dir=/abs/path/to/s sid=abc-123");
  });

  it("body without substitutables gets just the header", () => {
    const out = substituteSkillBody({
      skill: mkSkill("plain body"),
      args: "",
      sessionId: "sid",
    });
    expect(out).toBe("Skill base directory: /abs/path/to/s\n\nplain body");
  });

  it("always prepends the base-dir header", () => {
    const out = substituteSkillBody({
      skill: mkSkill(""),
      args: "",
      sessionId: "sid",
    });
    expect(out.startsWith("Skill base directory: /abs/path/to/s\n\n")).toBe(true);
  });

  it("is byte-identical across two calls with the same input", () => {
    const skill = mkSkill("hi $name dir=${SKAWLD_SKILL_DIR}", ["name"]);
    const a = substituteSkillBody({ skill, args: "you", sessionId: "sid" });
    const b = substituteSkillBody({ skill, args: "you", sessionId: "sid" });
    expect(a).toBe(b);
  });
});
