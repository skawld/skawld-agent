import { describe, expect, it } from "bun:test";
import { splitShellArgs } from "./shell-split.js";

describe("splitShellArgs", () => {
  it("returns empty array on empty input", () => {
    expect(splitShellArgs("")).toEqual([]);
  });

  it("splits a single token", () => {
    expect(splitShellArgs("hello")).toEqual(["hello"]);
  });

  it("splits whitespace-separated tokens", () => {
    expect(splitShellArgs("a b c")).toEqual(["a", "b", "c"]);
  });

  it("treats double-quoted spans as one token", () => {
    expect(splitShellArgs('a "b c" d')).toEqual(["a", "b c", "d"]);
  });

  it("treats single-quoted spans as one token", () => {
    expect(splitShellArgs("a 'b c' d")).toEqual(["a", "b c", "d"]);
  });

  it("handles escaped double quotes inside double quotes", () => {
    expect(splitShellArgs('"a\\"b"')).toEqual(['a"b']);
  });

  it("treats single quotes inside double quotes literally", () => {
    expect(splitShellArgs("\"a'b\"")).toEqual(["a'b"]);
  });

  it("ignores leading and trailing whitespace", () => {
    expect(splitShellArgs("  a   b  ")).toEqual(["a", "b"]);
  });

  it("leniently absorbs an unclosed quote into the trailing token", () => {
    expect(splitShellArgs('a "bc')).toEqual(["a", "bc"]);
  });
});
