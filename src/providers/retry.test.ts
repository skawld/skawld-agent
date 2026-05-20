import { describe, expect, it } from "bun:test";
import {
  AbortError,
  AuthError,
  ProviderError,
  RateLimitError,
} from "../core/errors.js";
import { withRetry } from "./retry.js";

const fastOpts = {
  maxAttempts: 4,
  baseDelayMs: 1,
  maxDelayMs: 5,
  jitter: 0,
};

describe("withRetry", () => {
  it("returns on first success without retry", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      fastOpts,
      new AbortController().signal,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries retryable errors and eventually succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new ProviderError("flaky", { status: 502, retryable: true });
        }
        return calls;
      },
      fastOpts,
      new AbortController().signal,
    );
    expect(result).toBe(3);
    expect(calls).toBe(3);
  });

  it("throws after maxAttempts retryable failures", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError("nope", { status: 502, retryable: true });
        },
        fastOpts,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(fastOpts.maxAttempts);
  });

  it("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new AuthError("nope");
        },
        fastOpts,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(calls).toBe(1);
  });

  it("rethrows non-SkawldError without retry", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("boom");
        },
        fastOpts,
        new AbortController().signal,
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("honors RateLimitError.retry_after_seconds (clamped by maxDelayMs)", async () => {
    let calls = 0;
    const start = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          // 100s clamped to maxDelayMs=5ms
          throw new RateLimitError("slow", { retry_after_seconds: 100 });
        }
        return "ok";
      },
      fastOpts,
      new AbortController().signal,
    );
    const elapsed = Date.now() - start;
    expect(calls).toBe(2);
    expect(elapsed).toBeLessThan(200);
  });

  it("aborts mid-backoff via signal", async () => {
    const ctrl = new AbortController();
    const slowOpts = {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      jitter: 0,
    };
    setTimeout(() => ctrl.abort(), 10);
    await expect(
      withRetry(
        async () => {
          throw new ProviderError("flaky", { status: 502, retryable: true });
        },
        slowOpts,
        ctrl.signal,
      ),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it("throws AbortError immediately when signal already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      withRetry(async () => "never", fastOpts, ctrl.signal),
    ).rejects.toBeInstanceOf(AbortError);
  });
});
