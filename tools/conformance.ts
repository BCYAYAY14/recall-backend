// The protocol conformance suite (plan section 17.1). Every case drives
// ReferenceClients against a backend through `ConformanceEnv`, so the SAME
// cases run against the in-process core (test/unit/conformance.spec.ts), the
// Worker in the Workers runtime (test/worker) and a deployed dev backend:
//
//   node tools/conformance-cli.ts https://recall-dev.<sub>.workers.dev
//
// A case that needs to move the server's clock or force maintenance declares
// it in `needs`, and an environment that cannot do that skips it BY NAME.

import { ReferenceClient, HttpError } from "../client/reference-client.ts";

export interface ConformanceEnv {
  /** A new paired device with its own id and credential. */
  device(label: string): Promise<ReferenceClient>;
  /** Server-side capabilities a case may need. */
  advance?(ms: number): void;
  compact?(): Promise<void>;
  revoke?(deviceId: string): Promise<void>;
  capabilities: Set<"clock" | "compact" | "revoke">;
}

export interface Case {
  id: string;
  name: string;
  needs?: ("clock" | "compact" | "revoke")[];
  run(env: ConformanceEnv): Promise<void>;
}

export class ConformanceFailure extends Error {}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new ConformanceFailure(message);
}

let counter = 0;
export function uuid(): string { return crypto.randomUUID(); }

const T0 = "2026-09-16T10:00:00.000Z";

export function notebookRow(id = uuid()) {
  return { lane: "notebook", id, env: { folder_id: null, position: 0, created_at: T0, exam_at: null, retention_pct: null, new_per_day: null }, content: { name: `Doc ${++counter}`, emoji: "\u{1F4DA}", style: null } };
}

export function noteEnv(notebookId: string, position = 0, parentId: string | null = null) {
  return { notebook_id: notebookId, parent_id: parentId, position, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: T0 };
}

export function noteContent(front: string, spans: string | null = null) {
  return { front, back: null, cloze_text: null, tags: "", spans, attrs: null };
}

async function sync(...clients: ReferenceClient[]) {
  for (const c of clients) { await c.push(); await c.pull(); }
  for (const c of clients) { await c.pull(); }
}

async function sameDigest(a: ReferenceClient, b: ReferenceClient, server?: ReferenceClient) {
  const da = JSON.stringify(await a.digest());
  const db = JSON.stringify(await b.digest());
  check(da === db, "the two devices' digests differ");
  if (server) {
    const remote = await server.request("GET", "/v1/digest");
    const lanes = remote.lanes as Record<string, unknown>;
    check(JSON.stringify(lanes) === da, "the device digest differs from the server's");
  }
}

async function seedDoc(a: ReferenceClient) {
  const nb = notebookRow();
  a.upsert(nb.lane, nb.id, nb.env, nb.content);
  return nb.id;
}

export const CASES: Case[] = [
  {
    id: "P1", name: "a Mac edit reaches the iPhone with identical content",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const n = uuid();
      mac.upsert("note", n, noteEnv(doc), noteContent("Bonjour", '[{"k":"b","s":0,"e":7}]'));
      await sync(mac, phone);
      const got = phone.get("note", n);
      check(got?.content.front === "Bonjour", "text did not arrive");
      check(got?.content.spans === '[{"k":"b","s":0,"e":7}]', "spans did not arrive");
      check(got?.updated_at === mac.get("note", n)?.updated_at, "updated_at differs");
      await sameDigest(mac, phone, mac);
    },
  },
  {
    id: "P2", name: "an iPhone edit reaches the Mac",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(phone);
      const n = uuid();
      phone.upsert("note", n, noteEnv(doc), noteContent("from the phone"));
      await sync(phone, mac);
      check(mac.get("note", n)?.content.front === "from the phone", "text did not arrive");
      await sameDigest(mac, phone, phone);
    },
  },
  {
    id: "P3", name: "50 rapid commits: every final state arrives",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const ids = Array.from({ length: 10 }, uuid);
      for (let i = 0; i < 50; i++) {
        const id = ids[i % 10]!;
        mac.upsert("note", id, noteEnv(doc, i % 10), noteContent(`v${i}`));
        if (i % 7 === 0) await mac.push();
      }
      await sync(mac, phone);
      for (let j = 0; j < 10; j++) check(phone.get("note", ids[j]!)?.content.front === `v${40 + j}`, `final state of row ${j} lost`);
      await sameDigest(mac, phone, mac);
    },
  },
  {
    id: "P4", name: "different paragraphs edited concurrently: both survive, zero conflicts",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const a = uuid(), b = uuid();
      mac.upsert("note", a, noteEnv(doc, 0), noteContent("a"));
      mac.upsert("note", b, noteEnv(doc, 1), noteContent("b"));
      await sync(mac, phone);
      mac.upsert("note", a, noteEnv(doc, 0), noteContent("a from mac"));
      phone.upsert("note", b, noteEnv(doc, 1), noteContent("b from phone"));
      await mac.push(); await phone.push();
      await sync(mac, phone);
      check(mac.get("note", b)?.content.front === "b from phone" && phone.get("note", a)?.content.front === "a from mac", "an edit was lost");
      check(mac.stats.conflict + phone.stats.conflict === 0, "a conflict was recorded");
      await sameDigest(mac, phone, mac);
    },
  },
  {
    id: "P5", name: "the same paragraph concurrently: one winner, one conflict, one kept version",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const n = uuid();
      mac.upsert("note", n, noteEnv(doc), noteContent("start"));
      await sync(mac, phone);
      mac.upsert("note", n, noteEnv(doc), noteContent("mac wins"));
      phone.upsert("note", n, noteEnv(doc), noteContent("phone loses"));
      await mac.push();
      await phone.push();
      await sync(mac, phone);
      const kept = [...mac.kept, ...phone.kept].filter((k) => k.reason === "conflict");
      check(kept.length === 1, `expected exactly one kept version, saw ${kept.length}`);
      const winner = mac.get("note", n)?.content.front;
      check(kept[0]?.content.front !== winner && ["mac wins", "phone loses"].includes(String(kept[0]?.content.front)), "the loser's text was not kept");
      check(mac.get("note", n)?.content.front === phone.get("note", n)?.content.front, "the devices disagree");
      await sameDigest(mac, phone, mac);
    },
  },
  {
    id: "P6", name: "offline edits on both, then both reconnect: nothing silently lost",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const shared = uuid();
      mac.upsert("note", shared, noteEnv(doc), noteContent("base"));
      await sync(mac, phone);
      const macOnly = Array.from({ length: 20 }, uuid), phoneOnly = Array.from({ length: 20 }, uuid);
      macOnly.forEach((id, i) => mac.upsert("note", id, noteEnv(doc, i + 1), noteContent(`m${i}`)));
      phoneOnly.forEach((id, i) => phone.upsert("note", id, noteEnv(doc, i + 30), noteContent(`p${i}`)));
      mac.upsert("note", shared, noteEnv(doc), noteContent("mac offline"));
      phone.upsert("note", shared, noteEnv(doc), noteContent("phone offline"));
      await phone.push(); await mac.push();
      await sync(mac, phone);
      for (const id of [...macOnly, ...phoneOnly]) check(mac.get("note", id) && phone.get("note", id), "a row is missing");
      const texts = new Set([mac.get("note", shared)!.content.front, ...mac.kept.map((k) => k.content.front), ...phone.kept.map((k) => k.content.front)]);
      check(texts.has("mac offline") && texts.has("phone offline"), "a same-row edit vanished without a kept version");
      await sameDigest(mac, phone, mac);
    },
  },
  {
    id: "P7", name: "a push replayed five times: duplicates, seq unchanged",
    async run(env) {
      const mac = await env.device("mac");
      const doc = await seedDoc(mac);
      mac.upsert("note", uuid(), noteEnv(doc), noteContent("once"));
      const b = await mac.buildBatch();
      const first = await mac.request("POST", "/v1/push", { t: "push", batch: b.batch, ops: b.ops });
      for (let i = 0; i < 5; i++) {
        const again = await mac.request("POST", "/v1/push", { t: "push", batch: b.batch, ops: b.ops });
        check(again.seq === first.seq, "seq advanced on a replay");
        check((again.results as { outcome: string }[]).every((r) => r.outcome === "duplicate"), "a replay was not a duplicate");
      }
    },
  },
  {
    id: "P8", name: "an ops frame applied shuffled equals the ordered application",
    async run(env) {
      const mac = await env.device("mac"), a = await env.device("a"), b = await env.device("b");
      const doc = await seedDoc(mac);
      const n = uuid();
      for (let i = 0; i < 6; i++) { mac.upsert("note", n, noteEnv(doc), noteContent(`v${i}`)); await mac.push(); }
      const frame = await a.request("GET", "/v1/pull?since=0&limit=1000");
      const ops = [...(frame.ops as { seq: number }[])];
      await a.applyFrame(frame as never);
      await b.applyFrame({ ...(frame as never as { from: number; to: number }), ops: ops.reverse() } as never);
      check(JSON.stringify(await a.digest()) === JSON.stringify(await b.digest()), "shuffled application diverged");
    },
  },
  {
    id: "P9", name: "a dropped frame is detected as a gap and refilled from the cursor",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      await mac.push();
      const first = await phone.request("GET", "/v1/pull?since=0&limit=1000");
      mac.upsert("note", uuid(), noteEnv(doc), noteContent("x"));
      await mac.push();
      mac.upsert("note", uuid(), noteEnv(doc, 1), noteContent("y"));
      await mac.push();
      const later = await phone.request("GET", `/v1/pull?since=${Number(first.to) + 1}&limit=1000`);
      check(!(await phone.applyFrame(later as never)), "a frame past a gap was applied");
      await phone.pull();
      await mac.pull();
      await sameDigest(mac, phone, mac);
    },
  },
  {
    id: "P12", name: "terminated mid-push: rows stay dirty and the resend is a duplicate",
    async run(env) {
      const mac = await env.device("mac");
      const doc = await seedDoc(mac);
      mac.upsert("note", uuid(), noteEnv(doc), noteContent("in flight"));
      mac.faults.dropAck = () => true;
      await mac.push();
      mac.faults.dropAck = undefined;
      check(mac.dirtyRows().length === 2, "an unacknowledged row was cleaned");
      await mac.push();
      check(mac.stats.duplicate === 2 && mac.dirtyRows().length === 0, "the resend was not a clean duplicate");
    },
  },
  {
    id: "P13", name: "terminated mid-apply: the cursor did not move and the batch is redelivered",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      mac.upsert("note", uuid(), noteEnv(doc), noteContent("x"));
      await mac.push();
      phone.faults.crashMidApply = () => true;
      await phone.request("GET", "/v1/pull?since=0").then((f) => phone.applyFrame(f as never));
      check(phone.cursor === 0 && phone.rows.size === 0, "a crashed apply left partial state");
      phone.faults.crashMidApply = undefined;
      await phone.pull();
      await sameDigest(mac, phone, mac);
    },
  },
  {
    id: "P19", name: "a device offline past retention bootstraps and converges", needs: ["clock", "compact"],
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      await sync(mac, phone);
      await phone.ack();
      env.advance!(60 * 86_400_000);
      const n = uuid();
      for (let i = 0; i < 3; i++) { mac.upsert("note", n, noteEnv(doc), noteContent(`day ${i}`)); await mac.push(); await mac.hello(); await mac.pull(); await mac.ack(); }
      await env.compact!();
      env.advance!(46 * 86_400_000);
      mac.upsert("note", uuid(), noteEnv(doc, 2), noteContent("later"));
      await mac.push(); await mac.hello(); await mac.pull(); await mac.ack();
      await env.compact!();
      const before = phone.stats.bootstraps;
      await phone.hello();
      await phone.pull();
      check(phone.stats.bootstraps > before, "no bootstrap after a 106-day absence");
      await mac.pull();
      await sameDigest(mac, phone, mac);
    },
  },
  {
    id: "P22", name: "an unknown column is rejected and the stored row is unchanged",
    async run(env) {
      const mac = await env.device("mac");
      const doc = await seedDoc(mac);
      await mac.push();
      const before = await mac.request("GET", "/v1/digest");
      const b = await mac.buildBatch();
      const op = { op_id: uuid(), lane: "notebook", id: doc, kind: "upsert", updated_at: "2027-01-01T00:00:00.000Z", base_seq: 0,
        env: { folder_id: null, position: 0, created_at: T0, exam_at: null, retention_pct: null, new_per_day: null, colour: "red" },
        content: { name: "x", emoji: "y", style: null } };
      const ack = await mac.request("POST", "/v1/push", { t: "push", batch: b.batch, ops: [op] });
      check((ack.results as { outcome: string; reason: string }[])[0]?.reason === "unknown_column:env.colour", "the future column was not rejected");
      const after = await mac.request("GET", "/v1/digest");
      check(JSON.stringify(before.lanes) === JSON.stringify(after.lanes), "the stored row moved");
    },
  },
  {
    id: "P23", name: "an empty library bootstraps with zero errors",
    async run(env) {
      const phone = await env.device("iphone");
      await phone.bootstrap();
      await phone.pull();
      check(phone.rows.size === 0, "rows appeared from nowhere");
    },
  },
  {
    id: "A1", name: "an ack for revision A never cleans revision B",
    async run(env) {
      const mac = await env.device("mac");
      const doc = await seedDoc(mac);
      await mac.push();
      const n = uuid();
      mac.upsert("note", n, noteEnv(doc), noteContent("A"));
      const b = await mac.buildBatch();
      mac.upsert("note", n, noteEnv(doc), noteContent("B"));
      const ack = await mac.request("POST", "/v1/push", { t: "push", batch: b.batch, ops: b.ops });
      await mac.handleAck(ack.results as never, b.capture);
      check(mac.get("note", n)?.dirty === true, "B was cleaned by A's ack");
      await mac.push();
      const other = await env.device("other");
      await other.pull();
      check(other.get("note", n)?.content.front === "B", "B never reached the server");
    },
  },
  {
    id: "A2", name: "same updated_at, different payload: still dirty (the case updated_at alone fails)",
    async run(env) {
      const mac = await env.device("mac");
      const doc = await seedDoc(mac);
      const n = uuid();
      mac.upsert("note", n, noteEnv(doc), noteContent("A"));
      const b = await mac.buildBatch();
      mac.mutateWithoutStamp("note", n, (r) => { r.env = { ...r.env, position: 9 }; });
      const ack = await mac.request("POST", "/v1/push", { t: "push", batch: b.batch, ops: b.ops });
      await mac.handleAck(ack.results as never, b.capture);
      check(mac.get("note", n)?.dirty === true, "a same-millisecond revision was cleaned");
    },
  },
  {
    id: "A6", name: "stale and conflict acks never clean without adopting; one kept version for conflict, none for stale",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const n = uuid();
      mac.upsert("note", n, noteEnv(doc), noteContent("base"));
      await sync(mac, phone);
      mac.upsert("note", n, noteEnv(doc), noteContent("mac newer"));
      await mac.push();
      await phone.pull();
      // A skewed clock on an unchanged base: the edit carries an OLDER stamp
      // than the row it was made on (a device whose clock is an hour behind).
      phone.mutateWithoutStamp("note", n, (r) => {
        r.content = noteContent("phone behind, same base");
        r.updated_at = new Date(Date.parse(r.updated_at) - 3_600_000).toISOString();
      });
      const before = phone.kept.length;
      await phone.push();
      check(phone.stats.conflict === 0, "a stale write was called a conflict");
      check(phone.kept.length === before, "a stale verdict produced a kept version");
      check(phone.get("note", n)?.content.front === "mac newer", "the winner was not adopted");
    },
  },
  {
    id: "O1", name: "two payloads forced onto one updated_at: two op ids, both applied, both visible",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const n = uuid();
      mac.upsert("note", n, noteEnv(doc), noteContent("same ms"));
      const first = await mac.buildBatch();
      await mac.push();
      mac.mutateWithoutStamp("note", n, (r) => { r.env = { ...r.env, position: 3 }; });
      const second = await mac.buildBatch();
      const firstId = [...first.capture.entries()].find(([, c]) => c.key === `note:${n}`)![0];
      const secondId = [...second.capture.entries()].find(([, c]) => c.key === `note:${n}`)![0];
      check(firstId !== secondId, "the op id repeated for a distinct mutation");
      await mac.push();
      check(mac.stats.duplicate === 0 && mac.stats.stale === 0, "the second mutation was not applied");
      await phone.pull();
      check(phone.get("note", n)?.env.position === 3, "the second mutation is not visible on the other device");
    },
  },
  {
    id: "O5", name: "delete, undelete, delete within one second: three op ids, final state deleted",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const n = uuid();
      mac.upsert("note", n, noteEnv(doc), noteContent("x"));
      await mac.push();
      const ids = new Set<string>();
      mac.tombstone("note", n); ids.add((await mac.buildBatch()).ops.at(-1)!.op_id as string); await mac.push();
      mac.upsert("note", n, noteEnv(doc), noteContent("x")); ids.add((await mac.buildBatch()).ops.at(-1)!.op_id as string); await mac.push();
      mac.tombstone("note", n); ids.add((await mac.buildBatch()).ops.at(-1)!.op_id as string); await mac.push();
      check(ids.size === 3, "op ids repeated across delete and undelete");
      await phone.pull();
      check(phone.get("note", n)?.kind === "tombstone", "the final state is not deleted");
    },
  },
  {
    id: "P28", name: "one push in flight: a second is requeued, never concurrent",
    async run(env) {
      const mac = await env.device("mac");
      const doc = await seedDoc(mac);
      mac.upsert("note", uuid(), noteEnv(doc), noteContent("x"));
      const [a, b] = await Promise.all([mac.push(), mac.push()]);
      check([a, b].includes("requeued") && [a, b].includes("sent"), `expected sent and requeued, saw ${a} and ${b}`);
    },
  },
  {
    id: "P29", name: "a sender discards the fan-out of its own ops but advances its cursor",
    async run(env) {
      const mac = await env.device("mac");
      const doc = await seedDoc(mac);
      await mac.push();
      const stampBefore = mac.get("notebook", doc)!.updated_at;
      await mac.pull();
      check(mac.cursor > 0, "the cursor did not advance across own ops");
      check(mac.get("notebook", doc)!.updated_at === stampBefore && !mac.get("notebook", doc)!.dirty, "own op re-stamped the row");
      check(mac.kept.length === 0 && mac.stats.conflict === 0, "own op produced a self-conflict");
    },
  },
  {
    id: "P30", name: "the same op over two transports is applied once",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      await mac.push();
      const frame = await phone.request("GET", "/v1/pull?since=0");
      await phone.applyFrame(frame as never);
      const cursor = phone.cursor;
      await phone.applyFrame(frame as never);
      check(phone.cursor === cursor && phone.rows.size === 1, "a redelivered frame was applied twice");
      void doc;
    },
  },
  {
    id: "P32", name: "a revoked device's push is refused whole, no seq allocated", needs: ["revoke"],
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      await mac.push();
      const seq = Number((await mac.hello()).seq);
      phone.upsert("note", uuid(), noteEnv(doc), noteContent("from a revoked phone"));
      await env.revoke!(phone.deviceId);
      let refused = false;
      try { await phone.push(); } catch (e) { refused = e instanceof HttpError && e.status === 401; }
      check(refused, "the revoked push was not refused with 401");
      check(Number((await mac.hello()).seq) === seq, "a seq was allocated for a revoked device");
      check(phone.dirtyRows().length === 1, "the refused row was cleaned or lost");
    },
  },
  {
    id: "P36", name: "a remote structural move during a text edit: one conflict, one kept version",
    async run(env) {
      const mac = await env.device("mac"), phone = await env.device("iphone");
      const doc = await seedDoc(mac);
      const n = uuid();
      mac.upsert("note", n, noteEnv(doc, 0), noteContent("text"));
      await sync(mac, phone);
      mac.upsert("note", n, noteEnv(doc, 5), noteContent("text"));
      phone.upsert("note", n, noteEnv(doc, 0), noteContent("text edited"));
      await mac.push();
      await phone.push();
      await sync(mac, phone);
      const kept = [...mac.kept, ...phone.kept].filter((k) => k.reason === "conflict");
      check(kept.length === 1, `expected exactly one kept version, saw ${kept.length}`);
    },
  },
];

export async function runCases(env: ConformanceEnv, only?: string[]): Promise<{ id: string; name: string; result: "pass" | "fail" | "skip"; detail?: string }[]> {
  const out = [];
  for (const c of CASES) {
    if (only && !only.includes(c.id)) continue;
    if (c.needs?.some((n) => !env.capabilities.has(n))) {
      out.push({ id: c.id, name: c.name, result: "skip" as const, detail: `needs ${c.needs.join(", ")}` });
      continue;
    }
    try {
      await c.run(env);
      out.push({ id: c.id, name: c.name, result: "pass" as const });
    } catch (e) {
      out.push({ id: c.id, name: c.name, result: "fail" as const, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
