/**
 * Retry a single request attempt that may throw a retryable SkawldError.
 *
 * Honors RateLimitError.retry_after_seconds when present, otherwise exponential
 * backoff with jitter. Aborts immediately on signal.
 */

import { AbortError, RateLimitError, SkawldError } from "../core/errors.js";

export interface RetryOptions {
  /** Maximum total attempts (including the first). Default 5. */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff. Default 1000. */
  baseDelayMs?: number;
  /** Maximum delay between attempts in milliseconds. Default 30000. */
  maxDelayMs?: number;
  /** Jitter fraction applied to backoff (0..1). Default 0.2. */
  jitter?: number;
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
}

function resolveOptions(opts: RetryOptions): ResolvedRetryOptions {
  return {
    maxAttempts: opts.maxAttempts ?? 5,
    baseDelayMs: opts.baseDelayMs ?? 1000,
    maxDelayMs: opts.maxDelayMs ?? 30000,
    jitter: opts.jitter ?? 0.2,
  };
}

function isRetryable(err: unknown): boolean {
  return err instanceof SkawldError && err.retryable;
}

function computeDelay(
  err: unknown,
  attempt: number,
  opts: ResolvedRetryOptions,
): number {
  if (err instanceof RateLimitError && err.retry_after_seconds !== undefined) {
    return Math.min(err.retry_after_seconds * 1000, opts.maxDelayMs);
  }
  const exp = opts.baseDelayMs * 2 ** attempt;
  const capped = Math.min(exp, opts.maxDelayMs);
  const jitterMs = capped * opts.jitter * (Math.random() * 2 - 1);
  return Math.max(0, capped + jitterMs);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError("aborted before sleep"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new AbortError("aborted during backoff"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `fn` up to `maxAttempts` times. Retries only when the thrown error
 * extends SkawldError with `retryable: true`. Honors AbortSignal.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
  signal: AbortSignal,
): Promise<T> {
  const resolved = resolveOptions(opts);
  let lastErr: unknown;
  for (let attempt = 0; attempt < resolved.maxAttempts; attempt++) {
    if (signal.aborted) throw new AbortError("aborted");
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (err instanceof AbortError) throw err;
      if (!isRetryable(err)) throw err;
      if (attempt === resolved.maxAttempts - 1) break;
      const delay = computeDelay(err, attempt, resolved);
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}
