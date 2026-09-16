// The TypeScript reference client for protocol 1.
//
// It is what the conformance suite, the fault injections and the synthetic
// soak drive, and it is the executable statement of what Recall's Swift client
// must do: dirty tracking, the acknowledgement rule, one push in flight, frame
// continuity, own-op discard, kept versions on a server verdict, bootstrap.
// Its store is in memory and every apply is atomic (built on a copy, then
// swapped), which is the in-memory form of "rows and cursor in one local
// transaction".

import { canonical, sha256Hex } from "../src/canonical.ts";
import { isNewer, wireMillis, wireTime } from "../src/isnewer.ts";
import { opId, payloadDigest } from "../src/opid.ts";
import { LANES, LANE_ORDER, type Outcome, type WireRow } from "../src/protocol.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LocalRow {
  lane: string;
  id: string;
  kind: "upsert" | "tombstone";
  updated_at: string;
  env: Record<string, unknown>;
  content: Record<string, unknown>;
  dirty: boolean;
  /** The seq of the server row this device last saw. */
  base_seq: number;
}

export interface KeptVersion { lane: string; id: string; updated_at: string; content: Record<string, unknown>; reason: "conflict" | "overwritten" }

export interface Faults {
  /** Called after a push body is sent and before its ack is read. True drops the ack. */
  dropAck?: () => boolean;
  /** Called before an apply commits. True abandons it (a crash mid-apply). */
  crashMidApply?: () => boolean;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(`${status} ${String(body.error ?? "")}`);
    this.status = status;
    this.body = body;
  }
}

const key = (lane: string, id: string) => `${lane}:${id}`;

export class ReferenceClient {
  rows = new Map<string, LocalRow>();
  kept: KeptVersion[] = [];
  cursor = 0;
  epoch: string | null = null;
  issued = new Set<string>();
  inFlight = false;
  stats = { pushes: 0, requeued: 0, applied: 0, duplicate: 0, stale: 0, conflict: 0, rejected: 0, gaps: 0, bootstraps: 0, requests: 0 };
  faults: Faults = {};
  private clockSkewMs = 0;

  readonly base: string;
  readonly deviceId: string;
  token: string;
  private fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(base: string, deviceId: string, token: string, fetchFn: FetchLike, now: () => number = () => Date.now()) {
    this.base = base;
    this.deviceId = deviceId;
    this.token = token;
    this.fetchFn = fetchFn;
    this.now = now;
  }

  setClockSkew(ms: number): void { this.clockSkewMs = ms; }

  // MARK: local edits

  private stamp(previous?: string): string {
    const now = this.now() + this.clockSkewMs;
    const prev = previous ? wireMillis(previous)! : -Infinity;
    return wireTime(now > prev ? now : prev + 1);
  }

  /** Writes a full row locally, as the app's commit does. */
  upsert(lane: string, id: string, env: Record<string, unknown>, content: Record<string, unknown>): LocalRow {
    const existing = this.rows.get(key(lane, id));
    const spec = LANES[lane]!;
    const fullEnv = { ...env };
    if ("deleted_at" in spec.env) fullEnv.deleted_at = null;
    const row: LocalRow = {
      lane, id, kind: "upsert", updated_at: spec.stampColumn ? String(env[spec.stampColumn]) : this.stamp(existing?.updated_at),
      env: fullEnv, content, dirty: true, base_seq: existing?.base_seq ?? 0,
    };
    this.rows.set(key(lane, id), row);
    return row;
  }

  /** Mutates a row in the SAME millisecond it already carries (the non-touch() write paths, F-23). */
  mutateWithoutStamp(lane: string, id: string, mutate: (r: LocalRow) => void): void {
    const r = this.rows.get(key(lane, id));
    if (!r) throw new Error("no such row");
    mutate(r);
    r.dirty = true;
  }

  tombstone(lane: string, id: string): LocalRow {
    const existing = this.rows.get(key(lane, id));
    if (!existing) throw new Error("no such row");
    const at = this.stamp(existing.updated_at);
    const row: LocalRow = { ...existing, kind: "tombstone", updated_at: at, env: { ...existing.env, deleted_at: at }, content: {}, dirty: true };
    this.rows.set(key(lane, id), row);
    return row;
  }

  get(lane: string, id: string): LocalRow | undefined { return this.rows.get(key(lane, id)); }

  dirtyRows(): LocalRow[] { return [...this.rows.values()].filter((r) => r.dirty); }

  // MARK: transport

  async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    this.stats.requests++;
    const res = await this.fetchFn(this.base + path, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!res.ok) throw new HttpError(res.status, json);
    return json;
  }

  // MARK: hello

  async hello(): Promise<Record<string, unknown>> {
    const ok = await this.request("POST", "/v1/hello", {
      t: "hello", pv: 1, device: this.deviceId, since: this.cursor, schema: 219, app: "reference", ...(this.epoch ? { epoch: this.epoch } : {}),
    });
    if (ok.resync === true) await this.bootstrap();
    else if (this.epoch === null) this.epoch = String(ok.epoch);
    return ok;
  }

  // MARK: push

  private opFor(r: LocalRow) {
    const op: Record<string, unknown> = { lane: r.lane, id: r.id, kind: r.kind, updated_at: r.updated_at, base_seq: r.base_seq, env: r.env };
    if (r.kind === "upsert") op.content = r.content;
    return op;
  }

  /** Builds a batch from dirty rows. Captures (updated_at, digest) per row. */
  async buildBatch(max = 500) {
    const dirty = this.dirtyRows().sort((a, b) => LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane)).slice(0, max);
    const ops: Record<string, unknown>[] = [];
    const capture = new Map<string, { key: string; updated_at: string; digest: string }>();
    for (const r of dirty) {
      const op = this.opFor(r);
      const digest = await payloadDigest(op as never);
      const id = await opId({ device: this.deviceId, lane: r.lane, id: r.id, updated_at: r.updated_at, env: r.env, ...(r.kind === "upsert" ? { content: r.content } : {}) });
      op.op_id = id;
      ops.push(op);
      capture.set(id, { key: key(r.lane, r.id), updated_at: r.updated_at, digest });
    }
    return { batch: crypto.randomUUID(), ops, capture };
  }

  /** One push. Returns "requeued" if one is already in flight (race X1). */
  async push(): Promise<"requeued" | "empty" | "sent" | "lost"> {
    if (this.inFlight) { this.stats.requeued++; return "requeued"; }
    if (this.dirtyRows().length === 0) return "empty";
    this.inFlight = true;
    try {
      const b = await this.buildBatch();
      for (const id of b.capture.keys()) this.issued.add(id);
      this.stats.pushes++;
      let ack: Record<string, unknown>;
      try {
        ack = await this.request("POST", "/v1/push", { t: "push", batch: b.batch, ops: b.ops });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        return "lost";
      }
      if (this.faults.dropAck?.()) return "lost";
      await this.handleAck(ack.results as Outcome[], b.capture);
      return "sent";
    } finally {
      this.inFlight = false;
    }
  }

  /** The acknowledgement rule (PROTOCOL.md section 4). */
  async handleAck(results: Outcome[], capture: Map<string, { key: string; updated_at: string; digest: string }>): Promise<void> {
    for (const r of results) {
      const cap = capture.get(r.op_id);
      if (r.outcome === "rejected") { this.stats.rejected++; continue; }
      if (!cap) continue;
      const row = this.rows.get(cap.key);
      if (r.outcome === "applied" || r.outcome === "duplicate") {
        this.stats[r.outcome]++;
        if (!row) continue;
        const current = await payloadDigest(this.opFor(row) as never);
        if (row.updated_at === cap.updated_at && current === cap.digest) {
          row.dirty = false;
          row.base_seq = Math.max(row.base_seq, r.seq);
        }
        continue;
      }
      this.stats[r.outcome]++;
      if (!row) continue;
      const current = await payloadDigest(this.opFor(row) as never);
      const unchanged = row.updated_at === cap.updated_at && current === cap.digest;
      if (!unchanged) {
        // A newer local mutation exists: it stays dirty and races again.
        row.base_seq = Math.max(row.base_seq, r.winner.seq);
        if (r.outcome === "conflict") this.kept.push({ lane: row.lane, id: row.id, updated_at: cap.updated_at, content: row.content, reason: "conflict" });
        continue;
      }
      if (r.outcome === "conflict") this.kept.push({ lane: row.lane, id: row.id, updated_at: row.updated_at, content: row.content, reason: "conflict" });
      this.rows.set(cap.key, fromWire(r.winner));
    }
  }

  // MARK: apply

  /** Applies one ops frame atomically. Returns false on a gap. */
  async applyFrame(frame: { from: number; to: number; ops: WireRow[] }): Promise<boolean> {
    if (frame.from > this.cursor + 1) { this.stats.gaps++; return false; }
    const next = new Map(this.rows);
    const kept: KeptVersion[] = [];
    const ops = [...frame.ops].sort((a, b) => a.seq - b.seq);
    for (const op of ops) {
      if (op.seq <= this.cursor) continue;
      if (op.op_id && this.issued.has(op.op_id)) {
        const mine = next.get(key(op.lane, op.id));
        if (mine) next.set(key(op.lane, op.id), { ...mine, base_seq: Math.max(mine.base_seq, op.seq) });
        continue;
      }
      applyRemote(next, op, kept);
    }
    if (this.faults.crashMidApply?.()) return true;
    this.rows = next;
    this.kept.push(...kept);
    this.cursor = Math.max(this.cursor, frame.to);
    return true;
  }

  /** Pulls until drained. Bootstraps on a retention gap. */
  async pull(limit = 500): Promise<number> {
    let frames = 0;
    for (;;) {
      let frame: Record<string, unknown>;
      try {
        frame = await this.request("GET", `/v1/pull?since=${this.cursor}&limit=${limit}`);
      } catch (e) {
        if (e instanceof HttpError && e.body.error === "resync_required") { await this.bootstrap(); continue; }
        throw e;
      }
      frames++;
      const ok = await this.applyFrame(frame as never);
      if (!ok) continue;
      if (frame.more !== true) break;
    }
    return frames;
  }

  async ack(): Promise<void> {
    await this.request("POST", "/v1/ack", { seq: this.cursor });
  }

  /** Pages the row table, then catches up from the pinned seq. Dirty local rows survive. */
  async bootstrap(): Promise<void> {
    this.stats.bootstraps++;
    const next = new Map<string, LocalRow>();
    for (const r of this.dirtyRows()) next.set(key(r.lane, r.id), { ...r, base_seq: 0 });
    let after = { after_lane: "", after_id: "" };
    let pinned: number | null = null;
    let epoch = "";
    for (;;) {
      const page = await this.request("GET", `/v1/snapshot?after_lane=${encodeURIComponent(after.after_lane)}&after_id=${encodeURIComponent(after.after_id)}&limit=500`);
      if (pinned === null) { pinned = Number(page.pinned_seq); epoch = String(page.epoch); }
      const kept: KeptVersion[] = [];
      for (const row of page.rows as WireRow[]) applyRemote(next, row, kept);
      this.kept.push(...kept);
      if (page.more !== true) break;
      after = page.next as typeof after;
    }
    this.rows = next;
    this.cursor = pinned ?? 0;
    this.epoch = epoch;
    this.issued.clear();
  }

  // MARK: digest

  async digest() {
    const out: Record<string, unknown> = {};
    for (const lane of LANE_ORDER) {
      const rows = [...this.rows.values()].filter((r) => r.lane === lane).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => ({ id: r.id, updated_at: r.updated_at, deleted_at: (r.env.deleted_at as string | null | undefined) ?? null,
          payload: canonical({ content: r.kind === "tombstone" ? {} : r.content, env: r.env }) }));
      const { laneDigest } = await import("../src/library-core.ts");
      out[lane] = await laneDigest(rows);
    }
    return out;
  }
}

export function fromWire(w: WireRow): LocalRow {
  return { lane: w.lane, id: w.id, kind: w.kind, updated_at: w.updated_at, env: w.env, content: w.content, dirty: false, base_seq: w.seq };
}

/** The client's applier: the log's order wins; a dirty local row newer than the remote one survives; an overwritten dirty row is kept. */
export function applyRemote(rows: Map<string, LocalRow>, op: WireRow, kept: KeptVersion[]): void {
  const k = key(op.lane, op.id);
  const local = rows.get(k);
  if (!local) { rows.set(k, fromWire(op)); return; }
  // The server says this op replaced a concurrent revision. If that revision
  // is the one this device holds, keep it: the row was clean, so no local
  // dirty flag would ever have noticed (plan F-22).
  if (op.replaced && local.updated_at === op.replaced.updated_at && local.kind === "upsert"
      && canonical(local.content) !== canonical(op.content)) {
    kept.push({ lane: local.lane, id: local.id, updated_at: local.updated_at, content: local.content, reason: "conflict" });
    rows.set(k, fromWire(op));
    return;
  }
  if (op.seq <= local.base_seq && !local.dirty) return;
  if (local.dirty) {
    if (isNewer(local.updated_at, op.updated_at)) {
      rows.set(k, { ...local, base_seq: Math.max(local.base_seq, op.seq) });
      return;
    }
    if (canonical(local.content) !== canonical(op.content) && local.kind === "upsert") {
      kept.push({ lane: local.lane, id: local.id, updated_at: local.updated_at, content: local.content, reason: "overwritten" });
    }
  }
  rows.set(k, fromWire(op));
}

export async function contentDigest(rows: LocalRow[]): Promise<string> {
  return sha256Hex(rows.map((r) => `${r.lane}|${r.id}|${r.updated_at}`).sort().join("\n"));
}
