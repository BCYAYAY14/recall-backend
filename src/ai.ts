// Make Cards and the quiz for a paired browser (PLAN-BETA-0.12 section 26,
// W-7). The browser writes the prompt from the doc (the app's own words,
// AIPrompts in Recall's AIWriting.swift, restated in assets/js/ai.js) and this
// route sends it to OpenRouter with the owner's key, which is a Worker SECRET
// (`OPENROUTER_KEY`) and never reaches the browser, a URL, a log line or a
// sync lane. Without the secret the route answers one sentence and the web
// falls back to a quiz built from the doc's own cards.
//
// The request shape is `OpenRouterClient.body` exactly: temperature 0.2, the
// answer bounded by `max_tokens`, a strict JSON schema, low reasoning effort,
// and the schema in words for a model that refuses structured output. The
// Worker holds no state and keeps zero runtime dependencies: one fetch.

import type { Caller } from "./auth.ts";
import type { Env } from "./env.ts";
import { HttpFailure } from "./http.ts";

export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** The owner's default (2026-09-14), as the app's Settings > AI has it. */
export const DEFAULT_MODEL = "google/gemini-2.5-flash";
/** `AIPrompts.maxOutputTokens`: no single answer is worth more. */
export const MAX_OUTPUT_TOKENS = 16_000;
/** `AIPrompts.cardsPieces`' limit: a whole doc is one request. */
export const MAX_PROMPT_CHARS = 220_000;
const MODEL_RE = /^[a-z0-9][a-z0-9._\-]*\/[a-zA-Z0-9._:\-]+$/;

export interface AiRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  structured: boolean;
  maxTokens: number;
  model: string;
}

/** The browser's body, validated. Every refusal is one sentence. */
export function readAiRequest(body: Record<string, unknown>): AiRequest {
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
  const system = str("system");
  const user = str("user");
  const schemaName = str("schema_name");
  if (!system || !user) throw new HttpFailure(400, "bad_prompt", "A request needs its instructions and its notes.");
  if (system.length + user.length > MAX_PROMPT_CHARS) throw new HttpFailure(413, "too_large", "That doc is too long for one request.");
  if (!/^[a-z_]{1,40}$/.test(schemaName)) throw new HttpFailure(400, "bad_schema", "schema_name names the answer's shape.");
  const schema = body.schema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) throw new HttpFailure(400, "bad_schema", "schema is a JSON schema object.");
  const maxTokens = Number(body.max_tokens);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new HttpFailure(400, "bad_tokens", "max_tokens is a positive whole number.");
  const model = str("model").trim() || DEFAULT_MODEL;
  if (!MODEL_RE.test(model) || model.length > 120) throw new HttpFailure(400, "bad_model", "That is not an OpenRouter model name.");
  return { system, user, schemaName, schema: schema as Record<string, unknown>, structured: body.structured !== false,
           maxTokens: Math.min(MAX_OUTPUT_TOKENS, maxTokens), model };
}

/** `OpenRouterClient.body`, restated. */
export function openRouterBody(r: AiRequest): Record<string, unknown> {
  let content = r.user;
  if (!r.structured) content += "\n\nReply with only a JSON object matching this JSON schema:\n" + JSON.stringify(r.schema);
  const out: Record<string, unknown> = {
    model: r.model,
    temperature: 0.2,
    max_tokens: Math.max(1, r.maxTokens),
    messages: [{ role: "system", content: r.system }, { role: "user", content }],
  };
  if (r.structured) {
    out.response_format = { type: "json_schema", json_schema: { name: r.schemaName, strict: true, schema: r.schema } };
    out.reasoning = { effort: "low" };
  }
  return out;
}

/** `choices[0].message.content` and whether the cap cut it off. */
export function readCompletion(data: unknown): { content: string; truncated: boolean } | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown; native_finish_reason?: unknown };
  const c = first.message?.content;
  let content: string | null = null;
  if (typeof c === "string") content = c;
  else if (Array.isArray(c)) content = c.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  if (content === null) return null;
  const reason = typeof first.finish_reason === "string" ? first.finish_reason : typeof first.native_finish_reason === "string" ? first.native_finish_reason : "";
  return { content, truncated: reason === "length" };
}

/** `OpenRouterClient.Failure.sentence`, one per upstream status. */
export function upstreamFailure(status: number, message: string | null): HttpFailure {
  switch (status) {
    case 401: case 403: return new HttpFailure(502, "ai_unauthorized", "OpenRouter refused the backend's key. Check the OPENROUTER_KEY secret.");
    case 402: return new HttpFailure(502, "ai_no_credits", "The OpenRouter account has no credits left.");
    case 429: return new HttpFailure(503, "ai_busy", "OpenRouter is busy. Try again in a minute.");
    default: return new HttpFailure(502, "ai_refused", "OpenRouter: " + (message ?? `HTTP ${status}`).slice(0, 160));
  }
}

export async function aiComplete(env: Env, caller: Caller, body: Record<string, unknown>): Promise<{ content: string; truncated: boolean; model: string }> {
  if (caller.scope !== "full") throw new HttpFailure(403, "scope", "This device may read but not change the library.");
  const key = (env.OPENROUTER_KEY ?? "").trim();
  if (!key) throw new HttpFailure(503, "ai_unconfigured", "This backend has no OpenRouter key, so Make Cards and the quiz's written questions are off. Set the OPENROUTER_KEY secret to turn them on.");
  const request = readAiRequest(body);
  const endpoint = env.OPENROUTER_ENDPOINT || OPENROUTER_ENDPOINT;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Recall" },
      body: JSON.stringify(openRouterBody(request)),
    });
  } catch {
    throw new HttpFailure(502, "ai_unreachable", "OpenRouter could not be reached. Try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { data = null; }
  const serverMessage = data && typeof data === "object" && (data as { error?: { message?: unknown } }).error
    ? String((data as { error: { message?: unknown } }).error.message ?? "OpenRouter refused the request") : null;
  if (!res.ok) throw upstreamFailure(res.status, serverMessage);
  if (serverMessage) throw upstreamFailure(500, serverMessage);
  const reply = readCompletion(data);
  if (!reply) throw new HttpFailure(502, "ai_unreadable", "The model's answer could not be read.");
  return { ...reply, model: request.model };
}
