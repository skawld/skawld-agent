/** Skill types. See docs/11-skills.html. */

export interface SkillFrontmatter {
  /** Resolved skill name (defaults to dir name when omitted in YAML). */
  name: string;
  /** Required short description, surfaced in skill_listing. */
  description: string;
  /** Optional usage hint for the model. */
  whenToUse?: string;
  /** Optional list of tools this skill is permitted to invoke for its turn. */
  allowedTools?: string[];
  /** Optional list of named argument slots, substituted into the body. */
  arguments?: string[];
  /** Optional hint string surfaced in skill_listing alongside the description. */
  argumentHint?: string;
  /** Optional per-skill model override. */
  model?: string;
  /** Optional semantic version. */
  version?: string;
  /** When true, the skill is hidden from skill_listing and not invokable by the model. */
  disableModelInvocation: boolean;
}

export interface Skill {
  name: string;
  /** Absolute path to the skill directory. */
  dir: string;
  frontmatter: SkillFrontmatter;
  /** Raw markdown body (everything after the closing `---`). */
  body: string;
}

export interface SkippedSkill {
  dir: string;
  reason:
    | "invalid-frontmatter"
    | "missing-skill-md"
    | "name-collision-tool"
    | "name-collision-skill"
    | "io-error";
  detail: string;
}
