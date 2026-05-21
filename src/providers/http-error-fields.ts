/**
 * Shared HTTP error-field extractors used by the Anthropic and OpenAI error
 * mappers. Both SDKs expose `status`/`statusCode` and a `retry-after` header in
 * the same shape, so these readers are identical across providers.
 */

export function readStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

export function readRetryAfter(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { headers?: Record<string, string> | Headers };
  const h = e.headers;
  if (!h) return undefined;
  const raw =
    typeof (h as Headers).get === "function"
      ? (h as Headers).get("retry-after")
      : (h as Record<string, string>)["retry-after"];
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
