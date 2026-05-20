import { describe, expect, test } from "bun:test";
import {
  evaluateBashRules,
  matchBashRule,
  matchPathRule,
  matchToolRule,
  type BashRule,
} from "./rules.js";

const projectRoot = "/repo";

describe("permission tool rules", () => {
  test("matches exact tool names and wildcard tools", () => {
    expect(matchToolRule({ kind: "tool", tool: "Write", decision: "allow" }, { tool: "Write", input: {} })).toBe(true);
    expect(matchToolRule({ kind: "tool", tool: "Read", decision: "allow" }, { tool: "Write", input: {} })).toBe(false);
    expect(matchToolRule({ kind: "tool", tool: "*", decision: "deny" }, { tool: "Bash", input: {} })).toBe(true);
  });
});

describe("permission path rules", () => {
  test("resolves relative file paths under the project root", () => {
    const rule = { kind: "path" as const, paths: ["/repo/src/**"], decision: "allow" as const };

    expect(matchPathRule(rule, { tool: "Write", input: { file_path: "src/index.ts" } }, projectRoot)).toBe(true);
  });

  test("supports leading ! inversion for paths outside the project", () => {
    const rule = { kind: "path" as const, paths: ["!/repo/**"], decision: "deny" as const };

    expect(matchPathRule(rule, { tool: "Write", input: { file_path: "/tmp/outside.ts" } }, projectRoot)).toBe(true);
    expect(matchPathRule(rule, { tool: "Write", input: { file_path: "/repo/src/index.ts" } }, projectRoot)).toBe(false);
  });

  test("limits matching to the configured tools filter", () => {
    const rule = { kind: "path" as const, tools: ["Edit"], paths: ["/repo/src/**"], decision: "allow" as const };

    expect(matchPathRule(rule, { tool: "Write", input: { file_path: "src/index.ts" } }, projectRoot)).toBe(false);
    expect(matchPathRule(rule, { tool: "Edit", input: { file_path: "src/index.ts" } }, projectRoot)).toBe(true);
  });

  test("resolves relative paths against call.cwd when provided", () => {
    const rule = { kind: "path" as const, paths: ["/repo/sub/**"], decision: "allow" as const };

    expect(matchPathRule(rule, { tool: "Write", input: { file_path: "nested.ts" }, cwd: "/repo/sub" }, projectRoot)).toBe(true);
    expect(matchPathRule(rule, { tool: "Write", input: { file_path: "nested.ts" }, cwd: "/repo/other" }, projectRoot)).toBe(false);
  });

  test("uses the project root as Glob and Grep path fallback", () => {
    const globRule = { kind: "path" as const, tools: ["Glob"], paths: ["/repo/**"], decision: "allow" as const };
    const grepRule = { kind: "path" as const, tools: ["Grep"], paths: ["/repo/**"], decision: "allow" as const };

    expect(matchPathRule(globRule, { tool: "Glob", input: { pattern: "*.ts" } }, projectRoot)).toBe(true);
    expect(matchPathRule(grepRule, { tool: "Grep", input: { pattern: "PermissionEngine" } }, projectRoot)).toBe(true);
  });
});

describe("permission bash rules", () => {
  test("plain patterns match token prefixes including quoted tokens", () => {
    expect(matchBashRule({ kind: "bash", pattern: "git status", decision: "allow" }, 'git "status" --short')).toBe(true);
    expect(matchBashRule({ kind: "bash", pattern: 'npm run "test unit"', decision: "allow" }, 'npm run "test unit" -- --watch')).toBe(true);
  });

  test("regex patterns match the raw command segment", () => {
    expect(matchBashRule({ kind: "bash", pattern: { regex: "^\\s*rm\\s+-rf\\b" }, decision: "deny" }, " rm -rf dist")).toBe(true);
  });

  test("invalid regex patterns do not throw and do not match", () => {
    expect(() => matchBashRule({ kind: "bash", pattern: { regex: "[" }, decision: "deny" }, "rm -rf dist")).not.toThrow();
    expect(matchBashRule({ kind: "bash", pattern: { regex: "[" }, decision: "deny" }, "rm -rf dist")).toBe(false);
  });

  test("denies composite commands after shell operators", () => {
    const rules: BashRule[] = [
      { kind: "bash", pattern: "git status", decision: "allow" },
      { kind: "bash", pattern: { regex: "^\\s*rm\\b" }, decision: "deny" },
    ];

    for (const operator of ["&&", "||", ";", "|"]) {
      expect(evaluateBashRules(rules, `git status ${operator} rm -rf dist`)).toBe("deny");
    }
  });

  test("does not match git statusx as git status", () => {
    expect(matchBashRule({ kind: "bash", pattern: "git status", decision: "allow" }, "git statusx")).toBe(false);
  });

  test("does not split on quoted shell operators", () => {
    const rules: BashRule[] = [
      { kind: "bash", pattern: "echo", decision: "allow" },
      { kind: "bash", pattern: { regex: "\\brm\\b" }, decision: "deny" },
    ];

    expect(evaluateBashRules(rules, 'echo "safe && rm -rf dist"')).toBe("allow");
    expect(evaluateBashRules(rules, "echo 'safe | rm -rf dist'")).toBe("allow");
  });
});
