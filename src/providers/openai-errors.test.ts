import { describe, expect, it } from "bun:test";
import {
  AbortError,
  AuthError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
} from "../core/errors.js";
import { mapOpenAIError } from "./openai-errors.js";

describe("mapOpenAIError", () => {
  it("401 → AuthError", () => {
    expect(mapOpenAIError({ status: 401, message: "no" })).toBeInstanceOf(
      AuthError,
    );
  });

  it("429 with retry-after header → RateLimitError", () => {
    const e = mapOpenAIError({
      status: 429,
      message: "slow down",
      headers: { "retry-after": "8" },
    });
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).retry_after_seconds).toBe(8);
  });

  it("400 with context_length_exceeded → ContextLengthError", () => {
    expect(
      mapOpenAIError({
        status: 400,
        error: { message: "context_length_exceeded blah" },
      }),
    ).toBeInstanceOf(ContextLengthError);
  });

  it("400 other → non-retryable ProviderError", () => {
    const e = mapOpenAIError({ status: 400, message: "bad request" });
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).retryable).toBe(false);
  });

  it("503 → retryable ProviderError", () => {
    const e = mapOpenAIError({ status: 503, message: "down" });
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).retryable).toBe(true);
  });

  it("AbortError name preserved", () => {
    const raw = new Error("aborted");
    raw.name = "AbortError";
    expect(mapOpenAIError(raw)).toBeInstanceOf(AbortError);
  });

  it("no status → retryable provider error (network class)", () => {
    const e = mapOpenAIError({ message: "ECONNRESET" });
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).retryable).toBe(true);
  });

  it("reads message from nested error.message field", () => {
    const e = mapOpenAIError({
      status: 400,
      error: { message: "maximum context length is 8192" },
    });
    expect(e).toBeInstanceOf(ContextLengthError);
    expect(e.message).toContain("maximum context length");
  });
});
