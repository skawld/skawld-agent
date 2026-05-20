import { describe, expect, it } from "bun:test";
import { BaseProvider, type ProviderStreamEvent } from "./base.js";

function describeEvent(ev: ProviderStreamEvent): string {
  switch (ev.type) {
    case "message_start":
      return `start:${ev.model}`;
    case "text_delta":
      return `text:${ev.text}`;
    case "thinking_delta":
      return `think:${ev.text}`;
    case "tool_use_start":
      return `tu_start:${ev.id}:${ev.name}`;
    case "tool_use_input_delta":
      return `tu_delta:${ev.id}:${ev.json_delta}`;
    case "tool_use_end":
      return `tu_end:${ev.id}`;
    case "message_end":
      return `end:${ev.stop_reason}`;
    default: {
      const _exhaustive: never = ev;
      return _exhaustive;
    }
  }
}

describe("ProviderStreamEvent union", () => {
  it("is exhaustive (compile-time check via never)", () => {
    expect(describeEvent({ type: "message_start", model: "x" })).toBe("start:x");
    expect(describeEvent({ type: "text_delta", text: "hi" })).toBe("text:hi");
    expect(describeEvent({ type: "thinking_delta", text: "t" })).toBe("think:t");
    expect(
      describeEvent({ type: "tool_use_start", id: "1", name: "Bash" }),
    ).toBe("tu_start:1:Bash");
    expect(
      describeEvent({ type: "tool_use_input_delta", id: "1", json_delta: "{" }),
    ).toBe("tu_delta:1:{");
    expect(describeEvent({ type: "tool_use_end", id: "1" })).toBe("tu_end:1");
    expect(
      describeEvent({
        type: "message_end",
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ).toBe("end:end_turn");
  });
});

describe("BaseProvider", () => {
  it("is abstract and subclassable", () => {
    class Stub extends BaseProvider {
      readonly id = "stub";
      contextWindow(_model: string): number {
        return 1000;
      }
      async *stream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: "message_start", model: "x" };
      }
    }
    const s = new Stub();
    expect(s.id).toBe("stub");
    expect(s.contextWindow("x")).toBe(1000);
  });
});
