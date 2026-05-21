/**
 * OpenAIResponsesProvider — stateless full-history mode (no previous_response_id
 * in v1). System blocks live in top-level `instructions`. Function tools live at
 * the top level (not nested under `function`). Tool calls use call_id, which we
 * normalize to `id` in ProviderStreamEvent so the engine has one identifier
 * across providers.
 */

import OpenAI from "openai";
import type {
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
import type { OpenAIChatProviderOptions } from "./openai-chat.js";
import { mapOpenAIError } from "./openai-errors.js";

export interface OpenAIResponsesProviderOptions extends OpenAIChatProviderOptions {
  /** Reasoning effort hint. */
  reasoning?: "low" | "medium" | "high";
}

const KNOWN_OPENAI_RESPONSES_CONTEXT: Record<string, number> = {
  "gpt-5": 400_000,
  "gpt-4.1": 1_000_000,
  "gpt-4o": 128_000,
  o1: 200_000,
};

const DEFAULT_CONTEXT = 128_000;

/* ----------- wire input items ----------- */

interface InputTextPart {
  type: "input_text";
  text: string;
}
interface OutputTextPart {
  type: "output_text";
  text: string;
}
interface InputImagePart {
  type: "input_image";
  image_url: string;
}

type MessageContentPart = InputTextPart | OutputTextPart | InputImagePart;

interface InputMessageItem {
  type: "message";
  role: "user" | "assistant";
  content: MessageContentPart[];
}

interface FunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface FunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

interface ReasoningItem {
  type: "reasoning";
  summary: Array<{ type: "summary_text"; text: string }>;
}

type InputItem =
  | InputMessageItem
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem;

interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: ToolSchema["input_schema"];
}

export interface ResponsesRequestPayload {
  model: ModelId;
  instructions?: string;
  input: InputItem[];
  tools?: ResponsesFunctionTool[];
  max_output_tokens: number;
  temperature?: number;
  reasoning?: { effort: "low" | "medium" | "high" };
  stream: true;
}

/* ----------- translation ----------- */

export function translateInstructions(blocks: SystemBlock[]): string {
  return blocks.map((b) => b.text).join("\n\n");
}

export function translateTools(tools: ToolSchema[]): ResponsesFunctionTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

function imageToUrl(source: ImageBlock["source"]): string {
  if (source.type === "url") return source.url;
  return `data:${source.media_type};base64,${source.data}`;
}

function toolResultToString(
  content: import("../core/types.js").ToolResultBlock["content"],
): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("\n");
}

export function translateInput(messages: Message[]): InputItem[] {
  const out: InputItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const parts: OutputTextPart[] = [];
      const calls: FunctionCallItem[] = [];
      for (const b of msg.content) {
        if (b.type === "text") parts.push({ type: "output_text", text: b.text });
        else if (b.type === "tool_use") {
          calls.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input),
          });
        } else if (b.type === "thinking" && b.signature) {
          out.push({
            type: "reasoning",
            summary: [{ type: "summary_text", text: b.thinking }],
          });
        }
      }
      if (parts.length > 0) {
        out.push({ type: "message", role: "assistant", content: parts });
      }
      for (const c of calls) out.push(c);
    } else {
      // user: tool_result blocks become function_call_output items; text/image
      // blocks become an input message.
      const inputParts: MessageContentPart[] = [];
      for (const b of msg.content) {
        if (b.type === "tool_result") {
          out.push({
            type: "function_call_output",
            call_id: b.tool_use_id,
            output: toolResultToString(b.content),
          });
        } else if (b.type === "text") {
          inputParts.push({ type: "input_text", text: b.text });
        } else if (b.type === "image") {
          inputParts.push({ type: "input_image", image_url: imageToUrl(b.source) });
        }
      }
      if (inputParts.length > 0) {
        out.push({ type: "message", role: "user", content: inputParts });
      }
    }
  }
  return out;
}

export function buildPayload(
  req: ProviderRequest,
  reasoning?: "low" | "medium" | "high",
): ResponsesRequestPayload {
  const payload: ResponsesRequestPayload = {
    model: req.model,
    input: translateInput(req.messages),
    max_output_tokens: req.max_output_tokens,
    stream: true,
  };
  const instructions = translateInstructions(req.system);
  if (instructions.length > 0) payload.instructions = instructions;
  if (req.tools.length > 0) payload.tools = translateTools(req.tools);
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (reasoning) payload.reasoning = { effort: reasoning };
  return payload;
}

/* ----------- stop reason derivation ----------- */

export function deriveStopReason(
  status: string | undefined,
  hasFunctionCall: boolean,
  incompleteReason?: string,
): StopReason {
  if (status === "completed") return hasFunctionCall ? "tool_use" : "end_turn";
  if (status === "incomplete") {
    if (incompleteReason === "max_output_tokens") return "max_tokens";
    if (incompleteReason === "content_filter") return "refusal";
    return "error";
  }
  return "error";
}

/* ----------- usage ----------- */

interface WireResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

function buildUsage(u: WireResponseUsage | undefined): Usage {
  const out: Usage = {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
  };
  const cached = u?.input_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cache_read_tokens = cached;
  return out;
}

/* ----------- wire event mapping ----------- */

export async function* mapWireEvents(
  wire: AsyncIterable<unknown>,
  model: ModelId,
): AsyncIterable<ProviderStreamEvent> {
  yield { type: "message_start", model };

  // item_id → call_id (Responses uses item_id during stream; we expose call_id as id)
  const itemToCallId = new Map<string, string>();
  let hasFunctionCall = false;
  let stopReason: StopReason = "end_turn";
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };

  for await (const raw of wire) {
    const ev = raw as { type?: string } & Record<string, unknown>;
    switch (ev.type) {
      case "response.created":
      case "response.in_progress":
        break;
      case "response.output_item.added": {
        const item = (ev as { item?: { type?: string; id?: string; call_id?: string; name?: string } }).item;
        if (item?.type === "function_call" && item.id && item.call_id && item.name) {
          itemToCallId.set(item.id, item.call_id);
          hasFunctionCall = true;
          yield { type: "tool_use_start", id: item.call_id, name: item.name };
        }
        break;
      }
      case "response.output_text.delta": {
        const e = ev as { delta?: string };
        if (e.delta) yield { type: "text_delta", text: e.delta };
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning.delta": {
        const e = ev as { delta?: string };
        if (e.delta) yield { type: "thinking_delta", text: e.delta };
        break;
      }
      case "response.function_call_arguments.delta": {
        const e = ev as { item_id?: string; delta?: string };
        if (e.item_id && e.delta !== undefined) {
          const callId = itemToCallId.get(e.item_id);
          if (callId) {
            yield {
              type: "tool_use_input_delta",
              id: callId,
              json_delta: e.delta,
            };
          }
        }
        break;
      }
      case "response.output_item.done": {
        const item = (ev as { item?: { type?: string; id?: string } }).item;
        if (item?.type === "function_call" && item.id) {
          const callId = itemToCallId.get(item.id);
          if (callId) {
            yield { type: "tool_use_end", id: callId };
            itemToCallId.delete(item.id);
          }
        }
        break;
      }
      case "response.completed": {
        const r = (ev as {
          response?: {
            status?: string;
            incomplete_details?: { reason?: string };
            usage?: WireResponseUsage;
          };
        }).response;
        stopReason = deriveStopReason(
          r?.status,
          hasFunctionCall,
          r?.incomplete_details?.reason,
        );
        usage = buildUsage(r?.usage);
        break;
      }
      case "response.failed":
      case "response.incomplete": {
        const r = (ev as {
          response?: {
            status?: string;
            incomplete_details?: { reason?: string };
            usage?: WireResponseUsage;
          };
        }).response;
        stopReason = deriveStopReason(
          r?.status ?? "incomplete",
          hasFunctionCall,
          r?.incomplete_details?.reason,
        );
        usage = buildUsage(r?.usage);
        break;
      }
      default:
        // Unknown / new event — ignore.
        break;
    }
  }

  yield { type: "message_end", stop_reason: stopReason, usage };
}

/* ----------- provider ----------- */

interface WireStream extends AsyncIterable<unknown> {
  controller?: { abort?: () => void };
}

interface OpenAIWireClient {
  responses: {
    stream(
      params: ResponsesRequestPayload,
      options?: { signal?: AbortSignal; maxRetries?: number },
    ): WireStream;
  };
}

export class OpenAIResponsesProvider extends BaseProvider {
  readonly id = "openai-responses";
  protected client: OpenAIWireClient;
  protected reasoning?: "low" | "medium" | "high";

  constructor(opts: OpenAIResponsesProviderOptions = {}) {
    super();
    // Retries are delegated to the SDK per-request (see openStream): the SDK
    // retries the initial connection at the transport layer, before the stream
    // is consumed — the only layer that can retry a streaming request safely.
    const init: ConstructorParameters<typeof OpenAI>[0] = {};
    if (opts.apiKey !== undefined) init.apiKey = opts.apiKey;
    if (opts.baseURL !== undefined) init.baseURL = opts.baseURL;
    if (opts.defaultHeaders !== undefined) init.defaultHeaders = opts.defaultHeaders;
    this.client = new OpenAI(init) as unknown as OpenAIWireClient;
    if (opts.reasoning) this.reasoning = opts.reasoning;
  }

  contextWindow(model: ModelId): number {
    return KNOWN_OPENAI_RESPONSES_CONTEXT[model] ?? DEFAULT_CONTEXT;
  }

  protected openStream(
    payload: ResponsesRequestPayload,
    signal: AbortSignal,
    maxRetries: number,
  ): WireStream {
    return this.client.responses.stream(payload, { signal, maxRetries });
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const payload = buildPayload(req, this.reasoning);
    let wire: WireStream;
    // The SDK retries the initial connection (429/5xx/network) internally,
    // honoring Retry-After; openStream returns before the request resolves, so
    // any error surfaces during iteration below. Catch here covers synchronous
    // setup failures only.
    try {
      wire = this.openStream(payload, req.signal, req.max_retries ?? 5);
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
