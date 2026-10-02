// The web's inline style sidecar (assets/js/spans.js) against the cases
// Recall's InlineSpansTests pins: the fingerprint, the stored format, the
// edit mapping and the toggle, so a bold typed in the browser is the bold the
// Mac reads (PLAN-BETA-0.12 section 26, W-7).

import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

interface Run { start: number; end: number; kind: string; value?: string | null }
interface SpansModule {
  fingerprint(text: string): string;
  encode(runs: Run[], anchor: string): string | null;
  decode(json: string | null, anchor: string): Run[];
  normalize(runs: Run[], length?: number): Run[];
  mapped(runs: Run[], lo: number, removed: number, inserted: number): Run[];
  mappedThroughDiff(runs: Run[], from: string, to: string): Run[];
  toggle(runs: Run[], kind: string, lo: number, hi: number, value?: string | null): Run[];
  remove(runs: Run[], kinds: string[] | null, lo: number, hi: number): Run[];
  covers(runs: Run[], kind: string, lo: number, hi: number): boolean;
}

const { Spans } = loadAssets<{ Spans: SpansModule }>(["spans.js"], ["Spans"]);
const run = (start: number, end: number, kind: string): Run => ({ start, end, kind, value: null });
const plain = (runs: Run[]) => runs.map(r => [r.start, r.end, r.kind]);

describe("the spans sidecar matches InlineSpans", () => {
  it("fingerprints with FNV-1a, a constant of the algorithm", () => {
    expect(Spans.fingerprint("")).toBe("cbf29ce484222325");
    expect(Spans.fingerprint("bold text")).toBe(Spans.fingerprint("bold text"));
    expect(Spans.fingerprint("bold text")).not.toBe(Spans.fingerprint("bold texu"));
  });

  it("round trips, stores nothing for a plain note, drops style when the text moved", () => {
    const anchor = "plain bold text";
    const json = Spans.encode([run(6, 10, "b"), run(11, 15, "h")], anchor);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!)).toEqual({ v: 1, n: 15, h: Spans.fingerprint(anchor), r: [[6, 10, "b"], [11, 15, "h"]] });
    expect(plain(Spans.decode(json, anchor))).toEqual([[6, 10, "b"], [11, 15, "h"]]);
    expect(Spans.encode([], "plain")).toBeNull();
    expect(Spans.encode([run(3, 3, "b")], "plain")).toBeNull();
    expect(Spans.decode(json, "plain BOLD text")).toEqual([]);
    expect(Spans.decode(json, "plain bold")).toEqual([]);
    for (const bad of [null, "", "not json", "{\"v\":1}"]) expect(Spans.decode(bad, "x")).toEqual([]);
  });

  it("skips a run with an unknown tag and keeps the rest", () => {
    const anchor = "abcdef";
    const json = `{"v":1,"n":6,"h":"${Spans.fingerprint(anchor)}","r":[[0,2,"b"],[2,4,"zz"]]}`;
    expect(plain(Spans.decode(json, anchor))).toEqual([[0, 2, "b"]]);
  });

  it("drops a stored inline code run like any unknown kind, keeping the rest (code left Recall, owner 2026-09-29)", () => {
    const anchor = "run npm test now";
    const json = `{"v":1,"n":16,"h":"${Spans.fingerprint(anchor)}","r":[[0,3,"b"],[4,12,"c"]]}`;
    expect(plain(Spans.decode(json, anchor))).toEqual([[0, 3, "b"]]);
    expect(Spans.normalize([run(0, 3, "c")], 3)).toEqual([]);
    // A line that is written again stores no `c`.
    expect(Spans.encode(Spans.decode(json, anchor), anchor)).not.toContain('"c"');
  });

  it("normalises: merges, clamps and drops empty runs", () => {
    expect(plain(Spans.normalize([run(0, 4, "b"), run(4, 8, "b"), run(2, 3, "i"), run(9, 99, "b")], 12)))
      .toEqual([[0, 8, "b"], [2, 3, "i"], [9, 12, "b"]]);
    expect(Spans.normalize([run(3, 3, "b"), run(5, 4, "c")])).toEqual([]);
  });

  it("maps an edit as the caret carries style: sticky right, a whole deletion drops the run", () => {
    expect(plain(Spans.mapped([run(4, 8, "b")], 0, 0, 3))).toEqual([[7, 11, "b"]]);
    expect(plain(Spans.mapped([run(0, 4, "b")], 2, 0, 3))).toEqual([[0, 7, "b"]]);
    expect(plain(Spans.mapped([run(0, 4, "b")], 4, 0, 2))).toEqual([[0, 6, "b"]]);
    expect(plain(Spans.mapped([run(4, 8, "b")], 4, 0, 2))).toEqual([[6, 10, "b"]]);
    expect(Spans.mapped([run(2, 6, "b")], 2, 4, 0)).toEqual([]);
    expect(plain(Spans.mapped([run(2, 10, "b")], 6, 8, 0))).toEqual([[2, 6, "b"]]);
  });

  it("toggles: on then off, a subrange splits, a mixed range turns fully on", () => {
    const on = Spans.toggle([], "b", 2, 6);
    expect(plain(on)).toEqual([[2, 6, "b"]]);
    expect(Spans.toggle(on, "b", 2, 6)).toEqual([]);
    expect(plain(Spans.toggle([run(0, 10, "b")], "b", 4, 6))).toEqual([[0, 4, "b"], [6, 10, "b"]]);
    expect(plain(Spans.toggle([run(0, 3, "b")], "b", 0, 8))).toEqual([[0, 8, "b"]]);
    expect(Spans.covers([run(0, 8, "b")], "b", 2, 4)).toBe(true);
  });

  it("carries a style through what the store did to the text (the stored marker comes off)", () => {
    // "# Title" typed with "Title" bold: the store keeps "Title" and the
    // run moves left by the marker's two characters.
    expect(plain(Spans.mappedThroughDiff([run(2, 7, "b")], "# Title", "Title"))).toEqual([[0, 5, "b"]]);
  });

  it("keeps a highlight colour and a size as the value the app stores", () => {
    const anchor = "abc def";
    const json = Spans.encode([{ start: 0, end: 3, kind: "h", value: "#E8C34A" }, { start: 4, end: 7, kind: "z", value: "18" }], anchor);
    expect(JSON.parse(json!).r).toEqual([[0, 3, "h", "#e8c34a"], [4, 7, "z", "18"]]);
  });
});
