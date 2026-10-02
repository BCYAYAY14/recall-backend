// The web's queue (assets/js/sched.js): the rules AppDatabase states and the
// Swift suite pins (the new-card cap counts plain docs only, a deadline doc
// ramps, the young window, the queue order, clampToExam), so the hero the
// browser draws is the session it deals (landmine 6, landmine 226).

import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

interface SchedModule {
  DAY: number;
  startOfDay(ms: number): number;
  buildQueue(lib: Lib, now: number, newPerDay: number, scope?: unknown, allowance?: number): Card[];
  dueCounts(lib: Lib, now: number, newPerDay: number): { learning: number; review: number; cappedNew: number; rampNew: number; total: number };
  examQuotas(lib: Lib, now: number): Map<string, number>;
  clampToExam(due: number, exam: number | null, now: number): number;
}
interface Card { id: string; note_id: string; state: string; due: string; cloze_ordinal: number | null; introduced_on: string | null; deleted_at: null; detached: boolean; suspended: boolean }
interface Lib { folders: Map<string, unknown>; docs: Map<string, unknown>; notes: Map<string, unknown>; cards: Card[]; events: unknown[] }

const { Sched } = loadAssets<{ Sched: SchedModule }>(["fsrs.js", "sched.js"], ["Sched"]);
const iso = (ms: number) => new Date(ms).toISOString();
const noon = (() => { const d = new Date(2026, 8, 23, 12, 0, 0, 0); return d.getTime(); })();
const hour = 3_600_000;

function library(): Lib {
  const docs = new Map<string, unknown>([
    ["plain", { id: "plain", folder_id: null, exam_at: null, deleted_at: null }],
    ["exam", { id: "exam", folder_id: null, exam_at: iso(Sched.startOfDay(noon) + 10 * Sched.DAY), deleted_at: null }],
  ]);
  const notes = new Map<string, unknown>();
  const cards: Card[] = [];
  let n = 0;
  const add = (doc: string, state: string, due: number, opts: Partial<Card> & { created?: number } = {}) => {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    notes.set(id, { id, notebook_id: doc, created_at: iso(opts.created ?? noon - 2 * Sched.DAY), deleted_at: null });
    cards.push({ id, note_id: id, state, due: iso(due), cloze_ordinal: null, introduced_on: null, deleted_at: null, detached: false, suspended: false, ...opts });
  };
  for (let i = 0; i < 15; i++) add("plain", "new", noon - Sched.DAY);
  for (let i = 0; i < 3; i++) add("plain", "review", noon - 2 * Sched.DAY, { introduced_on: iso(noon - hour) });
  add("plain", "learning", noon - 5 * 60_000);
  add("plain", "review", noon - 3 * hour);
  add("plain", "review", noon + hour);
  add("plain", "new", noon - Sched.DAY, { created: noon - 10_000 });
  for (let i = 0; i < 20; i++) add("exam", "new", noon - Sched.DAY);
  return { folders: new Map(), docs, notes, cards, events: [] };
}

describe("the browser deals what the Mac deals", () => {
  it("caps plain new cards by what was introduced today; a deadline doc ramps", () => {
    const lib = library();
    expect(Sched.examQuotas(lib, noon).get("exam")).toBe(2);
    const dc = Sched.dueCounts(lib, noon, 10);
    expect(dc).toMatchObject({ learning: 1, review: 4, cappedNew: 7, rampNew: 2 });
    expect(dc.total).toBe(14);
    expect(Sched.buildQueue(lib, noon, 10).length).toBe(dc.total);
  });

  it("orders learning, review, capped new, then the ramp; a young card waits", () => {
    const lib = library();
    const q = Sched.buildQueue(lib, noon, 10);
    expect(q.map((c) => c.state).slice(0, 5)).toEqual(["learning", "review", "review", "review", "review"]);
    expect(q.slice(-2).every((c) => (lib.notes.get(c.note_id) as { notebook_id: string }).notebook_id === "exam")).toBe(true);
    const young = lib.cards.find((c) => (lib.notes.get(c.note_id) as { created_at: string }).created_at === iso(noon - 10_000));
    expect(q.includes(young!)).toBe(false);
  });

  it("a keyed allowance still takes the deadline ramp (landmine 226)", () => {
    const q = Sched.buildQueue(library(), noon, 10, null, 0);
    expect(q.filter((c) => c.state === "new").length).toBe(2);
  });

  it("nothing is scheduled past the exam day", () => {
    const exam = Sched.startOfDay(noon) + 5 * Sched.DAY;
    expect(Sched.clampToExam(noon + 30 * Sched.DAY, exam, noon)).toBe(exam);
    expect(Sched.clampToExam(noon + Sched.DAY, exam, noon)).toBe(noon + Sched.DAY);
    expect(Sched.clampToExam(noon + 30 * Sched.DAY, null, noon)).toBe(noon + 30 * Sched.DAY);
  });
});
