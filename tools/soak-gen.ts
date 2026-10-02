// The soak's row generator (tools/soak.ts), apart from the soak so a unit
// test can drive it without a backend (test/unit/fuzz.spec.ts).
//
// EVERY ROW IT WRITES NAMES A PARENT IT MADE (D-144): a foreign key
// (`PARENT_COLUMNS`) names a live row of the parent lane this client holds,
// or null where the column admits it; a lane whose required parent is not
// held yet writes nothing this turn. The generator used to fill every uuid
// column with a random id, so a notebook named a folder that never existed,
// and a client that refuses orphans (Recall, the reference client since
// BACKEND-13) could never hold those rows: recall-dev kept 281 of them.
// `note.parent_id` names only a ROOT note, and only for a new note, so no
// edit can close a cycle.

import type { ReferenceClient } from "../client/reference-client.ts";
import { LANES, PARENT_COLUMNS, type ColumnType } from "../src/protocol.ts";

export interface Dice { rnd: (n: number) => number; chance: (p: number) => boolean }

export const defaultDice: Dice = {
  rnd: (n) => Math.floor(Math.random() * n),
  chance: (p) => Math.random() < p,
};

export const EDITABLE_LANES = ["folder", "notebook", "note", "card", "grade_event", "dictionary", "occlusion", "media"];

export function live(c: ReferenceClient, lane: string) {
  return [...c.rows.values()].filter((r) => r.lane === lane && r.kind === "upsert");
}

function value(t: ColumnType, now: string, dice: Dice): unknown {
  const nullable = t.endsWith("?");
  const base = (nullable ? t.slice(0, -1) : t) as string;
  if (nullable && dice.chance(0.3)) return null;
  switch (base) {
    case "uuid": return crypto.randomUUID();
    case "ts": return now;
    case "int": return dice.rnd(50);
    case "num": return Math.round(Math.random() * 1e6) / 1e3;
    case "bool": return dice.chance(0.5);
    case "sha": return Array.from({ length: 64 }, () => "0123456789abcdef"[dice.rnd(16)]).join("");
    case "strmap": return { k: String(dice.rnd(9)) };
    default: return `soak ${dice.rnd(1e6)} ${dice.chance(0.1) ? "émoji 😀 \"quote\" \\ tab\t" : ""}`;
  }
}

/**
 * A parent for `column` of a `lane` row: a live row of the parent lane this
 * client holds, null where the column admits it, or `undefined` when a
 * required parent is not held (the row is not written).
 */
function parentFor(c: ReferenceClient, lane: string, column: string, parentLane: string, nullable: boolean, isNew: boolean, id: string, dice: Dice): string | null | undefined {
  let pool = live(c, parentLane);
  if (lane === "note" && column === "parent_id") {
    if (!isNew) return null;
    pool = pool.filter((r) => r.env.parent_id === null && r.id !== id);
  }
  if (pool.length === 0 || (nullable && dice.chance(0.3))) return nullable ? null : undefined;
  return pool[dice.rnd(pool.length)]!.id;
}

/**
 * One random edit on `c`: a tombstone, an FI-12 same-millisecond mutation
 * (`onSameMillisecond` counts it), or an upsert of a new or existing row.
 * Returns false when the chosen lane had no parent to name and nothing was
 * written.
 */
export function edit(c: ReferenceClient, now: string, dice: Dice = defaultDice, onSameMillisecond: () => void = () => {}): boolean {
  const lane = EDITABLE_LANES[dice.rnd(EDITABLE_LANES.length)]!;
  const spec = LANES[lane]!;
  const existing = live(c, lane);
  if (existing.length > 0 && spec.tombstones && dice.chance(0.1)) { c.tombstone(lane, existing[dice.rnd(existing.length)]!.id); return true; }
  if (existing.length > 0 && lane === "note" && dice.chance(0.08)) {
    // FI-12: a second mutation inside the millisecond the row already carries.
    onSameMillisecond();
    c.mutateWithoutStamp(lane, existing[dice.rnd(existing.length)]!.id, (r) => { r.content = { ...r.content, tags: `same ms ${dice.rnd(1e6)}` }; });
    return true;
  }
  const isNew = !(existing.length > 0 && lane !== "grade_event" && dice.chance(0.6));
  const id = isNew ? crypto.randomUUID() : existing[dice.rnd(existing.length)]!.id;
  const parents = new Map(PARENT_COLUMNS[lane] ?? []);
  const env: Record<string, unknown> = {};
  for (const [col, t] of Object.entries(spec.env)) {
    const parentLane = parents.get(col);
    if (col === "deleted_at") env[col] = null;
    else if (parentLane) {
      const p = parentFor(c, lane, col, parentLane, t.endsWith("?"), isNew, id, dice);
      if (p === undefined) return false;
      env[col] = p;
    } else env[col] = value(t, now, dice);
  }
  const content: Record<string, unknown> = {};
  for (const [col, t] of Object.entries(spec.content)) content[col] = value(t, now, dice);
  c.upsert(lane, id, env, content);
  return true;
}
