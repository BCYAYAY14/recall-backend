// POST /v1/ai (PLAN-BETA-0.12 section 26, W-7): the key stays a Worker
// secret, the route refuses without it in one sentence, a read-only
// credential is refused, and a completion comes back as the model's text.

import { afterEach, describe, expect, it, vi } from "vitest";
import { E, call, ownerDevice, pairedDevice } from "./helpers.ts";

const body = {
  system: "You write flashcards.",
  user: "Topic: Cells\n<<<NOTES\n- Mitochondria make ATP.\nNOTES>>>",
  schema_name: "cards",
  schema: { type: "object", properties: { cards: { type: "array" } }, required: ["cards"] },
  max_tokens: 1000,
};

const env = E as unknown as { OPENROUTER_KEY?: string };

afterEach(() => {
  delete env.OPENROUTER_KEY;
  vi.restoreAllMocks();
});

describe("the AI route", () => {
  it("without the secret answers one sentence and sends nothing", async () => {
    const o = await ownerDevice();
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await call("POST", "/v1/ai", body, o.token);
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("ai_unconfigured");
    expect(String(r.json.message)).toContain("OPENROUTER_KEY");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a read_share credential is refused", async () => {
    const web = await pairedDevice("web", "Old browser");
    await E.META.prepare("UPDATE device SET scope = 'read_share' WHERE id = ?").bind(web.deviceId).run();
    const r = await call("POST", "/v1/ai", body, web.token);
    expect(r.status).toBe(403);
  });

  it("sends the app's request with the key server side and returns the model's text", async () => {
    env.OPENROUTER_KEY = "sk-test-not-a-real-key";
    const web = await pairedDevice("web", "Browser");
    let sent: { url: string; auth: string | null; json: Record<string, unknown> } | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      sent = { url, auth: new Headers(init?.headers).get("authorization"), json: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"cards\":[]}" }, finish_reason: "stop" }] }), { status: 200 });
    });
    const r = await call("POST", "/v1/ai", body, web.token);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ content: "{\"cards\":[]}", truncated: false, model: "google/gemini-2.5-flash" });
    expect(sent!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent!.auth).toBe("Bearer sk-test-not-a-real-key");
    expect(sent!.json).toMatchObject({ temperature: 0.2, max_tokens: 1000, reasoning: { effort: "low" } });
    expect(JSON.stringify(r.json)).not.toContain("sk-test");
  });

  it("an upstream refusal is one sentence, never the key", async () => {
    env.OPENROUTER_KEY = "sk-test-not-a-real-key";
    const o = await ownerDevice();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith("https://openrouter.ai/")) return real(input, init);
      return new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 });
    });
    const r = await call("POST", "/v1/ai", body, o.token);
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("ai_no_credits");
    expect(JSON.stringify(r.json)).not.toContain("sk-test");
  });

  it("refuses a body without its notes", async () => {
    env.OPENROUTER_KEY = "sk-test-not-a-real-key";
    const o = await ownerDevice();
    const r = await call("POST", "/v1/ai", { ...body, user: "" }, o.token);
    expect(r.status).toBe(400);
  });
});
