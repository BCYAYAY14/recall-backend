// Attachments through the Worker only (plan 9 and 36). Content addressed by
// sha256 under <library>/blob/<sha>. R2 verifies a single PUT's sha256 itself,
// so the Worker hashes nothing (finding F-20). Every R2 operation is decided
// and charged by BudgetDO first; a trip is cached at the edge for 10 seconds
// so a storm costs no Durable Object requests (plan 36.5c).

import type { Caller } from "./auth.ts";
import { requireFull } from "./auth.ts";
import type { BudgetAnswer, BudgetRequest } from "./budget-do.ts";
import type { Env } from "./env.ts";
import { HttpFailure, json, nowIso, readJson } from "./http.ts";
import { liveShare, validSha } from "./shares.ts";

export const SINGLE_PUT_MAX = 5 * 1024 * 1024;
export const PART_SIZE = 5 * 1024 * 1024;
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

function tripKey(library: string, cls: "a" | "b"): Request {
  return new Request(`https://budget.recall.invalid/${library}/${cls}`);
}

export async function writeTripCache(library: string, answer: Extract<BudgetAnswer, { ok: false }>, classes: ("a" | "b")[]): Promise<void> {
  const until = answer.resets_at ? Date.parse(answer.resets_at) : Date.now() + 10_000;
  const seconds = Math.max(1, Math.min(10, Math.ceil((until - Date.now()) / 1000)));
  for (const c of classes) {
    await caches.default.put(tripKey(library, c), new Response(JSON.stringify(answer), { headers: { "cache-control": `max-age=${seconds}` } }));
  }
}

export async function clearTripCache(library: string): Promise<void> {
  await caches.default.delete(tripKey(library, "a"));
  await caches.default.delete(tripKey(library, "b"));
}

function refusal(answer: Extract<BudgetAnswer, { ok: false }>): HttpFailure {
  return new HttpFailure(answer.status, "budget", answer.message, { status: answer.reason === "disabled" ? "disabled" : "budget", reason: answer.reason, resets_at: answer.resets_at });
}

/**
 * Storage that is missing or switched off answers so before anything is
 * looked up, the same way at every door, so a download on a notes-only
 * backend says `absent` as `begin` does, never a bare 404 (D-071).
 */
function requireStorage(env: Env): void {
  if (!env.MEDIA) throw new HttpFailure(501, "absent", "This backend has no attachment storage (notes-only mode).", { status: "absent" });
  if (env.R2_ENABLED === "false") throw new HttpFailure(503, "budget", "Attachment storage is switched off on this backend. Your files are safe on this device.", { status: "disabled", reason: "disabled" });
}

/** The one gate every R2 operation passes. */
export async function gate(env: Env, library: string, req: BudgetRequest): Promise<void> {
  requireStorage(env);
  const classes: ("a" | "b")[] = [];
  if ((req.classA ?? 0) > 0) classes.push("a");
  if ((req.classB ?? 0) > 0) classes.push("b");
  for (const c of classes) {
    const hit = await caches.default.match(tripKey(library, c));
    if (hit) throw refusal(await hit.json());
  }
  let answer: BudgetAnswer;
  try {
    answer = await env.BUDGET.getByName(`budget:${library}`).authorize(req, true);
  } catch {
    // B9: an unreachable budget is a refusal, never a pass.
    throw new HttpFailure(503, "budget", "Attachment storage is paused: its safety counter could not be read. Your files are safe on this device.", { status: "budget", reason: "unavailable" });
  }
  if (!answer.ok) {
    if (answer.trip) await writeTripCache(library, answer, answer.reason === "disabled" ? ["a", "b"] : classes);
    throw refusal(answer);
  }
}

interface AttachmentRow { sha: string; r2_key: string; bytes: number; mime: string; completed_at: string | null; upload_id: string | null; upload_at: string | null }

async function attachment(env: Env, library: string, sha: string) {
  return env.META.prepare("SELECT sha, r2_key, bytes, mime, completed_at, upload_id, upload_at FROM attachment WHERE library_id = ? AND sha = ?")
    .bind(library, sha).first<AttachmentRow>();
}

export async function begin(env: Env, caller: Caller, request: Request, now = Date.now()) {
  requireFull(caller);
  const body = await readJson(request, 4096);
  const sha = validSha(body.sha);
  const bytes = Number(body.bytes);
  const mime = String(body.mime ?? "");
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new HttpFailure(400, "bad_size", "bytes must be a positive whole number.");
  if (!MIME_RE.test(mime)) throw new HttpFailure(400, "bad_mime", "mime is not a media type.");
  if (!env.MEDIA) return json({ status: "absent" });
  if (env.R2_ENABLED === "false") return json({ status: "disabled", message: "Attachment storage is switched off on this backend. Your files are safe on this device." });
  const existing = await attachment(env, caller.library, sha);
  if (existing?.completed_at) return json({ status: "have" });
  const key = `${caller.library}/blob/${sha}`;
  if (bytes <= SINGLE_PUT_MAX) {
    // Size and switch are checked now so a refused object never starts; nothing is charged yet.
    await gate(env, caller.library, { kind: "begin", bytes, device: caller.device });
    await env.META.prepare(`INSERT INTO attachment (sha, library_id, r2_key, bytes, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(library_id, sha) DO UPDATE SET bytes = excluded.bytes, mime = excluded.mime`).bind(sha, caller.library, key, bytes, mime, nowIso(now)).run();
    return json({ status: "put", url: `/v1/blob/put/${sha}` });
  }
  if (existing?.upload_id && existing.upload_at && now - Date.parse(existing.upload_at) < 7 * 86_400_000) {
    const parts = await env.META.prepare("SELECT n, bytes FROM attachment_part WHERE library_id = ? AND sha = ? ORDER BY n").bind(caller.library, sha).all<{ n: number; bytes: number }>();
    return json({ status: "multipart", part_size: PART_SIZE, parts_total: Math.ceil(bytes / PART_SIZE), parts: parts.results.map((p) => ({ n: p.n, uploaded: true })) });
  }
  await gate(env, caller.library, { kind: "create_multipart", classA: 1, bytes, device: caller.device, sha });
  const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  await env.META.batch([
    env.META.prepare(`INSERT INTO attachment (sha, library_id, r2_key, bytes, mime, created_at, upload_id, upload_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(library_id, sha) DO UPDATE SET bytes = excluded.bytes, mime = excluded.mime, upload_id = excluded.upload_id, upload_at = excluded.upload_at`)
      .bind(sha, caller.library, key, bytes, mime, nowIso(now), upload.uploadId, nowIso(now)),
    env.META.prepare("DELETE FROM attachment_part WHERE library_id = ? AND sha = ?").bind(caller.library, sha),
  ]);
  return json({ status: "multipart", part_size: PART_SIZE, parts_total: Math.ceil(bytes / PART_SIZE), parts: [] });
}

export async function put(env: Env, caller: Caller, request: Request, shaParam: string, now = Date.now()) {
  requireFull(caller);
  const sha = validSha(shaParam);
  const row = await attachment(env, caller.library, sha);
  if (!row) throw new HttpFailure(409, "not_begun", "Call /v1/blob/begin first.");
  if (row.completed_at) return json({ ok: true, status: "have" });
  const length = Number(request.headers.get("content-length") ?? "-1");
  if (length !== row.bytes || length > SINGLE_PUT_MAX) throw new HttpFailure(400, "bad_length", "Content-Length must equal the declared size, at most 5 MiB.");
  await gate(env, caller.library, { kind: "put", classA: 1, bytes: row.bytes, storeBytes: row.bytes, device: caller.device, sha });
  try {
    await env.MEDIA!.put(row.r2_key, request.body, { sha256: sha, httpMetadata: { contentType: row.mime } });
  } catch {
    throw new HttpFailure(400, "sha_mismatch", "The bytes do not match their sha256; nothing was stored.");
  }
  await env.META.prepare("UPDATE attachment SET completed_at = ?, verified = 1 WHERE library_id = ? AND sha = ?").bind(nowIso(now), caller.library, sha).run();
  return json({ ok: true });
}

export async function part(env: Env, caller: Caller, request: Request, shaParam: string, nParam: string) {
  requireFull(caller);
  const sha = validSha(shaParam);
  const n = Number(nParam);
  const row = await attachment(env, caller.library, sha);
  if (!row?.upload_id) throw new HttpFailure(409, "not_begun", "No multipart upload is open for this sha.");
  const total = Math.ceil(row.bytes / PART_SIZE);
  if (!Number.isSafeInteger(n) || n < 1 || n > total) throw new HttpFailure(400, "bad_part", `Parts are numbered 1 to ${total}.`);
  const expected = n < total ? PART_SIZE : row.bytes - PART_SIZE * (total - 1);
  const length = Number(request.headers.get("content-length") ?? "-1");
  if (length !== expected) throw new HttpFailure(400, "bad_length", `Part ${n} is ${expected} bytes.`);
  await gate(env, caller.library, { kind: "part", classA: 1, device: caller.device, sha });
  const uploaded = await env.MEDIA!.resumeMultipartUpload(row.r2_key, row.upload_id).uploadPart(n, request.body!);
  await env.META.prepare(`INSERT INTO attachment_part (library_id, sha, n, etag, bytes) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(library_id, sha, n) DO UPDATE SET etag = excluded.etag, bytes = excluded.bytes`).bind(caller.library, sha, n, uploaded.etag, length).run();
  return json({ ok: true, n });
}

export async function commit(env: Env, caller: Caller, request: Request, now = Date.now()) {
  requireFull(caller);
  const body = await readJson(request, 4096);
  const sha = validSha(body.sha);
  const row = await attachment(env, caller.library, sha);
  if (!row) throw new HttpFailure(409, "not_begun", "Call /v1/blob/begin first.");
  if (row.completed_at) return json({ ok: true });
  if (!row.upload_id) throw new HttpFailure(409, "not_uploaded", "The bytes have not been sent.");
  const parts = await env.META.prepare("SELECT n, etag FROM attachment_part WHERE library_id = ? AND sha = ? ORDER BY n").bind(caller.library, sha).all<{ n: number; etag: string }>();
  const total = Math.ceil(row.bytes / PART_SIZE);
  if (parts.results.length !== total) throw new HttpFailure(409, "parts_missing", `${total - parts.results.length} part(s) are still to send.`, { parts: parts.results.map((p) => p.n) });
  await gate(env, caller.library, { kind: "complete", classA: 1, storeBytes: row.bytes, device: caller.device, sha });
  const object = await env.MEDIA!.resumeMultipartUpload(row.r2_key, row.upload_id).complete(parts.results.map((p) => ({ partNumber: p.n, etag: p.etag })));
  if (object.size !== row.bytes) {
    await env.MEDIA!.delete(row.r2_key);
    throw new HttpFailure(400, "bad_size", "The assembled object is not the declared size; it was discarded.");
  }
  // A multipart object's sha is not verified by R2 (finding F-20); it is marked so.
  await env.META.batch([
    env.META.prepare("UPDATE attachment SET completed_at = ?, verified = 0, upload_id = NULL, upload_at = NULL WHERE library_id = ? AND sha = ?").bind(nowIso(now), caller.library, sha),
    env.META.prepare("DELETE FROM attachment_part WHERE library_id = ? AND sha = ?").bind(caller.library, sha),
  ]);
  return json({ ok: true });
}

export async function download(env: Env, caller: Caller, request: Request, shaParam: string) {
  const sha = validSha(shaParam);
  requireStorage(env);
  const row = await attachment(env, caller.library, sha);
  if (!row?.completed_at) throw new HttpFailure(404, "not_found", "Image not available.");
  const range = request.headers.get("range");
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) throw new HttpFailure(416, "bad_range", "One byte range, bytes=a-b.");
    await gate(env, caller.library, { kind: "range", classB: 1, device: caller.device, sha });
    const offset = Number(m[1]);
    // A range past the object is clamped to its last byte; one that starts
    // past it, or ends before it starts, is unsatisfiable (review 2026-09-26, BACKEND-8).
    const end = Math.min(m[2] ? Number(m[2]) : row.bytes - 1, row.bytes - 1);
    if (!Number.isSafeInteger(offset) || offset >= row.bytes || end < offset) {
      throw new HttpFailure(416, "bad_range", `The object is ${row.bytes} bytes.`, { size: row.bytes });
    }
    const obj = await env.MEDIA!.get(row.r2_key, { range: { offset, length: end - offset + 1 } });
    if (!obj) throw new HttpFailure(404, "not_found", "Image not available.");
    return new Response(obj.body, { status: 206, headers: { "content-type": row.mime, "content-range": `bytes ${offset}-${end}/${row.bytes}`, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
  }
  await gate(env, caller.library, { kind: "get", classB: 1, device: caller.device, sha });
  const obj = await env.MEDIA!.get(row.r2_key);
  if (!obj) throw new HttpFailure(404, "not_found", "Image not available.");
  return new Response(obj.body, { headers: { "content-type": row.mime, "content-length": String(row.bytes), "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}

/** A visitor's picture: a live share naming a document that holds this sha. Whole objects only (C10). */
export async function shareBlob(env: Env, request: Request, ctx: ExecutionContext, ipKey: string) {
  const body = await readJson(request, 4096);
  const share = await liveShare(env, body.token);
  const sha = validSha(body.sha);
  if (!(await env.LIBRARY.getByName(`library:${share.library_id}`).documentHoldsSha(share.notebook_id, sha))) {
    throw new HttpFailure(404, "not_found", "Image not available.");
  }
  const cacheKey = new Request(`https://share-blob.recall.invalid/${share.library_id}/${sha}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached; // An edge hit never touches R2 and is never counted.
  const row = await attachment(env, share.library_id, sha);
  if (!row?.completed_at) throw new HttpFailure(404, "not_found", "Image not available.");
  await gate(env, share.library_id, { kind: "get", classB: 1, shareTokenSha: share.token_sha, ipKey, sha });
  const obj = await env.MEDIA!.get(row.r2_key);
  if (!obj) throw new HttpFailure(404, "not_found", "Image not available.");
  const bytes = await obj.arrayBuffer();
  const headers = { "content-type": row.mime, "content-length": String(bytes.byteLength), "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  ctx.waitUntil(caches.default.put(cacheKey, new Response(bytes, { headers })));
  return new Response(bytes, { headers });
}
