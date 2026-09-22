// The synthetic soak and fault injection (plan 13.6, strands 1 and 2), for a
// backend holding SYNTHETIC data only.
//
//   node tools/soak.ts <env file> <seconds> [pool a] [pool b] [ops per second]
//
// Two reference clients edit at random across seven lanes while faults are
// injected: dropped acks (FI-4), crashes mid-apply (FI-3), pushes lost after
// the request left (FI-1, FI-2), pushes replayed (FI-5), corrupt ops (FI-10),
// two mutations in one millisecond (FI-12) and a five-minute clock skew on one
// client for the middle third of the run (FI-11). Every SOAK_DIGEST_S seconds
// (60 by default) both clients quiesce and their digests are compared with
// GET /v1/digest: ANY mismatch fails the soak. Prints counts and timings only;
// no token, no row content.
//
// Exit 0 SOAK PASS, 1 SOAK FAIL, 2 usage, 3 SOAK INCONCLUSIVE (this machine
// lost the network for longer than the outage budget; see the retry note
// below). A run that ends 3 proves nothing past its last EXACT digest.

import { readFileSync } from "node:fs";
import { HttpError, ReferenceClient, type FetchLike } from "../client/reference-client.ts";
import { wireTime } from "../src/isnewer.ts";
import { LANES, type ColumnType } from "../src/protocol.ts";

const [file, secondsArg, poolA = "0", poolB = "1", rateArg = "4"] = process.argv.slice(2);
if (!file || !secondsArg) { console.error("usage: node tools/soak.ts <env file> <seconds> [pool a] [pool b] [ops per second]"); process.exit(2); }
const vars = new Map(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const base = vars.get("RECALL_CF_DEV_URL")!;
const seconds = Number(secondsArg);
const rate = Number(rateArg);

// BOUNDED RETRY AND BACKOFF. The 72 h production soak died at t+13,271 s on a
// real network drop (EHOSTUNREACH on this Mac, node exited) with 216 of 216
// digests EXACT: with no retry, an outage on the machine running the tool reads
// as a soak that never finished. The retry sits around the REAL fetch inside
// fetchWithFaults, BEFORE the fault dice, so every INJECTED fault (the lost
// push, the replay, dropAck, crashMidApply, the corrupt op) still escapes and
// is still counted, and a network gap can never read as a sync defect.
//
// A retried push may deliver the same frame twice. The protocol answers
// duplicate, which is exactly what FI-5 (the deliberate replay above) already
// exercises, so a retry cannot make a false PASS out of a broken server.
//
// The ladder is 6 attempts at about 2, 4, 8, 16, 32 and 64 s, full jitter
// (a wait drawn uniformly from 0 to the rung, AWS style: two clients that fail
// together do not come back together). An outage that outlives the ladder
// holds at the 64 s rung, and the EPISODE is bounded: 30 minutes of continuous
// failure ends the run with SOAK INCONCLUSIVE and exit 3. A run that lost the
// network never prints SOAK PASS.
// 30 minutes by default. SOAK_OUTAGE_BUDGET_S shortens it so the refusal can
// be DRIVEN in a minute instead of waited out; the 72 h runs never set it.
const OUTAGE_BUDGET_MS = Number(process.env.SOAK_OUTAGE_BUDGET_S ?? 1800) * 1000;

// THE DIGEST INTERVAL IS THE RUN'S COST, NOT A DETAIL (owner, 2026-09-21).
// `GET /v1/digest` reads EVERY row of EVERY lane (`LibraryCore.digest`), so
// one check costs the whole library in Durable Objects `rows_read`, and the
// library only grows while the soak edits. At one check a minute the 72 h
// production run reached 90% of the free tier's 5,000,000 daily rows_read
// 10.7 h into its second UTC day, with the third day projected at about twice
// the cap: a limit the run would have hit with every digest still EXACT, and
// whose errors it would have reported as a backend failure. Nothing a real
// device does resembles this: a device pulls the rows changed since its
// watermark and never hashes the library. 60 s stays the default so a short
// local run keeps its resolution; the 72 h production runs set 600.
const DIGEST_MS = Number(process.env.SOAK_DIGEST_S ?? 60) * 1000;
const LADDER = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000];
const RETRY_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

// THE CONNECT WINDOW ALSO RETRIES A 500 (owner, 2026-09-22). The 600 s rerun
// started on time with the right code and died in its first second: the
// production Worker answered the opening `hello` with a one-off 500
// "internal", which is not on the list above, so the error escaped as an
// uncaught throw with no summary, and a 72 h run ended before its first edit.
// Production answered health normally an hour later. While `connecting` is
// true (hello, the first pull and the start digest) a 500 is retried on the
// same ladder and inside the same outage budget as a network gap. That is safe
// there and ONLY there: nothing in the window edits, every request in it is a
// read or an idempotent hello, so a retry cannot turn a sync defect into a
// PASS. After the start digest a 500 escapes exactly as before, because from
// then on a server error is evidence about the backend.
let connecting = false;
const net = { retries: 0, episodes: 0, outageMs: 0, longestMs: 0, exceeded: false };
let episodeStart = 0;
let lastFetchMs = 0;

// Thrown when the budget is spent. It extends HttpError because
// ReferenceClient.push() turns any OTHER throw into "lost" (that is the FI-1
// model), which would swallow the one error the run must not survive.
class SoakOutage extends HttpError {
  constructor(seconds: number) {
    super(0, { error: `network outage ${seconds} s, past the ${Math.round(OUTAGE_BUDGET_MS / 1000)} s budget` });
  }
}

// A real transport failure: the request never got an answer. Node wraps these
// as "fetch failed" with the cause underneath.
function transportFailure(e: unknown): boolean {
  const s = `${String((e as Error)?.message ?? e)} ${String((e as { cause?: unknown })?.cause ?? "")}`;
  return /fetch failed|ECONN|EHOSTUNREACH|ENETDOWN|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|other side closed|terminated|network|Timeout/i.test(s);
}

function closeEpisode(recovered: boolean) {
  if (episodeStart === 0) return;
  const down = Date.now() - episodeStart;
  net.outageMs += down;
  net.longestMs = Math.max(net.longestMs, down);
  episodeStart = 0;
  if (recovered) console.log(`network: recovered after ${Math.round(down / 1000)} s down`);
}

/** The only place this tool calls fetch. Retries the network, never a fault. */
async function realFetch(input: string, init?: RequestInit): Promise<Response> {
  let attempt = 0;
  for (;;) {
    let failure = "";
    try {
      const at = performance.now();
      const res = await fetch(input, init);
      const connectError = connecting && res.status === 500;
      if (!RETRY_STATUS.has(res.status) && !connectError) {
        lastFetchMs = performance.now() - at;
        closeEpisode(true);
        return res;
      }
      await res.arrayBuffer();
      failure = connectError ? "server status 500 while connecting" : `edge status ${res.status}`;
    } catch (e) {
      if (!transportFailure(e)) throw e;
      failure = String((e as Error)?.message ?? e).split("\n")[0]!;
    }
    if (episodeStart === 0) { episodeStart = Date.now(); net.episodes++; }
    const down = Date.now() - episodeStart;
    if (down >= OUTAGE_BUDGET_MS) {
      net.exceeded = true;
      closeEpisode(false);
      throw new SoakOutage(Math.round(down / 1000));
    }
    const rung = LADDER[Math.min(attempt, LADDER.length - 1)]!;
    const wait = Math.min(Math.round(Math.random() * rung), Math.max(0, OUTAGE_BUDGET_MS - down));
    attempt++;
    net.retries++;
    console.log(`network: ${failure}, attempt ${attempt}, down ${Math.round(down / 1000)} s, waiting ${Math.round(wait / 1000)} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Seconds this run spent waiting for the network, the open episode included. */
const pausedMs = () => net.outageMs + (episodeStart === 0 ? 0 : Date.now() - episodeStart);

const rnd = (n: number) => Math.floor(Math.random() * n);
const chance = (p: number) => Math.random() < p;
const faults = { dropAck: 0, crashMidApply: 0, lostPush: 0, replayedPush: 0, corruptOp: 0, sameMillisecond: 0, skewedEdits: 0 };
const rejectedExpected = { n: 0 };
const pushTimes: number[] = [];

function client(pool: string, name: string): ReferenceClient {
  const [id, token] = vars.get(`RECALL_CF_DEV_POOL_${pool}`)!.split(":");
  const fetchWithFaults: FetchLike = async (input, init) => {
    const isPush = String(input).endsWith("/v1/push");
    // realFetch has already retried the network; the dice below are the faults
    // this soak MEANS to inject and are never retried.
    const res = await realFetch(input, init);
    if (isPush) pushTimes.push(lastFetchMs);
    if (isPush && res.ok && chance(0.03)) {
      // FI-5: the same frame again; every op must answer duplicate.
      faults.replayedPush++;
      await res.arrayBuffer();
      return realFetch(input, init);
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

// A push here may answer "lost" by design (FI-1), so these catches are the
// tool working. An OUTAGE is not: it is rethrown, or 30 minutes of no network
// would read as a quiet quiesce.
const notAnOutage = (e: unknown) => { if (e instanceof SoakOutage) throw e; };

async function quiesce() {
  c: for (let round = 0; round < 20; round++) {
    for (const c of [a, b]) { await c.push().catch(notAnOutage); }
    for (const c of [a, b]) { await c.pull(); }
    if (a.dirtyRows().length === 0 && b.dirtyRows().length === 0) {
      const again = [await a.push().catch((e) => { notAnOutage(e); return "lost"; }), await b.push().catch((e) => { notAnOutage(e); return "lost"; })];
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
  // WHAT THIS CHECK COST. Every lane's digest already counts its live rows and
  // its tombstones, and their sum is exactly the rows the server read to
  // produce it, so the Durable Objects bill for a check is in the reply and
  // costs nothing more to print. The tool recorded no usage at all before
  // (plan 13.6 strand 1), which is how a run got to 90% of a daily cap with
  // nobody knowing.
  const rowsRead = Object.values(server).reduce((n: number, d) => {
    const lane = d as { live?: number; tombstones?: number };
    return n + (lane.live ?? 0) + (lane.tombstones ?? 0);
  }, 0);
  const da = await a.digest(), db = await b.digest();
  const bad: string[] = [];
  for (const lane of Object.keys(server)) {
    if (JSON.stringify(da[lane]) !== JSON.stringify(server[lane])) bad.push(`a.${lane}`);
    if (JSON.stringify(db[lane]) !== JSON.stringify(server[lane])) bad.push(`b.${lane}`);
  }
  faultsOn();
  console.log(`${label}: digest ${bad.length === 0 ? "EXACT" : "MISMATCH " + bad.join(",")} (lost pushes during quiesce ${faults.lostPush - lostBefore}) rows ${rowsRead}`);
  return bad.length === 0;
}

const started = Date.now();
// D59: an outage EXTENDS the deadline by the time it paused. The soak's claim
// is 72 h of edits against the backend, not 72 h of clock, so time this tool
// spent waiting for a network that was not there buys no proof and is added
// back. `soaked` is that clock; every check label and the middle-third skew
// window read it, so a gap does not slide the window either.
const soaked = () => Date.now() - started - pausedMs();
let ok = false;
let edits = 0;
let inconclusive: SoakOutage | null = null;
try {
  console.log(`digest every ${DIGEST_MS / 1000} s, ${rate} ops/s, ${seconds} s to soak`);
  connecting = true;
  await a.hello(); await b.hello();
  await a.pull(); await b.pull();
  ok = await checkDigests("start");
  connecting = false;
  let nextCheck = soaked() + DIGEST_MS;
  const interval = 1000 / rate;
  while (soaked() < seconds * 1000) {
    const elapsed = soaked() / (seconds * 1000);
    b.setClockSkew(elapsed > 1 / 3 && elapsed < 2 / 3 ? 300_000 : 0);
    const c = chance(0.5) ? a : b;
    edit(c);
    if (c === b && elapsed > 1 / 3 && elapsed < 2 / 3) faults.skewedEdits++;
    edits++;
    if (chance(0.02)) await corruptPush(c);
    if (chance(0.5)) await sync(c);
    if (soaked() >= nextCheck) {
      ok = (await checkDigests(`t+${Math.round(soaked() / 1000)}s`)) && ok;
      nextCheck = soaked() + DIGEST_MS;
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
} catch (e) {
  if (!(e instanceof SoakOutage)) throw e;
  inconclusive = e;
  ok = false;
}

pushTimes.sort((x, y) => x - y);
const pct = (p: number) => pushTimes.length ? pushTimes[Math.min(pushTimes.length - 1, Math.floor((p / 100) * pushTimes.length))]!.toFixed(0) : "-";
const rejected = a.stats.rejected + b.stats.rejected;
console.log(`edits ${edits}, soaked ${Math.round(soaked() / 1000)} s, wall ${Math.round((Date.now() - started) / 1000)} s`);
console.log(`faults ${JSON.stringify(faults)}`);
// The network's own line, so a gap in the log is read as a gap and never as a
// sync defect.
console.log(`network ${JSON.stringify({ retries: net.retries, episodes: net.episodes, outage_s: Math.round(pausedMs() / 1000), longest_s: Math.round(net.longestMs / 1000), budget_s: OUTAGE_BUDGET_MS / 1000 })}`);
console.log(`a ${JSON.stringify(a.stats)} kept ${a.kept.length}`);
console.log(`b ${JSON.stringify(b.stats)} kept ${b.kept.length}`);
console.log(`push round trip p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${pct(100)} ms over ${pushTimes.length}`);
if (inconclusive || net.exceeded) {
  // Not a pass and not a failure of the backend: this machine lost the network
  // for longer than the budget, so the run proves nothing past its last EXACT
  // digest. Its own exit code, so a supervisor can tell the two apart.
  console.log(`SOAK INCONCLUSIVE: ${inconclusive?.body.error ?? "the outage budget was spent"}`);
  process.exit(3);
}
if (rejected !== rejectedExpected.n) { console.log(`rejected ${rejected} but ${rejectedExpected.n} corrupt ops were injected`); ok = false; }
console.log(ok ? "SOAK PASS" : "SOAK FAIL");
process.exit(ok ? 0 : 1);
