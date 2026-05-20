import { describe, expect, it } from "bun:test";
import type { Message } from "../core/types.js";
import type { ProviderRequest, ProviderStreamEvent } from "./base.js";
import {
  type ResponsesRequestPayload,
  buildPayload,
  deriveStopReason,
  mapWireEvents,
  OpenAIResponsesProvider,
  translateInput,
  translateTools,
} from "./openai-responses.js";

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "gpt-5",
    system: [],
    tools: [],
    messages: [],
    max_output_tokens: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(
  iter: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

describe("translateTools", () => {
  it("emits function tools at top level (no nested function envelope)", () => {
    const out = translateTools([
      {
        name: "Bash",
        description: "Run",
        input_schema: { type: "object", properties: {} },
      },
    ]);
    expect(out).toEqual([
      {
        type: "function",
        name: "Bash",
        description: "Run",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });
});

describe("translateInput", () => {
  it("user text → input_text in input message; tool_result → function_call_output", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "out" },
          { type: "text", text: "and then?" },
        ],
      },
    ];
    expect(translateInput(msgs)).toEqual([
      { type: "function_call_output", call_id: "c1", output: "out" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "and then?" }],
      },
    ]);
  });

  it("assistant text + tool_use replay → output_text message + function_call item", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_use", id: "c1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
    ];
    expect(translateInput(msgs)).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "calling" }],
      },
      {
        type: "function_call",
        call_id: "c1",
        name: "Bash",
        arguments: '{"cmd":"ls"}',
      },
    ]);
  });

  it("thinking with signature → reasoning item; without signature → dropped", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "with sig", signature: "s" },
          { type: "thinking", thinking: "no sig" },
        ],
      },
    ];
    const out = translateInput(msgs);
    expect(out.some((i) => i.type === "reasoning")).toBe(true);
    expect(out.filter((i) => i.type === "reasoning").length).toBe(1);
  });

  it("converts base64 image to data URL via input_image", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA" },
          },
        ],
      },
    ];
    expect(translateInput(msgs)).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAA" },
        ],
      },
    ]);
  });
});

describe("buildPayload", () => {
  it("uses top-level instructions; never sends previous_response_id", () => {
    const payload: ResponsesRequestPayload = buildPayload(
      req({ system: [{ type: "text", text: "be terse" }] }),
    );
    expect(payload.instructions).toBe("be terse");
    expect(
      (payload as unknown as Record<string, unknown>).previous_response_id,
    ).toBeUndefined();
  });

  it("attaches reasoning when provided", () => {
    const payload = buildPayload(req(), "medium");
    expect(payload.reasoning).toEqual({ effort: "medium" });
  });

  it("stream: true always set", () => {
    expect(buildPayload(req()).stream).toBe(true);
  });
});

describe("deriveStopReason", () => {
  it.each([
    ["completed", false, undefined, "end_turn"],
    ["completed", true, undefined, "tool_use"],
    ["incomplete", false, "max_output_tokens", "max_tokens"],
    ["incomplete", false, "content_filter", "refusal"],
    ["incomplete", false, "other", "error"],
    ["weird", false, undefined, "error"],
  ])(
    "status=%p hasFn=%p reason=%p → %p",
    (status, hasFn, reason, expected) => {
      expect(
        deriveStopReason(
          status as string,
          hasFn as boolean,
          reason as string | undefined,
        ),
      ).toBe(expected as ReturnType<typeof deriveStopReason>);
    },
  );
});

describe("mapWireEvents", () => {
  it("maps text deltas, function call bracket, completed with usage", async () => {
    const events: unknown[] = [
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hi " },
      { type: "response.output_text.delta", delta: "there" },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "item_1", call_id: "call_1", name: "Bash" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item_1",
        delta: '{"cmd":"ls"}',
      },
      {
        type: "response.output_item.done",
        item: { type: "function_call", id: "item_1" },
      },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 100,
            output_tokens: 30,
            input_tokens_details: { cached_tokens: 60 },
          },
        },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "gpt-5"));
    expect(out).toEqual([
      { type: "message_start", model: "gpt-5" },
      { type: "text_delta", text: "Hi " },
      { type: "text_delta", text: "there" },
      { type: "tool_use_start", id: "call_1", name: "Bash" },
      { type: "tool_use_input_delta", id: "call_1", json_delta: '{"cmd":"ls"}' },
      { type: "tool_use_end", id: "call_1" },
      {
        type: "message_end",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 30, cache_read_tokens: 60 },
      },
    ]);
  });

  it("maps reasoning_summary_text.delta → thinking_delta", async () => {
    const events: unknown[] = [
      { type: "response.reasoning_summary_text.delta", delta: "hmm" },
      {
        type: "response.completed",
        response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    expect(out).toContainEqual({ type: "thinking_delta", text: "hmm" });
  });

  it("incomplete with max_output_tokens → max_tokens", async () => {
    const events: unknown[] = [
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      },
    ];
    const out = await collect(mapWireEvents(fromArray(events), "m"));
    const end = out.find((e) => e.type === "message_end");
    expect(end?.type).toBe("message_end");
    if (end?.type === "message_end") expect(end.stop_reason).toBe("max_tokens");
  });
});

describe("OpenAIResponsesProvider", () => {
  it("contextWindow returns known model value, falls back to 128_000", () => {
    const p = new OpenAIResponsesProvider({ apiKey: "x" });
    expect(p.contextWindow("gpt-5")).toBe(400_000);
    expect(p.contextWindow("unknown")).toBe(128_000);
  });

  it("stream() yields normalized events from openStream", async () => {
    class FakeProvider extends OpenAIResponsesProvider {
      lastPayload?: ResponsesRequestPayload;
      override openStream(payload: ResponsesRequestPayload) {
        this.lastPayload = payload;
        const events: unknown[] = [
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ];
        return Object.assign(fromArray(events), { controller: undefined });
      }
    }
    const p = new FakeProvider({ apiKey: "x", reasoning: "low" });
    const events = await collect(p.stream(req({ model: "m" })));
    expect(p.lastPayload?.reasoning).toEqual({ effort: "low" });
    expect(events[0]).toEqual({ type: "message_start", model: "m" });
    expect(events.at(-1)).toMatchObject({
      type: "message_end",
      stop_reason: "end_turn",
    });
  });
});
