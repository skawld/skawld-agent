/**
 * Provider contract.
 *
 * Providers consume a normalized request and yield a normalized stream of events
 * that the engine assembles into ContentBlocks. Providers know nothing about
 * tools running, sessions, permissions, or compaction.
 */

import type {
  Message,
  ModelId,
  StopReason,
  Usage,
} from "../core/types";
import type { ToolSchema } from "../tools/base";

/** A normalized request the engine builds for the provider on each turn. */
export interface ProviderRequest {
  model: ModelId;
  /** Already-assembled system prompt blocks (see 06-system-prompt). */
  system: SystemBlock[];
  /** Tool definitions in skawld's normalized shape. */
  tools: ToolSchema[];
  /** Full conversation so far. */
  messages: Message[];
  /** Hard cap on the response output tokens. */
  max_output_tokens: number;
  /** Optional temperature; provider chooses a sane default if omitted. */
  temperature?: number;
  /** Optional stop sequences. */
  stop_sequences?: string[];
  /** Hint to the provider whether to attempt prompt caching on this request. */
  cache_prompt?: boolean;
  /**
   * Cache entry TTL hint. Default "5m" (Anthropic's standard ephemeral cache).
   * Set to "1h" for long-idle sessions that won't refresh within 5 minutes.
   * Only consumed by providers with explicit cache control (Anthropic);
   * automatic-cache providers (OpenAI) ignore this.
   */
  cache_ttl?: "5m" | "1h";
  /** Abort signal for the whole request. */
  signal: AbortSignal;
}

export interface SystemBlock {
  type: "text";
  text: string;
  /** True if this block should sit inside a cacheable prefix. */
  cacheable?: boolean;
}

/** Streaming events the provider yields. The engine assembles these into ContentBlocks. */
export type ProviderStreamEvent =
  | { type: "message_start"; model: ModelId }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string; signature?: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; json_delta: string }
  | { type: "tool_use_end"; id: string }
  | { type: "message_end"; stop_reason: StopReason; usage: Usage };

/** The final response after stream completion, materialized by the engine. */
export interface ProviderResponse {
  message: Message; // role = "assistant"
  stop_reason: StopReason;
  usage: Usage;
}

export abstract class BaseProvider {
  /** Stable id for logs and config (e.g. "anthropic", "openai-chat"). */
  abstract readonly id: string;

  /** Maximum context window for the model, in tokens. Used by compaction. */
  abstract contextWindow(model: ModelId): number;

  /** Streaming entry point. The engine always streams. */
  abstract stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent>;
}
