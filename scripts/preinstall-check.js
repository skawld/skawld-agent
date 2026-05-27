#!/usr/bin/env node
if (!process.versions.bun) {
  const red = "\x1b[31m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  console.error(
    `\n${red}${bold}skawld requires Bun${reset}\n\n` +
      `skawld is Bun-native and imports Bun built-ins such as ${bold}bun:sqlite${reset}.\n` +
      `It will not run on Node.js, Deno, or other JavaScript runtimes.\n\n` +
      `Install Bun:  ${bold}curl -fsSL https://bun.sh/install | bash${reset}\n` +
      `Then install: ${bold}bun add skawld${reset}\n`,
  );
  process.exit(1);
}
