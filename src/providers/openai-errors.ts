/**
 * Shared OpenAI error mapper. Used by both Chat Completions and Responses providers.
 */

import {
  AbortError,
  AuthError,
  ContextLengthError,
  ProviderError,
  RateLimitError,
  SkawldError,
} from "../core/errors.js";
import { readRetryAfter, readStatus } from "./http-error-fields.js";

export function mapOpenAIError(err: unknown): SkawldError {
  if (err instanceof SkawldError) return err;
  if (err instanceof Error && err.name === "AbortError") {
    return new AbortError(err.message, { cause: err });
  }
  const status = readStatus(err);
  const message = readMessage(err);
  if (status === 401 || status === 403) {
    return new AuthError(message, { cause: err });
  }
  if (status === 429) {
    return new RateLimitError(message, {
      retry_after_seconds: readRetryAfter(err),
      cause: err,
    });
  }
  if (status === 400) {
    if (
      /context_length_exceeded|maximum context|too long|max_tokens|reduce the length/i.test(
        message,
      )
    ) {
      return new ContextLengthError(message, { cause: err });
    }
    return new ProviderError(message, {
      status,
      retryable: false,
      cause: err,
    });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError(message, { status, retryable: true, cause: err });
  }
  return new ProviderError(message, {
    status,
    retryable: status === undefined,
    cause: err,
  });
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; error?: { message?: unknown } };
    if (typeof e.message === "string") return e.message;
    if (typeof e.error?.message === "string") return e.error.message;
  }
  return String(err);
}
