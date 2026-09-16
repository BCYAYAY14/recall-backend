// BudgetDO: the R2 circuit breaker, one per library (plan 36.5).
//
// * GLOBAL per library, strongly consistent: one object, one thread, one
//   counter. A read-modify-write cannot be raced (FI-16e).
// * CONSERVATIVE: every attempt is charged BEFORE it happens and nothing is
//   ever refunded (36.5a).
// * FAIL CLOSED: a missing, corrupt or unreadable counter refuses R2 (36.5f).
// * ISOLATED: document sync never calls this object.
// * Limits may be lowered freely and raised only up to SAFETY_MAX (36.5g).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

const MB = 1024 * 1024;
const GB = 1024 * MB;

export const DEFAULT_LIMITS: Record<string, number> = {
  r2_bytes_ceiling: 8 * GB,
  r2_object_max_bytes: 25 * MB,
  r2_class_a_month: 100_000,
  r2_class_b_month: 1_000_000,
  r2_class_a_per_minute: 30,
  r2_class_a_bucket: 150,
  r2_class_b_per_minute: 120,
  r2_class_b_bucket: 200,
  device_class_a_day: 2_000,
  device_class_a_minute: 20,
  share_class_b_minute: 60,
  share_class_b_day: 2_000,
  ip_class_b_minute: 120,
  ip_class_b_day: 1_000,
  range_per_object_minute: 20,
  multipart_creates_per_sha_day: 3,
};

export const SAFETY_MAX: Record<string, number> = {
  r2_bytes_ceiling: 8 * GB,
  r2_object_max_bytes: 25 * MB,
  r2_class_a_month: 200_000,
  r2_class_b_month: 2_000_000,
  r2_class_a_per_minute: 60,
  r2_class_a_bucket: 300,
  r2_class_b_per_minute: 240,
  r2_class_b_bucket: 400,
  device_class_a_day: 4_000,
  device_class_a_minute: 40,
  share_class_b_minute: 120,
  share_class_b_day: 4_000,
  ip_class_b_minute: 240,
  ip_class_b_day: 2_000,
  range_per_object_minute: 40,
  multipart_creates_per_sha_day: 3,
};

export type BudgetKind = "begin" | "put" | "create_multipart" | "part" | "complete" | "abort" | "get" | "range" | "list" | "snapshot" | "recount";

export interface BudgetRequest {
  kind: BudgetKind;
  classA?: number;
  classB?: number;
  /** The declared object size, checked against the per-object cap. */
  bytes?: number;
  /** Bytes added to stored total, charged now. */
  storeBytes?: number;
  device?: string;
  shareTokenSha?: string;
  ipKey?: string;
  sha?: string;
}

export type BudgetAnswer =
  | { ok: true }
  | { ok: false; status: number; reason: string; message: string; resets_at: string | null; trip: boolean };

const INTERNAL: BudgetKind[] = ["abort", "snapshot", "recount"];

function monthKey(now: number) { return new Date(now).toISOString().slice(0, 7); }
function dayKey(now: number) { return new Date(now).toISOString().slice(0, 10); }
function minuteKey(now: number) { return new Date(now).toISOString().slice(0, 16); }
function nextMonth(now: number) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

class Corrupt extends Error {}

export class BudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS counter (key TEXT PRIMARY KEY, month_key TEXT NOT NULL, value INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS bucket (key TEXT PRIMARY KEY, tokens REAL NOT NULL, refilled_at INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS trip (key TEXT PRIMARY KEY, at INTEGER NOT NULL, until INTEGER NOT NULL, reason TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS usage (key TEXT PRIMARY KEY, period TEXT NOT NULL, n INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`);
      const init = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'initialized'").toArray()[0];
      if (!init) {
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
          for (const k of ["class_a_month", "class_b_month", "bytes_total"]) sql.exec("INSERT INTO counter VALUES (?, ?, 0)", k, monthKey(now));
          sql.exec("INSERT INTO bucket VALUES ('class_a', ?, ?)", DEFAULT_LIMITS.r2_class_a_bucket!, now);
          sql.exec("INSERT INTO bucket VALUES ('class_b', ?, ?)", DEFAULT_LIMITS.r2_class_b_bucket!, now);
          sql.exec("INSERT INTO meta VALUES ('r2_enabled', '1')");
          sql.exec("INSERT INTO meta VALUES ('initialized', ?)", String(now));
        });
      }
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 86_400_000);
    });
  }

  bind(libraryId: string): void {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO meta VALUES ('library_id', ?)", libraryId);
  }

  // MARK: reading state, failing closed

  private limit(key: string): number {
    const row = this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM limits WHERE key = ?", key).toArray()[0];
    const v = row ? row.value : DEFAULT_LIMITS[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Corrupt(key);
    return Math.min(v, SAFETY_MAX[key] ?? v);
  }

  private counter(key: string, now: number): number {
    const row = this.ctx.storage.sql.exec<{ month_key: string; value: number }>("SELECT month_key, value FROM counter WHERE key = ?", key).toArray()[0];
    if (!row) throw new Corrupt(`missing counter ${key}`);
    if (!Number.isSafeInteger(row.value) || row.value < 0) throw new Corrupt(`bad counter ${key}`);
    const current = monthKey(now);
    if (row.month_key > current) throw new Corrupt(`future month ${key}`);
    if (key !== "bytes_total" && row.month_key < current) {
      this.ctx.storage.sql.exec("UPDATE counter SET month_key = ?, value = 0 WHERE key = ?", current, key);
      return 0;
    }
    return row.value;
  }

  private tokens(key: "class_a" | "class_b", now: number): number {
    const row = this.ctx.storage.sql.exec<{ tokens: number; refilled_at: number }>("SELECT tokens, refilled_at FROM bucket WHERE key = ?", key).toArray()[0];
    if (!row) throw new Corrupt(`missing bucket ${key}`);
    if (!Number.isFinite(row.tokens) || row.tokens < 0) throw new Corrupt(`bad bucket ${key}`);
    const rate = this.limit(key === "class_a" ? "r2_class_a_per_minute" : "r2_class_b_per_minute");
    const cap = this.limit(key === "class_a" ? "r2_class_a_bucket" : "r2_class_b_bucket");
    const elapsed = Math.max(0, now - row.refilled_at);
    return Math.min(cap, row.tokens + (elapsed / 60_000) * rate);
  }

  private usage(key: string, period: string): number {
    const row = this.ctx.storage.sql.exec<{ period: string; n: number }>("SELECT period, n FROM usage WHERE key = ?", key).toArray()[0];
    return row && row.period === period ? row.n : 0;
  }

  private addUsage(key: string, period: string, n: number): void {
    this.ctx.storage.sql.exec(`INSERT INTO usage (key, period, n) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET n = CASE WHEN usage.period = excluded.period THEN usage.n + excluded.n ELSE excluded.n END, period = excluded.period`, key, period, n);
  }

  private refuse(status: number, reason: string, message: string, resetsAt: number | null, trip: boolean): BudgetAnswer {
    return { ok: false, status, reason, message, resets_at: resetsAt === null ? null : new Date(resetsAt).toISOString(), trip };
  }

  private tripUntil(key: string, reason: string, now: number, until: number): void {
    this.ctx.storage.sql.exec("INSERT INTO trip (key, at, until, reason) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, until = excluded.until, reason = excluded.reason",
      key, now, until, reason);
  }

  // MARK: the gate

  /**
   * Decides and CHARGES one R2 attempt. `envEnabled` is the dashboard switch
   * (`R2_ENABLED`), read by the Worker and passed in, so either door turns R2
   * off. Throws nothing: any internal failure is a refusal.
   */
  authorize(req: BudgetRequest, envEnabled: boolean, now = Date.now()): BudgetAnswer {
    try {
      return this.ctx.storage.transactionSync(() => this.decide(req, envEnabled, now));
    } catch (e) {
      return this.refuse(503, e instanceof Corrupt ? "corrupt" : "unavailable",
        "Attachment storage is paused: its safety counter could not be read. Your files are safe on this device.", null, false);
    }
  }

  private decide(req: BudgetRequest, envEnabled: boolean, now: number): BudgetAnswer {
    const sql = this.ctx.storage.sql;
    const internal = INTERNAL.includes(req.kind);
    const a = Math.max(0, Math.floor(req.classA ?? 0));
    const b = Math.max(0, Math.floor(req.classB ?? 0));
    // `begin` charges nothing but answers as a PUT would, so a tripped or
    // exhausted budget stops the upload before any byte moves (plan 36.6).
    const probeA = req.kind === "begin" ? 1 : a;

    const enabledRow = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'r2_enabled'").toArray()[0];
    if (!enabledRow) throw new Corrupt("r2_enabled unreadable");
    if (!envEnabled || enabledRow.value !== "1") {
      return this.refuse(503, "disabled", "Attachment storage is switched off on this backend. Your files are safe on this device.", null, true);
    }

    // C6 before anything is charged: an oversized object never moves a byte.
    if (req.bytes !== undefined && req.bytes > this.limit("r2_object_max_bytes")) {
      const mb = (n: number) => `${Math.round(n / MB)} MB`;
      return this.refuse(413, "object_too_large", `This file is ${mb(req.bytes)}; attachments are limited to ${mb(this.limit("r2_object_max_bytes"))}. It stays on this device.`, null, false);
    }

    if (!internal) {
      const trips = sql.exec<{ key: string; until: number; reason: string }>("SELECT key, until, reason FROM trip WHERE until > ?", now).toArray();
      const blocking = trips.find((t) => (probeA > 0 && t.key.startsWith("class_a")) || (b > 0 && t.key.startsWith("class_b")));
      if (blocking) return this.refuse(429, blocking.reason, pausedMessage(blocking.until), blocking.until, true);
    }

    // C5 storage.
    const stored = this.counter("bytes_total", now);
    const addBytes = Math.max(0, req.storeBytes ?? 0);
    if (addBytes > 0 && stored + addBytes > this.limit("r2_bytes_ceiling")) {
      return this.refuse(507, "storage_ceiling", "Attachment storage has reached its safety ceiling. Your files are safe on this device.", null, false);
    }

    // C3, C4 monthly walls. Internal work still counts but is not refused.
    const aMonth = this.counter("class_a_month", now);
    const bMonth = this.counter("class_b_month", now);
    if (!internal) {
      if (probeA > 0 && aMonth + probeA > this.limit("r2_class_a_month")) {
        this.tripUntil("class_a_month", "class_a_month", now, Date.parse(nextMonth(now)));
        return this.refuse(429, "class_a_month", pausedMessage(Date.parse(nextMonth(now))), Date.parse(nextMonth(now)), true);
      }
      if (b > 0 && bMonth + b > this.limit("r2_class_b_month")) {
        this.tripUntil("class_b_month", "class_b_month", now, Date.parse(nextMonth(now)));
        return this.refuse(429, "class_b_month", pausedMessage(Date.parse(nextMonth(now))), Date.parse(nextMonth(now)), true);
      }
    }

    // C1, C2 global bursts: the primary breaker, checked before any per-device limit.
    const aTokens = this.tokens("class_a", now);
    const bTokens = this.tokens("class_b", now);
    if (!internal) {
      if (probeA > 0 && aTokens < probeA) {
        const until = now + Math.ceil(((probeA - aTokens) / this.limit("r2_class_a_per_minute")) * 60_000);
        this.tripUntil("class_a_burst", "class_a_burst", now, until);
        return this.refuse(429, "class_a_burst", pausedMessage(until), until, true);
      }
      if (b > 0 && bTokens < b) {
        const until = now + Math.ceil(((b - bTokens) / this.limit("r2_class_b_per_minute")) * 60_000);
        this.tripUntil("class_b_burst", "class_b_burst", now, until);
        return this.refuse(429, "class_b_burst", pausedMessage(until), until, true);
      }
    }

    // Secondary, subordinate limits (C7 to C11). They can only refuse more.
    const day = dayKey(now), minute = minuteKey(now);
    if (!internal && req.device && a > 0) {
      if (this.usage(`dev_a_day:${req.device}`, day) + a > this.limit("device_class_a_day")) return this.refuse(429, "device_class_a_day", "This device has sent its attachment allowance for today.", Date.parse(day + "T00:00:00.000Z") + 86_400_000, false);
      if (this.usage(`dev_a_min:${req.device}`, minute) + a > this.limit("device_class_a_minute")) return this.refuse(429, "device_class_a_minute", "This device is sending attachments too quickly.", now + 60_000, false);
    }
    if (!internal && req.shareTokenSha && b > 0) {
      if (this.usage(`share_b_min:${req.shareTokenSha}`, minute) + b > this.limit("share_class_b_minute")) return this.refuse(429, "share_class_b_minute", "This link is being read too quickly.", now + 60_000, false);
      if (this.usage(`share_b_day:${req.shareTokenSha}`, day) + b > this.limit("share_class_b_day")) return this.refuse(429, "share_class_b_day", "This link's pictures are paused until tomorrow.", Date.parse(day + "T00:00:00.000Z") + 86_400_000, false);
    }
    if (!internal && req.ipKey && b > 0) {
      if (this.usage(`ip_b_min:${req.ipKey}`, minute) + b > this.limit("ip_class_b_minute")) return this.refuse(429, "ip_class_b_minute", "Too many requests.", now + 60_000, false);
      if (this.usage(`ip_b_day:${req.ipKey}`, day) + b > this.limit("ip_class_b_day")) return this.refuse(429, "ip_class_b_day", "Too many requests today.", Date.parse(day + "T00:00:00.000Z") + 86_400_000, false);
    }
    if (!internal && req.kind === "range" && req.sha) {
      if (this.usage(`range:${req.device ?? "?"}:${req.sha}`, minute) + 1 > this.limit("range_per_object_minute")) return this.refuse(429, "range_per_object", "Too many range reads of one object.", now + 60_000, false);
    }
    if (!internal && req.kind === "create_multipart" && req.sha) {
      if (this.usage(`mp:${req.sha}`, day) + 1 > this.limit("multipart_creates_per_sha_day")) return this.refuse(429, "multipart_loop", "This file's upload has restarted too often today; it will try again tomorrow.", Date.parse(day + "T00:00:00.000Z") + 86_400_000, false);
    }

    // Charge, before the operation, never refunded.
    if (a > 0) {
      sql.exec("UPDATE counter SET value = value + ? WHERE key = 'class_a_month'", a);
      sql.exec("UPDATE bucket SET tokens = ?, refilled_at = ? WHERE key = 'class_a'", Math.max(0, aTokens - a), now);
    }
    if (b > 0) {
      sql.exec("UPDATE counter SET value = value + ? WHERE key = 'class_b_month'", b);
      sql.exec("UPDATE bucket SET tokens = ?, refilled_at = ? WHERE key = 'class_b'", Math.max(0, bTokens - b), now);
    }
    if (addBytes > 0) sql.exec("UPDATE counter SET value = value + ? WHERE key = 'bytes_total'", addBytes);
    if (req.device && a > 0) { this.addUsage(`dev_a_day:${req.device}`, day, a); this.addUsage(`dev_a_min:${req.device}`, minute, a); }
    if (req.shareTokenSha && b > 0) { this.addUsage(`share_b_min:${req.shareTokenSha}`, minute, b); this.addUsage(`share_b_day:${req.shareTokenSha}`, day, b); }
    if (req.ipKey && b > 0) { this.addUsage(`ip_b_min:${req.ipKey}`, minute, b); this.addUsage(`ip_b_day:${req.ipKey}`, day, b); }
    if (req.kind === "range" && req.sha) this.addUsage(`range:${req.device ?? "?"}:${req.sha}`, minute, 1);
    if (req.kind === "create_multipart" && req.sha) this.addUsage(`mp:${req.sha}`, day, 1);
    return { ok: true };
  }

  // MARK: the owner's controls

  report(now = Date.now()) {
    const sql = this.ctx.storage.sql;
    try {
      const limits: Record<string, { value: number; max: number; default: number }> = {};
      for (const k of Object.keys(DEFAULT_LIMITS)) limits[k] = { value: this.limit(k), max: SAFETY_MAX[k]!, default: DEFAULT_LIMITS[k]! };
      return {
        ok: true,
        r2_enabled: sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'r2_enabled'").toArray()[0]?.value === "1",
        month: monthKey(now), resets_at: nextMonth(now),
        usage: { class_a_month: this.counter("class_a_month", now), class_b_month: this.counter("class_b_month", now), bytes_total: this.counter("bytes_total", now) },
        trips: sql.exec("SELECT key, until, reason FROM trip WHERE until > ?", now).toArray(),
        limits,
      };
    } catch (e) {
      return { ok: false, reason: e instanceof Corrupt ? "corrupt" : "unavailable" };
    }
  }

  /** B13: a value above SAFETY_MAX is refused whatever the client sends. */
  setLimits(values: Record<string, unknown>): { ok: boolean; refused?: string } {
    for (const [k, v] of Object.entries(values)) {
      if (!(k in DEFAULT_LIMITS)) return { ok: false, refused: `unknown limit ${k}` };
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return { ok: false, refused: `${k} must be a whole number` };
      if (v > SAFETY_MAX[k]!) return { ok: false, refused: `${k} cannot exceed ${SAFETY_MAX[k]}` };
    }
    this.ctx.storage.transactionSync(() => {
      // Changing a limit is the explicit safe recovery action (plan 36.6): the
      // next attempt is judged against the new values, not an old trip.
      this.ctx.storage.sql.exec("DELETE FROM trip");
      for (const [k, v] of Object.entries(values)) {
        this.ctx.storage.sql.exec("INSERT INTO limits (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, v as number);
      }
    });
    return { ok: true };
  }

  setR2Enabled(enabled: boolean): void {
    this.ctx.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('r2_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", enabled ? "1" : "0");
    if (enabled) this.ctx.storage.sql.exec("DELETE FROM trip WHERE key = 'disabled'");
  }

  /** Test door: corrupt a counter, to prove the gate fails closed (B6, B9). */
  corruptForTest(what: "delete_counter" | "negative" | "future"): void {
    const sql = this.ctx.storage.sql;
    if (what === "delete_counter") sql.exec("DELETE FROM counter WHERE key = 'class_a_month'");
    if (what === "negative") sql.exec("UPDATE counter SET value = -5 WHERE key = 'class_a_month'");
    if (what === "future") sql.exec("UPDATE counter SET month_key = '2999-01' WHERE key = 'class_a_month'");
  }

  // MARK: the daily alarm: abandoned multiparts, the storage recount, pruning

  override async alarm(): Promise<void> {
    await this.maintain();
    await this.ctx.storage.setAlarm(Date.now() + 86_400_000);
  }

  async maintain(now = Date.now()): Promise<Record<string, unknown>> {
    const sql = this.ctx.storage.sql;
    const libraryId = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'library_id'").toArray()[0]?.value;
    const out: Record<string, unknown> = {};
    sql.exec("DELETE FROM usage WHERE period < ?", dayKey(now - 2 * 86_400_000));
    sql.exec("DELETE FROM trip WHERE until < ?", now);
    if (!libraryId || !this.env.MEDIA) return { skipped: "no attachment storage" };
    const media = this.env.MEDIA;

    // C12: at most 50 aborts a run, each charged before it is attempted.
    const stale = await this.env.META.prepare(`SELECT sha, r2_key, upload_id FROM attachment
      WHERE library_id = ? AND upload_id IS NOT NULL AND completed_at IS NULL AND upload_at < ? LIMIT 50`)
      .bind(libraryId, new Date(now - 7 * 86_400_000).toISOString()).all<{ sha: string; r2_key: string; upload_id: string }>();
    let aborted = 0;
    for (const s of stale.results) {
      this.authorize({ kind: "abort", classA: 1 }, true, now);
      try { await media.resumeMultipartUpload(s.r2_key, s.upload_id).abort(); } catch { /* already gone; still charged */ }
      await this.env.META.batch([
        this.env.META.prepare("UPDATE attachment SET upload_id = NULL, upload_at = NULL WHERE library_id = ? AND sha = ? AND completed_at IS NULL").bind(libraryId, s.sha),
        this.env.META.prepare("DELETE FROM attachment_part WHERE library_id = ? AND sha = ?").bind(libraryId, s.sha),
      ]);
      aborted++;
    }
    out.aborted = aborted;

    // B6: recount stored bytes against R2 reality. Each listed page is one Class A.
    let bytes = 0, pages = 0;
    let cursor: string | undefined;
    do {
      this.authorize({ kind: "recount", classA: 1 }, true, now);
      const page = await media.list({ prefix: `${libraryId}/blob/`, cursor, limit: 1000 });
      pages++;
      for (const o of page.objects) bytes += o.size;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && pages < 100);
    sql.exec(`INSERT INTO counter (key, month_key, value) VALUES ('bytes_total', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, month_key = excluded.month_key`, monthKey(now), bytes);
    // A corrupt monthly counter is rebuilt conservatively: at its limit, so the month stays refused.
    for (const k of ["class_a_month", "class_b_month"]) {
      const row = sql.exec<{ month_key: string; value: number }>("SELECT month_key, value FROM counter WHERE key = ?", k).toArray()[0];
      if (!row || !Number.isSafeInteger(row.value) || row.value < 0 || row.month_key > monthKey(now)) {
        const wall = this.limit(k === "class_a_month" ? "r2_class_a_month" : "r2_class_b_month");
        sql.exec(`INSERT INTO counter (key, month_key, value) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET month_key = excluded.month_key, value = excluded.value`, k, monthKey(now), wall);
        out[`rebuilt_${k}`] = true;
      }
    }
    out.bytes_total = bytes;
    out.list_pages = pages;
    return out;
  }
}

function pausedMessage(until: number): string {
  const when = new Date(until);
  const soon = until - Date.now() < 3_600_000;
  const label = soon ? `${when.toISOString().slice(11, 16)} UTC` : when.toISOString().slice(0, 10);
  return `Attachment uploads are paused until ${label}. Your files are safe on this device.`;
}
