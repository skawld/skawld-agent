/**
 * OpenAIChatCompletionsProvider — also serves as the base for OpenAI-compatible
 * endpoints (Ollama, vLLM, Groq, DeepSeek) via baseURL + contextWindowOverride.
 *
 * Translation is the heavy lift: ContentBlocks from one assistant turn fan into
 * separate wire messages, tool_use blocks coalesce under one assistant message's
 * tool_calls, and tool_result blocks become role:"tool" messages.
 */

import OpenAI from "openai";
import type {
  ContentBlock,
  ImageBlock,
  Message,
  ModelId,
  StopReason,
  Usage,
} from "../core/types.js";
import type { ToolSchema } from "../tools/base.js";
import {
  BaseProvider,
  type ProviderRequest,
  type ProviderStreamEvent,
  type SystemBlock,
} from "./base.js";
import { mapOpenAIError } from "./openai-errors.js";
import { withRetry } from "./retry.js";

export interface OpenAIChatProviderOptions {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  maxRetries?: number;
  /** Override context window lookup, for compatible endpoints. */
  contextWindowOverride?: (model: ModelId) => number | undefined;
}

const KNOWN_OPENAI_CONTEXT: Record<string, number> = {
  "gpt-5": 400_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  o1: 200_000,
};

const DEFAULT_CONTEXT = 128_000;

/* ------- wire shapes (kept local to avoid SDK type churn in tests) ------- */

interface ChatFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolSchema["input_schema"];
  };
}

interface SystemMessage {
  role: "system";
  content: string;
}

interface UserContentPartText {
  type: "text";
  text: string;
}
interface UserContentPartImage {
  type: "image_url";
  image_url: { url: string };
}
type UserContentPart = UserContentPartText | UserContentPartImage;

interface UserMessage {
  role: "user";
  content: string | UserContentPart[];
}

interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: AssistantToolCall[];
}

interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ChatRequestPayload {
  model: ModelId;
  messages: ChatMessage[];
  tools?: ChatFunctionTool[];
  max_tokens: number;
  temperature?: number;
  stop?: string[];
  stream: true;
  stream_options: { include_usage: true };
}

/* ----------- translation ----------- */

export function translateSystem(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

export function translateTools(tools: ToolSchema[]): ChatFunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function imageToUrl(source: ImageBlock["source"]): string {
  if (source.kind === "url") return source.url;
  return `data:${source.media_type};base64,${source.data}`;
}

function toolResultContentToString(
  content: import("../core/types.js").ToolResultBlock["content"],
): string {
  if (typeof content === "string") return content;
  // OpenAI Chat tool messages only accept string content. Flatten text parts;
  // drop images (Chat Completions tool messages don't support images).
  return content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("\n");
}

function translateUserBlocks(blocks: ContentBlock[]): UserContentPart[] {
  const parts: UserContentPart[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "image")
      parts.push({ type: "image_url", image_url: { url: imageToUrl(b.source) } });
  }
  return parts;
}

export function translateMessages(messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: AssistantToolCall[] = [];
      for (const b of msg.content) {
        if (b.type === "text") textParts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          });
        }
        // thinking dropped: not accepted on input
      }
      const assistant: AssistantMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      out.push(assistant);
    } else {
      // user: tool_result blocks fan out into role:"tool" messages, then a single
      // user message for any text/image blocks remaining.
      const nonResult: ContentBlock[] = [];
      for (const b of msg.content) {
        if (b.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: toolResultContentToString(b.content),
          });
        } else {
          nonResult.push(b);
        }
      }
      if (nonResult.length > 0) {
        const parts = translateUserBlocks(nonResult);
        out.push({
          role: "user",
          content:
            parts.length === 1 && parts[0]?.type === "text"
              ? parts[0].text
              : parts,
        });
      }
    }
  }
  return out;
}

export function buildPayload(req: ProviderRequest): ChatRequestPayload {
  const messages: ChatMessage[] = [];
  if (req.system.length > 0) {
    messages.push({ role: "system", content: translateSystem(req.system) });
  }
  messages.push(...translateMessages(req.messages));
  const payload: ChatRequestPayload = {
    model: req.model,
    messages,
    max_tokens: req.max_output_tokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.tools.length > 0) payload.tools = translateTools(req.tools);
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (req.stop_sequences !== undefined) payload.stop = req.stop_sequences;
  return payload;
}

export function mapStopReason(wire: string | null | undefined): StopReason {
  switch (wire) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "error";
  }
}

/* ----------- stream event mapping ----------- */

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ToolCallSlot {
  id: string;
  name: string;
  emittedStart: boolean;
}

function buildUsage(u: WireUsage | undefined): Usage {
  const out: Usage = {
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
  };
  const cached = u?.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cache_read_tokens = cached;
  return out;
}

export async function* mapWireEvents(
  wire: AsyncIterable<unknown>,
  model: ModelId,
): AsyncIterable<ProviderStreamEvent> {
  yield { type: "message_start", model };

  const slots = new Map<number, ToolCallSlot>();
  let stopReason: StopReason = "end_turn";
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };

  for await (const raw of wire) {
    const chunk = raw as {
      choices?: Array<{
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string | null;
      }>;
      usage?: WireUsage;
    };

    if (chunk.usage) usage = buildUsage(chunk.usage);

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { type: "text_delta", text: delta.content };
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let slot = slots.get(tc.index);
          if (!slot) {
            // Buffer until we have id+name to emit start.
            if (tc.id && tc.function?.name) {
              slot = { id: tc.id, name: tc.function.name, emittedStart: true };
              slots.set(tc.index, slot);
              yield { type: "tool_use_start", id: slot.id, name: slot.name };
              if (tc.function.arguments) {
                yield {
                  type: "tool_use_input_delta",
                  id: slot.id,
                  json_delta: tc.function.arguments,
                };
              }
            } else {
              // hold partial info until id+name arrive
              slot = {
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
                emittedStart: false,
              };
              slots.set(tc.index, slot);
            }
            continue;
          }
          // Existing slot: maybe finally got id/name to emit start.
          if (!slot.emittedStart) {
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (slot.id && slot.name) {
              slot.emittedStart = true;
              yield { type: "tool_use_start", id: slot.id, name: slot.name };
            }
          }
          if (slot.emittedStart && tc.function?.arguments) {
            yield {
              type: "tool_use_input_delta",
              id: slot.id,
              json_delta: tc.function.arguments,
            };
          }
        }
      }
    }

    if (choice.finish_reason) {
      stopReason = mapStopReason(choice.finish_reason);
      const indices = [...slots.keys()].sort((a, b) => a - b);
      for (const i of indices) {
        const s = slots.get(i);
        if (s?.emittedStart) yield { type: "tool_use_end", id: s.id };
      }
    }
  }

  yield { type: "message_end", stop_reason: stopReason, usage };
}

/* ----------- provider ----------- */

interface WireStream extends AsyncIterable<unknown> {
  controller?: { abort?: () => void };
}

interface OpenAIWireClient {
  chat: {
    completions: {
      stream(
        params: ChatRequestPayload,
        options?: { signal?: AbortSignal },
      ): WireStream;
    };
  };
}

export class OpenAIChatCompletionsProvider extends BaseProvider {
  readonly id = "openai-chat";
  protected client: OpenAIWireClient;
  protected contextWindowOverride?: (model: ModelId) => number | undefined;

  constructor(opts: OpenAIChatProviderOptions = {}) {
    super();
    const init: ConstructorParameters<typeof OpenAI>[0] = {
      maxRetries: 0,
    };
    if (opts.apiKey !== undefined) init.apiKey = opts.apiKey;
    if (opts.baseURL !== undefined) init.baseURL = opts.baseURL;
    if (opts.defaultHeaders !== undefined) init.defaultHeaders = opts.defaultHeaders;
    this.client = new OpenAI(init) as unknown as OpenAIWireClient;
    if (opts.contextWindowOverride) {
      this.contextWindowOverride = opts.contextWindowOverride;
    }
  }

  contextWindow(model: ModelId): number {
    return (
      this.contextWindowOverride?.(model) ??
      KNOWN_OPENAI_CONTEXT[model] ??
      DEFAULT_CONTEXT
    );
  }

  protected openStream(
    payload: ChatRequestPayload,
    signal: AbortSignal,
  ): WireStream {
    return this.client.chat.completions.stream(payload, { signal });
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const payload = buildPayload(req);
    let wire: WireStream;
    try {
      wire = await withRetry(
        async () => this.openStream(payload, req.signal),
        {},
        req.signal,
      );
    } catch (err) {
      throw mapOpenAIError(err);
    }

    try {
      yield* mapWireEvents(wire, req.model);
    } catch (err) {
      throw mapOpenAIError(err);
    } finally {
      wire.controller?.abort?.();
    }
  }
}
