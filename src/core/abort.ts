/** AbortSignal helpers. */

import { AbortError } from "./errors.js";

/** Combine multiple AbortSignals. The result fires when any input fires. */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/** Throw AbortError if the signal has fired. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AbortError("aborted", { cause: signal.reason });
  }
}
