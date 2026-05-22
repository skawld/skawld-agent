import { describe, expect, it } from "bun:test";
import { addUsage, type Message, type Usage } from "./types.js";

describe("addUsage", () => {
  it("sums all fields including optionals defaulting to 0", () => {
    const a: Usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 };
    const b: Usage = { input_tokens: 3, output_tokens: 1, cache_creation_tokens: 4 };
    expect(addUsage(a, b)).toEqual({
      input_tokens: 13,
      output_tokens: 6,
      cache_read_tokens: 2,
      cache_creation_tokens: 4,
    });
  });

  it("returns zeros when both inputs are zero", () => {
    const z: Usage = { input_tokens: 0, output_tokens: 0 };
    expect(addUsage(z, z)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });
});

describe("Message shape", () => {
  it("accepts a discriminated content block union", () => {
    const m: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "abc", name: "Read", input: { path: "/x" } },
        { type: "thinking", thinking: "reasoning..." },
      ],
    };
    expect(m.content).toHaveLength(3);
  });

  it("accepts optional provider metadata for provider-specific replay state", () => {
    const m: Message = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      provider_metadata: {
        openai_responses: {
          response_id: "resp_1",
          output_items: [{ type: "reasoning", id: "rs_1" }],
        },
      },
    };
    expect(m.provider_metadata?.openai_responses?.response_id).toBe("resp_1");
  });
});
