import { describe, test, expect } from "bun:test";
import { normalizeNameForMcp, buildMcpToolName } from "./naming.js";

describe("normalizeNameForMcp", () => {
  test("keeps alphanumerics, underscore, dash", () => {
    expect(normalizeNameForMcp("create_issue-2")).toBe("create_issue-2");
  });

  test("replaces spaces, slashes, dots, colons with underscore", () => {
    expect(normalizeNameForMcp("add comment/to.issue:now")).toBe("add_comment_to_issue_now");
  });

  test("replaces unicode and symbols", () => {
    expect(normalizeNameForMcp("héllo@world")).toBe("h_llo_world");
  });
});

describe("buildMcpToolName", () => {
  test("namespaces server and tool", () => {
    expect(buildMcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
  });

  test("normalizes both segments", () => {
    expect(buildMcpToolName("my server", "do thing")).toBe("mcp__my_server__do_thing");
  });
});
