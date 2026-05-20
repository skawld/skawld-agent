#!/usr/bin/env bun
// CLI binary entry. Implemented in module 08.
import { main } from "./main.js";
main(process.argv.slice(2)).catch((err: unknown) => {
  const e = err as { stack?: string } | undefined;
  process.stderr.write(`skawld: ${e?.stack ?? String(err)}\n`);
  process.exit(1);
});
