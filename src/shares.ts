// Share links (plan 10.2). The link is https://<backend>/#share=<token>; the
// token is 32 random bytes, stored only as sha256, and travels to the API in a
// POST body, never in a URL path (finding F-14).

import type { Caller } from "./auth.ts";
import type { Env } from "./env.ts";
import { HttpFailure, json, nowIso, randomToken, sha256HexOf } from "./http.ts";
import { isWireTime } from "./isnewer.ts";
import { SHA_RE, UUID_RE, type WireRow } from "./protocol.ts";

export async function createShare(env: Env, caller: Caller, body: Record<string, unknown>, origin: string, now = Date.now()) {
  const notebookId = String(body.notebook_id ?? "");
  if (!UUID_RE.test(notebookId)) throw new HttpFailure(400, "bad_notebook", "notebook_id must be a lowercase uuid.");
  const expires = body.expires_at ?? null;
  if (expires !== null && (!isWireTime(expires) || Date.parse(String(expires)) <= now)) throw new HttpFailure(400, "bad_expiry", "expires_at must be a future timestamp or null.");
  if (!(await env.LIBRARY.getByName(`library:${caller.library}`).notebookIsLive(notebookId))) throw new HttpFailure(404, "not_found", "That document is not in the library.");
  const token = randomToken(32);
  const id = crypto.randomUUID();
  await env.META.prepare(`INSERT INTO share (id, library_id, notebook_id, token_sha, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, caller.library, notebookId, await sha256HexOf(token), caller.device, nowIso(now), expires).run();
  return { id, token, url: `${origin}/#share=${token}`, expires_at: expires };
}

export async function listShares(env: Env, caller: Caller) {
  const r = await env.META.prepare(`SELECT id, notebook_id, created_at, expires_at, revoked_at, last_viewed_at, view_count FROM share WHERE library_id = ? ORDER BY created_at DESC`)
    .bind(caller.library).all();
  return { shares: r.results };
}

export async function revokeShare(env: Env, caller: Caller, id: string, now = Date.now()) {
  if (!UUID_RE.test(id)) throw new HttpFailure(400, "bad_share", "Not a share id.");
  const r = await env.META.prepare("UPDATE share SET revoked_at = ? WHERE id = ? AND library_id = ? AND revoked_at IS NULL").bind(nowIso(now), id, caller.library).run();
  if (r.meta.changes !== 1) throw new HttpFailure(404, "not_found", "No such active link.");
  return { ok: true };
}

interface ShareRow { id: string; library_id: string; notebook_id: string; token_sha: string; expires_at: string | null; revoked_at: string | null; last_viewed_at: string | null }

/** Resolves a token to a live share, or answers with the sentence the page shows. */
export async function liveShare(env: Env, token: unknown, now = Date.now()): Promise<ShareRow> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) throw new HttpFailure(404, "not_found", "This link does not exist.");
  const row = await env.META.prepare("SELECT * FROM share WHERE token_sha = ?").bind(await sha256HexOf(token)).first<ShareRow>();
  if (!row) throw new HttpFailure(404, "not_found", "This link does not exist.");
  if (row.revoked_at) throw new HttpFailure(410, "revoked", "This link has been stopped.");
  if (row.expires_at && Date.parse(row.expires_at) <= now) throw new HttpFailure(410, "expired", "This link has expired.");
  return row;
}

// What a visitor may see: the document, its live notes, card ids and flags,
// media and regions. Never a schedule, a snapshot, a device or the library id.
// A media row's `rel_path` is its content-addressed file name, nothing more.
function pick(o: Record<string, unknown>, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
}

export function visitorView(doc: { notebook: WireRow; notes: WireRow[]; cards: WireRow[]; media: WireRow[]; occlusions: WireRow[] }) {
  return {
    notebook: { id: doc.notebook.id, ...pick(doc.notebook.content, ["name", "emoji", "style"]) },
    notes: doc.notes.map((n) => ({ id: n.id, updated_at: n.updated_at, ...pick(n.env, ["notebook_id", "parent_id", "position", "kind", "occ_mode", "typed_answer", "created_at"]), ...pick(n.content, ["front", "back", "cloze_text", "spans", "attrs"]) })),
    cards: doc.cards.map((c) => ({ id: c.id, ...pick(c.env, ["note_id", "cloze_ordinal", "flag", "suspended", "detached"]) })),
    media: doc.media.map((m) => ({ id: m.id, ...pick(m.env, ["note_id", "rel_path", "mime", "bytes_sha", "display_width", "created_at"]), ...pick(m.content, ["crop", "latex"]) })),
    occlusion: doc.occlusions.map((o) => ({ id: o.id, ...pick(o.env, ["note_id", "ordinal", "x", "y", "w", "h", "media_id", "rotation", "z"]), ...pick(o.content, ["label", "points_json"]) })),
  };
}

export async function resolveShare(env: Env, body: Record<string, unknown>, ctx: ExecutionContext, now = Date.now()) {
  const share = await liveShare(env, body.token, now);
  const doc = await env.LIBRARY.getByName(`library:${share.library_id}`).sharedDocument(share.notebook_id);
  if (!doc) throw new HttpFailure(404, "not_found", "This document no longer exists.");
  // A view is counted at most once a minute per link: one conditional statement.
  ctx.waitUntil(env.META.prepare("UPDATE share SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ? AND (last_viewed_at IS NULL OR last_viewed_at < ?)")
    .bind(nowIso(now), share.id, nowIso(now - 60_000)).run().then(() => undefined, () => undefined));
  return json(visitorView(doc as never));
}

export function validSha(sha: unknown): string {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) throw new HttpFailure(400, "bad_sha", "sha must be 64 lowercase hex characters.");
  return sha;
}
