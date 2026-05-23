import { describe, expect, it } from "bun:test";
import { resolveModelOverride } from "./overlay.js";

describe("resolveModelOverride", () => {
  it("returns override unchanged when both have [1m]", () => {
    expect(resolveModelOverride("claude-sonnet-4-6[1m]", "claude-opus-4-7[1m]"))
      .toBe("claude-sonnet-4-6[1m]");
  });

  it("returns override unchanged when neither has [1m]", () => {
    expect(resolveModelOverride("claude-sonnet-4-6", "claude-opus-4-7"))
      .toBe("claude-sonnet-4-6");
  });

  it("adds [1m] suffix when only the session model has it", () => {
    expect(resolveModelOverride("claude-sonnet-4-6", "claude-opus-4-7[1m]"))
      .toBe("claude-sonnet-4-6[1m]");
  });

  it("leaves override [1m] alone when session lacks it", () => {
    expect(resolveModelOverride("claude-sonnet-4-6[1m]", "claude-opus-4-7"))
      .toBe("claude-sonnet-4-6[1m]");
  });

  it("identity when override equals session", () => {
    expect(resolveModelOverride("claude-opus-4-7", "claude-opus-4-7"))
      .toBe("claude-opus-4-7");
  });

  it("identity with [1m] suffix on both", () => {
    expect(resolveModelOverride("claude-opus-4-7[1m]", "claude-opus-4-7[1m]"))
      .toBe("claude-opus-4-7[1m]");
  });
});
