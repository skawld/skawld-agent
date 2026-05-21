/**
 * Minimal skawld agent example.
 *
 * Requires: ANTHROPIC_API_KEY in environment.
 * Run with: bun run examples/minimal-agent.ts
 *
 * The agent receives one prompt, streams the assistant reply to stdout,
 * and exits cleanly when the run produces a result event.
 * No live API call is made if the key is absent — the script exits with
 * a clear error message instead.
 */

import { Agent } from "../src/sdk.js";
import { AnthropicProvider } from "../src/providers/index.js";
import { defaultTools } from "../src/tools/index.js";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Error: ANTHROPIC_API_KEY is not set.\n" +
      "Export it before running:\n" +
      "  export ANTHROPIC_API_KEY=sk-ant-..."
  );
  process.exit(1);
}

const agent = new Agent({
  provider: new AnthropicProvider(),  // picks up ANTHROPIC_API_KEY automatically
  model: "claude-opus-4-5",
  tools: defaultTools(),
});

const session = await agent.session();

console.log("Running agent…\n");

for await (const event of session.run(
  "List the files in the current directory and give me a one-sentence summary of what this project does."
)) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") {
        process.stdout.write(block.text);
      }
    }
  }

  if (event.type === "result") {
    process.stdout.write("\n");
    break;
  }

  if (event.type === "error") {
    console.error("\nAgent error:", event.error.message);
    break;
  }
}

await agent.close();
