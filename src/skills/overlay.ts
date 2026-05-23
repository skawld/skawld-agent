/** Pure helpers for the one-turn Skill overlay. */

import type { ModelId } from "../core/types.js";

/**
 * Carry the `[1m]` extended-context suffix from the session model when the
 * override lacks one. Allows per-skill model overrides to inherit the session's
 * context-window choice without each skill author having to specify it.
 */
export function resolveModelOverride(override: ModelId, sessionModel: ModelId): ModelId {
  if (override.endsWith("[1m]") || !sessionModel.endsWith("[1m]")) return override;
  return `${override}[1m]`;
}
