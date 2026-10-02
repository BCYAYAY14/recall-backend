// BACKEND-1 at library scale (the 2026-09-26 review's simulation). Builds a library shaped like
// the owner's (thousands of rows), walks LibraryCore.snapshot exactly as
// CloudflareSync.bootstrap does (limit 1000, the Swift client's default), and
// models the client's landing rules page by page: rows of one page are applied
// in CloudflareLanes.order; a row lands only when its foreign-key parent is in
// the local store (SQLite FK: note.notebook_id NOT NULL, note.parent_id,
// card.note_id, grade_event.card_id, media.note_id); NotePull re-roots a child
// whose parent is neither local nor in the same page. Prints what an EMPTY
// device holds afterwards.
import { describe, expect, it } from "vitest";
import { LibraryCore } from "../../src/library-core.ts";
import { nodeSql } from "../support/node-sql.ts";

const T0 = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const uuid = () => crypto.randomUUID();

describe("verify BACKEND-1 at library scale", () => {
  it("an empty device bootstrapping an owner-sized library keeps every row", () => {
    const c = new LibraryCore(nodeSql());
    c.migrate();
    const mac = uuid();
    let t = T0;
    const ops: unknown[] = [];
    const notebooks: string[] = [];
    for (let i = 0; i < 30; i++) {
      const id = uuid(); notebooks.push(id);
      ops.push({ op_id: uuid(), lane: "notebook", id, kind: "upsert", updated_at: iso(++t), base_seq: 0,
        env: { folder_id: null, position: i, created_at: iso(T0), deleted_at: null, exam_at: null, retention_pct: null, new_per_day: null },
        content: { name: `Doc ${i}`, emoji: "x", style: null } });
    }
    const notes: { id: string; parent: string | null }[] = [];
    const note = (nb: string, parent: string | null, kind: string) => {
      const id = uuid(); notes.push({ id, parent });
      ops.push({ op_id: uuid(), lane: "note", id, kind: "upsert", updated_at: iso(++t), base_seq: 0,
        env: { notebook_id: nb, parent_id: parent, position: notes.length, kind, unreviewed: false, occ_mode: null, typed_answer: false, created_at: iso(T0), deleted_at: null },
        content: { front: "p", back: null, cloze_text: null, tags: "", spans: null, attrs: null } });
      return id;
    };
    for (let i = 0; i < 4000; i++) note(notebooks[i % 30]!, null, "paragraph");
    const tableRows: string[] = [];
    for (let k = 0; k < 20; k++) {
      const table = note(notebooks[k]!, null, "table");
      for (let r = 0; r < 10; r++) tableRows.push(note(notebooks[k]!, table, "tablerow"));
    }
    const cards: { id: string; note: string }[] = [];
    for (let i = 0; i < 1500; i++) {
      const id = uuid(), n = notes[i * 2]!.id; cards.push({ id, note: n });
      ops.push({ op_id: uuid(), lane: "card", id, kind: "upsert", updated_at: iso(++t), base_seq: 0,
        env: { note_id: n, cloze_ordinal: null, flag: 0, suspended: false, stability: 1, difficulty: 5, due: iso(t), state: "review", last_review_at: null, introduced_on: null, reps: 1, lapses: 0, detached: false, deleted_at: null },
        content: { q_snapshot: null, a_snapshot: null } });
    }
    for (let i = 0; i < 3000; i++) {
      const at = iso(++t);
      ops.push({ op_id: uuid(), lane: "grade_event", id: uuid(), kind: "upsert", updated_at: at, base_seq: 0,
        env: { card_id: cards[i % 1500]!.id, rating: 3, reviewed_at: at, device_id: mac }, content: {} });
    }
    for (let b = 0; b < ops.length; b += 500) {
      const r = c.push(mac, { batch: `b${b}`, ops: ops.slice(b, b + 500) }, t + 1000 + b);
      expect(r.ack.results.every((x) => x.outcome === "applied")).toBe(true);
    }

    // The walk CloudflareSync.bootstrap does (limit 1000), with the client's landing rules.
    const order = ["folder", "notebook", "note", "card", "grade_event", "media", "occlusion", "dictionary", "font"];
    const local = new Map<string, Set<string>>(order.map((l) => [l, new Set<string>()]));
    const reRooted = new Set<string>();
    const pageLanes: string[] = [];
    let lane = "", id = "";
    for (;;) {
      const page = c.snapshot(lane, id, 1000);
      pageLanes.push([...new Set(page.rows.map((r) => r.lane))].join("+"));
      for (const l of order) {
        const rows = page.rows.filter((r) => r.lane === l);
        const inBatch = new Set(rows.map((r) => r.id));
        for (const r of rows) {
          const env = r.env as Record<string, string | null>;
          let ok = true;
          if (l === "note") {
            ok = local.get("notebook")!.has(env.notebook_id!);
            if (ok && env.parent_id) {
              if (local.get("note")!.has(env.parent_id)) { /* parent local */ }
              else if (inBatch.has(env.parent_id)) { /* same page: parentsFirst orders it, lands if the parent lands */ }
              else reRooted.add(r.id);
            }
          }
          if (l === "card" || l === "media") ok = local.get("note")!.has(env.note_id!);
          if (l === "grade_event") ok = local.get("card")!.has(env.card_id!);
          if (ok) local.get(l)!.add(r.id);
        }
      }
      if (!page.more || !page.next) break;
      lane = page.next.after_lane; id = page.next.after_id;
    }
    const got = Object.fromEntries(order.slice(0, 5).map((l) => [l, local.get(l)!.size]));
    const reRootedTableRows = tableRows.filter((x) => reRooted.has(x)).length;
    console.log("pages:", pageLanes.join(" | "));
    console.log("server rows: notebook 30, note", notes.length, "card 1500, grade_event 3000");
    console.log("empty device after bootstrap:", JSON.stringify(got), "table rows re-rooted:", reRootedTableRows, "of", tableRows.length);
    expect(got).toEqual({ folder: 0, notebook: 30, note: notes.length, card: 1500, grade_event: 3000 });
  }, 180_000);
});
