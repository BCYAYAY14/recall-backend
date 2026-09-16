// The synthetic soak and fault injection (plan 13.6, strands 1 and 2), for a
// backend holding SYNTHETIC data only.
//
//   node tools/soak.ts <env file> <seconds> [pool a] [pool b] [ops per second]
//
// Two reference clients edit at random across seven lanes while faults are
// injected: dropped acks (FI-4), crashes mid-apply (FI-3), pushes lost after
// the request left (FI-1, FI-2), pushes replayed (FI-5), corrupt ops (FI-10),
// two mutations in one millisecond (FI-12) and a five-minute clock skew on one
// client for the middle third of the run (FI-11). Every 60 s both clients
// quiesce and their digests are compared with GET /v1/digest: ANY mismatch
// fails the soak. Prints counts and timings only; no token, no row content.

import { readFileSync } from "node:fs";
import { ReferenceClient, type FetchLike } from "../client/reference-client.ts";
import { wireTime } from "../src/isnewer.ts";
import { LANES, type ColumnType } from "../src/protocol.ts";

const [file, secondsArg, poolA = "0", poolB = "1", rateArg = "4"] = process.argv.slice(2);
if (!file || !secondsArg) { console.error("usage: node tools/soak.ts <env file> <seconds> [pool a] [pool b] [ops per second]"); process.exit(2); }
const vars = new Map(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const base = vars.get("RECALL_CF_DEV_URL")!;
const seconds = Number(secondsArg);
const rate = Number(rateArg);

const rnd = (n: number) => Math.floor(Math.random() * n);
const chance = (p: number) => Math.random() < p;
const faults = { dropAck: 0, crashMidApply: 0, lostPush: 0, replayedPush: 0, corruptOp: 0, sameMillisecond: 0, skewedEdits: 0 };
const rejectedExpected = { n: 0 };
const pushTimes: number[] = [];

function client(pool: string, name: string): ReferenceClient {
  const [id, token] = vars.get(`RECALL_CF_DEV_POOL_${pool}`)!.split(":");
  const fetchWithFaults: FetchLike = async (input, init) => {
    const isPush = String(input).endsWith("/v1/push");
    const started = performance.now();
    const res = await fetch(input, init);
    if (isPush) pushTimes.push(performance.now() - started);
    if (isPush && res.ok && chance(0.03)) {
      // FI-5: the same frame again; every op must answer duplicate.
      faults.replayedPush++;
      await res.arrayBuffer();
      return fetch(input, init);
    }
    if (isPush && chance(0.04)) {
      // FI-1, FI-2: the frame reached the server, the answer never came back.
      faults.lostPush++;
      await res.arrayBuffer();
      throw new Error("connection lost after send");
    }
    return res;
  };
  const c = new ReferenceClient(base, id!, token!, fetchWithFaults);
  c.faults = {
    dropAck: () => { const f = chance(0.04); if (f) faults.dropAck++; return f; },
    crashMidApply: () => { const f = chance(0.04); if (f) faults.crashMidApply++; return f; },
  };
  void name;
  return c;
}

const a = client(poolA, "a");
const b = client(poolB, "b");

function value(t: ColumnType, now: string, refs: { notebook?: string; note?: string; card?: string }, column: string): unknown {
  const nullable = t.endsWith("?");
  const base = (nullable ? t.slice(0, -1) : t) as string;
  if (nullable && chance(0.3)) return null;
  switch (base) {
    case "uuid": return column === "notebook_id" ? refs.notebook ?? crypto.randomUUID()
      : column === "note_id" ? refs.note ?? crypto.randomUUID()
      : column === "card_id" ? refs.card ?? crypto.randomUUID() : crypto.randomUUID();
    case "ts": return now;
    case "int": return rnd(50);
    case "num": return Math.round(Math.random() * 1e6) / 1e3;
    case "bool": return chance(0.5);
    case "sha": return Array.from({ length: 64 }, () => "0123456789abcdef"[rnd(16)]).join("");
    case "strmap": return { k: String(rnd(9)) };
    default: return `soak ${rnd(1e6)} ${chance(0.1) ? "émoji 😀 \"quote\" \\ tab\t" : ""}`;
  }
}

const editableLanes = ["notebook", "note", "card", "grade_event", "dictionary", "occlusion", "media"];

function live(c: ReferenceClient, lane: string) {
  return [...c.rows.values()].filter((r) => r.lane === lane && r.kind === "upsert");
}

function edit(c: ReferenceClient) {
  const now = wireTime(Date.now());
  const lane = editableLanes[rnd(editableLanes.length)]!;
  const spec = LANES[lane]!;
  const refs = { notebook: live(c, "notebook")[0]?.id, note: live(c, "note")[0]?.id, card: live(c, "card")[0]?.id };
  const existing = live(c, lane);
  if (existing.length > 0 && spec.tombstones && chance(0.1)) { c.tombstone(lane, existing[rnd(existing.length)]!.id); return; }
  if (existing.length > 0 && lane === "note" && chance(0.08)) {
    // FI-12: a second mutation inside the millisecond the row already carries.
    faults.sameMillisecond++;
    c.mutateWithoutStamp(lane, existing[rnd(existing.length)]!.id, (r) => { r.content = { ...r.content, tags: `same ms ${rnd(1e6)}` }; });
    return;
  }
  const id = existing.length > 0 && lane !== "grade_event" && chance(0.6) ? existing[rnd(existing.length)]!.id : crypto.randomUUID();
  const env: Record<string, unknown> = {};
  for (const [col, t] of Object.entries(spec.env)) env[col] = col === "deleted_at" ? null : value(t, now, refs, col);
  const content: Record<string, unknown> = {};
  for (const [col, t] of Object.entries(spec.content)) content[col] = value(t, now, refs, col);
  c.upsert(lane, id, env, content);
}

async function corruptPush(c: ReferenceClient) {
  // FI-10: an op carrying a column its lane does not define. Rejected, counted, the lane continues.
  faults.corruptOp++;
  rejectedExpected.n++;
  const op = { op_id: crypto.randomUUID(), lane: "dictionary", id: crypto.randomUUID(), kind: "upsert", updated_at: wireTime(Date.now()),
    base_seq: 0, env: { created_at: wireTime(Date.now()), deleted_at: null, not_a_column: 1 }, content: { word: "x" } };
  let ack: Record<string, unknown>;
  try {
    ack = await c.request("POST", "/v1/push", { t: "push", batch: crypto.randomUUID(), ops: [op] });
  } catch (e) {
    // The lost-push fault can land on this probe too: the answer is unknown, so it is not counted.
    if (!String(e).includes("connection lost")) throw e;
    rejectedExpected.n--;
    return;
  }
  const outcome = (ack.results as { outcome: string }[])[0]?.outcome;
  if (outcome !== "rejected") throw new Error(`a corrupt op answered ${outcome}`);
  c.stats.rejected++;
}

async function sync(c: ReferenceClient) {
  try {
    await c.push();
  } catch (e) {
    if (String(e).includes("429")) return;
    throw e;
  }
  await c.pull();
}

async function quiesce() {
  c: for (let round = 0; round < 20; round++) {
    for (const c of [a, b]) { await c.push().catch(() => undefined); }
    for (const c of [a, b]) { await c.pull(); }
    if (a.dirtyRows().length === 0 && b.dirtyRows().length === 0) {
      const again = [await a.push().catch(() => "lost"), await b.push().catch(() => "lost")];
      if (again.every((x) => x === "empty")) { await a.pull(); await b.pull(); break c; }
    }
  }
}

const faultsOff = () => { a.faults = {}; b.faults = {}; };
const faultsOn = () => {
  for (const c of [a, b]) c.faults = {
    dropAck: () => { const f = chance(0.04); if (f) faults.dropAck++; return f; },
    crashMidApply: () => { const f = chance(0.04); if (f) faults.crashMidApply++; return f; },
  };
};

async function checkDigests(label: string): Promise<boolean> {
  faultsOff();
  const lostBefore = faults.lostPush;
  await quiesce();
  const server = (await a.request("GET", "/v1/digest")).lanes as Record<string, unknown>;
  const da = await a.digest(), db = await b.digest();
  const bad: string[] = [];
  for (const lane of Object.keys(server)) {
    if (JSON.stringify(da[lane]) !== JSON.stringify(server[lane])) bad.push(`a.${lane}`);
    if (JSON.stringify(db[lane]) !== JSON.stringify(server[lane])) bad.push(`b.${lane}`);
  }
  faultsOn();
  console.log(`${label}: digest ${bad.length === 0 ? "EXACT" : "MISMATCH " + bad.join(",")} (lost pushes during quiesce ${faults.lostPush - lostBefore})`);
  return bad.length === 0;
}

const started = Date.now();
await a.hello(); await b.hello();
await a.pull(); await b.pull();
let ok = await checkDigests("start");
let nextCheck = Date.now() + 60_000;
let edits = 0;
const interval = 1000 / rate;
while (Date.now() - started < seconds * 1000) {
  const elapsed = (Date.now() - started) / (seconds * 1000);
  b.setClockSkew(elapsed > 1 / 3 && elapsed < 2 / 3 ? 300_000 : 0);
  const c = chance(0.5) ? a : b;
  edit(c);
  if (c === b && elapsed > 1 / 3 && elapsed < 2 / 3) faults.skewedEdits++;
  edits++;
  if (chance(0.02)) await corruptPush(c);
  if (chance(0.5)) await sync(c);
  if (Date.now() >= nextCheck) {
    ok = (await checkDigests(`t+${Math.round((Date.now() - started) / 1000)}s`)) && ok;
    nextCheck = Date.now() + 60_000;
  }
  await new Promise((r) => setTimeout(r, interval));
}
b.setClockSkew(0);
if (process.env.SOAK_NEGATIVE === "1") {
  // The negative control: a row that diverges without being dirty must fail the check.
  const row = live(a, "note")[0] ?? live(a, "dictionary")[0];
  if (row) row.content = { ...row.content, silently: "changed" };
}
ok = (await checkDigests("end")) && ok;

pushTimes.sort((x, y) => x - y);
const pct = (p: number) => pushTimes.length ? pushTimes[Math.min(pushTimes.length - 1, Math.floor((p / 100) * pushTimes.length))]!.toFixed(0) : "-";
const rejected = a.stats.rejected + b.stats.rejected;
console.log(`edits ${edits}, wall ${Math.round((Date.now() - started) / 1000)} s`);
console.log(`faults ${JSON.stringify(faults)}`);
console.log(`a ${JSON.stringify(a.stats)} kept ${a.kept.length}`);
console.log(`b ${JSON.stringify(b.stats)} kept ${b.kept.length}`);
console.log(`push round trip p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${pct(100)} ms over ${pushTimes.length}`);
if (rejected !== rejectedExpected.n) { console.log(`rejected ${rejected} but ${rejectedExpected.n} corrupt ops were injected`); ok = false; }
console.log(ok ? "SOAK PASS" : "SOAK FAIL");
process.exit(ok ? 0 : 1);
