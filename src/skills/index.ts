/** Internal barrel for the skills subsystem. Public API lives in src/sdk.ts. */

export { loadSkillsFromDir } from "./loader.js";
export type { LoadSkillsOptions, LoadSkillsResult } from "./loader.js";
export type { Skill, SkillFrontmatter, SkippedSkill } from "./types.js";
export { substituteSkillBody } from "./substitute.js";
export type { SubstituteOptions } from "./substitute.js";
export { buildSkillListing } from "./listing.js";
export type { BuildSkillListingOptions } from "./listing.js";
export { splitShellArgs } from "./shell-split.js";
