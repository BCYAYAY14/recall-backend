// LibraryDO: one per library. The op log and current rows (LibraryCore), the
// hibernating WebSockets, the per-device push limit, the daily row estimate,
// and the daily alarm (compaction, snapshot, orphan marking, deletion).
//
// Document sync reaches this object and NEVER BudgetDO (plan 36.5f): a budget
// failure cannot stop a keystroke from syncing.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { carryReplaced, LibraryCore, Refused, type Sql } from "./library-core.ts";
import { LIMITS, type WireRow } from "./protocol.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> };

const DAY = 86_400_000;
const PUSH_PER_MINUTE = 120;
const SNAPSHOT_KEEP = 14;
const SNAPSHOT_ROWS_PER_PART = 50_000;
const DELETE_DELAY_MS = 7 * DAY;

interface SocketInfo { device: string; scope: string; run: string; started: number; opsIn: number; opsOut: number; stale: number; conflicts: number; rejected: number }

/** `written` hears Cloudflare's own count for every statement, index entries included (the meter the free tier bills). */
function doSql(ctx: DurableObjectState, written: (n: number) => void): Sql {
  return {
    exec: (sql, ...params) => {
      const cursor = ctx.storage.sql.exec(sql, ...params);
      const rows = cursor.toArray();
      if (cursor.rowsWritten > 0) written(cursor.rowsWritten);
      return rows as never;
    },
    transaction: (fn) => ctx.storage.transactionSync(fn),
  };
}

export class LibraryDO extends DurableObject<Env> {
  private core: LibraryCore;
  private pushWindows = new Map<string, { start: number; n: number }>();
  private rowsToday = { day: "", n: 0, persistedAt: 0 };
  private httpRuns = new Map<string, SocketInfo>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new LibraryCore(doSql(ctx, (n) => this.countRows(n, Date.now())));
    ctx.blockConcurrencyWhile(async () => {
      this.core.migrate();
      const [day = "", n = "0"] = (this.core.meta("rows_today") ?? "").split(" ");
      this.rowsToday = { day, n: Number(n) || 0, persistedAt: Date.now() };
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(nextMaintenance(Date.now()));
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  private wrap<T>(fn: () => T): Result<T> {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      if (e instanceof Refused) return { ok: false, status: e.status, code: e.code, message: e.message };
      throw e;
    }
  }

  // MARK: the daily row-write count (plan 15.5), Cloudflare's own meter

  private countRows(n: number, now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.rowsToday.day !== day) this.rowsToday = { day, n: 0, persistedAt: 0 };
    this.rowsToday.n += n;
    if (now - this.rowsToday.persistedAt > 60_000) {
      // Stamped first: this write is itself counted, through this function.
      this.rowsToday.persistedAt = now;
      this.core.setMeta("rows_today", `${day} ${this.rowsToday.n}`);
    }
  }

  budget(now = Date.now()) {
    const limit = Number(this.env.DO_ROWS_DAILY_LIMIT ?? "100000");
    const day = new Date(now).toISOString().slice(0, 10);
    const used = this.rowsToday.day === day ? this.rowsToday.n : 0;
    const resets = new Date(Date.parse(day + "T00:00:00.000Z") + DAY).toISOString();
    return { do_rows_written: { used, limit, resets_at: resets } };
  }

  private refuseOverBudget(now: number): void {
    const b = this.budget(now).do_rows_written;
    if (b.limit > 0 && b.used >= b.limit) {
      throw new Refused(429, "limit", "Your backend has used today's free allowance. Your work is saved on this device and will sync after 00:00 UTC.");
    }
  }

  private refuseOverPushRate(device: string, now: number): void {
    const w = this.pushWindows.get(device);
    if (!w || now - w.start >= 60_000) { this.pushWindows.set(device, { start: now, n: 1 }); return; }
    if (w.n >= PUSH_PER_MINUTE) throw new Refused(429, "rate", "Too many pushes from this device this minute.");
    w.n++;
  }

  // MARK: RPC

  hello(device: string, frame: Record<string, unknown>, libraryId: string): Result<Record<string, unknown>> {
    const now = Date.now();
    this.flushHttpRun(device, libraryId, now);
    this.httpRuns.set(device, { device, scope: "", run: crypto.randomUUID(), started: now, opsIn: 0, opsOut: 0, stale: 0, conflicts: 0, rejected: 0 });
    return this.wrap(() => ({ ...this.core.hello(device, frame, now), budget: this.budget(now) }));
  }

  /** The body arrives as TEXT so the Worker spends no CPU parsing it. */
  push(device: string, scope: string, body: string): Result<Record<string, unknown>> {
    const now = Date.now();
    return this.wrap(() => {
      if (scope !== "full") throw new Refused(403, "scope", "This device may read but not write.");
      if (body.length > LIMITS.bytes_per_batch) throw new Refused(413, "too_large", "A push is at most 1 MiB.");
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(body) as Record<string, unknown>; } catch { throw new Refused(400, "bad_json", "The push is not JSON."); }
      this.refuseOverPushRate(device, now);
      this.refuseOverBudget(now);
      const r = this.core.push(device, frame, now);
      this.broadcast(r.committed);
      const run = this.httpRuns.get(device);
      if (run) { run.opsIn += frame.ops instanceof Array ? frame.ops.length : 0; run.stale += r.counts.stale; run.conflicts += r.counts.conflict; run.rejected += r.counts.rejected; }
      return { ...r.ack, budget: this.budget(now) };
    });
  }

  pull(device: string, since: number, limit: number): Result<Record<string, unknown>> {
    return this.wrap(() => {
      if (this.core.isRevoked(device)) throw new Refused(401, "revoked", "This device was revoked.");
      const frame = this.core.pull(since, limit);
      const run = this.httpRuns.get(device);
      if (run) run.opsOut += frame.ops.length;
      return frame;
    });
  }

  ack(device: string, seq: number): Result<boolean> {
    return this.wrap(() => this.core.ack(device, seq, Date.now()));
  }

  snapshot(afterLane: string, afterId: string, limit: number): Result<Record<string, unknown>> {
    return this.wrap(() => this.core.snapshot(afterLane, afterId, limit));
  }

  async digest() { return this.core.digest(); }

  revokeDevice(device: string): void {
    this.core.revoke(device, Date.now());
    for (const ws of this.ctx.getWebSockets(device)) {
      try { ws.send(JSON.stringify({ t: "bye", reason: "revoked" })); ws.close(4001, "revoked"); } catch { /* already gone */ }
    }
  }

  unrevokeDevice(device: string): void { this.core.unrevoke(device); }

  sharedDocument(notebookId: string) { return this.core.sharedDocument(notebookId); }

  documentHoldsSha(notebookId: string, sha: string): boolean { return this.core.documentHoldsSha(notebookId, sha); }

  notebookIsLive(notebookId: string): boolean {
    const nb = this.core.row("notebook", notebookId);
    return nb !== null && nb.env.deleted_at === null;
  }

  shaIsReferenced(sha: string): boolean { return (this.core.liveShas().get(sha) ?? 0) > 0; }

  conflicts(limit: number) { return this.core.conflicts(limit); }

  ping(): string { return "ok"; }

  bindLibrary(libraryId: string): void {
    if (!this.core.meta("library_id")) this.core.setMeta("library_id", libraryId);
  }

  requestDelete(libraryId: string): string {
    const at = new Date(Date.now()).toISOString();
    this.core.setMeta("delete_requested_at", at);
    this.core.setMeta("library_id", libraryId);
    return at;
  }

  cancelDelete(): void { this.ctx.storage.sql.exec("DELETE FROM meta WHERE key = 'delete_requested_at'"); }

  /** Test and restore door: replace an EMPTY library from snapshot lines. */
  restore(lines: string[]): Result<number> {
    return this.wrap(() => this.core.restoreFrom(lines, Date.now()));
  }

  /** The dates of the daily snapshots R2 holds for a library, oldest first. */
  async snapshotDates(libraryId: string): Promise<string[]> {
    if (!this.env.MEDIA || !libraryId) return [];
    const listed = await this.env.MEDIA.list({ prefix: `${libraryId}/snapshot/`, limit: 1000 });
    return [...new Set(listed.objects.map((o) => o.key.split("/")[2]!))].sort();
  }

  /**
   * The restore door for the daily R2 snapshot (review 2026-09-26,
   * BACKEND-12): reads one date's parts (the newest when `date` is null) and
   * restores them into THIS object, which must hold no rows. A new epoch
   * sends every device to bootstrap. The object is bound to `libraryId`
   * (the caller's, from D1), which a snapshot written before D-143 does not
   * carry.
   */
  async restoreFromSnapshot(libraryId: string, date: string | null): Promise<Result<number>> {
    if (!this.env.MEDIA) return { ok: false, status: 503, code: "no_storage", message: "This backend has no attachment storage, so it keeps no snapshots." };
    const dates = await this.snapshotDates(libraryId);
    const day = date ?? dates[dates.length - 1] ?? null;
    if (!day || !dates.includes(day)) return { ok: false, status: 404, code: "no_snapshot", message: "No snapshot of this library was kept on that date." };
    const listed = await this.env.MEDIA.list({ prefix: `${libraryId}/snapshot/${day}/`, limit: 1000 });
    const lines: string[] = [];
    for (const key of listed.objects.map((o) => o.key).sort()) {
      const obj = await this.env.MEDIA.get(key);
      if (!obj) return { ok: false, status: 409, code: "snapshot_changed", message: "A part of that snapshot went while it was read. Try again." };
      const text = await new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text();
      for (const line of text.split("\n")) if (line) lines.push(line);
    }
    const out = this.restore(lines);
    if (out.ok) this.bindLibrary(libraryId);
    return out;
  }

  exportLines(): string[] { return [...this.core.snapshotLines()]; }

  // MARK: WebSocket

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    const device = request.headers.get("x-recall-device") ?? "";
    const scope = request.headers.get("x-recall-scope") ?? "";
    if (!device || this.core.isRevoked(device)) return new Response(JSON.stringify({ error: "revoked" }), { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [device]);
    const info: SocketInfo = { device, scope, run: crypto.randomUUID(), started: Date.now(), opsIn: 0, opsOut: 0, stale: 0, conflicts: 0, rejected: 0 };
    server.serializeAttachment(info);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo;
    const now = Date.now();
    const send = (body: unknown) => ws.send(JSON.stringify(body));
    if (typeof message !== "string" || message.length > LIMITS.bytes_per_batch) { send({ t: "error", reason: "bad_frame" }); return; }
    if (this.core.isRevoked(info.device)) { send({ t: "bye", reason: "revoked" }); ws.close(4001, "revoked"); return; }
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(message) as Record<string, unknown>; } catch { send({ t: "error", reason: "bad_frame" }); return; }
    const libraryId = this.core.meta("library_id") ?? "";
    try {
      switch (frame.t) {
        case "hello": send({ ...this.core.hello(info.device, frame, now), budget: this.budget(now) }); break;
        case "push": {
          if (info.scope !== "full") throw new Refused(403, "scope", "This device may read but not write.");
          this.refuseOverPushRate(info.device, now);
          this.refuseOverBudget(now);
          const r = this.core.push(info.device, frame, now);
          info.opsIn += Array.isArray(frame.ops) ? frame.ops.length : 0;
          info.stale += r.counts.stale; info.conflicts += r.counts.conflict; info.rejected += r.counts.rejected;
          ws.serializeAttachment(info);
          send({ ...r.ack, budget: this.budget(now) });
          this.broadcast(r.committed);
          break;
        }
        case "pull": {
          const f = this.core.pull(frame.since === undefined ? 0 : Number(frame.since), Number(frame.limit ?? 500));
          info.opsOut += f.ops.length;
          ws.serializeAttachment(info);
          send(f);
          break;
        }
        case "ack": this.core.ack(info.device, Number(frame.seq), now); break;
        default: send({ t: "error", reason: "bad_frame" });
      }
    } catch (e) {
      if (e instanceof Refused) {
        if (e.status === 429) send({ t: "limit", service: e.code === "limit" ? "do_rows_written" : "push_rate", resets_at: this.budget(now).do_rows_written.resets_at, message: e.message });
        else if (e.status === 426) { send({ t: "bye", reason: "protocol", message: e.message }); ws.close(4002, "protocol"); }
        else if (e.status === 401) { send({ t: "bye", reason: "revoked" }); ws.close(4001, "revoked"); }
        else send({ t: "error", reason: e.code, message: e.message });
      } else {
        send({ t: "error", reason: "internal" });
        throw e;
      }
    }
    void libraryId;
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (info) await this.writeRun(info, "ws", Date.now());
    try { ws.close(code, reason); } catch { /* closed */ }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const info = ws.deserializeAttachment() as SocketInfo | null;
    if (info) await this.writeRun(info, "ws", Date.now());
  }

  /** Fan-out: every connected socket, the sender's included (it discards its own op ids and advances its cursor). */
  private broadcast(committed: WireRow[]): void {
    if (committed.length === 0) return;
    const frame = JSON.stringify({ t: "ops", from: committed[0]!.seq, to: committed[committed.length - 1]!.seq, more: false, ops: carryReplaced(committed) });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(frame); } catch { /* a dead socket catches up on its next hello */ }
    }
  }

  // MARK: the sync record (D1 sync_run, counts only)

  private flushHttpRun(device: string, libraryId: string, now: number): void {
    const run = this.httpRuns.get(device);
    if (!run || (run.opsIn === 0 && run.opsOut === 0)) return;
    this.httpRuns.delete(device);
    this.ctx.waitUntil(this.writeRun(run, "http", now, libraryId));
  }

  private async writeRun(info: SocketInfo, transport: string, now: number, libraryId = this.core.meta("library_id") ?? ""): Promise<void> {
    if (!libraryId) return;
    const outcome = info.rejected > 0 ? "partial" : "ok";
    try {
      await this.env.META.prepare(`INSERT OR IGNORE INTO sync_run (id, library_id, device_id, started_at, ended_at, transport, ops_in, ops_out, stale, conflicts, rejected, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(info.run, libraryId, info.device, new Date(info.started).toISOString(), new Date(now).toISOString(), transport,
          info.opsIn, info.opsOut, info.stale, info.conflicts, info.rejected, outcome).run();
    } catch {
      // The record is diagnostic. Losing one never touches the data.
    }
  }

  // MARK: the daily alarm

  override async alarm(): Promise<void> {
    const now = Date.now();
    const libraryId = this.core.meta("library_id") ?? "";
    for (const [device] of this.httpRuns) this.flushHttpRun(device, libraryId, now);
    const deleteAt = this.core.meta("delete_requested_at");
    if (deleteAt && now - Date.parse(deleteAt) >= DELETE_DELAY_MS) {
      await this.dropEverything(libraryId);
      return;
    }
    await this.maintain(now, libraryId);
    await this.ctx.storage.setAlarm(nextMaintenance(now));
  }

  /** Snapshot first, then compaction, then orphan marking. Each step survives the others failing. */
  async maintain(now = Date.now(), libraryId = this.core.meta("library_id") ?? ""): Promise<Record<string, unknown>> {
    const report: Record<string, unknown> = {};
    try { report.snapshot = await this.writeSnapshot(now, libraryId); } catch (e) { report.snapshot = `failed: ${(e as Error).name}`; }
    report.compaction = this.core.compact(now);
    try { report.orphans = await this.markOrphans(now, libraryId); } catch (e) { report.orphans = `failed: ${(e as Error).name}`; }
    if (libraryId) {
      try { await this.env.META.prepare("DELETE FROM sync_run WHERE started_at < ?").bind(new Date(now - 90 * DAY).toISOString()).run(); } catch { /* diagnostic */ }
    }
    return report;
  }

  private r2Usable(): boolean {
    return this.env.MEDIA !== undefined && this.env.R2_ENABLED !== "false";
  }

  /** Gzipped NDJSON parts under <library>/snapshot/<date>/ ; the 14 newest dates are kept. Budgeted through BudgetDO. */
  async writeSnapshot(now: number, libraryId: string): Promise<string> {
    if (!this.r2Usable() || !libraryId) return "skipped: no attachment storage";
    const media = this.env.MEDIA!;
    const date = new Date(now).toISOString().slice(0, 10);
    const lines = [...this.core.snapshotLines()];
    const parts = Math.max(1, Math.ceil(lines.length / SNAPSHOT_ROWS_PER_PART));
    const budget = this.env.BUDGET.getByName(`budget:${libraryId}`);
    const auth = await budget.authorize({ kind: "snapshot", classA: parts + 1, bytes: 0 }, true);
    if (!auth.ok) return `skipped: ${auth.reason}`;
    for (let p = 0; p < parts; p++) {
      const body = lines.slice(p * SNAPSHOT_ROWS_PER_PART, (p + 1) * SNAPSHOT_ROWS_PER_PART).join("\n") + "\n";
      const gz = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
      await media.put(`${libraryId}/snapshot/${date}/${String(p).padStart(4, "0")}.ndjson.gz`, gz, { httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" } });
    }
    const listed = await media.list({ prefix: `${libraryId}/snapshot/`, limit: 1000 });
    const dates = [...new Set(listed.objects.map((o) => o.key.split("/")[2]!))].sort();
    const stale = dates.slice(0, Math.max(0, dates.length - SNAPSHOT_KEEP));
    const doomed = listed.objects.filter((o) => stale.includes(o.key.split("/")[2]!)).map((o) => o.key);
    if (doomed.length) await media.delete(doomed);
    return `wrote ${lines.length} lines in ${parts} part(s)`;
  }

  /** Refcounts come from live rows; an unreferenced attachment is marked, and deleted after 45 days. */
  async markOrphans(now: number, libraryId: string): Promise<string> {
    if (!libraryId) return "skipped";
    const live = this.core.liveShas();
    const rows = await this.env.META.prepare("SELECT sha, refcount, orphan_at, r2_key FROM attachment WHERE library_id = ?").bind(libraryId).all<{ sha: string; refcount: number; orphan_at: string | null; r2_key: string }>();
    let marked = 0, cleared = 0, deleted = 0;
    const statements: D1PreparedStatement[] = [];
    const deletions: string[] = [];
    for (const a of rows.results) {
      const n = live.get(a.sha) ?? 0;
      if (n > 0 && (a.refcount !== n || a.orphan_at)) {
        statements.push(this.env.META.prepare("UPDATE attachment SET refcount = ?, orphan_at = NULL WHERE library_id = ? AND sha = ?").bind(n, libraryId, a.sha));
        if (a.orphan_at) cleared++;
      } else if (n === 0 && !a.orphan_at) {
        statements.push(this.env.META.prepare("UPDATE attachment SET refcount = 0, orphan_at = ? WHERE library_id = ? AND sha = ?").bind(new Date(now).toISOString(), libraryId, a.sha));
        marked++;
      } else if (n === 0 && a.orphan_at && now - Date.parse(a.orphan_at) > 45 * DAY && this.r2Usable()) {
        deletions.push(a.r2_key);
        statements.push(this.env.META.prepare("DELETE FROM attachment WHERE library_id = ? AND sha = ?").bind(libraryId, a.sha));
        statements.push(this.env.META.prepare("DELETE FROM attachment_part WHERE library_id = ? AND sha = ?").bind(libraryId, a.sha));
        deleted++;
      }
    }
    if (deletions.length) await this.env.MEDIA!.delete(deletions);
    for (let i = 0; i < statements.length; i += 50) await this.env.META.batch(statements.slice(i, i + 50));
    return `marked ${marked}, cleared ${cleared}, deleted ${deleted}`;
  }

  private async dropEverything(libraryId: string): Promise<void> {
    if (this.env.MEDIA && libraryId) {
      let cursor: string | undefined;
      do {
        const page = await this.env.MEDIA.list({ prefix: `${libraryId}/`, cursor, limit: 1000 });
        if (page.objects.length) await this.env.MEDIA.delete(page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    if (libraryId) {
      await this.env.META.batch([
        this.env.META.prepare("DELETE FROM share WHERE library_id = ?").bind(libraryId),
        this.env.META.prepare("DELETE FROM attachment WHERE library_id = ?").bind(libraryId),
        this.env.META.prepare("DELETE FROM attachment_part WHERE library_id = ?").bind(libraryId),
        this.env.META.prepare("DELETE FROM sync_run WHERE library_id = ?").bind(libraryId),
        this.env.META.prepare("UPDATE device SET revoked_at = ? WHERE library_id = ?").bind(new Date().toISOString(), libraryId),
      ]);
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

/** 03:17 UTC tomorrow, or later today if it has not passed. */
export function nextMaintenance(now: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 17);
  return t > now ? t : t + DAY;
}
