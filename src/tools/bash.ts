import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Tool, ToolContext, ToolResult, ToolScope } from "./base.js";
import { ToolExecutionError } from "../core/errors.js";

export interface BashInput {
  command: string;
  timeout_ms?: number;
  description?: string;
}

const NAME = "Bash";
const DEFAULT_TIMEOUT = 120_000;
const MIN_TIMEOUT = 100;
const MAX_TIMEOUT = 1_800_000;
const STREAM_CAP = 30_000;
const COMBINED_CAP = 30_000;
const isWindows = process.platform === "win32";

// ---------------------------------------------------------------------------
// Bounded stream accumulator
// ---------------------------------------------------------------------------

interface Accumulator {
  text: string;
  truncated: boolean;
  truncatedBytes: number;
}

function makeAccumulator(): Accumulator {
  return { text: "", truncated: false, truncatedBytes: 0 };
}

function appendToAccumulator(acc: Accumulator, chunk: string): void {
  if (acc.truncated) {
    acc.truncatedBytes += chunk.length;
    return;
  }
  const headroom = STREAM_CAP - acc.text.length;
  if (chunk.length <= headroom) {
    acc.text += chunk;
  } else {
    acc.text += chunk.slice(0, headroom);
    acc.truncatedBytes = chunk.length - headroom;
    acc.truncated = true;
  }
}

// ---------------------------------------------------------------------------
// Process-tree termination
// ---------------------------------------------------------------------------

function killTree(pid: number): void {
  if (isWindows) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
    } catch {
      // ignore
    }
    return;
  }
  // POSIX: kill the process group (negative pid)
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // ESRCH = already gone
    return;
  }
  // Grace period, then SIGKILL
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }, 2_000);
}

// ---------------------------------------------------------------------------
// Format combined output
// ---------------------------------------------------------------------------

function formatOutput(stdout: Accumulator, stderr: Accumulator, exitCode: number): string {
  let combined =
    stderr.text.length > 0
      ? `${stdout.text}\n---\n${stderr.text}`
      : stdout.text;

  let truncationNote = "";
  const totalTruncated =
    (stdout.truncated ? stdout.truncatedBytes : 0) +
    (stderr.truncated ? stderr.truncatedBytes : 0);
  if (totalTruncated > 0) {
    truncationNote = `\n… (${totalTruncated} chars truncated)`;
  }

  // Apply combined cap
  if (combined.length > COMBINED_CAP) {
    const omitted = combined.length - COMBINED_CAP;
    combined = combined.slice(0, COMBINED_CAP);
    truncationNote = `\n… (${omitted + totalTruncated} chars truncated)`;
  }

  return `${combined}${truncationNote}\nexit: ${exitCode}`;
}

// ---------------------------------------------------------------------------
// BashTool
// ---------------------------------------------------------------------------

export class BashTool implements Tool<BashInput> {
  readonly name = NAME;
  readonly description =
    "Run a shell command. Returns stdout, stderr, and the exit code. Non-zero exit codes are not errors — the model interprets them.";
  readonly input_schema = {
    type: "object" as const,
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds. Defaults to 120000, max 1800000.",
      },
      description: {
        type: "string",
        description: "Brief description of what the command does.",
      },
    },
    required: ["command"],
  };
  readonly scope: ToolScope = "exec";
  readonly parallelSafe = false;

  validate(raw: Record<string, unknown>): BashInput {
    if (typeof raw.command !== "string" || raw.command.trim() === "") {
      throw new ToolExecutionError("Bash: 'command' must be a non-empty string.", {
        tool_name: NAME,
      });
    }
    let timeout_ms = DEFAULT_TIMEOUT;
    if (raw.timeout_ms !== undefined) {
      const t = Number(raw.timeout_ms);
      if (!isFinite(t)) {
        throw new ToolExecutionError("Bash: 'timeout_ms' must be a finite number.", {
          tool_name: NAME,
        });
      }
      timeout_ms = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, t));
    }
    return {
      command: raw.command,
      timeout_ms,
      description: typeof raw.description === "string" ? raw.description : undefined,
    };
  }

  summarize(input: BashInput): string {
    if (input.description) return input.description;
    const snippet =
      input.command.length > 60 ? input.command.slice(0, 60) + "…" : input.command;
    return `Bash: ${snippet}`;
  }

  async execute(input: BashInput, ctx: ToolContext): Promise<ToolResult> {
    const timeout_ms = input.timeout_ms ?? DEFAULT_TIMEOUT;
    const shell = isWindows
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");
    const shellFlag = isWindows ? "/c" : "-c";

    // Reject immediately if already aborted
    if (ctx.signal.aborted) {
      return {
        content: "Bash: aborted by signal before execution.",
        summary: this.summarize(input),
        is_error: true,
      };
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [shellFlag, input.command], {
        cwd: ctx.cwd,
        env: process.env,
        detached: !isWindows,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return {
        content: `Bash: failed to spawn shell: ${(err as Error).message}`,
        summary: this.summarize(input),
        is_error: true,
      };
    }

    // Spawn can succeed but fail immediately with ENOENT via error event
    const stdout = makeAccumulator();
    const stderr = makeAccumulator();
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    child.stdout!.on("data", (chunk: Buffer) => {
      appendToAccumulator(stdout, stdoutDecoder.write(chunk));
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      appendToAccumulator(stderr, stderrDecoder.write(chunk));
    });

    return new Promise<ToolResult>((resolve) => {
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      function settle(result: ToolResult): void {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      }

      function doKill(): void {
        if (child.pid !== undefined) {
          killTree(child.pid);
        }
      }

      // 1. Natural exit
      child.on("close", (code) => {
        // Flush remaining bytes in StringDecoder buffer
        appendToAccumulator(stdout, stdoutDecoder.end());
        appendToAccumulator(stderr, stderrDecoder.end());
        settle({
          content: formatOutput(stdout, stderr, code ?? 1),
          summary: this.summarize(input),
        });
      });

      // Spawn error (e.g., ENOENT on shell binary)
      child.on("error", (err) => {
        settle({
          content: `Bash: spawn error: ${err.message}`,
          summary: this.summarize(input),
          is_error: true,
        });
      });

      // 2. Timeout
      killTimer = setTimeout(() => {
        doKill();
        settle({
          content: `Bash: timed out after ${timeout_ms} ms.`,
          summary: this.summarize(input),
          is_error: true,
        });
      }, timeout_ms);

      // 3. Abort signal
      const onAbort = () => {
        doKill();
        settle({
          content: "Bash: aborted by signal.",
          summary: this.summarize(input),
          is_error: true,
        });
      };

      if (ctx.signal.aborted) {
        // Check again after spawning — could have been aborted in the gap
        onAbort();
        return;
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      // Clean up abort listener when done
      child.on("close", () => {
        ctx.signal.removeEventListener("abort", onAbort);
      });
      child.on("error", () => {
        ctx.signal.removeEventListener("abort", onAbort);
      });
    });
  }
}
