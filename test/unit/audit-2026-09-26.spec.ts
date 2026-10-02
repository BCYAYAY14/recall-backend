// The 2026-09-26 review's backend repros (BACKEND-1 to BACKEND-7 in the
// review's numbering, noted per case where it differs). Each asserts the
// correct behaviour and failed on the tree the review read.
import { describe, expect, it } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import { ipBlock } from "../../src/http.ts";
import { carryReplaced, LibraryCore, OP_RETENTION_MS, pageSize, Refused } from "../../src/library-core.ts";
import { coreServer } from "../support/core-server.ts";
import { validateOp } from "../../src/protocol.ts";
import { nodeSql } from "../support/node-sql.ts";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

function core() {
  const c = new LibraryCore(nodeSql());
  c.migrate();
  return c;
}

function notebookOp(id: string, at: number, name = "Doc", base = 0) {
  return { op_id: crypto.randomUUID(), lane: "notebook", id, kind: "upsert", updated_at: iso(at), base_seq: base,
    env: { folder_id: null, position: 0, created_at: iso(T0), deleted_at: null, exam_at: null, retention_pct: null, new_per_day: null },
    content: { name, emoji: "x", style: null } };
}
function noteOp(id: string, nb: string, at: number, front = "p", base = 0) {
  return { op_id: crypto.randomUUID(), lane: "note", id, kind: "upsert", updated_at: iso(at), base_seq: base,
    env: { notebook_id: nb, parent_id: null, position: 0, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: iso(T0), deleted_at: null },
    content: { front, back: null, cloze_text: null, tags: "", spans: null, attrs: null } };
}
function noteTombstone(id: string, nb: string, at: number, base: number) {
  return { op_id: crypto.randomUUID(), lane: "note", id, kind: "tombstone", updated_at: iso(at), base_seq: base,
    env: { notebook_id: nb, parent_id: null, position: 0, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: iso(T0), deleted_at: iso(at) } };
}
function cardOp(id: string, note: string, at: number) {
  return { op_id: crypto.randomUUID(), lane: "card", id, kind: "upsert", updated_at: iso(at), base_seq: 0,
    env: { note_id: note, cloze_ordinal: null, flag: 0, suspended: false, stability: 0, difficulty: 0, due: iso(at), state: "new", last_review_at: null, introduced_on: null, reps: 0, lapses: 0, detached: false, deleted_at: null },
    content: { q_snapshot: null, a_snapshot: null } };
}

describe("backend audit repros", () => {
  it("BACKEND-1: a paged snapshot delivers a notebook before its notes and a note before its cards", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID(), card = crypto.randomUUID();
    const mac = crypto.randomUUID();
    const ack = c.push(mac, { batch: "b", ops: [notebookOp(nb, T0 + 1), noteOp(note, nb, T0 + 2), cardOp(card, note, T0 + 3)] }, T0 + 10);
    expect(ack.ack.results.map((r) => r.outcome)).toEqual(["applied", "applied", "applied"]);
    // One row a page: what a bootstrap sees at every 1000-row page boundary.
    const order: string[] = [];
    let lane = "", id = "";
    for (;;) {
      const page = c.snapshot(lane, id, 1);
      order.push(...page.rows.map((r) => r.lane));
      if (!page.more || !page.next) break;
      lane = page.next.after_lane; id = page.next.after_id;
    }
    expect(order).toEqual(["notebook", "note", "card"]);
  });

  it("BACKEND-2: after the daily compaction a catch-up pull still delivers a notebook before its note", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID();
    const mac = crypto.randomUUID();
    c.push(mac, { batch: "b1", ops: [notebookOp(nb, T0 + 1)] }, T0 + 10);              // seq 1
    c.push(mac, { batch: "b2", ops: [noteOp(note, nb, T0 + 2)] }, T0 + 20);             // seq 2
    c.push(mac, { batch: "b3", ops: [notebookOp(nb, T0 + 3, "Renamed", 1)] }, T0 + 30); // seq 3 supersedes seq 1
    c.compact(T0 + DAY); // the 03:17 UTC alarm deletes superseded seq 1
    const page1 = c.pull(0, 1); // one op a page: a 500-op page boundary in miniature
    expect(page1.ops.map((o) => o.lane)).toEqual(["notebook"]);
  });

  it("BACKEND-4 (review BACKEND-3 repro): a device bootstrapped after 45 days offline still learns of a note deleted 31+ days ago", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID();
    const mac = crypto.randomUUID(), phone = crypto.randomUUID();
    c.hello(phone, { pv: 1, device: phone, since: 0 }, T0);
    c.push(mac, { batch: "b1", ops: [notebookOp(nb, T0 + 1), noteOp(note, nb, T0 + 2)] }, T0 + 10); // seq 1, 2
    c.ack(phone, 2, T0 + 20, true); // the phone holds the note live, then goes quiet
    const del = c.push(mac, { batch: "b2", ops: [noteTombstone(note, nb, T0 + DAY, 2)] }, T0 + DAY); // seq 3
    expect(del.ack.results[0]!.outcome).toBe("applied");
    const later = T0 + DAY + OP_RETENTION_MS + DAY;
    c.push(mac, { batch: "b3", ops: [notebookOp(nb, later - 1000, "Still here", 1)] }, later - 1000);
    c.hello(mac, { pv: 1, device: mac, since: 4 }, later - 500);
    c.ack(mac, 4, later - 500, true);
    c.compact(later);
    const hello = c.hello(phone, { pv: 1, device: phone, since: 2 }, later + 1);
    expect(hello.reason).toBe("retention_gap"); // the phone must bootstrap
    expect(() => c.pull(2, 500)).toThrow(/bootstrap/);
    const snap = c.snapshot("", "", 1000);
    expect(snap.rows.find((r) => r.id === note)?.kind).toBe("tombstone");
  });

  it("BACKEND-6: a column named after an Object.prototype member is refused as unknown_column", () => {
    const op = noteOp(crypto.randomUUID(), crypto.randomUUID(), T0 + 1) as Record<string, unknown>;
    Object.defineProperty(op.env, "constructor", { value: "junk", enumerable: true });
    expect(validateOp(JSON.parse(JSON.stringify(op)))).toBe("unknown_column:env.constructor");
  });
  it("BACKEND-3: the device whose clean revision was replaced still hears `replaced` after the replacer types again", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID();
    const phone = crypto.randomUUID(), mac = crypto.randomUUID();
    c.push(phone, { batch: "b0", ops: [notebookOp(nb, T0 + 1)] }, T0 + 10);                           // seq 1
    c.push(phone, { batch: "b1", ops: [noteOp(note, nb, T0 + 2, "phone words", 0)] }, T0 + 20);        // seq 2, clean on the phone
    const r = c.push(mac, { batch: "b2", ops: [noteOp(note, nb, T0 + 3, "mac words", 0)] }, T0 + 30);  // seq 3: never saw seq 2
    expect(r.ack.results[0]).toMatchObject({ outcome: "applied" });
    expect(r.committed[0]!.replaced?.updated_at).toBe(iso(T0 + 2));                                    // F-22 marks the replaced revision
    c.push(mac, { batch: "b3", ops: [noteOp(note, nb, T0 + 4, "mac words, more", 3)] }, T0 + 40);    // seq 4: the Mac keeps typing
    c.compact(T0 + DAY);                                                                               // seq 3 is superseded and deleted
    const frame = c.pull(2, 500);                                                                      // the phone comes back
    expect(frame.ops.filter((o) => o.id === note).some((o) => o.replaced?.updated_at === iso(T0 + 2))).toBe(true);
  });
  it("BACKEND-4: an offline edit OLDER than a delete does not resurrect the row once the tombstone is purged", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID();
    const mac = crypto.randomUUID(), phone = crypto.randomUUID();
    c.push(mac, { batch: "b1", ops: [notebookOp(nb, T0 + 1), noteOp(note, nb, T0 + 2)] }, T0 + 10);   // seq 1, 2
    c.hello(phone, { pv: 1, device: phone, since: 0 }, T0 + 20);                                        // the phone holds seq 2
    c.ack(phone, 2, T0 + 20, true);
    c.push(mac, { batch: "b2", ops: [noteTombstone(note, nb, T0 + DAY, 2)] }, T0 + DAY);                // seq 3: deleted on day 1
    c.hello(phone, { pv: 1, device: phone, since: 2 }, T0 + 20 * DAY);                                  // seen on day 20, did not pull
    c.compact(T0 + 32 * DAY);                                                                           // tombstone older than 30 days: purged
    // Day 33: the phone (seen 13 days ago, inside the 45-day window) pushes an edit it made on day 0, before the delete.
    const r = c.push(phone, { batch: "b3", ops: [noteOp(note, nb, T0 + 5, "offline edit from day 0", 2)] }, T0 + 33 * DAY);
    expect(r.ack.results[0]!.outcome).not.toBe("applied");
    expect(c.row("note", note)?.kind ?? "tombstone").toBe("tombstone");
  });

  it("BACKEND-5: an updated_at far in the future is refused rather than winning every later edit", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID();
    const phone = crypto.randomUUID(), mac = crypto.randomUUID();
    c.push(mac, { batch: "b0", ops: [notebookOp(nb, T0 + 1)] }, T0 + 10);
    const future = Date.parse("2099-01-01T00:00:00.000Z");
    const r = c.push(phone, { batch: "b1", ops: [noteOp(note, nb, future, "clock wrong", 0)] }, T0 + 20);
    expect(r.ack.results[0]).toMatchObject({ outcome: "rejected", reason: "future_time" });
  });

  it("BACKEND-1: a table's rows and a nested outline arrive after their parents, and a pre-order cursor starts over", () => {
    const c = core();
    const nb = crypto.randomUUID();
    // Ids chosen so every child sorts BEFORE its parent.
    const table = "ffffffff-0000-4000-8000-000000000001", row = "00000000-0000-4000-8000-000000000002";
    const deep = "00000000-0000-4000-8000-000000000001";
    const mac = crypto.randomUUID();
    const child = (id: string, parent: string, at: number) => {
      const op = noteOp(id, nb, at);
      (op.env as Record<string, unknown>).parent_id = parent;
      return op;
    };
    c.push(mac, { batch: "b", ops: [notebookOp(nb, T0 + 1), noteOp(table, nb, T0 + 2), child(row, table, T0 + 3), child(deep, row, T0 + 4)] }, T0 + 10);
    const seen: string[] = [];
    let lane = "", id = "";
    for (;;) {
      const page = c.snapshot(lane, id, 1);
      seen.push(...page.rows.map((r) => r.id));
      if (!page.more || !page.next) break;
      lane = page.next.after_lane; id = page.next.after_id;
    }
    expect(seen).toEqual([nb, table, row, deep]);
    // A cursor from the (lane, id) order is not trusted: the walk starts again.
    expect(c.snapshot("note", table, 1000).rows.map((r) => r.id)).toEqual([nb, table, row, deep]);
  });

  it("BACKEND-2: after compaction a card whose note was edited later still follows a retained op of its note", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID(), card = crypto.randomUUID();
    const mac = crypto.randomUUID();
    c.push(mac, { batch: "b1", ops: [notebookOp(nb, T0 + 1), noteOp(note, nb, T0 + 2, "q :: a")] }, T0 + 10); // seq 1, 2
    c.push(mac, { batch: "b2", ops: [cardOp(card, note, T0 + 3)] }, T0 + 20);                              // seq 3
    for (let i = 0; i < 5; i++) c.push(mac, { batch: `t${i}`, ops: [noteOp(note, nb, T0 + 4 + i, `q :: a ${i}`, 2 + i)] }, T0 + 30 + i);
    const out = c.compact(T0 + DAY);
    expect(out.superseded).toBe(4); // the note's four middle revisions; its first stays for the card
    const lanes: string[] = [];
    const held = new Set<string>();
    let since = 0;
    for (;;) {
      const f = c.pull(since, 1);
      for (const o of f.ops) {
        lanes.push(o.lane);
        if (o.lane === "card") expect(held.has(String(o.env.note_id))).toBe(true);
        held.add(o.id);
      }
      since = f.to;
      if (!f.more) break;
    }
    expect(lanes).toEqual(["notebook", "note", "card", "note"]);
  });

  it("BACKEND-3: a replaced op followed by its successor in ONE frame still carries the marker on the newest op", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID();
    const phone = crypto.randomUUID(), mac = crypto.randomUUID();
    c.push(phone, { batch: "b0", ops: [notebookOp(nb, T0 + 1), noteOp(note, nb, T0 + 2, "phone words", 0)] }, T0 + 10); // seq 1, 2
    c.push(mac, { batch: "b1", ops: [noteOp(note, nb, T0 + 3, "mac words", 0)] }, T0 + 20);                          // seq 3, replaced
    c.push(mac, { batch: "b2", ops: [noteOp(note, nb, T0 + 4, "mac words, more", 3)] }, T0 + 30);                    // seq 4
    const frame = c.pull(2, 500);
    const newest = frame.ops.filter((o) => o.id === note).at(-1)!;
    expect(newest.seq).toBe(4);
    expect(newest.replaced?.updated_at).toBe(iso(T0 + 2));
    // The newest op's own marker is never replaced by an older one.
    const own = { updated_at: iso(T0 + 9), device: "x" };
    const rows = carryReplaced([{ ...frame.ops[0]!, replaced: { updated_at: iso(T0 + 2), device: phone } }, { ...frame.ops[0]!, seq: 9, replaced: own }]);
    expect(rows[1]!.replaced).toEqual(own);
  });

  it("BACKEND-4: a tombstone older than a year goes once every device seen in that year has acknowledged it", () => {
    const c = core();
    const nb = crypto.randomUUID(), note = crypto.randomUUID();
    const mac = crypto.randomUUID();
    c.push(mac, { batch: "b1", ops: [notebookOp(nb, T0 + 1), noteOp(note, nb, T0 + 2)] }, T0 + 10);
    c.push(mac, { batch: "b2", ops: [noteTombstone(note, nb, T0 + DAY, 2)] }, T0 + DAY);
    c.hello(mac, { pv: 1, device: mac, since: 3 }, T0 + 400 * DAY);
    c.ack(mac, 3, T0 + 400 * DAY, true);
    expect(c.compact(T0 + 400 * DAY).purged).toBe(1);
    expect(c.row("note", note)).toBeNull();
  });

  it("BACKEND-9: a nonsense limit falls back and a nonsense cursor is refused, never bound as NaN", () => {
    const c = core();
    expect(pageSize("abc", 500)).toBe(500);
    expect(pageSize(5000, 500)).toBe(1000);
    expect(c.snapshot("", "", Number.NaN).more).toBe(false);
    expect(c.pull(0, Number.NaN).ops).toEqual([]);
    expect(() => c.pull(Number.NaN, 500)).toThrow(Refused);
  });

  it("BACKEND-10: an IPv6 address counts by its /64", () => {
    expect(ipBlock("2001:db8:1:2:aaaa::1")).toBe(ipBlock("2001:0db8:0001:0002:bbbb:cccc:dddd:eeee"));
    expect(ipBlock("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipBlock("198.51.100.7")).toBe("198.51.100.7");
  });

  it("BACKEND-12: a restore into an object whose rows were all purged numbers on from the old sequence", () => {
    const c = core();
    const nb = crypto.randomUUID();
    const mac = crypto.randomUUID();
    c.push(mac, { batch: "b1", ops: [notebookOp(nb, T0 + 1)] }, T0 + 10);
    const lines = [...c.snapshotLines()];
    c.push(mac, { batch: "b2", ops: [{ ...notebookOp(nb, T0 + 2, "Doc", 1), kind: "tombstone", content: undefined,
      env: { folder_id: null, position: 0, created_at: iso(T0), deleted_at: iso(T0 + 2), exam_at: null, retention_pct: null, new_per_day: null } }] }, T0 + 20);
    c.compact(T0 + 400 * DAY); // the tombstone goes; op 2 stays, the newest is never deleted
    expect(c.row("notebook", nb)).toBeNull();
    const before = c.maxSeq();
    expect(c.restoreFrom(lines, T0 + 401 * DAY)).toBe(1);
    expect(c.row("notebook", nb)?.seq).toBe(before + 1);
    expect(c.retainedFrom()).toBe(before + 1);
  });

  it("D-142: an epoch bootstrap re-offers every clean row the restored library lacks, as a successor", async () => {
    const server = coreServer();
    server.clock.now = T0;
    const dev = () => { const id = crypto.randomUUID(); return new ReferenceClient("http://core", id, id, server.fetch, () => server.clock.now); };
    const mac = dev(), phone = dev();
    const nb = crypto.randomUUID(), before = crypto.randomUUID(), after = crypto.randomUUID();
    const nbEnv = { folder_id: null, position: 0, created_at: iso(T0), exam_at: null, retention_pct: null, new_per_day: null };
    const env = { notebook_id: nb, parent_id: null, position: 0, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: iso(T0) };
    const content = (front: string) => ({ front, back: null, cloze_text: null, tags: "", spans: null, attrs: null });
    await mac.hello(); await phone.hello();
    mac.upsert("notebook", nb, nbEnv, { name: "Doc", emoji: "x", style: null });
    mac.upsert("note", before, env, content("in the snapshot"));
    await mac.push(); await phone.pull();
    const lines = [...server.core.snapshotLines()];
    server.clock.now += 1000;
    mac.upsert("note", after, env, content("acknowledged after it"));
    mac.upsert("note", before, env, content("edited after it"));
    await mac.push();
    expect(mac.dirtyRows()).toEqual([]);
    // The object is deleted and restored from `lines` behind the same URL.
    const restored = coreServer();
    restored.clock.now = server.clock.now + 1000;
    restored.core.restoreFrom(lines, restored.clock.now);
    server.clock.now = restored.clock.now;
    for (const d of [mac, phone]) (d as unknown as { fetchFn: typeof restored.fetch }).fetchFn = restored.fetch;
    expect((await phone.hello()).reason).toBe("epoch");
    expect((await mac.hello()).reason).toBe("epoch");
    expect(mac.dirtyRows().map((r) => r.id).sort()).toEqual([after, before].sort());
    await mac.push(); await phone.pull();
    expect(phone.get("note", after)?.content.front).toBe("acknowledged after it");
    expect(phone.get("note", before)?.content.front).toBe("edited after it");
    expect(restored.core.conflicts(10)).toEqual([]);
    const remote = JSON.stringify((await restored.core.digest()).lanes);
    for (const d of [mac, phone]) expect(JSON.stringify(await d.digest())).toBe(remote);
  });

  it("BACKEND-13: a reference client with foreign keys bootstraps a paged, compacted library and orphans nothing", async () => {
    const server = coreServer();
    const dev = (id = crypto.randomUUID()) => { let tick = 0; return new ReferenceClient("http://core", id, id, server.fetch, () => server.clock.now + (tick++)); };
    const mac = dev();
    const nb = crypto.randomUUID();
    mac.upsert("notebook", nb, { folder_id: null, position: 0, created_at: iso(T0), exam_at: null, retention_pct: null, new_per_day: null }, { name: "Doc", emoji: "x", style: null });
    const notes: string[] = [];
    for (let i = 0; i < 1200; i++) {
      const id = crypto.randomUUID(); notes.push(id);
      mac.upsert("note", id, { notebook_id: nb, parent_id: i % 10 && i > 10 ? notes[i - (i % 10)]! : null, position: i, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: iso(T0) },
        { front: `q ${i} :: a`, back: null, cloze_text: null, tags: "", spans: null, attrs: null });
    }
    for (let i = 0; i < 600; i++) {
      mac.upsert("card", crypto.randomUUID(), { note_id: notes[i * 2]!, cloze_ordinal: null, flag: 0, suspended: false, stability: 0, difficulty: 0, due: iso(T0), state: "new", last_review_at: null, introduced_on: null, reps: 0, lapses: 0, detached: false },
        { q_snapshot: null, a_snapshot: null });
    }
    while (mac.dirtyRows().length) await mac.push();
    // The notebook and a third of the notes are edited again, so compaction reorders their newest ops past the cards.
    server.clock.now += 1000;
    mac.upsert("notebook", nb, { folder_id: null, position: 0, created_at: iso(T0), exam_at: null, retention_pct: null, new_per_day: null }, { name: "Renamed", emoji: "x", style: null });
    for (let i = 0; i < 1200; i += 3) mac.upsert("note", notes[i]!, { ...mac.get("note", notes[i]!)!.env }, { ...mac.get("note", notes[i]!)!.content, tags: "later" });
    while (mac.dirtyRows().length) await mac.push();
    server.core.compact(server.clock.now);
    const phone = dev();
    await phone.pull(250);
    const fresh = dev();
    await fresh.bootstrap();
    await fresh.pull();
    expect(phone.orphans).toEqual([]);
    expect(fresh.orphans).toEqual([]);
    expect(JSON.stringify(await phone.digest())).toBe(JSON.stringify(await mac.digest()));
    expect(JSON.stringify(await fresh.digest())).toBe(JSON.stringify(await mac.digest()));
  }, 180_000);
});
