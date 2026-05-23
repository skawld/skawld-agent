/** Substitute named args + reserved vars into a skill body. Pure, single-pass. */

import type { Skill } from "./types.js";
import { splitShellArgs } from "./shell-split.js";

export interface SubstituteOptions {
  skill: Skill;
  /** Raw args string (may be empty). */
  args: string;
  sessionId: string;
}

export function substituteSkillBody(opts: SubstituteOptions): string {
  const { skill, args, sessionId } = opts;
  const tokens = splitShellArgs(args);
  const slots = skill.frontmatter.arguments ?? [];

  let body = skill.body;
  for (let i = 0; i < slots.length; i++) {
    const name = slots[i]!;
    const value = tokens[i] ?? "";
    body = body.replaceAll(`$${name}`, value);
  }
  body = body
    .replaceAll("$ARGUMENTS", args)
    .replaceAll("${SKAWLD_SKILL_DIR}", skill.dir)
    .replaceAll("${SKAWLD_SESSION_ID}", sessionId);

  return `Skill base directory: ${skill.dir}\n\n${body}`;
}
