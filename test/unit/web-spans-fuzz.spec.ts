// Recall's InlineSpansEditFuzzTests corpus replayed through the web editor's
// span code (assets/js/spans.js), PLAN-BETA-0.12 section 26 W-5 and ledger row
// D-155. The generator is the Swift file's xorshift64* with the same seed, and
// the draws are made in the same order, so every iteration here is the
// iteration the Swift suite runs; the kinds are `SpanKind.allCases` in
// declaration order (`Spans.KINDS`). The five spelled-out cases come first.

import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

interface Run { start: number; end: number; kind: string; value?: string | null }
interface SpansModule {
  normalize(runs: Run[], length?: number): Run[];
  mapped(runs: Run[], lo: number, removed: number, inserted: number): Run[];
  KINDS: string[];
}

const { Spans } = loadAssets<{ Spans: SpansModule }>(["spans.js"], ["Spans"]);
const run = (start: number, end: number, kind: string): Run => ({ start, end, kind, value: null });
const plain = (runs: Run[]) => runs.map(r => [r.start, r.end, r.kind]);

// xorshift64*, as `SeededRNG` in the Swift file: UInt64 arithmetic, wrapping.
class SeededRNG {
  private state: bigint;
  private static readonly mask = (1n << 64n) - 1n;
  constructor(seed: bigint) { this.state = seed === 0n ? 0x9E3779B97F4A7C15n : seed; }
  next(): bigint {
    const m = SeededRNG.mask;
    this.state ^= this.state >> 12n;
    this.state = (this.state ^ (this.state << 25n)) & m;
    this.state ^= this.state >> 27n;
    return (this.state * 2685821657736338717n) & m;
  }
  upTo(bound: number): number { return bound === 0 ? 0 : Number(this.next() % BigInt(bound)); }
}

describe("InlineSpansEditFuzzTests through the web editor's spans", () => {
  it("select all and retype does not paint the new text", () => {
    expect(Spans.mapped([run(6, 10, "b")], 0, 16, 15)).toEqual([]);
  });
  it("an edit inside a run keeps and grows it", () => {
    expect(plain(Spans.mapped([run(6, 10, "b")], 8, 2, 4))).toEqual([[6, 12, "b"]]);
  });
  it("a run overlapping the start is clipped to what survived", () => {
    expect(plain(Spans.mapped([run(6, 10, "b")], 8, 6, 3))).toEqual([[6, 8, "b"]]);
  });
  it("a run overlapping the end is clipped and shifted", () => {
    expect(plain(Spans.mapped([run(6, 10, "b")], 4, 4, 2))).toEqual([[6, 8, "b"]]);
  });
  it("a bracketing run shrinks with a deletion", () => {
    expect(plain(Spans.mapped([run(2, 12, "b")], 4, 5, 1))).toEqual([[2, 8, "b"]]);
  });

  it("the 4000 seeded edits never paint style onto freshly typed text", () => {
    // `SpanKind.allCases`, underline (D-189) declared after the link.
    // Inline code (`c`) is gone (owner 2026-09-29).
    expect(Spans.KINDS).toEqual(["b", "i", "s", "h", "p", "u", "f", "z", "l", "n"]);
    const rng = new SeededRNG(0x5EED1CE5n);
    const kinds = Spans.KINDS;
    const failures: string[] = [];
    let checked = 0;
    for (let iteration = 0; iteration < 4000; iteration++) {
      const textLength = rng.upTo(40) + 1;
      let runs: Run[] = [];
      const count = rng.upTo(3);
      for (let k = 0; k <= count; k++) {
        const s = rng.upTo(textLength);
        const e = s + 1 + rng.upTo(Math.max(1, textLength - s));
        runs.push(run(s, Math.min(e, textLength), kinds[rng.upTo(kinds.length)]!));
      }
      runs = Spans.normalize(runs, textLength);
      if (runs.length === 0) continue;

      const lo = rng.upTo(textLength + 1);
      const removedLength = rng.upTo(textLength - lo + 1);
      const insertedLength = rng.upTo(12);
      const hi = lo + removedLength;
      const newLength = textLength - removedLength + insertedLength;
      const out = Spans.mapped(runs, lo, removedLength, insertedLength);
      checked++;
      const context = `iteration ${iteration}: runs ${JSON.stringify(plain(runs))} removed {${lo}, ${removedLength}} inserted ${insertedLength} got ${JSON.stringify(plain(out))}`;

      for (const r of out) {
        if (r.start < 0 || r.end > newLength || r.start >= r.end) failures.push(`bounds. ${context}`);
      }
      const anySourceBrackets = runs.some(r => r.start <= lo && r.end >= hi);
      if (!anySourceBrackets && insertedLength > 0) {
        for (const r of out) {
          if (r.start < lo + insertedLength && r.end > lo) failures.push(`style painted onto typed text. ${context}`);
        }
      }
      for (const r of out) {
        for (let p = r.start; p < r.end; p++) {
          if (p >= lo && p < lo + insertedLength) continue;
          const old = p < lo ? p : p - insertedLength + removedLength;
          if (!runs.some(s => s.kind === r.kind && old >= s.start && old < s.end)) {
            failures.push(`position ${p} was not styled ${r.kind} before. ${context}`);
            break;
          }
        }
      }
    }
    expect(failures.slice(0, 5)).toEqual([]);
    // The Swift corpus skips an iteration whose runs normalise to nothing
    // (a link without an address, landmine 279); the count is pinned so a
    // generator drift shows here rather than as a smaller, greener corpus.
    expect(checked).toBeGreaterThan(3000);
    console.log(`[fuzz] ${checked} of 4000 iterations checked, ${failures.length} failures`);
  });
});
