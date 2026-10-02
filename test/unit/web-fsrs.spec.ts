// The web's FSRS-6 (assets/js/fsrs.js) against the values Recall's own
// Tests/RecallTests/FSRSTests.swift pins from py-fsrs, so the browser and the
// Mac schedule a card identically (PLAN-BETA-0.12 section 26, ruling W-B).

import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

type Rating = 1 | 2 | 3 | 4;
interface Mem { stability: number; difficulty: number }
interface P { weights: number[]; requestRetention: number; decay: number; factor: number }
interface FSRSModule {
  defaultWeights: number[];
  params(r?: number): P;
  retrievability(days: number, s: number, p?: P): number;
  initialStability(g: Rating, p: P): number;
  initialDifficulty(g: Rating, p: P, clamp?: boolean): number;
  nextDifficulty(d: number, g: Rating, p: P): number;
  nextStabilitySuccess(s: number, d: number, r: number, g: Rating, p: P): number;
  nextStabilityLapse(s: number, d: number, r: number, p: P): number;
  shortTermStability(s: number, g: Rating, p: P): number;
  interval(s: number, p: P): number;
  grade(mem: Mem | null, state: string, g: Rating, elapsedDays: number, now: number, p: P): { state: Mem; due: number; newState: string };
  startOfDay(ms: number): number;
}

const { FSRS } = loadAssets<{ FSRS: FSRSModule }>(["fsrs.js"], ["FSRS"]);
const p = FSRS.params();
const DAY = 86_400_000;

describe("FSRS-6 in the browser matches FSRSTests.swift", () => {
  it("carries FSRS-6's 21 defaults, decay -w20", () => {
    expect(FSRS.defaultWeights.length).toBe(21);
    expect(FSRS.defaultWeights[0]).toBe(0.212);
    expect(FSRS.defaultWeights[20]).toBe(0.1542);
    expect(p.decay).toBe(-0.1542);
  });

  it("retrievability at one stability equals 90%", () => {
    expect(FSRS.retrievability(1, 1)).toBeCloseTo(0.9, 4);
    expect(FSRS.retrievability(5, 10)).toBeGreaterThan(FSRS.retrievability(30, 10));
  });

  it("initial stability is the weight; initial difficulty is bounded and ordered", () => {
    for (const g of [1, 2, 3, 4] as Rating[]) expect(FSRS.initialStability(g, p)).toBeCloseTo(p.weights[g - 1]!, 6);
    const again = FSRS.initialDifficulty(1, p), easy = FSRS.initialDifficulty(4, p);
    expect(again).toBeCloseTo(p.weights[4]!, 6);
    expect(easy).toBeGreaterThanOrEqual(1);
    expect(easy).toBeLessThanOrEqual(10);
    expect(again).toBeGreaterThan(easy);
  });

  it("the interval grows with stability and shrinks with retention", () => {
    expect(FSRS.interval(10, p)).toBe(10);
    expect(FSRS.interval(10, FSRS.params(0.70))).toBeGreaterThan(10);
    expect(FSRS.interval(10, FSRS.params(0.97))).toBeLessThan(10);
  });

  it("a first Again is a learning card ten minutes on", () => {
    const now = Date.now();
    const out = FSRS.grade(null, "new", 1, 0, now, p);
    expect(out.newState).toBe("learning");
    expect(out.due - now).toBe(600_000);
  });

  it("a first graduate is due at the START of its day (C-15)", () => {
    const d = new Date(); d.setHours(22, 10, 0, 0);
    const now = d.getTime();
    const out = FSRS.grade(null, "new", 3, 0, now, p);
    const days = FSRS.interval(out.state.stability, p);
    expect(out.newState).toBe("review");
    expect(out.due).toBe(FSRS.startOfDay(now + days * DAY));
    expect(new Date(out.due).getHours()).toBe(0);
  });

  it("a lapse caps stability at the prior value; success grows it; Hard trails Good", () => {
    const prior = { stability: 25, difficulty: 6 };
    const lapse = FSRS.grade(prior, "review", 1, 20, Date.now(), p);
    expect(lapse.newState).toBe("relearning");
    expect(lapse.state.stability).toBeLessThanOrEqual(25);
    const base = { stability: 10, difficulty: 5 };
    const good = FSRS.grade(base, "review", 3, 8, Date.now(), p);
    const hard = FSRS.grade(base, "review", 2, 8, Date.now(), p);
    expect(good.state.stability).toBeGreaterThan(10);
    expect(hard.state.stability).toBeLessThan(good.state.stability);
  });

  it("a same-day review takes the short-term terms", () => {
    const out = FSRS.grade({ stability: 10, difficulty: 5 }, "review", 3, 0.4, Date.now(), p);
    expect(out.state.stability).toBeCloseTo(FSRS.shortTermStability(10, 3, p), 9);
  });

  // py-fsrs tests/test_basic.py `test_memo_state`.
  it("a same-day Hard follows FSRS-6 and may lower stability; Good and Easy never do (review 2026-09-26, core-study-3)", () => {
    const p = FSRS.params(0.9);
    expect(FSRS.shortTermStability(10, 2, p)).toBeCloseTo(5.24907, 4);
    expect(FSRS.shortTermStability(10, 3, p)).toBeGreaterThanOrEqual(10);
    expect(FSRS.shortTermStability(10, 4, p)).toBeGreaterThanOrEqual(10);
  });

  it("matches py-fsrs's memory state: 53.62691 and 6.3574867", () => {
    const ratings: Rating[] = [1, 3, 3, 3, 3, 3];
    const gaps = [0, 0, 1, 3, 8, 21];
    let now = 1_669_725_000_000;
    let mem: Mem | null = null;
    let state = "new";
    let last: number | null = null;
    ratings.forEach((rating, i) => {
      now += gaps[i]! * DAY;
      const elapsed = last === null ? 0 : (now - last) / DAY;
      const out = FSRS.grade(mem, state, rating, elapsed, now, p);
      mem = out.state; state = out.newState; last = now;
    });
    expect(mem!.stability).toBeCloseTo(53.62691, 4);
    expect(mem!.difficulty).toBeCloseTo(6.3574867, 4);
  });

  // py-fsrs `test_review_card`, with py-fsrs's own learning steps restated
  // around the formulas, exactly as FSRSTests does.
  it("matches py-fsrs's interval history", () => {
    const learning = [60_000, 600_000], relearning = [600_000];
    const ratings: Rating[] = [3, 3, 3, 3, 3, 3, 1, 1, 3, 3, 3, 3, 3];
    let st: "learning" | "review" | "relearning" = "learning";
    let step: number | null = 0;
    let s: number | null = null, d: number | null = null, last: number | null = null;
    let now = 1_669_725_000_000;
    const history: number[] = [];
    for (const rating of ratings) {
      const days = last === null ? null : Math.floor((now - last) / DAY);
      if (s !== null && d !== null && days !== null) {
        if (days < 1) s = FSRS.shortTermStability(s, rating, p);
        else {
          const r = FSRS.retrievability(days, s, p);
          s = rating !== 1 ? FSRS.nextStabilitySuccess(s, d, r, rating, p) : FSRS.nextStabilityLapse(s, d, r, p);
        }
        d = FSRS.nextDifficulty(d, rating, p);
      } else {
        s = FSRS.initialStability(rating, p);
        d = FSRS.initialDifficulty(rating, p);
      }
      const graduate = () => { st = "review"; step = null; return now + FSRS.interval(s!, p) * DAY; };
      let due: number;
      if (st === "learning" || st === "relearning") {
        const steps = st === "learning" ? learning : relearning;
        const at: number = step ?? 0;
        if (rating === 1) { step = 0; due = now + steps[0]!; }
        else if ((rating === 3 && at + 1 === steps.length) || rating === 4) due = graduate();
        else if (rating === 3) { step = at + 1; due = now + steps[at + 1]!; }
        else due = now + steps[at]!;
      } else if (rating === 1) {
        st = "relearning"; step = 0; due = now + relearning[0]!;
      } else {
        due = graduate();
      }
      last = now;
      history.push(Math.floor((due - now) / DAY));
      now = due;
    }
    expect(history).toEqual([0, 2, 11, 46, 163, 498, 0, 0, 2, 4, 7, 12, 21]);
  });
});
