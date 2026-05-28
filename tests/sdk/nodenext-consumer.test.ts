/**
 * NodeNext consumer guardrail.
 *
 * Typechecks a fixture that imports from all published subpaths under
 * moduleResolution: "NodeNext". Before this phase the emitted .d.ts files
 * had extensionless relative imports, producing 26+ TS2834 errors for any
 * NodeNext consumer. This test locks in the fix.
 *
 * Gated on SKAWLD_DIST_TEST (set only by `bun run test:dist`, which builds
 * first). Plain `bun test` skips this suite so the default fast path stays
 * unchanged.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";

const distTestEnabled = !!process.env.SKAWLD_DIST_TEST;

const repoRoot = join(import.meta.dir, "..", "..");
const fixtureDir = join(import.meta.dir, "fixtures", "nodenext-consumer");
const fixtureNodeModules = join(fixtureDir, "node_modules");
const scopeDir = join(fixtureNodeModules, "@skawld");
const symlinkTarget = join(scopeDir, "agent-sdk");

describe.skipIf(!distTestEnabled)("NodeNext consumer — published .d.ts resolve cleanly", () => {
  beforeAll(() => {
    // Create node_modules/@skawld/agent-sdk symlink pointing at the repo root
    // so tsc resolves "@skawld/agent-sdk", "@skawld/agent-sdk/providers", etc.
    // through package.json exports.
    if (!existsSync(scopeDir)) {
      mkdirSync(scopeDir, { recursive: true });
    }
    if (!existsSync(symlinkTarget)) {
      symlinkSync(repoRoot, symlinkTarget);
    }
  });

  afterAll(() => {
    // Clean up the symlink (leave node_modules dir — it is gitignored).
    if (existsSync(symlinkTarget)) {
      rmSync(symlinkTarget, { recursive: true, force: true });
    }
  });

  test("consumer.ts typechecks with 0 errors under NodeNext", () => {
    // Run the local tsc against the fixture tsconfig.
    // We use `bun x tsc` so we don't rely on a global install.
    const result = spawnSync(
      "bun",
      ["x", "tsc", "--project", join(fixtureDir, "tsconfig.json")],
      { cwd: repoRoot, encoding: "utf8" },
    );

    const output = (result.stdout ?? "") + (result.stderr ?? "");

    // Count TS2834 / TS2835 errors (NodeNext relative-import resolution errors).
    const ts2834Count = (output.match(/TS2834/g) ?? []).length;
    const ts2835Count = (output.match(/TS2835/g) ?? []).length;
    const nodeNextErrors = ts2834Count + ts2835Count;

    expect(
      nodeNextErrors,
      `Expected 0 TS2834/TS2835 errors but got ${nodeNextErrors}.\nOutput:\n${output}`,
    ).toBe(0);

    expect(
      result.status,
      `tsc exited with code ${result.status}.\nOutput:\n${output}`,
    ).toBe(0);
  });
});
