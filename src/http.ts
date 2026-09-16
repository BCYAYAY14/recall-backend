// Responses, errors and the request log. No response here ever carries a
// CORS header: the web app is served from the same origin (plan 10.3).

export class HttpFailure extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...headers } });
}

export function failure(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, message, ...extra }, status);
}

export async function readJson(request: Request, maxBytes = 1_048_576): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpFailure(413, "too_large", `A request body is at most ${maxBytes} bytes.`);
  const text = await readText(request, maxBytes);
  if (!text) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new HttpFailure(400, "bad_json", "The body is not JSON."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpFailure(400, "bad_json", "The body is not a JSON object.");
  return parsed as Record<string, unknown>;
}

export async function readText(request: Request, maxBytes = 1_048_576): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new HttpFailure(413, "too_large", `A request body is at most ${maxBytes} bytes.`); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** One structured line per request. Route PATTERNS only, a six-character device prefix, never a token or a body. */
export function logLine(fields: { route: string; status: number; ms: number; device?: string; outcome?: string }): void {
  console.log(JSON.stringify({
    route: fields.route, status: fields.status, ms: fields.ms,
    ...(fields.device ? { device: fields.device.slice(0, 6) } : {}),
    ...(fields.outcome ? { outcome: fields.outcome } : {}),
  }));
}

export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256HexOf(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality over sha256 of both sides, so length leaks nothing either. */
export async function secretEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(x, y);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i]! ^ v[i]!;
  return diff === 0;
}
