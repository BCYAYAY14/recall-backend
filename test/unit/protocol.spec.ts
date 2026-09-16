import { describe, expect, it } from "vitest";
import { LANES, LANE_ORDER, validateOp } from "../../src/protocol.ts";

const t = "2026-09-16T11:02:14.318Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function noteOp(over: Record<string, unknown> = {}) {
  return {
    op_id: uuid(1), lane: "note", id: uuid(2), kind: "upsert", updated_at: t, base_seq: 0,
    env: { notebook_id: uuid(3), parent_id: null, position: 0, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: t, deleted_at: null },
    content: { front: "hello", back: null, cloze_text: null, tags: "", spans: null, attrs: null },
    ...over,
  };
}

describe("lanes", () => {
  it("are exactly the eleven, in parents-first order", () => {
    expect(Object.keys(LANES).sort()).toEqual([...LANE_ORDER].sort());
    expect(LANE_ORDER.length).toBe(11);
    expect(LANES).not.toHaveProperty("note_version");
    expect(LANES).not.toHaveProperty("kv");
  });
});

describe("validateOp", () => {
  it("accepts a complete note upsert", () => {
    expect(validateOp(noteOp())).toBeNull();
  });
  it("P22: refuses an unknown column from a future client", () => {
    const op = noteOp();
    (op.content as Record<string, unknown>).colour = "red";
    expect(validateOp(op)).toBe("unknown_column:content.colour");
  });
  it("refuses a missing column: protocol 1 has no absent-means-leave-it", () => {
    const op = noteOp();
    delete (op.env as Record<string, unknown>).parent_id;
    expect(validateOp(op)).toBe("missing_column:env.parent_id");
  });
  it("refuses an uppercase uuid, a bad time and a wrong type", () => {
    expect(validateOp(noteOp({ id: "5D0C1F3E-9A8B-4C7D-8E6F-5A4B3C2D1E0F" }))).toBe("bad_id");
    expect(validateOp(noteOp({ updated_at: "2026-09-16T11:02:14Z" }))).toBe("bad_time");
    const op = noteOp();
    (op.env as Record<string, unknown>).position = 1.5;
    expect(validateOp(op)).toBe("bad_type:env.position");
  });
  it("a tombstone carries env with deleted_at and no content", () => {
    const op = noteOp({ kind: "tombstone" });
    delete (op as Record<string, unknown>).content;
    expect(validateOp(op)).toBe("tombstone_without_deleted_at");
    (op.env as Record<string, unknown>).deleted_at = t;
    expect(validateOp(op)).toBeNull();
    expect(validateOp({ ...op, content: {} })).toBe("tombstone_carries_content");
  });
  it("grade events are append-only and stamped by reviewed_at", () => {
    const op = { op_id: uuid(9), lane: "grade_event", id: uuid(8), kind: "upsert", updated_at: t, base_seq: 0,
      env: { card_id: uuid(7), rating: 3, reviewed_at: t, device_id: uuid(6) }, content: {} };
    expect(validateOp(op)).toBeNull();
    expect(validateOp({ ...op, updated_at: "2026-09-16T11:02:14.319Z" })).toBe("stamp_mismatch");
    const tomb = { ...op, kind: "tombstone" } as Record<string, unknown>;
    delete tomb.content;
    expect(validateOp(tomb)).toBe("tombstone_not_allowed");
  });
  it("refuses an unknown lane and an unknown top-level field", () => {
    expect(validateOp(noteOp({ lane: "note_version" }))).toBe("unknown_lane");
    expect(validateOp(noteOp({ user_id: uuid(5) }))).toBe("unknown_field:user_id");
  });
});
