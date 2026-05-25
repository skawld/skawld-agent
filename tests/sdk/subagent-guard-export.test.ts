/**
 * SDK surface smoke: `isSubagentEvent` guard is exported from the main entry
 * and narrows correctly. Regression for a docs/code mismatch flagged on
 * 2026-05-26 — docs claimed the guard was re-exported, but src/sdk.ts shipped
 * only the type. See plans/260526-0055-subagent-followup-fixes/phase-01.
 */

import { describe, expect, test } from "bun:test";
import { isSubagentEvent } from "../../src/sdk.js";
import type { Event, SubagentEvent, AssistantEvent } from "../../src/sdk.js";

describe("SDK surface — isSubagentEvent guard", () => {
  test("is exported as a callable function from the main entry", () => {
    expect(typeof isSubagentEvent).toBe("function");
  });

  test("returns true for SubagentEvent, false for other event variants", () => {
    const subagent: SubagentEvent = {
      type: "subagent_event",
      parent_session_id: "p",
      subagent_run_id: "sr-1",
      subagent_type: "researcher",
      display_name: "researcher",
      event: {
        type: "assistant",
        stop_reason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      } as AssistantEvent,
    };
    const assistant: AssistantEvent = {
      type: "assistant",
      stop_reason: "end_turn",
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    };

    expect(isSubagentEvent(subagent)).toBe(true);
    expect(isSubagentEvent(assistant as Event)).toBe(false);
  });

  test("narrows the type so guarded access is type-safe", () => {
    const ev: Event = {
      type: "subagent_event",
      parent_session_id: "p",
      subagent_run_id: "sr-2",
      subagent_type: "x",
      display_name: "x",
      event: {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      } as AssistantEvent,
    };
    if (isSubagentEvent(ev)) {
      // Inside this branch ev is SubagentEvent; reading subagent_run_id must compile.
      expect(ev.subagent_run_id).toBe("sr-2");
    } else {
      throw new Error("guard failed to narrow");
    }
  });
});
