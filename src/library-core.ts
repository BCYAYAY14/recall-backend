// The library's sync core: the op log, the current rows, cursors and conflict
// adjudication. Pure over a tiny SQL interface, so the SAME code runs inside
// LibraryDO (Durable Object SQLite) and in Node's built-in SQLite for the fuzz
// and fault suites. PROTOCOL.md sections 5 and 6 are the contract.

import { canonical } from "./canonical.ts";
import { wireMillis, wireTime } from "./isnewer.ts";
import { LANE_ORDER, LANES, LIMITS, PROTOCOL_MAX, PROTOCOL_MIN, validateOp,
  type Outcome, type PushOp, type WireRow } from "./protocol.ts";

export interface Sql {
  /** Runs one statement and returns its rows. */
  exec<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** Runs `fn` atomically: every write or none. */
  transaction<T>(fn: () => T): T;
}

export class Refused extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const DAY = 86_400_000;
export const OP_RETENTION_MS = 45 * DAY;
export const TOMBSTONE_PURGE_MS = 30 * DAY;
export const ACK_WRITE_INTERVAL_MS = 10_000;
export const LAST_SEEN_INTERVAL_MS = 15 * 60_000;

export const DO_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS op (
     seq INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
     lane TEXT NOT NULL, row_id TEXT NOT NULL, kind TEXT NOT NULL,
     updated_at TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, replaced_updated_at TEXT, replaced_device TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_op_row ON op(lane, row_id, seq)`,
  `CREATE TABLE IF NOT EXISTS row (
     lane TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT NOT NULL, updated_ms INTEGER NOT NULL,
     deleted_at TEXT, payload TEXT NOT NULL, seq INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (lane, id))`,
  `CREATE INDEX IF NOT EXISTS idx_row_seq ON row(seq)`,
  `CREATE TABLE IF NOT EXISTS conflict (
     id TEXT PRIMARY KEY, seq INTEGER NOT NULL, lane TEXT NOT NULL, row_id TEXT NOT NULL,
     loser_device TEXT NOT NULL, loser_updated TEXT NOT NULL, loser_payload TEXT NOT NULL,
     at INTEGER NOT NULL, cleared_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS client (
     device_id TEXT PRIMARY KEY, ack_seq INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL,
     protocol INTEGER NOT NULL, revoked_at INTEGER)`,
];

export const SCHEMA_VERSION = 1;

interface RowRecord { lane: string; id: string; updated_at: string; updated_ms: number; deleted_at: string | null; payload: string; seq: number; device_id: string }
interface OpRecord { seq: number; op_id: string; device_id: string; lane: string; row_id: string; kind: string; updated_at: string; payload: string; replaced_updated_at: string | null; replaced_device: string | null }

export interface PushResult {
  ack: { t: "push_ack"; batch: string; seq: number; results: Outcome[] };
  committed: WireRow[];
  rowsWritten: number;
  counts: { applied: number; duplicate: number; stale: number; conflict: number; rejected: number };
}

export class LibraryCore {
  private lastAckWrite = new Map<string, number>();
  private lastSeenWrite = new Map<string, number>();

  constructor(private readonly sql: Sql, private readonly newId: () => string = () => crypto.randomUUID()) {}

  migrate(): void {
    for (const s of DO_SCHEMA) this.sql.exec(s);
    const v = this.meta("schema_version");
    if (v === null) {
      this.setMeta("schema_version", String(SCHEMA_VERSION));
      this.setMeta("epoch", this.newId());
      this.setMeta("retained_from", "1");
    }
  }

  meta(key: string): string | null {
    const r = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key);
    return r[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  maxSeq(): number {
    const r = this.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM op");
    const fromOps = r[0]?.m ?? 0;
    const floor = Number(this.meta("seq_floor") ?? "0");
    return Math.max(fromOps, floor);
  }

  retainedFrom(): number {
    return Number(this.meta("retained_from") ?? "1");
  }

  epoch(): string {
    return this.meta("epoch") ?? "";
  }

  // MARK: clients

  isRevoked(deviceId: string): boolean {
    const r = this.sql.exec<{ revoked_at: number | null }>("SELECT revoked_at FROM client WHERE device_id = ?", deviceId);
    return r[0]?.revoked_at != null;
  }

  revoke(deviceId: string, now: number): void {
    this.sql.exec(`INSERT INTO client (device_id, ack_seq, last_seen_at, protocol, revoked_at) VALUES (?, 0, ?, 1, ?)
      ON CONFLICT(device_id) DO UPDATE SET revoked_at = excluded.revoked_at`, deviceId, now, now);
  }

  unrevoke(deviceId: string): void {
    this.sql.exec("UPDATE client SET revoked_at = NULL WHERE device_id = ?", deviceId);
  }

  private touchClient(deviceId: string, pv: number, now: number): void {
    const last = this.lastSeenWrite.get(deviceId) ?? 0;
    if (now - last < LAST_SEEN_INTERVAL_MS && this.lastSeenWrite.has(deviceId)) return;
    this.lastSeenWrite.set(deviceId, now);
    this.sql.exec(`INSERT INTO client (device_id, ack_seq, last_seen_at, protocol) VALUES (?, 0, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, protocol = excluded.protocol`, deviceId, now, pv);
  }

  // MARK: hello

  hello(deviceId: string, frame: Record<string, unknown>, now: number) {
    const pv = frame.pv;
    if (typeof pv !== "number" || pv < PROTOCOL_MIN || pv > PROTOCOL_MAX) {
      throw new Refused(426, "protocol", pv !== undefined && typeof pv === "number" && pv > PROTOCOL_MAX
        ? "This backend is older than Recall. Update the backend."
        : "Recall is older than this backend. Update Recall.");
    }
    if (frame.device !== deviceId) throw new Refused(403, "device_mismatch", "The frame names a different device.");
    if (this.isRevoked(deviceId)) throw new Refused(401, "revoked", "This device was revoked.");
    const since = typeof frame.since === "number" && Number.isSafeInteger(frame.since) && frame.since >= 0 ? frame.since : 0;
    this.touchClient(deviceId, pv, now);
    const seq = this.maxSeq();
    const retained = this.retainedFrom();
    let reason: string | null = null;
    if (typeof frame.epoch === "string" && frame.epoch !== this.epoch() && seq > 0) reason = "epoch";
    else if (since < seq && since + 1 < retained) reason = "retention_gap";
    else if (since > seq) reason = "ahead_of_server";
    return {
      t: "hello_ok", pv, pv_min: PROTOCOL_MIN, pv_max: PROTOCOL_MAX, seq, retained_from: retained,
      epoch: this.epoch(), resync: reason !== null, reason,
      schema: typeof frame.schema === "number" ? frame.schema : null,
      limits: LIMITS, server_time: wireTime(now),
    };
  }

  // MARK: push

  push(deviceId: string, frame: Record<string, unknown>, now: number): PushResult {
    const batch = typeof frame.batch === "string" ? frame.batch : "";
    const ops = frame.ops;
    if (!Array.isArray(ops)) throw new Refused(400, "bad_frame", "A push carries an ops array.");
    if (ops.length > LIMITS.ops_per_batch) throw new Refused(413, "too_many_ops", `A push carries at most ${LIMITS.ops_per_batch} ops.`);

    const results: Outcome[] = new Array(ops.length);
    const counts = { applied: 0, duplicate: 0, stale: 0, conflict: 0, rejected: 0 };
    const valid: { index: number; op: PushOp }[] = [];
    ops.forEach((raw, index) => {
      const reason = validateOp(raw);
      if (reason) {
        const opId = (raw as { op_id?: unknown })?.op_id;
        results[index] = { op_id: typeof opId === "string" ? opId : "", outcome: "rejected", reason };
        counts.rejected++;
      } else {
        valid.push({ index, op: raw as PushOp });
      }
    });

    const ordered = orderParentsFirst(valid);
    let rowsWritten = 0;
    const committed: WireRow[] = [];

    this.sql.transaction(() => {
      // Revocation and sequence allocation are one transaction (race X6).
      if (this.isRevoked(deviceId)) throw new Refused(401, "revoked", "This device was revoked.");
      let next = this.maxSeq() + 1;
      for (const { index, op } of ordered) {
        const dup = this.sql.exec<{ seq: number }>("SELECT seq FROM op WHERE op_id = ?", op.op_id);
        if (dup[0]) {
          results[index] = { op_id: op.op_id, outcome: "duplicate", seq: dup[0].seq };
          counts.duplicate++;
          continue;
        }
        const content = op.kind === "tombstone" ? {} : (op.content ?? {});
        const payload = canonical({ content, env: op.env });
        const ms = wireMillis(op.updated_at)!;
        const stored = this.sql.exec<RowRecord>("SELECT * FROM row WHERE lane = ? AND id = ?", op.lane, op.id)[0];

        if (op.lane === "grade_event" && stored) {
          // Append-only: a grade id already present is the same grade.
          results[index] = { op_id: op.op_id, outcome: "duplicate", seq: stored.seq };
          counts.duplicate++;
          continue;
        }

        if (!stored || ms > stored.updated_ms) {
          const seq = next++;
          const deletedAt = (op.env.deleted_at as string | null | undefined) ?? null;
          // A NEWER write that did not see the stored revision, from another
          // device, replaces work its author never read. It wins, and the
          // replaced revision is recorded as a conflict so the device that
          // wrote it keeps a version (plan F-22: a clean row must not lose a
          // same-paragraph race silently).
          const concurrent = stored !== undefined && op.base_seq < stored.seq && stored.device_id !== deviceId
            && stored.payload !== payload && op.lane !== "grade_event";
          let replaced: WireRow["replaced"];
          if (concurrent) {
            const conflictId = this.newId();
            this.sql.exec(`INSERT INTO conflict (id, seq, lane, row_id, loser_device, loser_updated, loser_payload, at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, conflictId, seq, op.lane, op.id, stored.device_id, stored.updated_at, stored.payload, now);
            rowsWritten += 1;
            counts.conflict++;
            replaced = { updated_at: stored.updated_at, device: stored.device_id, conflict_id: conflictId };
          }
          this.sql.exec(`INSERT INTO op (seq, op_id, device_id, lane, row_id, kind, updated_at, payload, at, replaced_updated_at, replaced_device)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, seq, op.op_id, deviceId, op.lane, op.id, op.kind, op.updated_at, payload, now,
            replaced?.updated_at ?? null, replaced?.device ?? null);
          this.sql.exec(`INSERT INTO row (lane, id, updated_at, updated_ms, deleted_at, payload, seq, device_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(lane, id) DO UPDATE SET updated_at = excluded.updated_at, updated_ms = excluded.updated_ms,
              deleted_at = excluded.deleted_at, payload = excluded.payload, seq = excluded.seq, device_id = excluded.device_id`,
            op.lane, op.id, op.updated_at, ms, deletedAt, payload, seq, deviceId);
          rowsWritten += 2;
          results[index] = { op_id: op.op_id, outcome: "applied", seq, ...(replaced ? { conflict_id: replaced.conflict_id } : {}) };
          counts.applied++;
          committed.push({ seq, op_id: op.op_id, lane: op.lane, id: op.id, kind: op.kind, updated_at: op.updated_at, env: op.env, content,
            ...(replaced ? { replaced } : {}) });
          continue;
        }

        if (ms === stored.updated_ms && payload === stored.payload) {
          results[index] = { op_id: op.op_id, outcome: "applied", seq: stored.seq };
          counts.applied++;
          continue;
        }

        if (ms === stored.updated_ms && op.base_seq >= stored.seq && op.lane !== "grade_event") {
          // A successor written in the same millisecond by a device that has
          // SEEN the stored row (a non-touch() write path, plan F-23). It is
          // not a concurrent edit, so the tie rule does not apply (test O1).
          const seq = next++;
          this.sql.exec(`INSERT INTO op (seq, op_id, device_id, lane, row_id, kind, updated_at, payload, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, seq, op.op_id, deviceId, op.lane, op.id, op.kind, op.updated_at, payload, now);
          this.sql.exec(`UPDATE row SET deleted_at = ?, payload = ?, seq = ?, device_id = ? WHERE lane = ? AND id = ?`,
            (op.env.deleted_at as string | null | undefined) ?? null, payload, seq, deviceId, op.lane, op.id);
          rowsWritten += 2;
          results[index] = { op_id: op.op_id, outcome: "applied", seq };
          counts.applied++;
          committed.push({ seq, op_id: op.op_id, lane: op.lane, id: op.id, kind: op.kind, updated_at: op.updated_at, env: op.env, content });
          continue;
        }

        const winner = wireRowFrom(stored);
        if (op.base_seq >= stored.seq) {
          results[index] = { op_id: op.op_id, outcome: "stale", winner };
          counts.stale++;
          continue;
        }
        const conflictId = this.newId();
        this.sql.exec(`INSERT INTO conflict (id, seq, lane, row_id, loser_device, loser_updated, loser_payload, at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, conflictId, stored.seq, op.lane, op.id, deviceId, op.updated_at, payload, now);
        rowsWritten += 1;
        results[index] = { op_id: op.op_id, outcome: "conflict", winner, conflict_id: conflictId };
        counts.conflict++;
      }
    });

    return { ack: { t: "push_ack", batch, seq: this.maxSeq(), results }, committed, rowsWritten, counts };
  }

  // MARK: pull

  pull(since: number, limit: number) {
    const seq = this.maxSeq();
    if (since < seq && since + 1 < this.retainedFrom()) {
      throw new Refused(409, "resync_required", "This device is behind the retained log and must bootstrap.");
    }
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.sql.exec<OpRecord>("SELECT * FROM op WHERE seq > ? ORDER BY seq LIMIT ?", since, n + 1);
    const more = rows.length > n;
    const page = more ? rows.slice(0, n) : rows;
    const to = more ? page[page.length - 1]!.seq : seq;
    return { t: "ops", from: since + 1, to: Math.max(to, since), more, ops: page.map(wireRowFromOp) };
  }

  /** Records a cursor. Written at most once per 10 s per device (plan 15.3c). */
  ack(deviceId: string, seq: number, now: number, force = false): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0) return false;
    const last = this.lastAckWrite.get(deviceId);
    if (!force && last !== undefined && now - last < ACK_WRITE_INTERVAL_MS) return false;
    this.lastAckWrite.set(deviceId, now);
    this.sql.exec(`INSERT INTO client (device_id, ack_seq, last_seen_at, protocol) VALUES (?, ?, ?, 1)
      ON CONFLICT(device_id) DO UPDATE SET ack_seq = MAX(client.ack_seq, excluded.ack_seq)`, deviceId, Math.min(seq, this.maxSeq()), now);
    return true;
  }

  // MARK: bootstrap

  snapshot(afterLane: string, afterId: string, limit: number) {
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    const pinned = this.maxSeq();
    const rows = this.sql.exec<RowRecord>(
      "SELECT * FROM row WHERE (lane > ?) OR (lane = ? AND id > ?) ORDER BY lane, id LIMIT ?",
      afterLane, afterLane, afterId, n + 1);
    const more = rows.length > n;
    const page = more ? rows.slice(0, n) : rows;
    const last = page[page.length - 1];
    return {
      pinned_seq: pinned, epoch: this.epoch(), rows: page.map(wireRowFrom), more,
      next: more && last ? { after_lane: last.lane, after_id: last.id } : null,
    };
  }

  // MARK: digest

  async digest() {
    const out: Record<string, unknown> = {};
    for (const lane of LANE_ORDER) {
      const rows = this.sql.exec<RowRecord>("SELECT id, updated_at, deleted_at, payload FROM row WHERE lane = ? ORDER BY id", lane);
      out[lane] = await laneDigest(rows);
    }
    return { seq: this.maxSeq(), epoch: this.epoch(), lanes: out };
  }

  // MARK: reads for shares and blobs

  row(lane: string, id: string): WireRow | null {
    const r = this.sql.exec<RowRecord>("SELECT * FROM row WHERE lane = ? AND id = ?", lane, id)[0];
    return r ? wireRowFrom(r) : null;
  }

  /** Every live row a shared document reaches: the doc, its notes, their cards, media and regions. */
  sharedDocument(notebookId: string): { notebook: WireRow; notes: WireRow[]; cards: WireRow[]; media: WireRow[]; occlusions: WireRow[] } | null {
    const nb = this.row("notebook", notebookId);
    if (!nb || nb.env.deleted_at !== null) return null;
    const live = (lane: string, where: string, ...params: unknown[]) =>
      this.sql.exec<RowRecord>(`SELECT * FROM row WHERE lane = '${lane}' AND deleted_at IS NULL AND ${where}`, ...params).map(wireRowFrom);
    const notes = live("note", "json_extract(payload, '$.env.notebook_id') = ?", notebookId);
    const noteIds = notes.map((n) => n.id);
    const byNote = (lane: string) => noteIds.length === 0 ? [] : live(lane,
      `json_extract(payload, '$.env.note_id') IN (SELECT value FROM json_each(?))`, JSON.stringify(noteIds));
    return { notebook: nb, notes, cards: byNote("card"), media: byNote("media"), occlusions: byNote("occlusion") };
  }

  /** True when a live media row of a live note in this document names the sha. */
  documentHoldsSha(notebookId: string, sha: string): boolean {
    const r = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM row m JOIN row n ON n.lane = 'note' AND n.id = json_extract(m.payload, '$.env.note_id')
      WHERE m.lane = 'media' AND m.deleted_at IS NULL AND n.deleted_at IS NULL
        AND json_extract(m.payload, '$.env.bytes_sha') = ? AND json_extract(n.payload, '$.env.notebook_id') = ?`, sha, notebookId);
    return (r[0]?.n ?? 0) > 0;
  }

  /** Shas a live media or font row names: the attachment refcounts. */
  liveShas(): Map<string, number> {
    const rows = this.sql.exec<{ sha: string; n: number }>(`SELECT json_extract(payload, '$.env.bytes_sha') AS sha, COUNT(*) AS n
      FROM row WHERE lane IN ('media', 'font') AND deleted_at IS NULL GROUP BY sha`);
    return new Map(rows.map((r) => [r.sha, r.n]));
  }

  conflicts(limit = 100) {
    return this.sql.exec<Record<string, unknown>>(`SELECT id, seq, lane, row_id, substr(loser_device, 1, 6) AS loser_device,
      loser_updated, at, cleared_at FROM conflict ORDER BY at DESC LIMIT ?`, limit);
  }

  // MARK: maintenance

  /**
   * The daily compaction (PROTOCOL.md section 5, plan 6.7):
   * 1. superseded ops (a newer op for the same row exists) are deleted whatever
   *    their age; a cursor below them still converges on the newer op;
   * 2. ops older than 45 days AND at or below every recently seen device's
   *    cursor are deleted, and `retained_from` moves past them;
   * 3. tombstone rows older than 30 days are purged;
   * the newest op is never deleted, so the sequence never restarts.
   */
  compact(now: number): { superseded: number; aged: number; purged: number; retainedFrom: number } {
    return this.sql.transaction(() => {
      const max = this.maxSeq();
      const active = this.sql.exec<{ m: number | null }>(
        "SELECT MIN(ack_seq) AS m FROM client WHERE revoked_at IS NULL AND last_seen_at >= ?", now - OP_RETENTION_MS)[0]?.m;
      const ackFloor = active ?? max;
      const superseded = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM op WHERE seq <> ? AND EXISTS
        (SELECT 1 FROM op o2 WHERE o2.lane = op.lane AND o2.row_id = op.row_id AND o2.seq > op.seq)`, max)[0]!.n;
      this.sql.exec(`DELETE FROM op WHERE seq <> ? AND EXISTS
        (SELECT 1 FROM op o2 WHERE o2.lane = op.lane AND o2.row_id = op.row_id AND o2.seq > op.seq)`, max);
      const agedRows = this.sql.exec<{ s: number | null; n: number }>(
        "SELECT MAX(seq) AS s, COUNT(*) AS n FROM op WHERE at < ? AND seq <= ? AND seq <> ?", now - OP_RETENTION_MS, ackFloor, max)[0]!;
      if (agedRows.n > 0 && agedRows.s !== null) {
        this.sql.exec("DELETE FROM op WHERE at < ? AND seq <= ? AND seq <> ?", now - OP_RETENTION_MS, ackFloor, max);
        this.setMeta("retained_from", String(Math.max(this.retainedFrom(), agedRows.s + 1)));
      }
      const purged = this.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM row WHERE deleted_at IS NOT NULL AND updated_ms < ?", now - TOMBSTONE_PURGE_MS)[0]!.n;
      this.sql.exec("DELETE FROM row WHERE deleted_at IS NOT NULL AND updated_ms < ?", now - TOMBSTONE_PURGE_MS);
      this.sql.exec("DELETE FROM conflict WHERE at < ?", now - OP_RETENTION_MS);
      this.setMeta("seq_floor", String(max));
      return { superseded, aged: agedRows.n, purged, retainedFrom: this.retainedFrom() };
    });
  }

  /** The NDJSON body of a snapshot: meta, every row and every client. */
  *snapshotLines(): Generator<string> {
    yield JSON.stringify({ t: "meta", schema_version: this.meta("schema_version"), epoch: this.epoch(), seq: this.maxSeq(), retained_from: this.retainedFrom() });
    for (const lane of LANE_ORDER) {
      for (const r of this.sql.exec<RowRecord>("SELECT * FROM row WHERE lane = ? ORDER BY id", lane)) {
        yield JSON.stringify({ t: "row", ...wireRowFrom(r) });
      }
    }
    for (const c of this.sql.exec("SELECT device_id, ack_seq, last_seen_at, protocol, revoked_at FROM client")) {
      yield JSON.stringify({ t: "client", ...c });
    }
  }

  /**
   * Restores rows from a snapshot into an EMPTY object with a NEW epoch, so
   * every device is told to bootstrap (plan 6.8, FI-14). Each row becomes one
   * genesis op so the log is a complete catch-up source.
   */
  restoreFrom(lines: Iterable<string>, now: number): number {
    return this.sql.transaction(() => {
      const existing = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM row")[0]!.n;
      if (existing > 0) throw new Refused(409, "not_empty", "A snapshot is restored only into an empty library.");
      let seq = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line) as Record<string, unknown>;
        if (rec.t === "client") {
          this.sql.exec("INSERT OR REPLACE INTO client (device_id, ack_seq, last_seen_at, protocol, revoked_at) VALUES (?, 0, ?, ?, ?)",
            rec.device_id, rec.last_seen_at, rec.protocol, rec.revoked_at ?? null);
          continue;
        }
        if (rec.t !== "row") continue;
        const r = rec as unknown as WireRow;
        if (!Object.hasOwn(LANES, r.lane)) continue;
        seq++;
        const payload = canonical({ content: r.content, env: r.env });
        const ms = wireMillis(r.updated_at);
        if (ms === null) continue;
        this.sql.exec(`INSERT INTO op (seq, op_id, device_id, lane, row_id, kind, updated_at, payload, at) VALUES (?, ?, 'restore', ?, ?, ?, ?, ?, ?)`,
          seq, this.newId(), r.lane, r.id, r.kind, r.updated_at, payload, now);
        this.sql.exec(`INSERT INTO row (lane, id, updated_at, updated_ms, deleted_at, payload, seq, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'restore')`,
          r.lane, r.id, r.updated_at, ms, (r.env.deleted_at as string | null | undefined) ?? null, payload, seq);
      }
      this.setMeta("epoch", this.newId());
      this.setMeta("retained_from", "1");
      return seq;
    });
  }
}

export function wireRowFrom(r: RowRecord): WireRow {
  const p = JSON.parse(r.payload) as { env: Record<string, unknown>; content: Record<string, unknown> };
  return { seq: r.seq, lane: r.lane, id: r.id, kind: r.deleted_at === null ? "upsert" : "tombstone", updated_at: r.updated_at, env: p.env, content: p.content };
}

function wireRowFromOp(r: OpRecord): WireRow {
  const p = JSON.parse(r.payload) as { env: Record<string, unknown>; content: Record<string, unknown> };
  const row: WireRow = { seq: r.seq, op_id: r.op_id, lane: r.lane, id: r.row_id, kind: r.kind as WireRow["kind"], updated_at: r.updated_at, env: p.env, content: p.content };
  if (r.replaced_updated_at) row.replaced = { updated_at: r.replaced_updated_at, device: r.replaced_device ?? "" };
  return row;
}

/** Lane order first; inside the note lane a parent before its children. */
export function orderParentsFirst<T extends { op: PushOp }>(items: T[]): T[] {
  const rank = (lane: string) => LANE_ORDER.indexOf(lane);
  const sorted = [...items].sort((a, b) => rank(a.op.lane) - rank(b.op.lane));
  const notes = sorted.filter((x) => x.op.lane === "note");
  if (notes.length < 2) return sorted;
  const byId = new Map(notes.map((x) => [x.op.id, x]));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (x: T, depth: number) => {
    if (seen.has(x.op.id) || depth > notes.length) return;
    const parent = x.op.env.parent_id;
    if (typeof parent === "string" && byId.has(parent) && !seen.has(parent)) visit(byId.get(parent)!, depth + 1);
    if (!seen.has(x.op.id)) { seen.add(x.op.id); out.push(x); }
  };
  for (const x of notes) visit(x, 0);
  const firstNote = sorted.findIndex((x) => x.op.lane === "note");
  return [...sorted.slice(0, firstNote), ...out, ...sorted.slice(firstNote + notes.length)];
}

export async function laneDigest(rows: { id: string; updated_at: string; deleted_at: string | null; payload: string }[]) {
  const xor = new Uint8Array(16);
  let live = 0, tombstones = 0;
  let maxUpdated: string | null = null;
  let text = "";
  for (const r of rows) {
    if (r.deleted_at === null) {
      live++;
      const hex = r.id.replace(/-/g, "");
      for (let i = 0; i < 16; i++) xor[i]! ^= parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    } else {
      tombstones++;
    }
    if (maxUpdated === null || r.updated_at > maxUpdated) maxUpdated = r.updated_at;
    text += `${r.id}|${r.updated_at}|${r.payload}\n`;
  }
  const sha = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return {
    live, tombstones, max_updated_at: maxUpdated,
    id_xor: Array.from(xor, (b) => b.toString(16).padStart(2, "0")).join(""),
    content_sha: Array.from(sha, (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}
