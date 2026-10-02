// The owner's three rulings of 2026-09-29 on the web, over the exact asset
// bytes: underline as the sidecar's seventh style kind `n` (D-189), a cell's
// style in its row's `spans` with no run crossing a cell (D-189,
// `TableCellRuns`), and formulas drawn by the vendored KaTeX, a bad one as
// its own source (D-190).
//
// The sidecar strings below were printed by Recall's own
// `InlineSpans.encode` (Sources/Core/InlineSpans.swift, the working tree of
// 2026-09-29, compiled on its own with stubs for the parser it does not use
// here), so "byte for byte" is the app's bytes, not a restatement of them.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Run { start: number; end: number; kind: string; value?: string | null }
const run = (start: number, end: number, kind: string, value: string | null = null): Run => ({ start, end, kind, value });
const plain = (runs: Run[]) => runs.map(r => [r.start, r.end, r.kind]);

// ------------------------------------------------------------ underline, `n`

describe("underline is the sidecar's `n` (D-189)", () => {
  const { Spans } = loadAssets<{ Spans: any }>(["gate.js", "spans.js"], ["Spans"]);

  it("encodes byte for byte as InlineSpans.encode does", () => {
    const app: [string, Run[], string][] = [
      ["under line", [run(0, 5, "n")],
       '{"v":1,"n":10,"h":"fbdfb59470aa49ab","r":[[0,5,"n"]]}'],
      ["bold italic under", [run(0, 4, "n"), run(0, 4, "i"), run(0, 4, "b"), run(5, 11, "n"), run(5, 11, "s")],
       '{"v":1,"n":17,"h":"71d73f38152a7aba","r":[[0,4,"b"],[0,4,"i"],[0,4,"n"],[5,11,"n"],[5,11,"s"]]}'],
      ["see docs now", [run(4, 8, "n"), run(4, 8, "l", "example.com"), run(0, 3, "h", "#E8C34A")],
       '{"v":1,"n":12,"h":"f0d2fbb7d0d68b0b","r":[[0,3,"h","#e8c34a"],[4,8,"l","https://example.com"],[4,8,"n"]]}'],
      ["Na\tsodium\t23", [run(3, 9, "n"), run(3, 9, "b"), run(0, 2, "p"), run(10, 12, "n")],
       '{"v":1,"n":12,"h":"d84b0c5073506d0a","r":[[0,2,"p"],[3,9,"b"],[3,9,"n"],[10,12,"n"]]}'],
      ["abc", [run(0, 2, "n"), run(1, 3, "n")],
       '{"v":1,"n":3,"h":"cec64e155111225d","r":[[0,3,"n"]]}'],
    ];
    expect(Spans.KINDS).toContain("n");
    for (const [anchor, runs, bytes] of app) {
      expect(Spans.encode(runs, anchor)).toBe(bytes);
      // A blob the Mac wrote reads back and re-encodes to the same bytes, so
      // an untouched line is never rewritten (web-5).
      expect(Spans.encode(Spans.decode(bytes, anchor), anchor)).toBe(bytes);
    }
  });

  it("carries no value: a stray fourth element is dropped and touching runs merge, as Swift decodes", () => {
    const stray = `{"v":1,"n":10,"h":"${Spans.fingerprint("under line")}","r":[[0,2,"n","x"],[2,5,"n"]]}`;
    expect(Spans.encode(Spans.decode(stray, "under line"), "under line"))
      .toBe('{"v":1,"n":10,"h":"fbdfb59470aa49ab","r":[[0,5,"n"]]}');
    expect(Spans.normalizedValue("n", "x")).toBeNull();
  });

  it("toggles, maps and clears like any other kind, and is not exclusive with any", () => {
    const on = Spans.toggle([], "n", 2, 6);
    expect(plain(on)).toEqual([[2, 6, "n"]]);
    expect(Spans.toggle(on, "n", 2, 6)).toEqual([]);
    const both = Spans.normalize([run(0, 4, "n"), run(0, 4, "s"), run(0, 4, "l", "https://a.org"), run(0, 4, "p")], 6);
    expect(both.map((r: Run) => r.kind).sort()).toEqual(["l", "n", "p", "s"]);
    // Typing at its end joins it (sticky right), unlike a link.
    expect(plain(Spans.mapped([run(0, 4, "n")], 4, 0, 3))).toEqual([[0, 7, "n"]]);
    expect(Spans.remove([run(0, 4, "n"), run(0, 4, "b")], null, 0, 4)).toEqual([]);
  });

  it("the stylesheet underlines it in the text's ink, and draws both lines with a strike", () => {
    const css = readFileSync(path.join(import.meta.dirname, "..", "..", "assets", "styles.css"), "utf8");
    expect(/\.sp-n\s*\{[^}]*text-decoration:\s*underline/.test(css)).toBe(true);
    expect(/\.sp-s\.sp-n[^{]*\{[^}]*underline line-through/.test(css)).toBe(true);
    const editor = readFileSync(path.join(import.meta.dirname, "..", "..", "assets", "js", "editor.js"), "utf8");
    expect(editor).toMatch(/u: "n"/);
    expect(editor).toMatch(/formatUnderline"\) \{ event\.preventDefault\(\); format\("n"\)/);
  });
});

// ------------------------------------------------------- table cells, D-189

describe("a cell's style is its row's runs, never crossing a cell (TableCellRuns)", () => {
  const { Spans } = loadAssets<{ Spans: any }>(["gate.js", "spans.js"], ["Spans"]);

  it("splits a run at the tab; the tab carries nothing (testARunNeverCrossesACellBoundary)", () => {
    expect(plain(Spans.clipToCells("ab\tcd", [run(1, 4, "i")], false))).toEqual([[1, 2, "i"], [3, 4, "i"]]);
  });

  it("reads and writes a row's runs cell by cell (testARowsRunsAreReadAndWrittenCellByCell)", () => {
    const text = "Na\tsodium metal\t23";
    const cells = Spans.cellRuns(text, [run(3, 9, "b")], false);
    expect(cells.map(plain)).toEqual([[], [[0, 6, "b"]], []]);
    expect(Spans.rowRuns(cells, text, false)).toEqual([run(3, 9, "b")]);
    // A cell's run past its cell's end is clipped to the cell.
    expect(plain(Spans.rowRuns([[run(0, 99, "n")], [], []], text, false))).toEqual([[0, 2, "n"]]);
  });

  it("a card table's cells split at the `::` gate (testAStyleToggledInACellAndACellEditMapTheRowsRuns)", () => {
    expect(Spans.cellRanges("Nitrate::NO3-", true)).toEqual([{ start: 0, end: 7 }, { start: 9, end: 13 }]);
    expect(plain(Spans.rowRuns([[], [run(0, 4, "s")]], "Nitrate::NO3-", true))).toEqual([[9, 13, "s"]]);
    expect(Spans.cellRanges("Term", true)).toEqual([{ start: 0, end: 4 }, { start: 4, end: 4 }]);
    // A run over the gate is two runs, one each side.
    expect(plain(Spans.clipToCells("Nitrate::NO3-", [run(5, 11, "b")], true))).toEqual([[5, 7, "b"], [9, 11, "b"]]);
  });
});

// The store over a stub backend, as web-editor-parity.spec.ts builds it.
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
        rowsMap.set(k, next);
        writes.push({ lane, id, patch, opts });
        return next;
      },
      contentBefore() { return null; },
      deviceId() { return "dev"; },
    };`;
  const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "spans.js", "model.js", "sched.js", "store.js"]
    .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${prelude}\n${src}\nreturn { Backend, Store, Spans };`)() as any;
}

function table(cardTable: boolean) {
  const S = stubbed();
  const doc = S.Store.createDoc("D", null, T0);
  const first = [...S.Backend.library().notes.values()][0].id;
  const id = S.Store.insertTable(doc, first, cardTable ? { rows: 2, cardTable: true } : { rows: 2, columns: 3 }, T0 + 1);
  return { S, id, rows: S.Store.tableOf(id).rows };
}

describe("a cell's style through the store (Store.saveTableRow)", () => {
  it("a normal table's row stores the cell's run at its offset, as the app does", () => {
    const { S, rows } = table(false);
    expect(S.Store.saveTableRow(rows[1].id, ["Sodium", "Na", "23"], T0 + 2, [[run(0, 6, "n")], [run(0, 2, "b")], []])).toBe(true);
    const row = S.Backend.get("note", rows[1].id);
    expect(row.front).toBe("Sodium\tNa\t23");
    // Recall's InlineSpans.encode for these runs on this text.
    expect(row.spans).toBe('{"v":1,"n":12,"h":"542724fbfec4913a","r":[[0,6,"n"],[7,9,"b"]]}');
    expect(S.Spans.cellRuns(row.front, S.Store.rowRunsOf(row), false)[1]).toEqual([run(0, 2, "b")]);
    // Saving what is shown again writes nothing.
    S.Backend.writes.length = 0;
    expect(S.Store.saveTableRow(rows[1].id, ["Sodium", "Na", "23"], T0 + 3, [[run(0, 6, "n")], [run(0, 2, "b")], []])).toBe(false);
    expect(S.Backend.writes).toEqual([]);
  });

  it("a card table's row keeps its answer's style through the gate's spacing (testACellsStyleSurvivesTheStoresGateSpacing)", () => {
    const { S, rows } = table(true);
    S.Store.saveTableRow(rows[1].id, ["Nitrate ", " NO3-"], T0 + 2, [[], [run(1, 5, "b")]]);
    const row = S.Backend.get("note", rows[1].id);
    expect([row.front, row.back]).toEqual(["Nitrate", "NO3-"]);
    expect(row.spans).toBe('{"v":1,"n":13,"h":"6865e4539b9efdd3","r":[[9,13,"b"]]}');
    // Both sides trimmed at once still keep each side's style.
    S.Store.saveTableRow(rows[1].id, ["  Nitrate ", " NO3-  "], T0 + 3, [[run(2, 9, "i")], [run(1, 5, "b")]]);
    expect(plain(S.Store.rowRunsOf(S.Backend.get("note", rows[1].id)))).toEqual([[0, 7, "i"], [9, 13, "b"]]);
  });

  it("a column added or removed keeps every other cell's style", () => {
    const { S, id, rows } = table(false);
    S.Store.saveTableRow(rows[1].id, ["a", "bb", "ccc"], T0 + 2, [[run(0, 1, "b")], [], [run(0, 3, "n")]]);
    S.Store.addTableColumn(id, T0 + 3);
    let row = S.Backend.get("note", rows[1].id);
    expect(row.front).toBe("a\tbb\tccc\t");
    expect(plain(S.Store.rowRunsOf(row))).toEqual([[0, 1, "b"], [5, 8, "n"]]);
    S.Store.deleteTableColumn(id, 1, T0 + 4);
    row = S.Backend.get("note", rows[1].id);
    expect(row.front).toBe("a\tccc\t");
    expect(plain(S.Store.rowRunsOf(row))).toEqual([[0, 1, "b"], [2, 5, "n"]]);
  });
});

// ------------------------------------- a normal row the app gates (rowGates)

// A normal table's body row whose cell holds `::` is a card row in the app
// (`CanvasBlock.rowGates`): it stores `storedText(cardGate: true)` as a front
// and a back (`std` and `vector<TAB>contiguous array`), reads back through
// `outlineRawText` as `front::back`, and its runs are `storedRuns` against
// that text. The sidecar strings were printed by Recall's `InlineSpans`
// (`mappedThroughDiff`, then `encode`) over `storedText`'s rule.
describe("a normal table's row the app stores as a card (CanvasBlock.rowGates)", () => {
  const liveCards = (S: any, noteId: string) =>
    S.Backend.library().cards.filter((c: any) => c.note_id === noteId && c.deleted_at == null);

  it("reads the whole row, back included, cell by cell", () => {
    const { S, id, rows } = table(false);
    S.Backend.write("note", rows[1].id, { content: {
      front: "std", back: "vector\tcontiguous array",
      spans: '{"v":1,"n":28,"h":"7f002770985f6893","r":[[5,11,"b"],[23,28,"n"]]}' } });
    const row = S.Backend.get("note", rows[1].id);
    expect(S.Store.rowCells(row, false)).toEqual(["std::vector", "contiguous array"]);
    const text = "std::vector\tcontiguous array";
    expect(S.Spans.cellRuns(text, S.Store.rowRunsOf(row), false).map(plain)).toEqual([[[5, 11, "b"]], [[11, 16, "n"]]]);
    // Saving what is shown writes nothing.
    S.Backend.writes.length = 0;
    expect(S.Store.saveTableRow(rows[1].id, ["std::vector", "contiguous array"], T0 + 2,
      [[run(5, 11, "b")], [run(11, 16, "n")]])).toBe(false);
    expect(S.Backend.writes).toEqual([]);
    expect(S.Store.tableOf(id).rows.length).toBe(2);
  });

  it("writes the faces, spans and card the app writes, and an edit keeps them", () => {
    const { S, id, rows } = table(false);
    expect(S.Store.saveTableRow(rows[1].id, ["std::vector", "contiguous array"], T0 + 2,
      [[run(5, 11, "b")], [run(11, 16, "n")]])).toBe(true);
    let row = S.Backend.get("note", rows[1].id);
    expect([row.front, row.back]).toEqual(["std", "vector\tcontiguous array"]);
    expect(row.spans).toBe('{"v":1,"n":28,"h":"7f002770985f6893","r":[[5,11,"b"],[23,28,"n"]]}');
    // A row stores no trigger, so its card is the default forward one.
    const cards = liveCards(S, rows[1].id);
    expect(cards.map((c: any) => [c.cloze_ordinal ?? null, c.q_snapshot, c.a_snapshot]))
      .toEqual([[null, "std", "vector\tcontiguous array"]]);
    expect(S.Backend.get("note", id).front.split("\n")[1]).toBe("std::vector\tcontiguous array");
    // An edit to the other cell keeps the gate, the style and the same card.
    S.Store.saveTableRow(rows[1].id, ["std::vector", "contiguous array, heap"], T0 + 3,
      [[run(5, 11, "b")], [run(11, 16, "n")]]);
    row = S.Backend.get("note", rows[1].id);
    expect([row.front, row.back]).toEqual(["std", "vector\tcontiguous array, heap"]);
    expect(plain(S.Store.rowRunsOf(row))).toEqual([[5, 11, "b"], [23, 28, "n"]]);
    expect(liveCards(S, rows[1].id).map((c: any) => [c.id, c.a_snapshot]))
      .toEqual([[cards[0].id, "vector\tcontiguous array, heap"]]);
  });

  it("takes the spaces round the gate off, carrying the style (storedRuns)", () => {
    const { S, rows } = table(false);
    S.Store.saveTableRow(rows[1].id, ["std :: vector", "contiguous array"], T0 + 2,
      [[run(0, 3, "i"), run(7, 13, "b")], []]);
    const row = S.Backend.get("note", rows[1].id);
    expect([row.front, row.back]).toEqual(["std", "vector\tcontiguous array"]);
    expect(row.spans).toBe('{"v":1,"n":28,"h":"7f002770985f6893","r":[[0,3,"i"],[5,11,"b"]]}');
  });

  it("gates on a later cell's `::`, the cells before it in the front", () => {
    const { S, rows } = table(false);
    S.Store.saveTableRow(rows[1].id, ["x", "y :: z"], T0 + 2, [[run(0, 1, "b")], [run(5, 6, "n")]]);
    const row = S.Backend.get("note", rows[1].id);
    expect([row.front, row.back]).toEqual(["x\ty", "z"]);
    expect(row.spans).toBe('{"v":1,"n":6,"h":"17de22aa6a99f26f","r":[[0,1,"b"],[5,6,"n"]]}');
    expect(S.Store.rowCells(row, false)).toEqual(["x", "y::z"]);
  });

  it("never gates a header, a split that would join two cells, or an off gate", () => {
    const { S, rows } = table(false);
    for (const [index, cells, front] of [
      [0, ["Term::x", "Y"], "Term::x\tY"],
      [1, ["a::", "b"], "a::\tb"],
      [1, ["a::-b", "c"], "a::-b\tc"],
      [1, ["a >> b", "c::d"], "a >> b\tc::d"],
    ] as [number, string[], string][]) {
      S.Store.saveTableRow(rows[index].id, cells, T0 + 2, [[], []]);
      const row = S.Backend.get("note", rows[index].id);
      expect([row.front, row.back]).toEqual([front, null]);
      expect(liveCards(S, rows[index].id)).toEqual([]);
    }
  });

  it("a row that stops gating, or becomes the header, retires its card", () => {
    const { S, id, rows } = table(false);
    S.Store.saveTableRow(rows[1].id, ["std::vector", "contiguous array"], T0 + 2, [[], []]);
    S.Store.saveTableRow(rows[1].id, ["std vector", "contiguous array"], T0 + 3, [[], []]);
    expect([S.Backend.get("note", rows[1].id).front, S.Backend.get("note", rows[1].id).back])
      .toEqual(["std vector\tcontiguous array", null]);
    expect(liveCards(S, rows[1].id)).toEqual([]);
    S.Store.saveTableRow(rows[1].id, ["std::vector", "contiguous array"], T0 + 4, [[], []]);
    expect(liveCards(S, rows[1].id).length).toBe(1);
    S.Store.deleteTableRow(rows[0].id, T0 + 5);
    expect([S.Backend.get("note", rows[1].id).front, S.Backend.get("note", rows[1].id).back])
      .toEqual(["std::vector\tcontiguous array", null]);
    expect(liveCards(S, rows[1].id)).toEqual([]);
    // With the header off the first row gates; turning it on retires the card.
    S.Store.setTableHeader(id, false, T0 + 6);
    expect(S.Backend.get("note", rows[1].id).back).toBe("vector\tcontiguous array");
    expect(liveCards(S, rows[1].id).length).toBe(1);
    S.Store.setTableHeader(id, true, T0 + 7);
    expect(S.Backend.get("note", rows[1].id).back).toBe(null);
    expect(liveCards(S, rows[1].id)).toEqual([]);
  });
});

// ------------------------------------------------------------ KaTeX, D-190

// The DOM calls KaTeX's `toNode` and render.js's inline path make, kept as a
// tree, so the vendored library runs here unchanged.
class KNode {
  children: KNode[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  className = "";
  data?: string;
  constructor(public tag: string) {}
  appendChild(child: KNode) {
    if (child.tag === "#fragment") this.children.push(...child.children);
    else this.children.push(child);
    return child;
  }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  get classList() {
    return { add: (c: string) => { this.className = (this.className + " " + c).trim(); },
             contains: (c: string) => this.className.split(/\s+/).includes(c) };
  }
  set textContent(t: string) { this.children = t ? [Object.assign(new KNode("#text"), { data: t })] : []; }
  get textContent(): string { return this.data ?? this.children.map(c => c.textContent).join(""); }
}
const kdoc = {
  compatMode: "CSS1Compat",
  createElement: (tag: string) => new KNode(tag),
  createElementNS: (_ns: string, tag: string) => new KNode(tag),
  createTextNode: (data: string) => Object.assign(new KNode("#text"), { data }),
  createDocumentFragment: () => new KNode("#fragment"),
  documentElement: { dataset: {} },
};
const g = globalThis as Record<string, unknown>;
g.document = kdoc;
g.window = globalThis;
new Function(readFileSync(path.join(root, "..", "vendor", "katex", "katex.min.js"), "utf8")).call(globalThis);
const { Render } = loadAssets<{ Render: any }>(["gate.js", "spans.js", "render.js"], ["Render"]);
const find = (n: KNode, cls: string): KNode[] =>
  (n.classList.contains(cls) ? [n] : []).concat(...n.children.map(c => find(c, cls)));

describe("formulas drawn by the vendored KaTeX (D-190)", () => {
  it("is the copy Recall bundles, byte for byte", () => {
    const app = path.join(process.env.HOME || "", "Recall", "Resources", "KaTeX");
    let same = true;
    try {
      for (const f of ["katex.min.js", "katex.min.css", "fonts/KaTeX_Main-Regular.woff2"]) {
        same &&= readFileSync(path.join(app, f), "base64") === readFileSync(path.join(root, "..", "vendor", "katex", f), "base64");
      }
    } catch { return; } // not on the owner's Mac: nothing to compare
    expect(same).toBe(true);
  });

  it("renders a formula, inline and display", () => {
    expect(typeof (g as any).katex.render).toBe("function");
    const inline = Render.formulaNode("x^2 + y^2", false, "$x^2 + y^2$");
    expect(inline.className).toBe("formula");
    expect(find(inline, "katex")).toHaveLength(1);
    expect(find(inline, "katex-display")).toHaveLength(0);
    // KaTeX's MathML half carries the source for a screen reader.
    expect(inline.textContent).toContain("x^2 + y^2");
    const display = Render.formulaNode("\\frac{a}{b}", true, "$$\\frac{a}{b}$$");
    expect(display.className).toBe("formula display");
    expect(find(display, "katex-display")).toHaveLength(1);
  });

  it("a formula KaTeX refuses shows its source and never throws", () => {
    for (const bad of ["\\frac{1}{", "x^^2", "\\notacommand{y}"]) {
      const node = Render.formulaNode(bad, false, "$" + bad + "$");
      expect(node.className).toBe("formula-source");
      expect(node.textContent).toBe("$" + bad + "$");
    }
    // `trust: false`: `\href` draws no link.
    const href = Render.formulaNode("\\href{javascript:alert(1)}{x}", false, "$\\href{javascript:alert(1)}{x}$");
    expect(JSON.stringify(href)).not.toMatch(/"href":"javascript/);
  });

  it("finds what the canvas renders: never money or an empty formula (MathText.renderableSites)", () => {
    const sites = (t: string, runs: Run[] = []) => Render.formulaSites(t, runs).map((s: any) => [s.typed, s.latex, s.display]);
    expect(sites("the identity $x^2 + y^2$ holds")).toEqual([["$x^2 + y^2$", "x^2 + y^2", false]]);
    expect(sites("sum $$\\sum_i i$$ here")).toEqual([["$$\\sum_i i$$", "\\sum_i i", true]]);
    expect(sites("costs $5-$10 today")).toEqual([]);
    expect(sites("a \\$5 and $x$")).toEqual([["$x$", "x", false]]);
    // Inline code is gone (owner 2026-09-29): a stored `c` run keeps no
    // dollars, so a backtick is an ordinary character around a formula.
    expect(sites("run `$HOME/$USER` now", [run(4, 17, "c")])).toEqual([["$HOME/$", "HOME/", false]]);
    expect(Render.delimited("$$ $$")).toEqual({ latex: " ", display: true });
    expect(sites("$$ $$")).toEqual([]);
    expect(Render.delimited("$a$b$")).toBeNull();
  });

  it("a line draws its formula; a cloze line and a cell keep the dollars", () => {
    const ctx = { picture: () => new KNode("img") };
    const drawn = Render.inlineDOM("area $\\pi r^2$ exactly", [], ctx, true, true);
    expect(find(drawn, "formula")).toHaveLength(1);
    const kept = Render.inlineDOM("area $\\pi r^2$ exactly", [], ctx, false, false);
    expect(find(kept, "formula")).toHaveLength(0);
    expect(kept.textContent).toBe("area $\\pi r^2$ exactly");
    // Code lines are gone (owner 2026-09-29): a legacy one is a paragraph
    // (`Model.kindOf`), so its formula renders like any line's.
    const legacy = Render.block({ id: "a", kind: "paragraph", text: "echo $x$", runs: [], attrs: {} }, ctx);
    expect(find(legacy, "formula")).toHaveLength(1);
    const cloze = Render.block({ id: "b", kind: "paragraph", text: "{{c1::$x$}} and $y$", runs: [], attrs: {}, isCloze: true }, ctx);
    expect(find(cloze, "formula")).toHaveLength(0);
    const line = Render.block({ id: "c", kind: "paragraph", text: "say $y$", runs: [], attrs: {} }, ctx);
    expect(find(line, "formula")).toHaveLength(1);
  });
});
