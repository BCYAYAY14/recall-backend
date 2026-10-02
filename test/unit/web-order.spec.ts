// The web's sibling order (assets/js/order.js and the writers in store.js)
// against Recall's `OrderSlots` (owner rulings 2026-09-25 and 2026-09-26,
// the app's landmine 256): the same read order, the same slots, the same
// windowed respace, so a web edit costs what an app edit costs. The expected
// values are the ones `SpacedPositionSyncTests` pins in the Swift suite.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

interface Plan { lo: number; hi: number; positions: number[] }
interface Row { id: string; position: number; created_at?: string | null }
interface OrderModule {
  GAP: number;
  ROOMY: number;
  CEILING: number;
  compare(a: Row, b: Row): number;
  slots(count: number, prev: number | null, next: number | null): number[] | null;
  plan(positions: number[], count: number, index: number): Plan;
  allocate(group: Row[], index: number, count: number, move: (row: Row, position: number) => void): number[];
}

const { Order } = loadAssets<{ Order: OrderModule }>(["order.js"], ["Order"]);
const { GAP, CEILING } = Order;

/// Inserts `count` rows at `index` of a bare position list, as the app's
/// allocator does, and returns how many existing rows moved.
function insert(p: number[], index: number, count = 1): number {
  const plan = Order.plan(p, count, index);
  const kept = plan.positions.slice(0, index - plan.lo).concat(plan.positions.slice(index - plan.lo + count));
  const moved = p.slice(plan.lo, plan.hi).filter((x, i) => x !== kept[i]).length;
  p.splice(plan.lo, plan.hi - plan.lo, ...plan.positions);
  return moved;
}

function assertSpaced(p: number[]) {
  for (let i = 1; i < p.length; i++) expect(p[i]!).toBeGreaterThan(p[i - 1]!);
  expect(p[0]).toBeGreaterThanOrEqual(0);
  expect(p[p.length - 1]).toBeLessThanOrEqual(CEILING);
}

const spaced = (n: number) => Array.from({ length: n }, (_, i) => (i + 1) * GAP);

describe("the read order", () => {
  it("is position, then created_at to the millisecond, then the lowercase hex id", () => {
    const t = "2026-09-26T10:00:00.000Z";
    const later = "2026-09-26T10:00:00.001Z";
    expect(Order.compare({ id: "b", position: 1, created_at: later }, { id: "a", position: 2, created_at: t })).toBeLessThan(0);
    expect(Order.compare({ id: "b", position: 1, created_at: t }, { id: "a", position: 1, created_at: later })).toBeLessThan(0);
    // An id pushed by the app arrives upper case, one made here lower case:
    // the comparison is the hex, never the case (`lower(hex(id))`).
    const upper = { id: "B0000000-0000-4000-8000-000000000000", position: 1, created_at: t };
    const lower = { id: "a1000000-0000-4000-8000-000000000000", position: 1, created_at: t };
    expect(Order.compare(lower, upper)).toBeLessThan(0);
    expect(Order.compare(upper, lower)).toBeGreaterThan(0);
    expect([upper, lower].sort(Order.compare)).toEqual([lower, upper]);
  });
});

describe("the arithmetic (testSlotsAreBetweenTheirNeighboursAndNeverNegative)", () => {
  it("puts a slot between its neighbours and never below zero", () => {
    expect(Order.slots(1, 1024, 2048)).toEqual([1536]);
    expect(Order.slots(1, null, 1024)).toEqual([511]);
    expect(Order.slots(1, null, null)).toEqual([1024]);
    expect(Order.slots(1, 2048, null)).toEqual([3072]);
    expect(Order.slots(1, 3, 4)).toBeNull();
    expect(Order.slots(1, 7, 7)).toBeNull();
    expect(Order.slots(1, null, 0)).toBeNull();
    expect(Order.slots(3, 0, 8)).toEqual([2, 4, 6]);
    expect(Order.slots(3, 0, 3)).toBeNull();
    expect(Order.slots(1, CEILING - 10, null)).toEqual([CEILING - 5]);
    expect(Order.slots(1, CEILING, null)).toBeNull();
  });
});

describe("the window rule (testPlanRespacesOnlyTheLinesNearby)", () => {
  it("respaces one neighbour in the middle, on the sparse side", () => {
    const p = spaced(20);
    p[10] = p[9]! + 1;
    const mid = Order.plan(p, 1, 10);
    expect([mid.lo, mid.hi]).toEqual([10, 11]);
    expect(mid.positions).toEqual([p[9]! + 682, p[9]! + 1364]);
  });

  it("keeps half the room free at the start and never goes negative", () => {
    const start = Order.plan([0, 1, 2, 3, 4096, 5120, 6144, 7168, 8192, 9216], 1, 0);
    expect(start.lo).toBe(0);
    expect(start.positions.every(x => x >= 0)).toBe(true);
    expect(start.positions[0]).toBeGreaterThanOrEqual(2047);
    expect(start.positions[start.positions.length - 1]).toBeLessThan(4096);
  });

  it("steps by the gap at the end, and spreads to the ceiling when it cannot", () => {
    const end = Order.plan([1024, 2048, 3072, 4096, 5120, 6144, 6145], 1, 6);
    expect(end).toEqual({ lo: 6, hi: 7, positions: [7168, 8192] });
    const ceil = Order.plan([1024, 2048, CEILING - 1, CEILING], 1, 3);
    expect(ceil.positions.every(x => x <= CEILING)).toBe(true);
    expect(ceil.hi - ceil.lo).toBeLessThan(4);
  });

  it("respaces a dense group once, whole, and a pasted run is never dense", () => {
    expect(Order.plan(Array.from({ length: 10 }, (_, i) => i), 1, 5))
      .toEqual({ lo: 0, hi: 10, positions: Array.from({ length: 11 }, (_, i) => (i + 1) * GAP) });
    const paste = Order.plan(spaced(6), 50, 2);
    expect(paste.hi - paste.lo).toBeGreaterThan(0);
    for (let i = 1; i < paste.positions.length; i++) {
      expect(paste.positions[i]! - paste.positions[i - 1]!).toBeGreaterThanOrEqual(Order.ROOMY);
    }
  });
});

describe("a 6668 line doc (the Swift suite's numbers)", () => {
  // Stamped rows besides the new one, the most in any one insert and the
  // total: `SpacedPositionSyncTests` prints the same pairs for the app.
  function run(p: number[], ops: number, index: (i: number) => number) {
    let max = 0, total = 0;
    for (let i = 0; i < ops; i++) {
      const moved = insert(p, index(i));
      max = Math.max(max, moved);
      total += moved;
    }
    return { max, total };
  }

  it("one spot and typing forward stamp the lines nearby only", () => {
    const p = spaced(6668);
    const spot = run(p, 300, () => 3001);
    // L5000 has moved down by the 300 rows typed above it.
    let last = 5300;
    const forward = run(p, 300, () => ++last);
    expect(spot).toEqual({ max: 16, total: 148 });
    expect(forward).toEqual({ max: 16, total: 129 });
    assertSpaced(p);
  });

  it("above the first line stays positive and near the top", () => {
    const p = spaced(6668);
    expect(run(p, 150, () => 0)).toEqual({ max: 64, total: 288 });
    assertSpaced(p);
  });

  it("above the last line and at the ceiling stay near the end", () => {
    const p = spaced(6668);
    expect(run(p, 150, () => p.length - 1)).toEqual({ max: 1, total: 13 });
    expect(run(p, 150, () => p.length)).toEqual({ max: 0, total: 0 });
    p[p.length - 1] = CEILING;
    expect(run(p, 20, () => p.length)).toEqual({ max: 1, total: 1 });
    assertSpaced(p);
  });
});

// store.js's writers over a stub Backend that records every write.
interface Written { lane: string; id: string; patch: { env?: Record<string, unknown> } }
interface StoreModule {
  insertLine(docId: string, afterId: string | null, text?: string, kind?: string, t?: number): string;
  createDoc(name: string, folderId?: string | null, t?: number): string;
  insertTable(docId: string, afterId: string | null, opts?: { rows?: number; columns?: number }, t?: number): string;
  addTableRow(tableId: string, afterRowId: string | null, t?: number): string | null;
  tableOf(tableId: string): { rows: Row[] } | null;
}

function loadStore() {
  const root = path.join(import.meta.dirname, "..", "..", "assets", "js");
  const src = ["wire.js", "order.js", "gate.js", "spans.js", "model.js"].map(f => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  const stub = `
    const Backend = (() => {
      const L = { folders: new Map(), docs: new Map(), notes: new Map(), media: new Map(), cards: [], events: [], occlusion: [] };
      const writes = [];
      const table = lane => lane === "note" ? L.notes : lane === "notebook" ? L.docs : L.folders;
      return {
        library: () => L,
        get: (lane, id) => table(lane).get(id) || null,
        write(lane, id, patch = {}, opts = {}) {
          writes.push({ lane, id, patch });
          const row = { ...(table(lane).get(id) || { id }), ...(patch.env || {}), ...(patch.content || {}) };
          if (opts.tombstone) row.deleted_at = new Date(opts.now || 0).toISOString();
          table(lane).set(id, row);
        },
        writes,
      };
    })();`;
  const store = readFileSync(path.join(root, "store.js"), "utf8");
  return new Function(`${src}\n;\n${stub}\n;\n${store}\nreturn { Store, Backend };`)() as {
    Store: StoreModule;
    Backend: { writes: Written[]; library(): { notes: Map<string, Row & { parent_id: string | null }>; docs: Map<string, Row & { folder_id: string | null }> } };
  };
}

describe("store.js places rows as the app does", () => {
  it("a line typed at one spot of a 6668 line doc writes the lines nearby only", () => {
    const { Store, Backend } = loadStore();
    const doc = Store.createDoc("Big", null, Date.parse("2026-09-26T00:00:00.000Z"));
    const first = [...Backend.library().notes.keys()][0]!;
    let after: string = first;
    for (let i = 0; i < 6667; i++) after = Store.insertLine(doc, after, "", "paragraph", 1_000 + i);
    const lines = [...Backend.library().notes.values()].sort(Order.compare);
    expect(lines.map(n => n.position)).toEqual(spaced(6668));
    const spot = lines[3000]!.id;
    let max = 0, total = 0;
    for (let i = 0; i < 300; i++) {
      Backend.writes.length = 0;
      const made = Store.insertLine(doc, spot, "", "paragraph", 20_000 + i);
      const moved = Backend.writes.filter(w => w.id !== made);
      // Only a position is written for a row that moved, and only when it
      // changed.
      for (const w of moved) expect(Object.keys(w.patch.env || {})).toEqual(["position"]);
      max = Math.max(max, moved.length);
      total += moved.length;
    }
    expect({ max, total }).toEqual({ max: 16, total: 148 });
    const after300 = [...Backend.library().notes.values()].sort(Order.compare);
    assertSpaced(after300.map(n => n.position));
    expect(after300[3001]!.id).toBe(Backend.writes[Backend.writes.length - 1]!.id);
  }, 60_000); // 6,967 single inserts, each reading the whole group: seconds on a busy machine

  it("a new doc takes the slot after the last doc of its own folder", () => {
    const { Store, Backend } = loadStore();
    const a = Store.createDoc("A", null, 1_000);
    const b = Store.createDoc("B", null, 2_000);
    const inside = Store.createDoc("In", "folder-1", 3_000);
    const docs = Backend.library().docs;
    expect([a, b, inside].map(id => docs.get(id)!.position)).toEqual([GAP, 2 * GAP, GAP]);
  });

  it("a table's rows are spaced and a row added between them moves nothing", () => {
    const { Store, Backend } = loadStore();
    const doc = Store.createDoc("T", null, 1_000);
    const table = Store.insertTable(doc, null, { rows: 3, columns: 2 }, 2_000);
    const rows = Store.tableOf(table)!.rows;
    expect(rows.map(r => r.position)).toEqual([GAP, 2 * GAP, 3 * GAP]);
    Backend.writes.length = 0;
    const added = Store.addTableRow(table, rows[0]!.id, 3_000)!;
    const moved = Backend.writes.filter(w => w.lane === "note" && w.id !== added && w.id !== table);
    expect(moved).toEqual([]);
    expect(Store.tableOf(table)!.rows.map(r => r.id)).toEqual([rows[0]!.id, added, rows[1]!.id, rows[2]!.id]);
  });
});
