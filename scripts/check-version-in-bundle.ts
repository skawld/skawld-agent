/**
 * Reads the bundled sdk output and confirms the real version string is present.
 * Run via: bun scripts/check-version-in-bundle.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist");
const bundlePath = resolve(outDir, "sdk.js");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
};
const expected = pkg.version;

const bundle = readFileSync(bundlePath, "utf8");
const marker = `SKAWLD_VERSION = "${expected}"`;
if (!bundle.includes(marker)) {
  console.error(`FAIL: "${marker}" not found in bundled sdk.js`);
  process.exit(1);
}
console.log(`PASS: bundle contains '${marker}'`);
