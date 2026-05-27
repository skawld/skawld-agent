/**
 * Simple interactive skawld CLI for manual testing.
 *
 * Requires: OPENAI_API_KEY in environment.
 * Optional: SKAWLD_MODEL (default: gpt-5), SKAWLD_CONFIG_DIR (default: ./.skawld).
 *
 * Run with: bun run examples/interactive-cli.ts
 *
 * Type a message, hit enter, watch the agent work. Ctrl+C or `/exit` to quit.
 */

import { createInterface } from "node:readline/promises";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "../src/sdk.js";
import { OpenAIResponsesProvider } from "../src/providers/index.js";
import { defaultTools } from "../src/tools/index.js";

if (!process.env.OPENAI_API_KEY) {
  console.error(
    "Error: OPENAI_API_KEY is not set.\n" +
      "Export it before running:\n" +
      "  export OPENAI_API_KEY=sk-..."
  );
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.SKAWLD_MODEL ?? "gpt-5";
const CONFIG_DIR = process.env.SKAWLD_CONFIG_DIR
  ? resolve(process.env.SKAWLD_CONFIG_DIR)
  : resolve(process.cwd(), ".skawld");

// ANSI colors
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

const label = (text: string, color: string): string =>
  `${c.bold}${color}${text}${c.reset}`;

function preview(v: unknown, max = 240): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function block(body: string, color: string): string {
  return body
    .split("\n")
    .map(line => `${color}│${c.reset} ${line}`)
    .join("\n");
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function promptForCwd(): Promise<string> {
  const defaultDir = process.cwd();
  for (let attempt = 0; attempt < 3; attempt++) {
    const input = (
      await rl.question(`${c.dim}Working dir (default: ${defaultDir}): ${c.reset}`)
    ).trim();
    const candidate = input === "" ? defaultDir : resolve(process.cwd(), input);
    try {
      if (!statSync(candidate).isDirectory()) {
        console.log(`${c.red}Not a directory: ${candidate}${c.reset}`);
        continue;
      }
      return candidate;
    } catch (err) {
      console.log(`${c.red}${(err as Error).message}${c.reset}`);
    }
  }
  console.log(`${c.red}Too many failed attempts; exiting.${c.reset}`);
  rl.close();
  process.exit(1);
}

const workingDir = await promptForCwd();

const agent = new Agent({
  provider: new OpenAIResponsesProvider({
    apiKey: OPENAI_API_KEY,
    reasoning: { effort: "medium", summary: "auto" },
  }),
  model: MODEL,
  tools: defaultTools(),
  cwd: workingDir,
  configDir: CONFIG_DIR,
  permissions: { mode: "yolo" },
});

const session = await agent.session();

// --- Subagent live boxes -----------------------------------------------------

type BoxState = {
  displayName: string;
  subagentType: string;
  toolCount: number;
  lastTools: Array<{ name: string; input: unknown }>;
  latestAnswer: string;
  status: "running" | "done" | "errored";
  errorMessage?: string;
};

const boxes = new Map<string, BoxState>();
const subagentToolUseIds = new Set<string>();
let liveLines = 0;
let lastRender = "";

function visualLength(text: string): number {
  return text.replace(ANSI_RE, "").length;
}

function boxWidth(): number {
  return Math.min(process.stdout.columns ?? 100, 100);
}

function padRight(text: string, width: number): string {
  const vl = visualLength(text);
  if (vl === width) return text;
  if (vl < width) return text + " ".repeat(width - vl);
  // Truncate visually while preserving ANSI escapes. Walk the string, copy
  // characters until we've emitted (width-1) visible chars, then append "…".
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < text.length && visible < width - 1) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      if (end !== -1) {
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    out += text[i];
    visible++;
    i++;
  }
  // Preserve any trailing reset codes so colors don't bleed.
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      if (end !== -1) {
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out + "…";
}

function wrapToWidth(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let rest = para;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

function renderBox(id: string, state: BoxState): string[] {
  const width = boxWidth();
  const innerWidth = width - 4;
  const color = state.status === "errored" ? c.red : c.magenta;
  const isDone = state.status !== "running";

  const titleText = ` ${state.displayName} · ${id} `;
  const statusText = isDone
    ? state.status === "errored"
      ? `error · ${state.toolCount} tools`
      : `done · ${state.toolCount} tools`
    : `${state.toolCount} tool calls`;
  const statusLabel = ` ${statusText} `;

  const fill = Math.max(
    1,
    width - 4 - titleText.length - statusLabel.length,
  );
  const top =
    `${color}╭─${c.reset}` +
    `${c.bold}${color}${titleText}${c.reset}` +
    `${color}${"─".repeat(fill)}${c.reset}` +
    `${c.bold}${color}${statusLabel}${c.reset}` +
    `${color}─╮${c.reset}`;

  let body: string[];
  if (state.status === "running") {
    body = state.lastTools.map(t => {
      const namePad = t.name.padEnd(7);
      // Budget against the actual name length, not the padEnd(7) assumption —
      // long tool names (e.g. "TaskCreate") would otherwise push the body
      // past innerWidth, soft-wrap in the terminal, and break liveLines.
      const budget = Math.max(8, innerWidth - visualLength(namePad) - 2);
      const inputPrev = preview(t.input, budget);
      return `${c.bold}${namePad}${c.reset} ${c.dim}${inputPrev}${c.reset}`;
    });
    if (body.length === 0) body = [`${c.dim}(starting…)${c.reset}`];
  } else if (state.status === "errored") {
    body = wrapToWidth(state.errorMessage ?? "(unknown error)", innerWidth);
  } else {
    body = wrapToWidth(state.latestAnswer || "(no output)", innerWidth);
    if (body.length > 10) {
      body = body.slice(0, 10);
      const last = body[9];
      body[9] = last.length > innerWidth - 1 ? last.slice(0, innerWidth - 1) + "…" : last + "…";
    }
  }

  const lines = [top];
  for (const ln of body) {
    lines.push(`${color}│${c.reset} ${padRight(ln, innerWidth)} ${color}│${c.reset}`);
  }
  lines.push(`${color}╰${"─".repeat(width - 2)}╯${c.reset}`);
  return lines;
}

function clearLive(): void {
  if (liveLines === 0) return;
  process.stdout.write(`\x1b[${liveLines}A\x1b[0J`);
  liveLines = 0;
  lastRender = "";
}

function renderLive(): void {
  const all: string[] = [];
  for (const [id, state] of boxes) all.push(...renderBox(id, state));
  const next = all.join("\n");
  if (next === lastRender) return;

  if (liveLines > 0) {
    process.stdout.write(`\x1b[${liveLines}A\x1b[0J`);
    liveLines = 0;
  }
  if (all.length === 0) {
    lastRender = "";
    return;
  }
  process.stdout.write(next + "\n");
  liveLines = all.length;
  lastRender = next;
}

function promoteBox(id: string, state: BoxState): void {
  // Clear the live region before promoting so the finalized box lands in
  // scrollback exactly where the live one was, not below a stale copy.
  if (liveLines > 0) {
    process.stdout.write(`\x1b[${liveLines}A\x1b[0J`);
    liveLines = 0;
    lastRender = "";
  }
  console.log(renderBox(id, state).join("\n"));
}

function handleSubagentEvent(envelope: any): void {
  const id: string = envelope.subagent_run_id;
  const inner = envelope.event;
  // Nested subagent envelopes: ignore the inner level for now.
  if (inner.type === "subagent_event") return;

  let box = boxes.get(id);
  if (!box) {
    box = {
      displayName: envelope.display_name,
      subagentType: envelope.subagent_type,
      toolCount: 0,
      lastTools: [],
      latestAnswer: "",
      status: "running",
    };
    boxes.set(id, box);
  }

  switch (inner.type) {
    case "tool_call_start":
      box.toolCount++;
      box.lastTools.push({ name: inner.tool_name, input: inner.input });
      if (box.lastTools.length > 5) box.lastTools.shift();
      break;
    case "assistant": {
      const text = inner.message.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      box.latestAnswer = text;
      break;
    }
    case "result":
      box.status = inner.subtype === "error" ? "errored" : "done";
      if (box.status === "errored") {
        box.errorMessage = box.errorMessage ?? "(subagent ended with error)";
      }
      promoteBox(id, box);
      boxes.delete(id);
      break;
    case "error":
      box.status = "errored";
      box.errorMessage = `${inner.error.name}: ${inner.error.message}`;
      promoteBox(id, box);
      boxes.delete(id);
      break;
  }
}

// --- Parent event rendering --------------------------------------------------

function hasParentOutput(event: any): boolean {
  switch (event.type) {
    case "assistant":
      return event.message.content.some(
        (b: any) =>
          b.type === "thinking" ||
          (b.type === "text" && b.text.trim()) ||
          (b.type === "tool_use" && b.name !== "Subagent"),
      );
    case "user":
      return event.message.content.some(
        (b: any) => b.type === "tool_result" && !subagentToolUseIds.has(b.tool_use_id),
      );
    case "error":
      return true;
    default:
      return false;
  }
}

function printParent(event: any): void {
  switch (event.type) {
    case "assistant":
      for (const b of event.message.content) {
        if (b.type === "thinking") {
          console.log(`\n${label("Thinking", c.magenta)}`);
          console.log(block(b.thinking, c.magenta) + c.reset);
        } else if (b.type === "text" && b.text.trim()) {
          console.log(`\n${label("Agent", c.green)}`);
          console.log(block(b.text, c.green));
        } else if (b.type === "tool_use") {
          if (b.name === "Subagent") {
            // Track so we can suppress the matching tool_result too; the live
            // box already shows the spawn + final answer.
            subagentToolUseIds.add(b.id);
            continue;
          }
          console.log(
            `\n${label("Tool", c.yellow)} ${c.bold}${b.name}${c.reset} ${c.dim}${preview(b.input)}${c.reset}`
          );
        }
      }
      break;

    case "user":
      for (const b of event.message.content) {
        if (b.type === "tool_result") {
          if (subagentToolUseIds.has(b.tool_use_id)) {
            subagentToolUseIds.delete(b.tool_use_id);
            continue;
          }
          const head = b.is_error ? label("Tool Result (error)", c.red) : label("Tool Result", c.blue);
          const text =
            typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          console.log(`\n${head}`);
          console.log(block(preview(text, 600), c.blue));
        }
      }
      break;

    case "error":
      console.log(`\n${label("Error", c.red)} ${event.error.name}: ${event.error.message}`);
      break;
  }
}

// --- Main loop ---------------------------------------------------------------

console.log(`${c.bold}skawld${c.reset} ${c.dim}— ${MODEL} · yolo · ${workingDir}${c.reset}`);
console.log(`${c.dim}Type a message. /exit to quit.${c.reset}`);

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearLive();
  rl.close();
  await agent.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  console.log(`\n${c.dim}bye${c.reset}`);
  void shutdown();
});

while (true) {
  let prompt: string;
  try {
    prompt = (await rl.question(`\n${label("You", c.cyan)} `)).trim();
  } catch {
    break;
  }
  if (!prompt) continue;
  if (prompt === "/exit" || prompt === "/quit") break;

  try {
    for await (const event of session.run(prompt)) {
      if (event.type === "subagent_event") {
        handleSubagentEvent(event);
        renderLive(); // diff-aware: no-op if box state didn't change visibly
      } else if (hasParentOutput(event)) {
        clearLive();
        printParent(event);
        renderLive();
      }
      if (event.type === "result" || event.type === "error") break;
    }
  } catch (err) {
    clearLive();
    console.error(`\n${label("Error", c.red)} ${(err as Error).message}`);
  }

  // Flush any boxes still open (turn ended mid-flight).
  clearLive();
  if (boxes.size > 0) {
    for (const [id, state] of boxes) {
      if (state.status === "running") {
        state.status = "errored";
        state.errorMessage = state.errorMessage ?? "(interrupted)";
      }
      promoteBox(id, state);
    }
    boxes.clear();
  }
}

await shutdown();
