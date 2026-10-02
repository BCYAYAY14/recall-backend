// Protocol 1: the frozen wire format. PROTOCOL.md is the prose; this file is
// the machine-checked half. A change here is a protocol change.

import { isWireTime } from "./isnewer.ts";

export const PROTOCOL_MIN = 1;
export const PROTOCOL_MAX = 1;
/** Recall's local migration this backend was written against, as major*100+minor (v2.19). */
export const SCHEMA = 219;
export const LIMITS = { ops_per_batch: 500, bytes_per_batch: 1_048_576 } as const;

// Column types. A trailing "?" admits null, which is a deliberate CLEAR.
type Base = "uuid" | "ts" | "int" | "num" | "bool" | "str" | "sha" | "strmap";
export type ColumnType = Base | `${Base}?`;

export interface LaneSpec {
  env: Record<string, ColumnType>;
  content: Record<string, ColumnType>;
  /** False for append-only lanes: a delete is refused. */
  tombstones: boolean;
  /** Append-only lanes: the env column that must equal `updated_at`. */
  stampColumn?: string;
}

// The ELEVEN lanes. `note_version` and `kv` are never lanes (plan F-08, F-10).
// Columns mirror Recall's models (Sources/Core/Models.swift CodingKeys); local
// bookkeeping (`pushed_at`, `uploaded_at`) never travels. `env` is what the
// server routes, orders and adjudicates on; `content` it never needs to read
// (plan 14.1a), so it could become ciphertext without moving anything else.
export const LANES: Record<string, LaneSpec> = {
  folder: {
    env: { position: "int", created_at: "ts", deleted_at: "ts?", exam_at: "ts?", retention_pct: "int?", new_per_day: "int?" },
    content: { name: "str", emoji: "str" },
    tombstones: true,
  },
  notebook: {
    env: { folder_id: "uuid?", position: "int", created_at: "ts", deleted_at: "ts?", exam_at: "ts?", retention_pct: "int?", new_per_day: "int?" },
    content: { name: "str", emoji: "str", style: "str?" },
    tombstones: true,
  },
  note: {
    env: { notebook_id: "uuid", parent_id: "uuid?", position: "int", kind: "str", unreviewed: "bool", occ_mode: "str?", typed_answer: "bool", created_at: "ts", deleted_at: "ts?" },
    content: { front: "str?", back: "str?", cloze_text: "str?", tags: "str", spans: "str?", attrs: "str?" },
    tombstones: true,
  },
  card: {
    env: { note_id: "uuid", cloze_ordinal: "int?", flag: "int", suspended: "bool", stability: "num", difficulty: "num", due: "ts", state: "str", last_review_at: "ts?", introduced_on: "ts?", reps: "int", lapses: "int", detached: "bool", deleted_at: "ts?" },
    content: { q_snapshot: "str?", a_snapshot: "str?" },
    tombstones: true,
  },
  grade_event: {
    env: { card_id: "uuid", rating: "int", reviewed_at: "ts", device_id: "str" },
    content: {},
    tombstones: false,
    stampColumn: "reviewed_at",
  },
  media: {
    env: { note_id: "uuid", rel_path: "str", mime: "str", bytes_sha: "sha", display_width: "num?", created_at: "ts", deleted_at: "ts?" },
    content: { crop: "str?", latex: "str?" },
    tombstones: true,
  },
  occlusion: {
    env: { note_id: "uuid", ordinal: "int", x: "num", y: "num", w: "num", h: "num", media_id: "uuid?", rotation: "num", z: "int", created_at: "ts", deleted_at: "ts?" },
    content: { label: "str", points_json: "str?" },
    tombstones: true,
  },
  dictionary: {
    env: { created_at: "ts", deleted_at: "ts?" },
    content: { word: "str" },
    tombstones: true,
  },
  font: {
    env: { rel_path: "str", bytes_sha: "sha", created_at: "ts", deleted_at: "ts?" },
    content: { family: "str", file_name: "str" },
    tombstones: true,
  },
  settings: {
    env: {},
    content: { values: "strmap" },
    tombstones: false,
  },
  device: {
    env: { platform: "str", app_version: "str", first_seen_at: "ts", last_seen_at: "ts", deleted_at: "ts?" },
    content: { name: "str" },
    tombstones: true,
  },
};

/** Parents before children: the order ops are sequenced inside one frame, and a snapshot's lane order. */
export const LANE_ORDER = ["folder", "notebook", "note", "card", "grade_event", "media", "occlusion", "dictionary", "font", "settings", "device"];

/**
 * The foreign keys of Recall's store (Sources/Core/Database.swift), as
 * `[env column, parent lane]`: a row whose parent is not held when it arrives
 * fails its key on the device. The snapshot's order and compaction both keep
 * a parent ahead of its children (review 2026-09-26, BACKEND-1, BACKEND-2).
 */
export const PARENT_COLUMNS: Record<string, [string, string][]> = {
  notebook: [["folder_id", "folder"]],
  note: [["notebook_id", "notebook"], ["parent_id", "note"]],
  card: [["note_id", "note"]],
  grade_event: [["card_id", "card"]],
  media: [["note_id", "note"]],
  occlusion: [["note_id", "note"], ["media_id", "media"]],
};

/**
 * How far past the server's clock a pushed `updated_at` may be. A later stamp
 * would win every honest edit until that date, so it is `rejected`
 * (`future_time`); the client keeps the row dirty and sends it again once
 * its clock is right (review 2026-09-26, BACKEND-5).
 */
export const MAX_FUTURE_MS = 10 * 60_000;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;

export type OpKind = "upsert" | "tombstone";

export interface PushOp {
  op_id: string;
  lane: string;
  id: string;
  kind: OpKind;
  updated_at: string;
  base_seq: number;
  env: Record<string, unknown>;
  content?: Record<string, unknown>;
}

/** A row as the server holds it and as every frame carries it. */
export interface WireRow {
  seq: number;
  op_id?: string;
  lane: string;
  id: string;
  kind: OpKind;
  updated_at: string;
  env: Record<string, unknown>;
  content: Record<string, unknown>;
  /** Present when this op replaced a concurrent revision from another device. */
  replaced?: { updated_at: string; device: string; conflict_id?: string };
}

export type Outcome =
  | { op_id: string; outcome: "applied"; seq: number; conflict_id?: string }
  | { op_id: string; outcome: "duplicate"; seq: number }
  | { op_id: string; outcome: "stale"; winner: WireRow }
  | { op_id: string; outcome: "conflict"; winner: WireRow; conflict_id: string }
  | { op_id: string; outcome: "rejected"; reason: string };

function typeOk(t: ColumnType, v: unknown): boolean {
  const nullable = t.endsWith("?");
  if (v === null) return nullable;
  const base = (nullable ? t.slice(0, -1) : t) as Base;
  switch (base) {
    case "uuid": return typeof v === "string" && UUID_RE.test(v);
    case "ts": return isWireTime(v);
    case "int": return typeof v === "number" && Number.isSafeInteger(v);
    case "num": return typeof v === "number" && Number.isFinite(v);
    case "bool": return typeof v === "boolean";
    case "str": return typeof v === "string";
    case "sha": return typeof v === "string" && SHA_RE.test(v);
    case "strmap":
      return typeof v === "object" && v !== null && !Array.isArray(v)
        && Object.values(v as object).every((x) => typeof x === "string");
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkColumns(spec: Record<string, ColumnType>, got: Record<string, unknown>, part: string): string | null {
  // Own keys only: `k in spec` finds `constructor` and `toString` through
  // the prototype (review 2026-09-26, BACKEND-6).
  for (const k of Object.keys(got)) {
    if (!Object.hasOwn(spec, k)) return `unknown_column:${part}.${k}`;
  }
  for (const [k, t] of Object.entries(spec)) {
    if (!Object.hasOwn(got, k)) return `missing_column:${part}.${k}`;
    if (!typeOk(t, got[k])) return `bad_type:${part}.${k}`;
  }
  return null;
}

/** Validates one op. Null when valid, else the rejection reason. */
export function validateOp(raw: unknown): string | null {
  if (!isPlainObject(raw)) return "not_an_object";
  const op = raw as Record<string, unknown>;
  const allowed = new Set(["op_id", "lane", "id", "kind", "updated_at", "base_seq", "env", "content"]);
  for (const k of Object.keys(op)) if (!allowed.has(k)) return `unknown_field:${k}`;
  if (typeof op.op_id !== "string" || !UUID_RE.test(op.op_id)) return "bad_op_id";
  if (typeof op.lane !== "string" || !Object.hasOwn(LANES, op.lane)) return "unknown_lane";
  const spec = LANES[op.lane]!;
  if (typeof op.id !== "string" || !UUID_RE.test(op.id)) return "bad_id";
  if (op.kind !== "upsert" && op.kind !== "tombstone") return "bad_kind";
  if (!isWireTime(op.updated_at)) return "bad_time";
  if (typeof op.base_seq !== "number" || !Number.isSafeInteger(op.base_seq) || op.base_seq < 0) return "bad_base_seq";
  if (!isPlainObject(op.env)) return "bad_env";
  const envErr = checkColumns(spec.env, op.env, "env");
  if (envErr) return envErr;
  if (op.kind === "tombstone") {
    if (!spec.tombstones) return "tombstone_not_allowed";
    if (op.content !== undefined) return "tombstone_carries_content";
    if (op.env.deleted_at === null) return "tombstone_without_deleted_at";
  } else {
    if (!isPlainObject(op.content)) return "bad_content";
    const contentErr = checkColumns(spec.content, op.content, "content");
    if (contentErr) return contentErr;
    if (Object.hasOwn(spec.env, "deleted_at") && op.env.deleted_at !== null) return "upsert_with_deleted_at";
  }
  if (spec.stampColumn && op.env[spec.stampColumn] !== op.updated_at) return "stamp_mismatch";
  return null;
}
