// Device pairing with opaque tokens (plan 8). No passwords, no email, no OAuth.
// The backend stores sha256 of every token and code; the token exists only on
// the device that holds it. The library is ALWAYS derived from the device row.

import type { Env } from "./env.ts";
import { HttpFailure, nowIso, randomToken, secretEquals, sha256HexOf } from "./http.ts";
import { UUID_RE } from "./protocol.ts";

export interface Caller {
  device: string;
  library: string;
  account: string;
  scope: "full" | "read_share";
  platform: string;
}

const CLAIM_WINDOW_MS = 60 * 60_000;
const PAIR_TTL_MS = 5 * 60_000;
const PAIR_ATTEMPTS = 5;
const ROTATE_GRACE_MS = 60_000;
const PLATFORMS = new Set(["mac", "ios", "web"]);

export async function authenticate(request: Request, env: Env, now = Date.now()): Promise<Caller> {
  const header = request.headers.get("authorization") ?? "";
  const protocolHeader = request.headers.get("sec-websocket-protocol") ?? "";
  let token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  // A browser WebSocket cannot set Authorization; it offers the token as a
  // subprotocol, which stays out of URLs and request logs.
  if (!token && protocolHeader) {
    const offered = protocolHeader.split(",").map((s) => s.trim()).find((s) => s.startsWith("recall.bearer."));
    if (offered) token = offered.slice("recall.bearer.".length);
  }
  if (!token) throw new HttpFailure(401, "auth", "Sign in again: this request carries no device credential.");
  const sha = await sha256HexOf(token);
  const row = await env.META.prepare(`SELECT id, library_id, account_id, scope, platform, revoked_at, token_sha, prev_token_sha, prev_valid_until
    FROM device WHERE token_sha = ? OR prev_token_sha = ? LIMIT 1`).bind(sha, sha)
    .first<{ id: string; library_id: string; account_id: string; scope: string; platform: string; revoked_at: string | null; token_sha: string; prev_token_sha: string | null; prev_valid_until: string | null }>();
  if (!row) throw new HttpFailure(401, "auth", "Sign in again: this device credential is not recognised.");
  if (row.revoked_at) throw new HttpFailure(401, "revoked", "This device was revoked. Its notes stay on the device.");
  if (row.token_sha !== sha && !(row.prev_valid_until && Date.parse(row.prev_valid_until) > now)) {
    throw new HttpFailure(401, "auth", "Sign in again: this device credential was rotated.");
  }
  return { device: row.id, library: row.library_id, account: row.account_id, scope: row.scope === "full" ? "full" : "read_share", platform: row.platform };
}

export function requireFull(caller: Caller): void {
  if (caller.scope !== "full") throw new HttpFailure(403, "scope", "This device may read but not change the library.");
}

function deployedAt(env: Env): number {
  const explicit = env.DEPLOYED_AT ? Date.parse(env.DEPLOYED_AT) : NaN;
  if (Number.isFinite(explicit)) return explicit;
  const ts = env.CF_VERSION_METADATA?.timestamp;
  return ts ? Date.parse(ts) : 0;
}

function versionKey(env: Env): string {
  return env.CF_VERSION_METADATA?.id ?? env.DEPLOYED_AT ?? "unversioned";
}

async function meta(env: Env, key: string): Promise<string | null> {
  const r = await env.META.prepare("SELECT value FROM deploy_meta WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

function setMeta(env: Env, key: string, value: string): D1PreparedStatement {
  return env.META.prepare("INSERT INTO deploy_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value);
}

function validateDeviceFields(body: Record<string, unknown>): { deviceId: string; label: string; platform: string } {
  const deviceId = String(body.device_id ?? "");
  const label = String(body.label ?? "").slice(0, 80);
  const platform = String(body.platform ?? "");
  if (!UUID_RE.test(deviceId)) throw new HttpFailure(400, "bad_device", "device_id must be a lowercase uuid.");
  if (!label.trim()) throw new HttpFailure(400, "bad_label", "A device needs a name.");
  if (!PLATFORMS.has(platform)) throw new HttpFailure(400, "bad_platform", "platform is mac, ios or web.");
  return { deviceId, label, platform };
}

async function pairSalt(env: Env): Promise<string> {
  const salt = await meta(env, "pair_salt");
  if (!salt) throw new HttpFailure(409, "unclaimed", "This backend has not been claimed yet.");
  return salt;
}

function newRecoveryCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/** Inserts or re-keys a device, and tells the library object it may write again. */
async function issueDevice(env: Env, account: string, library: string, deviceId: string, label: string, platform: string, scope: string, now: number) {
  const token = "rcl_" + randomToken(32);
  const sha = await sha256HexOf(token);
  const statement = env.META.prepare(`INSERT INTO device (id, account_id, library_id, label, platform, scope, token_sha, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET label = excluded.label, platform = excluded.platform, scope = excluded.scope,
      token_sha = excluded.token_sha, token_version = device.token_version + 1, prev_token_sha = NULL,
      prev_valid_until = NULL, revoked_at = NULL
    WHERE device.account_id = excluded.account_id`).bind(deviceId, account, library, label, platform, scope, sha, nowIso(now));
  return { token, statement };
}

// MARK: claim

export async function claim(env: Env, body: Record<string, unknown>, now = Date.now()) {
  const code = String(body.code ?? "");
  const { deviceId, label, platform } = validateDeviceFields(body);
  const setup = env.OWNER_SETUP_CODE ?? "";
  if (setup.length < 12) throw new HttpFailure(503, "setup_code_missing", "This backend has no setup code of at least 12 characters. Set OWNER_SETUP_CODE and redeploy.");
  if (now > deployedAt(env) + CLAIM_WINDOW_MS) throw new HttpFailure(410, "window_closed", "The setup window closed an hour after deployment. Change the setup code and redeploy to open it again.");
  const failKey = `claim_failures:${versionKey(env)}`;
  const failures = Number(await meta(env, failKey) ?? "0");
  if (failures >= 5) throw new HttpFailure(410, "window_closed", "Too many wrong setup codes for this deployment. Change the setup code and redeploy.");
  const account = await env.META.prepare("SELECT id, claimed_at FROM account LIMIT 1").first<{ id: string; claimed_at: string | null }>();
  if (!(await secretEquals(code, setup))) {
    await setMeta(env, failKey, String(failures + 1)).run();
    throw new HttpFailure(401, "bad_code", "That setup code is not right.");
  }
  const codeSha = await sha256HexOf("claim:" + setup);

  if (account?.claimed_at) {
    // A reclaim is allowed only with a setup code DIFFERENT from the one that
    // claimed, inside the window of the deploy that set it (plan 8.3, S11).
    if (body.reclaim !== true) throw new HttpFailure(409, "already_claimed", "This backend is already claimed.");
    if ((await meta(env, "claim_code_sha")) === codeSha) throw new HttpFailure(409, "already_claimed", "Reclaiming needs a new setup code and a redeploy.");
    const library = await env.META.prepare("SELECT id FROM library WHERE account_id = ?").bind(account.id).first<{ id: string }>();
    if (!library) throw new HttpFailure(500, "no_library", "The account has no library.");
    const issued = await issueDevice(env, account.id, library.id, deviceId, label, platform, "full", now);
    const recovery = Array.from({ length: 8 }, newRecoveryCode);
    const salt = await pairSalt(env);
    await env.META.batch([
      issued.statement,
      env.META.prepare("DELETE FROM recovery_code WHERE account_id = ?").bind(account.id),
      ...await Promise.all(recovery.map(async (c) => env.META.prepare("INSERT INTO recovery_code (code_sha, account_id, created_at) VALUES (?, ?, ?)").bind(await sha256HexOf(salt + c), account.id, nowIso(now)))),
      setMeta(env, "claim_code_sha", codeSha),
    ]);
    await env.LIBRARY.getByName(`library:${library.id}`).unrevokeDevice(deviceId);
    return { token: issued.token, library_id: library.id, recovery_codes: recovery, reclaimed: true };
  }

  const accountId = crypto.randomUUID();
  const libraryId = crypto.randomUUID();
  const salt = randomToken(16);
  const issued = await issueDevice(env, accountId, libraryId, deviceId, label, platform, "full", now);
  const recovery = Array.from({ length: 8 }, newRecoveryCode);
  try {
  await env.META.batch([
    // A plain INSERT on a fixed key: of two racing claims, one batch fails whole (S3).
    env.META.prepare("INSERT INTO deploy_meta (key, value) VALUES ('claimed', ?)").bind(nowIso(now)),
    env.META.prepare("INSERT INTO account (id, label, created_at, claimed_at) VALUES (?, ?, ?, ?)").bind(accountId, "Recall", nowIso(now), nowIso(now)),
    env.META.prepare("INSERT INTO library (id, account_id, created_at, schema_version) VALUES (?, ?, ?, 1)").bind(libraryId, accountId, nowIso(now)),
    issued.statement,
    setMeta(env, "pair_salt", salt),
    setMeta(env, "claim_code_sha", codeSha),
    ...await Promise.all(recovery.map(async (c) => env.META.prepare("INSERT INTO recovery_code (code_sha, account_id, created_at) VALUES (?, ?, ?)").bind(await sha256HexOf(salt + c), accountId, nowIso(now)))),
  ]);
  } catch {
    throw new HttpFailure(409, "already_claimed", "This backend is already claimed.");
  }
  await env.BUDGET.getByName(`budget:${libraryId}`).bind(libraryId);
  await bindLibrary(env, libraryId);
  return { token: issued.token, library_id: libraryId, recovery_codes: recovery };
}

async function bindLibrary(env: Env, libraryId: string): Promise<void> {
  await env.LIBRARY.getByName(`library:${libraryId}`).bindLibrary(libraryId);
}

// MARK: pairing

export async function pairBegin(env: Env, caller: Caller, now = Date.now()) {
  requireFull(caller);
  const salt = await pairSalt(env);
  const digits = crypto.getRandomValues(new Uint32Array(2));
  const code = String(digits[0]! % 10_000).padStart(4, "0") + String(digits[1]! % 10_000).padStart(4, "0");
  await env.META.batch([
    env.META.prepare("DELETE FROM pairing_code WHERE expires_at < ? OR used_at IS NOT NULL").bind(nowIso(now)),
    env.META.prepare("INSERT INTO pairing_code (code_sha, account_id, issued_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind(await sha256HexOf(salt + code), caller.account, caller.device, nowIso(now), nowIso(now + PAIR_TTL_MS)),
  ]);
  return { code: `${code.slice(0, 4)} ${code.slice(4)}`, expires_in: PAIR_TTL_MS / 1000 };
}

export async function pairClaim(env: Env, body: Record<string, unknown>, now = Date.now()) {
  const code = String(body.code ?? "").replace(/\s+/g, "");
  const { deviceId, label, platform } = validateDeviceFields(body);
  if (!/^\d{8}$/.test(code)) throw new HttpFailure(400, "bad_code", "A pairing code is eight digits.");
  const salt = await pairSalt(env);
  const live = await env.META.prepare("SELECT code_sha, account_id, attempts FROM pairing_code WHERE used_at IS NULL AND expires_at > ? AND attempts < ?")
    .bind(nowIso(now), PAIR_ATTEMPTS).all<{ code_sha: string; account_id: string; attempts: number }>();
  const offered = await sha256HexOf(salt + code);
  let match: { code_sha: string; account_id: string } | undefined;
  for (const c of live.results) if (await secretEquals(c.code_sha, offered)) match = c;
  if (!match) {
    // A wrong guess costs EVERY live code an attempt, so guessing cannot target one.
    await env.META.prepare("UPDATE pairing_code SET attempts = attempts + 1 WHERE used_at IS NULL AND expires_at > ?").bind(nowIso(now)).run();
    throw new HttpFailure(401, "bad_code", "That pairing code is wrong or has expired.");
  }
  const library = await env.META.prepare("SELECT id FROM library WHERE account_id = ?").bind(match.account_id).first<{ id: string }>();
  if (!library) throw new HttpFailure(500, "no_library", "The account has no library.");
  const scope = platform === "web" ? "read_share" : "full";
  const issued = await issueDevice(env, match.account_id, library.id, deviceId, label, platform, scope, now);
  const used = await env.META.prepare("UPDATE pairing_code SET used_at = ? WHERE code_sha = ? AND used_at IS NULL").bind(nowIso(now), match.code_sha).run();
  if (used.meta.changes !== 1) throw new HttpFailure(401, "bad_code", "That pairing code was already used.");
  await issued.statement.run();
  await env.LIBRARY.getByName(`library:${library.id}`).unrevokeDevice(deviceId);
  return { token: issued.token, library_id: library.id, scope };
}

export async function recover(env: Env, body: Record<string, unknown>, now = Date.now()) {
  const code = String(body.code ?? "").trim().toLowerCase();
  const { deviceId, label, platform } = validateDeviceFields(body);
  const salt = await pairSalt(env);
  const sha = await sha256HexOf(salt + code);
  const used = await env.META.prepare("UPDATE recovery_code SET used_at = ? WHERE code_sha = ? AND used_at IS NULL RETURNING account_id")
    .bind(nowIso(now), sha).first<{ account_id: string }>();
  if (!used) throw new HttpFailure(401, "bad_code", "That recovery code is wrong or was already used.");
  const library = await env.META.prepare("SELECT id FROM library WHERE account_id = ?").bind(used.account_id).first<{ id: string }>();
  if (!library) throw new HttpFailure(500, "no_library", "The account has no library.");
  const issued = await issueDevice(env, used.account_id, library.id, deviceId, label, platform, platform === "web" ? "read_share" : "full", now);
  await issued.statement.run();
  await env.LIBRARY.getByName(`library:${library.id}`).unrevokeDevice(deviceId);
  return { token: issued.token, library_id: library.id };
}

export async function rotate(env: Env, caller: Caller, now = Date.now()) {
  const token = "rcl_" + randomToken(32);
  const sha = await sha256HexOf(token);
  await env.META.prepare(`UPDATE device SET prev_token_sha = token_sha, prev_valid_until = ?, token_sha = ?, token_version = token_version + 1 WHERE id = ?`)
    .bind(nowIso(now + ROTATE_GRACE_MS), sha, caller.device).run();
  return { token };
}

export async function listDevices(env: Env, caller: Caller) {
  requireFull(caller);
  const rows = await env.META.prepare(`SELECT id, label, platform, scope, created_at, last_seen_at, app_version, protocol, revoked_at
    FROM device WHERE library_id = ? ORDER BY created_at`).bind(caller.library).all();
  return { devices: rows.results.map((d) => ({ ...d, this_device: d.id === caller.device })) };
}

/** Revocation is immediate: D1 first, then the library object closes the sockets and refuses the next frame. */
export async function revokeDevice(env: Env, caller: Caller, target: string, now = Date.now()) {
  requireFull(caller);
  if (!UUID_RE.test(target)) throw new HttpFailure(400, "bad_device", "Not a device id.");
  const r = await env.META.prepare("UPDATE device SET revoked_at = ? WHERE id = ? AND library_id = ? AND revoked_at IS NULL")
    .bind(nowIso(now), target, caller.library).run();
  if (r.meta.changes !== 1) throw new HttpFailure(404, "not_found", "No such active device.");
  await env.LIBRARY.getByName(`library:${caller.library}`).revokeDevice(target);
  return { ok: true };
}

/** `last_seen_at` is written at most once per 15 minutes per device. */
export async function touchDevice(env: Env, caller: Caller, app: string | null, protocol: number | null, now = Date.now()) {
  await env.META.prepare(`UPDATE device SET last_seen_at = ?, app_version = COALESCE(?, app_version), protocol = COALESCE(?, protocol)
    WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`)
    .bind(nowIso(now), app, protocol, caller.device, nowIso(now - 15 * 60_000)).run();
}
