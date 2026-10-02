// The AI route's pure half: the request is `OpenRouterClient.body` and the
// reply reading is `OpenRouterClient.content` / `wasTruncated`.

import { describe, expect, it } from "vitest";
import { openRouterBody, readAiRequest, readCompletion, upstreamFailure } from "../../src/ai.ts";

const base = { system: "s", user: "u", schema_name: "quiz", schema: { type: "object" }, max_tokens: 99_999 };

describe("the OpenRouter request", () => {
  it("caps the answer, defaults the model and asks for strict JSON", () => {
    const r = readAiRequest(base);
    expect(r.maxTokens).toBe(16_000);
    expect(r.model).toBe("google/gemini-2.5-flash");
    const b = openRouterBody(r);
    expect(b.response_format).toEqual({ type: "json_schema", json_schema: { name: "quiz", strict: true, schema: { type: "object" } } });
    expect(b.reasoning).toEqual({ effort: "low" });
  });

  it("puts the schema in words for a model without structured output", () => {
    const b = openRouterBody(readAiRequest({ ...base, structured: false }));
    expect(b.response_format).toBeUndefined();
    const messages = b.messages as { content: string }[];
    expect(messages[1]!.content).toContain("Reply with only a JSON object matching this JSON schema:");
  });

  it("refuses a model name that is not one", () => {
    expect(() => readAiRequest({ ...base, model: "https://evil.example/x" })).toThrow();
  });

  it("reads text parts and a length stop", () => {
    expect(readCompletion({ choices: [{ message: { content: [{ text: "{\"a\"" }, { text: ":1}" }] }, finish_reason: "length" }] }))
      .toEqual({ content: "{\"a\":1}", truncated: true });
    expect(readCompletion({})).toBeNull();
  });

  it("says each upstream failure in one sentence", () => {
    expect(upstreamFailure(401, null).code).toBe("ai_unauthorized");
    expect(upstreamFailure(429, null).code).toBe("ai_busy");
    expect(upstreamFailure(500, "boom").message).toBe("OpenRouter: boom");
  });
});
