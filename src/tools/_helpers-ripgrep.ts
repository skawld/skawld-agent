import { spawn } from "node:child_process";
import { findExecutable } from "./_helpers";

const RG_STDOUT_MAX = 10 * 1024 * 1024; // 10 MiB hard cap

export interface RipgrepResult {
  output: string;
  /** true when rg exited with code 1 (no matches) */
  noMatches: boolean;
}

/**
 * Run `rg` with the given args. Treats exit code 1 as "no matches" (success).
 * Aborts cleanly via signal. Retries once with `-j 1` on EAGAIN.
 */
export async function runRipgrep(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<RipgrepResult> {
  const rg = findExecutable("rg");
  if (!rg) throw new Error("ripgrep (rg) not found on PATH");
  return _spawnRg(rg, args, cwd, signal, false);
}

async function _spawnRg(
  rg: string,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  isRetry: boolean,
): Promise<RipgrepResult> {
  const finalArgs = isRetry ? ["-j", "1", ...args] : args;

  return new Promise<RipgrepResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted before rg spawn"));
      return;
    }

    const child = spawn(rg, finalArgs, { cwd, signal });
    let stdout = "";
    let stderr = "";
    let overflowed = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stdout += chunk.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (stdout.length > RG_STDOUT_MAX) {
        overflowed = true;
        child.kill();
        reject(new Error(`rg stdout exceeded ${RG_STDOUT_MAX} bytes`));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EAGAIN" && !isRetry) {
        // Retry once with -j 1 (single thread) to work around resource limits
        _spawnRg(rg, args, cwd, signal, true).then(resolve, reject);
      } else {
        reject(err);
      }
    });

    child.on("close", (code: number | null) => {
      if (overflowed) return; // already rejected
      if (code === 0) {
        resolve({ output: stdout, noMatches: false });
      } else if (code === 1) {
        // rg exit 1 = no matches (not an error)
        resolve({ output: "", noMatches: true });
      } else {
        reject(new Error(`rg exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}
