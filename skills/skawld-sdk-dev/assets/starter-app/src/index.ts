/**
 * Skawld starter app — a multi-turn terminal agent.
 *
 * Demonstrates the full lifecycle: provider + tools + permission prompting +
 * SQLite session persistence + streaming + graceful shutdown.
 *
 * Setup:  export ANTHROPIC_API_KEY=sk-ant-...
 * Run:    bun run src/index.ts
 * Quit:   /exit  (or Ctrl+C)
 *
 * Swap the provider block to use OpenAI instead (see the comment below).
 */

import { createInterface } from "node:readline/promises";
import { Agent } from "@skawld/agent-sdk";
import { AnthropicProvider } from "@skawld/agent-sdk/providers";
import { defaultTools } from "@skawld/agent-sdk/tools";
import type { CanUseTool } from "@skawld/agent-sdk/permissions";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first:  export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

// Ask the user to approve any write/exec tool the model wants to run.
// Read-scoped tools and the Task tools never reach this callback.
const canUseTool: CanUseTool = async (req) => {
  const answer = await rl.question(`\n  ⚠️  Allow ${req.tool_name}? ${req.summary} [y/N] `);
  return answer.trim().toLowerCase().startsWith("y")
    ? { behavior: "allow" }
    : { behavior: "deny", message: "User declined." };
};

const agent = new Agent({
  provider: new AnthropicProvider(),          // reads ANTHROPIC_API_KEY
  model: "claude-opus-4-5",
  // OpenAI instead:
  //   import { OpenAIResponsesProvider } from "@skawld/agent-sdk/providers";
  //   provider: new OpenAIResponsesProvider({ reasoning: { effort: "medium" } }), model: "gpt-5",
  tools: defaultTools(),
  permissions: { mode: "default", canUseTool },   // write/exec tools ask; reads are free
  // Sessions persist to .skawld/sessions.db by default. Resume with: agent.session({ id })
});

// One persistent session for the whole REPL — history carries across turns.
const session = await agent.session();
console.log(`Session ${session.id} ready. Type a message, or /exit to quit.\n`);

let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await agent.close();        // closes the SQLite store; would disconnect MCP servers too
  rl.close();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));

for (;;) {
  const prompt = (await rl.question("you › ")).trim();
  if (prompt === "" ) continue;
  if (prompt === "/exit") break;

  process.stdout.write("\nbot › ");
  try {
    for await (const event of session.run(prompt)) {
      switch (event.type) {
        case "assistant":
          for (const block of event.message.content) {
            if (block.type === "text") process.stdout.write(block.text);
          }
          break;
        case "tool_call_start":
          process.stdout.write(`\n  · ${event.tool_name}(${JSON.stringify(event.input).slice(0, 80)})\n`);
          break;
        case "result":
          process.stdout.write(`\n  [${event.subtype} · ${event.duration_ms}ms · ` +
            `${event.total_usage.input_tokens}+${event.total_usage.output_tokens} tok]\n\n`);
          break;
        case "error":
          process.stderr.write(`\n  ✖ ${event.error.name}: ${event.error.message}\n\n`);
          break;
      }
      if (event.type === "result") break;
    }
  } catch (err) {
    console.error("\nRun failed:", (err as Error).message, "\n");
  }
}

await shutdown(0);
