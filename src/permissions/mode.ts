import type { PermissionMode } from "../core/types.js";

export type { PermissionMode } from "../core/types.js";

const PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "yolo"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODES.includes(value as PermissionMode);
}
