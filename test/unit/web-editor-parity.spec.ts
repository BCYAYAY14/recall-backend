// D-190's store and span rules on the web, over the exact asset bytes: the
// block move (`CanvasDocument.moveBlocks`), a card table's header (E18), the
// link command's address rules (`LinkTarget.selfLink`, D-011), where a style
// may land (`InlineSpans.styleableRanges`), and the write observer the
// editor's undo is built on.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = path.join(import.meta.dirname, "..", "..", "assets", "js");
const T0 = Date.parse("2026-09-29T00:00:00.000Z");

function stubbed() {
  const prelude = `
    const writes = [];
    const rowsMap = new Map();
    const Backend = {
      writes, rowsMap,
      library() {
        const notes = new Map(), docs = new Map(), folders = new Map(), media = new Map();
        const cards = [], occlusion = [], events = [];
        for (const [k, r] of rowsMap) {
          const lane = k.split("|")[0];
          if (lane === "note") notes.set(r.id, r);
          else if (lane === "notebook") docs.set(r.id, r);
          else if (lane === "media") media.set(r.id, r);
          else if (lane === "card") cards.push(r);
          else if (lane === "occlusion") occlusion.push(r);
        }
        return { notes, docs, folders, media, cards, occlusion, events, settings: { retention: 90, newPerDay: 10 } };
      },
      get(lane, id) { return rowsMap.get(lane + "|" + id) || null; },
      write(lane, id, patch = {}, opts = {}) {
        const k = lane + "|" + id;
        const next = { ...(rowsMap.get(k) || { id }), ...(patch.env || {}), ...(patch.content || {}) };
        next.deleted_at = opts.tombstone ? "2026-09-29T00:00:01.000Z" : next.deleted_at ?? null;
        if (!opts.tombstone && patch.env && "deleted_at" in patch.env) next.deleted_at = patch.env.deleted_at;
        rowsMap.set(k, next);
        writes.push({ lane, id, patch, opts });
        return next;
      },
      contentBefore() { return null; },
      deviceId() { return "dev"; },
    };`;
  const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "spans.js", "model.js", "sched.js", "store.js"]
    .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${prelude}\n${src}\nreturn { Backend, Store, Order };`)() as any;
}

function doc(lines: string[]) {
  const S = stubbed();
  const id = S.Store.createDoc("D", null, T0);
  const first = [...S.Backend.library().notes.values()][0].id;
  S.Store.saveLine(first, lines[0], T0 + 1);
  const ids = [first];
  for (const line of lines.slice(1)) ids.push(S.Store.insertLine(id, ids[ids.length - 1], line, "paragraph", T0 + 2));
  return { S, id, ids };
}

const order = (S: any, docId: string) => [...S.Backend.library().notes.values()]
  .filter((n: any) => n.deleted_at == null && n.notebook_id === docId && !n.parent_id)
  .sort(S.Order.compare).map((n: any) => n.front);

describe("move block (⌥⌘[ and ⌥⌘])", () => {
  it("a block moves over one neighbour and writes only what moved", () => {
    const { S, id, ids } = doc(["alpha", "beta", "gamma", ""]);
    S.Backend.writes.length = 0;
    expect(S.Store.moveBlocks(id, [ids[0]], false, T0 + 10)).toBe(true);
    expect(order(S, id)).toEqual(["beta", "alpha", "gamma", ""]);
    expect(S.Backend.writes.filter((w: any) => w.lane === "note").map((w: any) => w.id)).toEqual([ids[0]]);
    expect(Object.keys(S.Backend.writes[0].patch.env)).toEqual(["position"]);
  });

  it("the trailing blank line stays last, and the first block cannot move up", () => {
    const { S, id, ids } = doc(["alpha", "beta", ""]);
    expect(S.Store.moveBlocks(id, [ids[1]], false, T0 + 10), "not past the trailing blank line (R4)").toBe(false);
    expect(S.Store.moveBlocks(id, [ids[0]], true, T0 + 10)).toBe(false);
    expect(order(S, id)).toEqual(["alpha", "beta", ""]);
  });

  it("a block set moves whole, and a set with a gap refuses", () => {
    const { S, id, ids } = doc(["a", "b", "c", "d", ""]);
    expect(S.Store.moveBlocks(id, [ids[1], ids[2]], true, T0 + 10)).toBe(true);
    expect(order(S, id)).toEqual(["b", "c", "a", "d", ""]);
    expect(S.Store.moveBlocks(id, [ids[1], ids[3]], true, T0 + 20), "b and d have c and a between them").toBe(false);
  });

  it("a table moves with its rows", () => {
    const { S, id, ids } = doc(["above", "below", ""]);
    const table = S.Store.insertTable(id, ids[0], { rows: 2, columns: 2 }, T0 + 5);
    expect(order(S, id)[1]).toBe("Column 1\tColumn 2\n\t");
    expect(S.Store.moveBlocks(id, [table], true, T0 + 10)).toBe(true);
    expect(order(S, id)[0]).toBe("Column 1\tColumn 2\n\t");
    expect(S.Store.tableOf(table).rows.length, "the rows are the table's and did not move").toBe(2);
  });
});

describe("a card table's header (E18)", () => {
  it("is never deleted; a normal table deletes any row, and its last row takes the table", () => {
    const { S, id, ids } = doc(["x", ""]);
    const cards = S.Store.insertTable(id, ids[0], { rows: 2, cardTable: true }, T0 + 5);
    const header = S.Store.tableOf(cards).rows[0];
    expect(S.Store.deleteTableRow(header.id, T0 + 6)).toBe(false);
    const plain = S.Store.insertTable(id, ids[0], { rows: 2, columns: 2 }, T0 + 7);
    const [h, body] = S.Store.tableOf(plain).rows;
    expect(S.Store.deleteTableRow(h.id, T0 + 8)).toBe(true);
    expect(S.Store.tableOf(plain).rows.map((r: any) => r.id)).toEqual([body.id]);
    expect(S.Store.deleteTableRow(body.id, T0 + 9)).toBe(true);
    expect(S.Backend.get("note", plain).deleted_at, "the last row takes the table").not.toBeNull();
  });
});

describe("the link command's rules and where a style lands", () => {
  const { Spans } = loadAssets<{ Spans: any }>(["spans.js"], ["Spans"]);

  it("words that are an address link to it unasked; other words do not", () => {
    expect(Spans.selfLink("https://example.com/a")).toBe("https://example.com/a");
    expect(Spans.selfLink("www.example.com")).toBe("https://www.example.com");
    expect(Spans.selfLink("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(Spans.selfLink("example.com")).toBeNull();
    expect(Spans.selfLink("FSRS")).toBeNull();
    expect(Spans.selfLink("javascript://x")).toBeNull();
    expect(Spans.linkTarget("en.wikipedia.org/wiki/FSRS")).toBe("https://en.wikipedia.org/wiki/FSRS");
    expect(Spans.linkTarget("two words")).toBeNull();
  });

  it("a style never lands on a picture token or on whitespace at a piece's ends", () => {
    const text = "see {{img:ABC}} the cell ";
    expect(Spans.styleableRanges(text, 0, text.length)).toEqual([{ start: 0, end: 3 }, { start: 16, end: 24 }]);
    expect(Spans.styleableRanges("   ", 0, 3)).toEqual([]);
    expect(Spans.styleableRanges("bold", 1, 3)).toEqual([{ start: 1, end: 3 }]);
  });
});

describe("the write observer the editor's undo is built on", () => {
  it("hears each row's state before a write, null for a new row", () => {
    const store = new Map<string, string>([["recall.viewer.device-id", "11111111-1111-4111-8111-111111111111"]]);
    const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "spans.js", "model.js", "local.js", "backend.js"]
      .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
    const prelude = `
      const window = { addEventListener() {} };
      const document = { addEventListener() {}, visibilityState: "visible" };
      const localStorage = { getItem: k => STORE.get(k) ?? null, setItem: (k, v) => STORE.set(k, String(v)), removeItem: k => STORE.delete(k) };
      const setTimeout = () => 0; const clearTimeout = () => {};
      const setInterval = () => 0; const clearInterval = () => {};
      const fetch = async () => new Response("{}", { status: 404 });`;
    const { Backend } = new Function("STORE", `${prelude}\n${src}\nreturn { Backend };`)(store) as any;
    Backend.adoptFixture([]);
    const heard: any[] = [];
    const off = Backend.observeWrites((lane: string, id: string, prior: any) => heard.push([lane, id, prior && prior.content.front]));
    const env = { notebook_id: "22222222-2222-4222-8222-222222222222", parent_id: null, position: 1024, kind: "paragraph", unreviewed: false,
                  occ_mode: null, typed_answer: false, created_at: "2026-09-29T00:00:00.000Z", deleted_at: null };
    const id = "33333333-3333-4333-8333-333333333333";
    Backend.write("note", id, { env, content: { front: "one", back: null, cloze_text: null, tags: "", spans: null, attrs: null } });
    Backend.write("note", id, { content: { front: "two" } });
    off();
    Backend.write("note", id, { content: { front: "three" } });
    expect(heard).toEqual([["note", id, null], ["note", id, "one"]]);
  });
});
