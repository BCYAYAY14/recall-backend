// Fault injection, plan 13.6 strand 2: the faults the soak does not inject
// (D50), each driven N times against a backend holding SYNTHETIC data only.
//
//   node tools/faults.ts <env file> pair <count>     pair fault devices (waits on the pair limiter)
//   node tools/faults.ts <env file> FI-6 [n]         an ack delivered out of order (A5)
//   node tools/faults.ts <env file> FI-7 [n]         the same op over WebSocket and HTTP (X4)
//   node tools/faults.ts <env file> FI-8 [n]         a real 429 from the push limiter mid-session
//   node tools/faults.ts <env file> FI-9 [n]         a revoke raced against a push (X6)
//   node tools/faults.ts <env file> FI-13 [n]        a multipart upload cut mid-part, resumed
//   node tools/faults.ts <env file> FI-14 [n]        the library object deleted, restored from R2
//   node tools/faults.ts <env file> FI-15 [n] <sever seconds> [first fault device] [device count]
//   node tools/faults.ts <env file> revoke-faults    revoke every fault device and forget its token
//
// The env file is the conformance tool's (RECALL_CF_DEV_URL, the owner token,
// RECALL_CF_DEV_POOL_<i>); fault devices are appended as RECALL_CF_DEV_FAULT_<i>.
// Prints counts and timings only: no token, no row content. Every row this
// tool writes lives in a doc it creates, and every row it writes names a
// parent that exists (so does the soak's generator since D-144).
// FI-14 stops and restarts a LOCAL `wrangler dev` (FI14_WRANGLER_CMD,
// FI14_DO_DIR) and refuses any other backend.

import { readFileSync, writeFileSync, chmodSync, readdirSync, rmSync, openSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { HttpError, ReferenceClient, type FetchLike, type LocalRow } from "../client/reference-client.ts";
import { canonical } from "../src/canonical.ts";
import { payloadDigest } from "../src/opid.ts";
import { LANE_ORDER } from "../src/protocol.ts";

const [file, command, ...rest] = process.argv.slice(2);
if (!file || !command) { console.error("usage: node tools/faults.ts <env file> <command> [args]"); process.exit(2); }
const readVars = () => new Map(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const vars = readVars();
const base = vars.get("RECALL_CF_DEV_URL")!;
const owner = vars.get("RECALL_CF_DEV_OWNER_TOKEN")!;
// Two runs may pair devices at once (the pairing run and FI-9), so a save
// re-reads the file and writes only the keys THIS run changed.
const changed = new Map<string, string | null>();
function setVar(k: string, v: string | null) {
  if (v === null) vars.delete(k); else vars.set(k, v);
  changed.set(k, v);
  const current = readVars();
  for (const [ck, cv] of changed) { if (cv === null) current.delete(ck); else current.set(ck, cv); }
  writeFileSync(file, [...current].map(([ck, cv]) => `${ck}=${cv}`).join("\n") + "\n");
  chmodSync(file, 0o600);
}

const rnd = (n: number) => Math.floor(Math.random() * n);
const chance = (p: number) => Math.random() < p;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const T0 = "2026-09-27T00:00:00.000Z";
const failures: string[] = [];
function check(cond: unknown, message: string): boolean {
  if (!cond) { failures.push(message); console.log(`  FAIL ${message}`); }
  return !!cond;
}

const requestTimes: number[] = [];
// The push limiter (120 pushes a device a minute) is not the fault under test
// outside FI-8: a push it refuses waits and goes again, as the app's does, and
// the waits are counted.
const rateWaits = { n: 0 };
const timed: FetchLike = async (input, init) => {
  for (;;) {
    const t = performance.now();
    const r = await fetch(input, init);
    requestTimes.push(performance.now() - t);
    if (r.status === 429 && command !== "FI-8" && String(input).endsWith("/v1/push")) {
      rateWaits.n++;
      await r.arrayBuffer();
      await sleep(5_000);
      continue;
    }
    return r;
  }
};

function pct(xs: number[], p: number): string {
  if (xs.length === 0) return "-";
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(0);
}
const summary = (label: string, xs: number[]) => `${label} p50 ${pct(xs, 50)} ms, p95 ${pct(xs, 95)} ms, max ${pct(xs, 100)} ms over ${xs.length}`;

async function ownerCall(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${owner}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 80) }; }
  return { status: r.status, json };
}

function pool(slot: number): { id: string; token: string } {
  const [id, token] = vars.get(`RECALL_CF_DEV_POOL_${slot}`)!.split(":");
  return { id: id!, token: token! };
}
function faultDevices(): { slot: number; id: string; token: string }[] {
  const out = [];
  for (const [k, v] of readVars()) {
    const m = /^RECALL_CF_DEV_FAULT_(\d+)$/.exec(k);
    if (m) { const [id, token] = v.split(":"); out.push({ slot: Number(m[1]), id: id!, token: token! }); }
  }
  return out.sort((a, b) => a.slot - b.slot);
}
const client = (d: { id: string; token: string }, f: FetchLike = timed) => new ReferenceClient(base, d.id, d.token, f);

/** Pairs `id` (a new device, or a revoked one: pairing un-revokes it). Waits on the pair limiter. */
async function pairDevice(id: string, label: string): Promise<string> {
  for (;;) {
    const begun = await ownerCall("POST", "/v1/pair/begin", {});
    if (begun.status !== 200) throw new Error(`pair/begin answered ${begun.status}`);
    const headers: Record<string, string> = { "content-type": "application/json" };
    // A LOCAL Worker trusts this header (Cloudflare sets it in front of a deployed one), so a local run is not held by the hourly pair limit.
    if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) headers["cf-connecting-ip"] = `198.51.100.${rnd(250)}`;
    const r = await fetch(base + "/v1/pair/claim", { method: "POST", headers, body: JSON.stringify({ code: begun.json.code, device_id: id, label, platform: "mac" }) });
    const json = await r.json() as Record<string, unknown>;
    if (r.status === 200) return String(json.token);
    if (r.status === 429) {
      const wait = Number(json.retry_after_ms ?? json.retryAfterMs ?? 0) || 5 * 60_000;
      console.log(`pair limiter: waiting ${Math.round(wait / 1000)} s`);
      await sleep(Math.min(wait + 2_000, 30 * 60_000));
      continue;
    }
    throw new Error(`pair/claim answered ${r.status} ${String(json.error)}`);
  }
}

// MARK: synthetic rows, every parent real

function notebookEnv() { return { folder_id: null, position: 0, created_at: T0, exam_at: null, retention_pct: null, new_per_day: null }; }
function noteEnv(doc: string, position: number) { return { notebook_id: doc, parent_id: null, position, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: T0 }; }
function noteContent(tag: string) { return { front: `fault ${tag} ${rnd(1e9)}${chance(0.1) ? " émoji 😀" : ""}`, back: null, cloze_text: null, tags: "", spans: null, attrs: null }; }

async function newDoc(c: ReferenceClient): Promise<string> {
  const doc = uuid();
  c.upsert("notebook", doc, notebookEnv(), { name: `Fault run ${command}`, emoji: "x", style: null });
  await c.push();
  return doc;
}
function editNote(c: ReferenceClient, doc: string, id = uuid(), tag = "edit"): string {
  c.upsert("note", id, noteEnv(doc, rnd(1_000_000)), noteContent(tag));
  return id;
}
const rowKey = (r: LocalRow | undefined) => r ? `${r.kind}|${r.updated_at}|${canonical({ env: r.env, content: r.content })}` : "absent";
const same = (a: ReferenceClient, b: ReferenceClient, lane: string, id: string) => rowKey(a.get(lane, id)) === rowKey(b.get(lane, id));

/** Pushes and pulls until nothing is dirty and a further push has nothing to send. */
async function quiesce(...cs: ReferenceClient[]) {
  for (let round = 0; round < 20; round++) {
    for (const c of cs) await c.push();
    for (const c of cs) await c.pull();
    if (cs.every((c) => c.dirtyRows().length === 0)) {
      const again = [];
      for (const c of cs) again.push(await c.push());
      if (again.every((x) => x === "empty")) { for (const c of cs) await c.pull(); return; }
    }
  }
  throw new Error("did not quiesce in 20 rounds");
}

/** Every client's digest against the server's, lane by lane. */
// Another run may write to the same library between the quiesce and the read
// (FI-8 and FI-9 run beside the others on a shared dev backend), so a
// mismatch is retried after a fresh quiesce, up to five times, and the
// attempt that settled it is printed.
async function digestCheck(label: string, ...cs: ReferenceClient[]): Promise<boolean> {
  let bad: string[] = [];
  let rows = 0, attempt = 0;
  for (attempt = 1; attempt <= 5; attempt++) {
    await quiesce(...cs);
    const server = (await cs[0]!.request("GET", "/v1/digest")).lanes as Record<string, unknown>;
    bad = [];
    for (const [i, c] of cs.entries()) {
      const d = await c.digest();
      for (const lane of Object.keys(server)) if (JSON.stringify(d[lane]) !== JSON.stringify(server[lane])) bad.push(`${i}.${lane}`);
    }
    rows = Object.values(server).reduce((n: number, d) => n + ((d as { live?: number }).live ?? 0) + ((d as { tombstones?: number }).tombstones ?? 0), 0);
    if (bad.length === 0) break;
    await sleep(3_000);
  }
  console.log(`${label}: digest ${bad.length === 0 ? "EXACT" : "MISMATCH " + bad.slice(0, 8).join(",")} over ${cs.length} clients, rows ${rows}, attempt ${Math.min(attempt, 5)}`);
  return check(bad.length === 0, `${label}: digests differ (${bad.slice(0, 8).join(",")})`);
}

async function start(slots = [0, 1]) {
  const cs = slots.map((s) => client(pool(s)));
  for (const c of cs) { await c.hello(); await c.pull(); }
  const doc = await newDoc(cs[0]!);
  for (const c of cs) await c.pull();
  return { cs, doc };
}

// MARK: WebSocket, for FI-7 and FI-15

/** Node's WebSocket (undici), which takes headers; the Workers types describe another one. */
interface NodeSocket {
  readyState: number;
  onmessage: ((e: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  send(s: string): void;
  close(): void;
}

class Socket {
  ws: NodeSocket;
  inbox: Record<string, unknown>[] = [];
  waiters: (() => void)[] = [];
  onOps?: (f: Record<string, unknown>) => void;
  constructor(token: string) {
    this.ws = new (globalThis as unknown as { WebSocket: new (u: string, o: unknown) => NodeSocket }).WebSocket(base.replace(/^http/, "ws") + "/v1/sync", { headers: { authorization: `Bearer ${token}` }, protocols: ["recall.v1"] });
    this.ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (f.t === "ops" && this.onOps) this.onOps(f);
      else this.inbox.push(f);
      this.waiters.splice(0).forEach((w) => w());
    };
  }
  async open() {
    if (this.ws.readyState === 1) return;
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error("socket failed")); });
  }
  send(body: unknown) { this.ws.send(JSON.stringify(body)); }
  async next(pred: (f: Record<string, unknown>) => boolean, timeout = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const i = this.inbox.findIndex(pred);
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("socket timeout");
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, left); });
    }
  }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

// MARK: FI-6, an ack delivered out of order

async function fi6(n: number) {
  const { cs: [a, b], doc } = await start([0, 1]);
  let outOfOrder = 0, wrongClean = 0;
  for (let it = 0; it < n; it++) {
    const r = editNote(a!, doc, uuid(), "fi6-base");
    await a!.push(); await b!.pull();
    const k = 2 + rnd(2);
    const inflight: { results: never; capture: Map<string, { key: string; updated_at: string; digest: string }>; updated_at: string }[] = [];
    for (let i = 0; i < k; i++) {
      editNote(a!, doc, r, `fi6-rev${i}`);
      if (chance(0.3)) editNote(a!, doc, uuid(), "fi6-side");
      const batch = await a!.buildBatch();
      for (const id of batch.capture.keys()) a!.issued.add(id);
      const ack = await a!.request("POST", "/v1/push", { t: "push", batch: batch.batch, ops: batch.ops });
      inflight.push({ results: ack.results as never, capture: batch.capture, updated_at: a!.get("note", r)!.updated_at });
    }
    if (chance(0.5)) editNote(a!, doc, r, "fi6-unsent");
    // A random delivery order that is never the send order.
    let order: number[];
    do { order = [...inflight.keys()].sort(() => Math.random() - 0.5); } while (order.every((v, i) => v === i));
    let newestDelivered = -1;
    for (const j of order) {
      if (j < newestDelivered) outOfOrder++;
      newestDelivered = Math.max(newestDelivered, j);
      const before = a!.get("note", r)!;
      const beforeDigest = await payloadDigest({ lane: before.lane, id: before.id, kind: before.kind, updated_at: before.updated_at, base_seq: before.base_seq, env: before.env, content: before.content } as never);
      const carries = before.updated_at === inflight[j]!.updated_at;
      await a!.handleAck(inflight[j]!.results, inflight[j]!.capture);
      // FAULTS_NEGATIVE=1: a client that cleans on ANY applied ack (the rule A5 forbids). The run must fail.
      if (process.env.FAULTS_NEGATIVE === "1") a!.get("note", r)!.dirty = false;
      const after = a!.get("note", r)!;
      if (!carries) {
        // A5: an ack for a revision the row no longer carries cleans nothing and changes nothing.
        const unchanged = after.dirty === before.dirty && after.updated_at === before.updated_at && canonical(after.content) === canonical(before.content);
        if (!unchanged) wrongClean++;
        check(unchanged, `FI-6 it ${it}: the ack for revision ${j} of ${k} touched a row carrying another revision`);
      }
      void beforeDigest;
    }
    await quiesce(a!, b!);
    check(same(a!, b!, "note", r) && !a!.get("note", r)!.dirty, `FI-6 it ${it}: the row did not converge clean`);
    await sleep(500);
  }
  await digestCheck("FI-6 end", a!, b!);
  console.log(`FI-6: ${n} iterations, ${outOfOrder} acks delivered after a newer revision's ack, ${wrongClean} wrongly cleaned or changed`);
}

// MARK: FI-7, the same op over WebSocket and HTTP

async function fi7(n: number) {
  const { cs: [a, b], doc } = await start([0, 1]);
  const sa = new Socket(pool(0).token), sb = new Socket(pool(1).token);
  await sa.open(); await sb.open();
  const fanout: Record<string, unknown>[] = [];
  sb.onOps = (f) => fanout.push(f);
  let pushedTwice = 0, receivedTwice = 0;
  for (let it = 0; it < n; it++) {
    await b!.pull();
    const ids = Array.from({ length: 1 + rnd(3) }, () => editNote(a!, doc, uuid(), "fi7"));
    const batch = await a!.buildBatch();
    for (const id of batch.capture.keys()) a!.issued.add(id);
    const frame = { t: "push", batch: batch.batch, ops: batch.ops };
    const httpFirst = chance(0.5);
    const gap = rnd(20);
    const viaHttp = (async () => { if (!httpFirst) await sleep(gap); return a!.request("POST", "/v1/push", frame); })();
    const viaWs = (async () => {
      if (httpFirst) await sleep(gap);
      for (;;) {
        sa.send(frame);
        const f = await sa.next((x) => (x.t === "push_ack" && x.batch === batch.batch) || x.t === "limit");
        if (f.t === "push_ack") return f;
        rateWaits.n++;
        await sleep(5_000);
      }
    })();
    const [h, w] = await Promise.all([viaHttp, viaWs]);
    pushedTwice++;
    const hr = h.results as { op_id: string; outcome: string; seq?: number }[];
    const wr = w.results as { op_id: string; outcome: string; seq?: number }[];
    for (const op of batch.ops) {
      const x = hr.find((r) => r.op_id === op.op_id), y = wr.find((r) => r.op_id === op.op_id);
      const outcomes = [x?.outcome, y?.outcome].sort().join(",");
      check(outcomes === "applied,duplicate" && x?.seq === y?.seq, `FI-7 it ${it}: one op over two transports answered ${outcomes}, seqs ${x?.seq} ${y?.seq}`);
    }
    for (const ack of chance(0.5) ? [h, w] : [w, h]) await a!.handleAck(ack.results as never, batch.capture);
    check(ids.every((id) => !a!.get("note", id)!.dirty), `FI-7 it ${it}: a doubly acknowledged row stayed dirty`);
    // Receive side: the fan-out and an HTTP pull carry the same ops; the second delivery changes nothing.
    const seqs = hr.map((r) => r.seq!).filter((s) => s !== undefined);
    const top = Math.max(...seqs);
    const deadline = Date.now() + 10_000;
    while (!fanout.some((f) => Number(f.to) >= top) && Date.now() < deadline) await sleep(20);
    const frames = fanout.splice(0);
    const pulled = await b!.request("GET", `/v1/pull?since=${b!.cursor}&limit=500`);
    const deliveries = chance(0.5) ? [...frames, pulled] : [pulled, ...frames];
    let applied = 0;
    for (const f of deliveries) {
      const cursor = b!.cursor;
      const snap = ids.map((id) => rowKey(b!.get("note", id))).join("\n");
      const ok = await b!.applyFrame(f as never);
      if (!ok) { await b!.pull(); continue; }
      if (b!.cursor !== cursor || ids.map((id) => rowKey(b!.get("note", id))).join("\n") !== snap) applied++;
    }
    receivedTwice++;
    await b!.pull();
    check(ids.every((id) => same(a!, b!, "note", id)), `FI-7 it ${it}: the receiver differs after two deliveries`);
    // The server's log holds each op once.
    const log = await b!.request("GET", `/v1/pull?since=${Math.min(...seqs) - 1}&limit=500`);
    const opIds = new Set(batch.ops.map((o) => String(o.op_id)));
    const occurrences = (log.ops as { op_id?: string }[]).filter((o) => o.op_id && opIds.has(o.op_id)).length;
    check(occurrences <= opIds.size, `FI-7 it ${it}: the log holds ${occurrences} ops for ${opIds.size} op ids`);
    void applied;
    await sleep(500);
  }
  sa.close(); sb.close();
  await digestCheck("FI-7 end", a!, b!);
  console.log(`FI-7: ${pushedTwice} frames pushed over both transports, ${receivedTwice} op sets received over both`);
}

// MARK: FI-8, the push limiter answers 429 mid-session

async function fi8(n: number, slots: number[]) {
  const reader = client(pool(1));
  await reader.hello(); await reader.pull();
  const doc = await newDoc(reader);
  const resumes: number[] = [];
  let injected = 0, emptyRefusals = 0;
  let next = 0;
  async function worker(slot: number) {
    const c = client(pool(slot));
    await c.hello();
    while (next < n) {
      const it = next++;
      // A random number of ordinary pushes, then empty frames fill the device's minute.
      for (let i = rnd(3); i > 0; i--) { editNote(c, doc, uuid(), "fi8-before"); await c.push(); }
      for (let i = 0; i < 130; i++) {
        try { await c.request("POST", "/v1/push", { t: "push", batch: uuid(), ops: [] }); } catch (e) {
          if (e instanceof HttpError && e.status === 429) { emptyRefusals++; break; }
          throw e;
        }
      }
      const ids = Array.from({ length: 1 + rnd(5) }, () => editNote(c, doc, uuid(), "fi8"));
      const before = ids.map((id) => rowKey(c.get("note", id))).join("\n");
      let refusedAt = 0;
      try { await c.push(); } catch (e) {
        if (e instanceof HttpError && e.status === 429) {
          refusedAt = Date.now();
          injected++;
          check(e.body.service === "push_rate", `FI-8 it ${it}: the 429 named ${String(e.body.service)}`);
        } else throw e;
      }
      if (!check(refusedAt > 0, `FI-8 it ${it}: the push after a full minute was not refused`)) continue;
      check(ids.every((id) => c.get("note", id)!.dirty) && ids.map((id) => rowKey(c.get("note", id))).join("\n") === before, `FI-8 it ${it}: a refused row was cleaned or changed`);
      const t = performance.now();
      const extra = editNote(c, doc, uuid(), "fi8-while-limited");
      const editMs = performance.now() - t;
      check(editMs < 16 && c.get("note", extra)!.dirty, `FI-8 it ${it}: editing while limited took ${editMs.toFixed(1)} ms`);
      for (;;) {
        await sleep(2_000);
        try { await c.push(); break; } catch (e) { if (!(e instanceof HttpError && e.status === 429)) throw e; }
      }
      resumes.push(Date.now() - refusedAt);
      await quiesce(c);
      await reader.pull();
      check([...ids, extra].every((id) => same(c, reader, "note", id) && !c.get("note", id)!.dirty), `FI-8 it ${it}: rows did not arrive after the reset`);
    }
  }
  await Promise.all(slots.map(worker));
  console.log(`FI-8: ${injected} real 429 push_rate refusals of a push carrying dirty rows (${emptyRefusals} more on the filler frames); ${summary("resumed after", resumes)}`);
}

// MARK: FI-9, a revoke raced against a push

async function fi9(n: number, victimSlot: number) {
  const reader = client(pool(1));
  await reader.hello(); await reader.pull();
  const doc = await newDoc(reader);
  const key = `RECALL_CF_DEV_FAULT_${victimSlot}`;
  if (!vars.get(key)) { const id = uuid(); setVar(key, `${id}:${await pairDevice(id, `Fault device ${victimSlot}`)}`); }
  let refused = 0, raced = 0, landedFirst = 0, authRefusals = 0;
  for (let it = 0; refused < n; it++) {
    const [id, token] = vars.get(key)!.split(":");
    const v = client({ id: id!, token: token! });
    await v.hello();
    const m = 1 + rnd(20);
    const ids = Array.from({ length: m }, () => editNote(v, doc, uuid(), "fi9"));
    // Locally a push takes 3 ms; over the internet about 60, so the live race spreads the push wider.
    const live = !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base);
    const pushDelay = live ? rnd(150) : rnd(40), revokeDelay = live ? rnd(20) : rnd(25);
    raced++;
    const [pushed] = await Promise.all([
      (async () => { await sleep(pushDelay); try { return await v.push(); } catch (e) { return e; } })(),
      (async () => { await sleep(revokeDelay); const r = await ownerCall("DELETE", `/v1/devices/${id}`); if (r.status !== 200) throw new Error(`revoke answered ${r.status}`); })(),
    ]);
    await reader.pull();
    const onServer = ids.filter((x) => reader.get("note", x) !== undefined).length;
    if (pushed instanceof HttpError && pushed.status === 401) {
      refused++;
      if (pushed.body.error === "revoked") authRefusals++;
      check(onServer === 0, `FI-9 it ${it}: ${onServer} of ${m} rows of a refused frame reached the server`);
      check(ids.every((x) => v.get("note", x)!.dirty), `FI-9 it ${it}: a refused row was cleaned`);
    } else if (pushed === "sent") {
      landedFirst++;
      check(onServer === m, `FI-9 it ${it}: an accepted frame landed ${onServer} of ${m} rows`);
    } else {
      check(false, `FI-9 it ${it}: the push answered ${String(pushed)}`);
    }
    // Pair the same id again (it un-revokes), then the refused rows go and nothing was lost.
    const fresh = await pairDevice(id!, `Fault device ${victimSlot}`);
    setVar(key, `${id}:${fresh}`);
    v.token = fresh;
    await quiesce(v);
    await reader.pull();
    check(ids.every((x) => same(v, reader, "note", x)), `FI-9 it ${it}: the rows did not arrive after pairing again`);
    if (refused % 5 === 0 && pushed instanceof HttpError) console.log(`FI-9 progress: ${refused} refused, ${landedFirst} landed before the revoke`);
  }
  console.log(`FI-9: ${raced} races, ${refused} pushes refused 401 revoked (frame whole: 0 rows landed each time), ${landedFirst} landed whole before the revoke`);
  void key;
}

// MARK: FI-13, a multipart upload cut mid-part and resumed

const PART = 5 * 1024 * 1024;
function putPart(path: string, body: Buffer, token: string, cutAt?: number): Promise<number> {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method: "PUT", headers: { authorization: `Bearer ${token}`, "content-length": String(body.length), "content-type": "application/octet-stream" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", (e) => (cutAt !== undefined ? resolve(-1) : reject(e)));
    if (cutAt !== undefined) {
      req.write(body.subarray(0, cutAt), () => setTimeout(() => req.destroy(new Error("cut")), 50));
    } else req.end(body);
  });
}

async function fi13(n: number) {
  check(!/workers\.dev/.test(base), "FI-13 runs against a local attachments Worker only");
  const d = pool(0);
  await ownerCall("PUT", "/v1/admin/limits", { device_class_a_minute: 40, r2_class_a_per_minute: 60, r2_class_a_bucket: 300, multipart_creates_per_sha_day: 3 });
  const resumed: number[] = [];
  let cut = 0, exact = 0;
  for (let it = 0; it < n; it++) {
    const total = 5;
    const bytes = PART * (total - 1) + 1 + rnd(PART - 1);
    const data = Buffer.allocUnsafe(bytes);
    crypto.getRandomValues(new Uint8Array(data.buffer, data.byteOffset, Math.min(bytes, 65536)));
    for (let o = 65536; o < bytes; o += 65536) data.copy(data, o, 0, Math.min(65536, bytes - o));
    data.writeUInt32BE(it, 0); data.writeDoubleBE(Math.random(), 8);
    const sha = createHash("sha256").update(data).digest("hex");
    const partBody = (p: number) => data.subarray((p - 1) * PART, Math.min(p * PART, bytes));
    const begin = async () => {
      for (;;) {
        const r = await fetch(base + "/v1/blob/begin", { method: "POST", headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: JSON.stringify({ sha, bytes, mime: "image/png" }) });
        const j = await r.json() as Record<string, unknown>;
        if (r.status === 429 || r.status === 503) { await sleep(3_000); continue; }
        return j;
      }
    };
    const sendPart = async (p: number, cutAt?: number) => {
      for (;;) {
        const s = await putPart(`/v1/blob/part/${sha}/${p}`, partBody(p), d.token, cutAt);
        if (s === 429 || s === 503) { await sleep(3_000); continue; }
        return s;
      }
    };
    const b0 = await begin();
    check(b0.status === "multipart" && b0.parts_total === total, `FI-13 it ${it}: begin answered ${String(b0.status)} ${String(b0.parts_total)}`);
    const k = 1 + rnd(total - 1); // parts 1..k land, part k+1 is cut
    for (let p = 1; p <= k; p++) check(await sendPart(p) === 200, `FI-13 it ${it}: part ${p} failed`);
    await sendPart(k + 1, Math.floor(partBody(k + 1).length / 2));
    cut++;
    const t = performance.now();
    const b1 = await begin();
    const have = ((b1.parts ?? []) as { n: number }[]).map((p) => p.n).sort((x, y) => x - y);
    const resumeAt = have.length + 1;
    check(have.join(",") === Array.from({ length: k }, (_, i) => i + 1).join(","), `FI-13 it ${it}: after a cut in part ${k + 1} the server lists parts ${have.join(",")}`);
    check(resumeAt === k + 1, `FI-13 it ${it}: resumes at part ${resumeAt}, not ${k + 1}`);
    for (let p = resumeAt; p <= total; p++) check(await sendPart(p) === 200, `FI-13 it ${it}: part ${p} failed on resume`);
    let committed = false;
    for (let tries = 0; tries < 20 && !committed; tries++) {
      const c = await fetch(base + "/v1/blob/commit", { method: "POST", headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" }, body: JSON.stringify({ sha }) });
      await c.arrayBuffer();
      if (c.status === 200) committed = true; else if (c.status === 429 || c.status === 503) await sleep(3_000); else break;
    }
    check(committed, `FI-13 it ${it}: commit failed`);
    resumed.push(performance.now() - t);
    const g = await fetch(base + `/v1/blob/${sha}`, { headers: { authorization: `Bearer ${d.token}` } });
    const got = Buffer.from(await g.arrayBuffer());
    const gotSha = createHash("sha256").update(got).digest("hex");
    if (check(g.status === 200 && gotSha === sha && got.length === bytes, `FI-13 it ${it}: the downloaded object's sha differs`)) exact++;
    console.log(`FI-13 it ${it}: ${bytes} bytes, ${total} parts, cut in part ${k + 1}, resumed at part ${resumeAt}, sha ${gotSha === sha ? "matches" : "DIFFERS"}`);
  }
  console.log(`FI-13: ${cut} uploads cut mid-part, ${exact} resumed at the next part with the sha matching; ${summary("resume to commit", resumed)}`);
}

// MARK: FI-14, the library object deleted and restored from its newest snapshot

let wrangler: ChildProcess | null = null;
async function startWrangler() {
  const cmd = process.env.FI14_WRANGLER_CMD!;
  const log = openSync("/tmp/scratch/cf-local/wrangler-fi14.log", "a");
  wrangler = spawn("/bin/sh", ["-c", `exec ${cmd}`], { stdio: ["ignore", log, log], detached: true, cwd: process.env.FI14_CWD });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base + "/v1/health"); if (r.status === 200 || r.status === 503) return; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error("the local Worker did not come back");
}
async function stopWrangler() {
  if (!wrangler) return;
  const p = wrangler;
  wrangler = null;
  try { process.kill(-p.pid!, "SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 40; i++) {
    try { await fetch(base + "/v1/health"); } catch { await sleep(300); return; }
    await sleep(250);
  }
  try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ }
  await sleep(500);
}

/**
 * Recall's epoch bootstrap (CloudflareSync.bootstrap, reason "epoch"): seen
 * seqs are forgotten, the snapshot lands through the ordinary applier, no
 * local row is dropped, and a clean row the restored library does not hold
 * at its revision is offered again (D-142, `reofferUnheld`; the reference
 * client's own epoch bootstrap does the same). `FI14_NO_REOFFER=1` is the
 * negative control: the bootstrap before D-142.
 */
async function recallBootstrap(c: ReferenceClient) {
  for (const r of c.rows.values()) r.base_seq = 0;
  const kept = c.rows;
  const rowsBefore = kept.size;
  await c.bootstrap(process.env.FI14_NO_REOFFER === "1" ? null : "epoch");
  // The reference client's bootstrap rebuilds its map from the snapshot and its dirty rows; Recall's keeps every local row.
  for (const [k, r] of kept) if (!c.rows.has(k)) c.rows.set(k, r);
  return rowsBefore;
}

async function fi14(n: number, postSnapshotPushes: boolean) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(base) || !process.env.FI14_DO_DIR || !process.env.FI14_WRANGLER_CMD) {
    console.log("FI-14 needs a LOCAL attachments Worker it may restart: FI14_WRANGLER_CMD, FI14_DO_DIR, FI14_CWD");
    process.exit(2);
  }
  const doDir = process.env.FI14_DO_DIR;
  const host = new URL(base).hostname;
  await startWrangler();
  const rebind = async () => {
    if (!process.env.FI14_LIBRARY_ID) return;
    const del = await ownerCall("POST", "/v1/admin/library/delete", { library_id: process.env.FI14_LIBRARY_ID, confirm: `delete ${host}` });
    const cancel = await ownerCall("POST", "/v1/admin/library/cancel-delete");
    check(del.status === 200 && cancel.status === 200, `FI-14: rebinding the library id answered ${del.status} ${cancel.status}`);
  };
  await rebind();
  const a = client(pool(0)), b = client(pool(1));
  await a.hello(); await a.pull(); await b.hello(); await b.pull();
  const doc = await newDoc(a);
  await b.pull();
  let converged = 0, lostFromStore = 0, diverged = 0, unboundAfterRestore = 0;
  const restoreMs: number[] = [];
  for (let it = 0; it < n; it++) {
    for (let i = 1 + rnd(4); i > 0; i--) editNote(chance(0.5) ? a : b, doc, uuid(), "fi14-before");
    await quiesce(a, b);
    const snap = await ownerCall("POST", "/v1/admin/maintain");
    check(snap.status === 200 && /^wrote/.test(String(snap.json.snapshot)), `FI-14 it ${it}: the snapshot answered ${snap.status} ${String(snap.json.snapshot)}`);
    const pushedAfter: string[] = [];
    if (postSnapshotPushes) {
      for (let i = 1 + rnd(3); i > 0; i--) { const c = chance(0.5) ? a : b; pushedAfter.push(editNote(c, doc, uuid(), "fi14-after-snapshot")); await c.push(); }
    }
    const dirtyA = Array.from({ length: 1 + rnd(3) }, () => editNote(a, doc, uuid(), "fi14-unsent"));
    const dirtyB = Array.from({ length: 1 + rnd(3) }, () => editNote(b, doc, uuid(), "fi14-unsent"));
    if (chance(0.5)) editNote(a, doc, [...a.rows.values()].find((r) => r.lane === "note" && !r.dirty)?.id ?? uuid(), "fi14-unsent-edit");
    const heldA = new Map([...a.rows].map(([k, r]) => [k, rowKey(r)]));
    const heldB = new Map([...b.rows].map(([k, r]) => [k, rowKey(r)]));
    // Delete the library object: stop the Worker, remove the LibraryDO's storage, start it again.
    await stopWrangler();
    let removed = 0;
    for (const f of readdirSync(doDir)) if (/^[0-9a-f]{64}\.sqlite(-wal|-shm)?$/.test(f)) { rmSync(`${doDir}/${f}`); removed++; }
    check(removed > 0, `FI-14 it ${it}: no library object storage to delete`);
    await startWrangler();
    const t = performance.now();
    const restored = await ownerCall("POST", "/v1/admin/restore", { confirm: `restore ${host}` });
    check(restored.status === 200, `FI-14 it ${it}: restore answered ${restored.status} ${String(restored.json.error)}`);
    // D-143: a restored object must know its library id (the restore door
    // binds the caller's, and the snapshot's meta line carries it), or its
    // next snapshot, orphan pass and sync record are skipped as "no
    // attachment storage". The probe counts any that do not. FI14_LIBRARY_ID
    // rebinds through the owner's delete-then-cancel doors, the workaround
    // before the fix; leave it unset to test the fix.
    const probe = await ownerCall("POST", "/v1/admin/maintain");
    if (String(probe.json.snapshot).startsWith("skipped")) unboundAfterRestore++;
    await rebind();
    for (const c of [a, b]) {
      const ok = await c.request("POST", "/v1/hello", { t: "hello", pv: 1, device: c.deviceId, since: c.cursor, schema: 219, app: "reference", epoch: c.epoch });
      check(ok.resync === true && ok.reason === "epoch", `FI-14 it ${it}: hello after the restore answered resync ${String(ok.resync)} ${String(ok.reason)}`);
      await recallBootstrap(c);
    }
    await quiesce(a, b);
    restoreMs.push(performance.now() - t);
    // Nothing lost from either store: every row each held is still there, at that revision or a newer one.
    for (const [c, held] of [[a, heldA], [b, heldB]] as const) {
      for (const [k, before] of held) {
        const now = c.rows.get(k);
        if (!now) { lostFromStore++; check(false, `FI-14 it ${it}: a row left a client's store`); continue; }
        if (rowKey(now) !== before && now.updated_at < before.split("|")[1]!) { lostFromStore++; check(false, `FI-14 it ${it}: a row went back to an older revision`); }
      }
    }
    check([...dirtyA, ...dirtyB].every((id) => same(a, b, "note", id)), `FI-14 it ${it}: an unsent edit did not reach the other client`);
    const server = (await a.request("GET", "/v1/digest")).lanes as Record<string, unknown>;
    const da = await a.digest(), db = await b.digest();
    const exact = LANE_ORDER.every((l) => JSON.stringify(da[l]) === JSON.stringify(server[l]) && JSON.stringify(db[l]) === JSON.stringify(server[l]));
    if (exact) converged++;
    else {
      diverged++;
      const missing = pushedAfter.filter((id) => !(a.get("note", id) && b.get("note", id)));
      const lanes = LANE_ORDER.filter((l) => JSON.stringify(da[l]) !== JSON.stringify(server[l]) || JSON.stringify(db[l]) !== JSON.stringify(server[l]))
        .map((l) => `${l} server ${JSON.stringify(server[l]).slice(0, 60)} a ${JSON.stringify(da[l]).slice(0, 60)} b ${JSON.stringify(db[l]).slice(0, 60)}`);
      console.log(`FI-14 it ${it}: NOT converged; ${pushedAfter.length} rows acknowledged after the snapshot, ${missing.length} of them held by one client only; ${lanes.join(" | ")}`);
      check(false, `FI-14 it ${it}: digests differ after the restore`);
    }
  }
  await stopWrangler();
  console.log(`FI-14${postSnapshotPushes ? " (with rows acknowledged after the snapshot)" : ""}: ${n} deletions restored; converged exact ${converged}, diverged ${diverged}, rows lost from a client store ${lostFromStore}; restored objects without their library id ${unboundAfterRestore}; orphans refused ${a.stats.orphans + b.stats.orphans}; ${summary("restore to converged", restoreMs)}`);
}

// MARK: FI-15, the network severed

async function fi15(n: number, severS: number, first: number, count: number) {
  // FI15_POOL_DEVICES="2,3,4,5" severs pool devices instead of fault devices;
  // FI15_PARTNER names the pool slot that stays online (two tiers at once use two partners).
  const devices: { id: string; token: string }[] = process.env.FI15_POOL_DEVICES
    ? process.env.FI15_POOL_DEVICES.split(",").map(Number).map(pool)
    : faultDevices().filter((d) => d.slot < 90).slice(first, first + count);
  if (devices.length === 0) { console.log("no fault devices: run `pair` first"); process.exit(2); }
  const partnerSlot = Number(process.env.FI15_PARTNER ?? 1);
  const partner = client(pool(partnerSlot));
  await partner.hello(); await partner.pull();
  const doc = await newDoc(partner);
  const ws = new Socket(pool(partnerSlot).token);
  await ws.open();
  const arrivals = new Map<string, number>(); // op_id -> when the partner's socket delivered it
  ws.onOps = (f) => {
    const at = performance.now();
    for (const op of f.ops as { op_id?: string }[]) if (op.op_id) arrivals.set(op.op_id, at);
    void partner.applyFrame(f as never).then((ok) => { if (!ok) return partner.pull(); });
  };
  let partnerEditing = true;
  const partnerRows: string[] = [];
  const partnerLoop = (async () => {
    while (partnerEditing) {
      const id = partnerRows.length > 20 && chance(0.5) ? partnerRows[rnd(partnerRows.length)]! : uuid();
      if (!partnerRows.includes(id)) partnerRows.push(id);
      editNote(partner, doc, id, "fi15-partner");
      try { await partner.push(); } catch (e) { if (!(e instanceof HttpError && e.status === 429)) throw e; }
      await sleep(5_000);
    }
  })();

  const firstByte: number[] = [], convergence: number[] = [], editMs: number[] = [];
  let severs = 0, withinBudget = 0;
  let nextSever = 0;
  const clients: ReferenceClient[] = [];
  async function severed(d: { id: string; token: string }) {
    let down = false;
    const net: FetchLike = (input, init) => (down ? Promise.reject(new TypeError("fetch failed: network severed")) : timed(input, init));
    const s = client(d, net);
    clients.push(s);
    await s.hello(); await s.pull();
    const mine: string[] = [];
    while (nextSever < n) {
      const it = nextSever++;
      await sleep(rnd(Math.min(60_000, severS * 1000)));
      down = true;
      const until = Date.now() + severS * 1000;
      const editEvery = Math.max(5_000, (severS * 1000) / 10);
      while (Date.now() < until) {
        const t = performance.now();
        const id = mine.length > 5 && chance(0.4) ? mine[rnd(mine.length)]! : uuid();
        if (!mine.includes(id)) mine.push(id);
        editNote(s, doc, id, "fi15-severed");
        editMs.push(performance.now() - t);
        // The app keeps trying while the network is gone; every attempt fails and leaves the rows dirty.
        await s.push().catch(() => undefined);
        await sleep(Math.min(editEvery, Math.max(0, until - Date.now())));
      }
      const partnerAtReturn = new Map(partnerRows.map((id) => [id, partner.get("note", id)?.updated_at ?? ""]));
      const dirty = s.dirtyRows().map((r) => r.id);
      down = false;
      const back = performance.now();
      await s.hello();
      firstByte.push(performance.now() - back);
      const batch = s.dirtyRows().length;
      await quiesce(s);
      const sHas = () => [...partnerAtReturn].every(([id, at]) => !at || ((s.get("note", id)?.updated_at ?? "") >= at));
      const issued = [...s.issued];
      const partnerHas = () => dirty.every((id) => partner.get("note", id) !== undefined && partner.get("note", id)!.updated_at >= s.get("note", id)!.updated_at);
      const deadline = performance.now() + 30_000;
      while (!(sHas() && partnerHas()) && performance.now() < deadline) await sleep(10);
      const took = performance.now() - back;
      severs++;
      convergence.push(took);
      const ok = sHas() && partnerHas();
      if (ok && took <= 3_000 && firstByte[firstByte.length - 1]! <= 2_500) withinBudget++;
      check(ok, `FI-15 sever ${it}: did not converge within 30 s`);
      void batch; void issued;
    }
  }
  await Promise.all(devices.map((d) => severed(d)));
  partnerEditing = false;
  await partnerLoop;
  ws.close();
  await digestCheck(`FI-15 ${severS} s end`, partner, ...clients);
  console.log(`FI-15 sever ${severS} s: ${severs} severs over ${devices.length} devices, ${withinBudget} inside the 17.6 budget (first byte 2,500 ms, convergence 3,000 ms)`);
  console.log(`  ${summary("first byte after return", firstByte)}`);
  console.log(`  ${summary("convergence after return", convergence)}`);
  console.log(`  ${summary("local edit while severed", editMs)}`);
}

// MARK: main

const started = Date.now();
const n = Number(rest[0] ?? 50);
switch (command) {
  case "pair": {
    const want = Number(rest[0] ?? 0);
    const have = new Set(faultDevices().map((d) => d.slot));
    for (let i = 0; i < want; i++) {
      if (have.has(i)) continue;
      const id = uuid();
      const token = await pairDevice(id, `Fault device ${i}`);
      setVar(`RECALL_CF_DEV_FAULT_${i}`, `${id}:${token}`);
      console.log(`paired fault device ${i}`);
    }
    break;
  }
  case "revoke-faults": {
    for (const d of faultDevices()) {
      const r = await ownerCall("DELETE", `/v1/devices/${d.id}`);
      console.log(`fault device ${d.slot}: revoke ${r.status}`);
      setVar(`RECALL_CF_DEV_FAULT_${d.slot}`, null);
    }
    break;
  }
  case "FI-6": await fi6(n); break;
  case "FI-7": await fi7(n); break;
  case "FI-8": await fi8(n, (rest[1] ?? "2,3,4,5").split(",").map(Number)); break;
  case "FI-9": await fi9(n, Number(rest[1] ?? 99)); break;
  case "FI-13": await fi13(n); break;
  case "FI-14": await fi14(n, rest[1] === "after"); break;
  case "FI-15": await fi15(n, Number(rest[1] ?? 30), Number(rest[2] ?? 0), Number(rest[3] ?? 50)); break;
  default: console.error(`unknown command ${command}`); process.exit(2);
}
if (requestTimes.length) console.log(summary("request round trip", requestTimes));
if (rateWaits.n) console.log(`push limiter waits (not a fault under test) ${rateWaits.n}`);
console.log(`wall ${Math.round((Date.now() - started) / 1000)} s`);
if (command.startsWith("FI-")) {
  console.log(failures.length === 0 ? `${command} PASS` : `${command} FAIL (${failures.length} failed checks)`);
  process.exit(failures.length === 0 ? 0 : 1);
}
