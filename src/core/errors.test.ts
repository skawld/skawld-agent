import { describe, expect, it } from "bun:test";
import {
  AbortError,
  AuthError,
  ConfigError,
  ContextLengthError,
  PermissionDeniedError,
  ProviderError,
  RateLimitError,
  SkawldError,
  ToolExecutionError,
} from "./errors.js";

describe("SkawldError hierarchy", () => {
  it("AuthError sets name and kind, not retryable", () => {
    const e = new AuthError("nope");
    expect(e).toBeInstanceOf(SkawldError);
    expect(e.name).toBe("AuthError");
    expect(e.kind).toBe("auth");
    expect(e.retryable).toBe(false);
    expect(e.message).toBe("nope");
  });

  it("RateLimitError is retryable and carries retry_after_seconds", () => {
    const e = new RateLimitError("slow", { retry_after_seconds: 5 });
    expect(e.name).toBe("RateLimitError");
    expect(e.kind).toBe("rate_limit");
    expect(e.retryable).toBe(true);
    expect(e.retry_after_seconds).toBe(5);
  });

  it("ContextLengthError is not retryable", () => {
    const e = new ContextLengthError("too long");
    expect(e.kind).toBe("context_length");
    expect(e.retryable).toBe(false);
  });

  it("PermissionDeniedError carries tool_name and reason", () => {
    const e = new PermissionDeniedError("denied", { tool_name: "Bash", reason: "blocked" });
    expect(e.name).toBe("PermissionDeniedError");
    expect(e.kind).toBe("permission_denied");
    expect(e.tool_name).toBe("Bash");
    expect(e.reason).toBe("blocked");
  });

  it("ToolExecutionError carries tool_name", () => {
    const e = new ToolExecutionError("boom", { tool_name: "Read" });
    expect(e.kind).toBe("tool_execution");
    expect(e.tool_name).toBe("Read");
  });

  it("AbortError sets kind=abort", () => {
    const e = new AbortError("aborted");
    expect(e.kind).toBe("abort");
    expect(e.retryable).toBe(false);
  });

  it("ProviderError honors status and retryable flag", () => {
    const e = new ProviderError("502", { status: 502, retryable: true });
    expect(e.name).toBe("ProviderError");
    expect(e.kind).toBe("provider");
    expect(e.status).toBe(502);
    expect(e.retryable).toBe(true);
  });

  it("ConfigError sets kind=config", () => {
    const e = new ConfigError("bad config");
    expect(e.kind).toBe("config");
    expect(e.retryable).toBe(false);
  });

  it("preserves cause via Error options", () => {
    const cause = new Error("root");
    const e = new AuthError("wrap", { cause });
    expect(e.cause).toBe(cause);
  });
});
