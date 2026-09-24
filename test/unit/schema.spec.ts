// Schema 2 (plan 15.3c, re-costed): every index entry is a row written, so the
// DO keeps no index a query does not need. These pin the shape, the one-time
// migration from schema 1, and compaction through the row's own seq.
import { describe, expect, it } from "vitest";
import { LibraryCore, SCHEMA_VERSION } from "../../src/library-core.ts";
import { nodeSql } from "../support/node-sql.ts";

const SCHEMA_1 = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE op (seq INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, lane TEXT NOT NULL, row_id TEXT NOT NULL, kind TEXT NOT NULL,
     updated_at TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, replaced_updated_at TEXT, replaced_device TEXT)`,
  `CREATE INDEX idx_op_row ON op(lane, row_id, seq)`,
  `CREATE TABLE row (lane TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT NOT NULL, updated_ms INTEGER NOT NULL,
     deleted_at TEXT, payload TEXT NOT NULL, seq INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (lane, id))`,
  `CREATE INDEX idx_row_seq ON row(seq)`,
  `CREATE TABLE conflict (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, lane TEXT NOT NULL, row_id TEXT NOT NULL,
     loser_device TEXT NOT NULL, loser_updated TEXT NOT NULL, loser_payload TEXT NOT NULL, at INTEGER NOT NULL, cleared_at INTEGER)`,
  `CREATE TABLE client (device_id TEXT PRIMARY KEY, ack_seq INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL, protocol INTEGER NOT NULL, revoked_at INTEGER)`,
];

function master(sql: ReturnType<typeof nodeSql>) {
  return sql.exec<{ type: string; name: string; sql: string | null }>("SELECT type, name, sql FROM sqlite_master ORDER BY name");
}

function dump(sql: ReturnType<typeof nodeSql>) {
  return {
    row: sql.exec("SELECT * FROM row ORDER BY lane, id"),
    op: sql.exec("SELECT * FROM op ORDER BY seq"),
    client: sql.exec("SELECT * FROM client ORDER BY device_id"),
    conflict: sql.exec("SELECT * FROM conflict ORDER BY id"),
  };
}

function put(sql: ReturnType<typeof nodeSql>, seq: number, lane: string, id: string) {
  sql.exec(`INSERT INTO op (seq, op_id, device_id, lane, row_id, kind, updated_at, payload, at) VALUES (?, ?, 'd', ?, ?, 'upsert', 't', ?, 0)`,
    seq, `op-${seq}`, lane, id, `{"n":${seq}}`);
  sql.exec(`INSERT INTO row (lane, id, updated_at, updated_ms, deleted_at, payload, seq, device_id) VALUES (?, ?, 't', ?, NULL, ?, ?, 'd')
    ON CONFLICT(lane, id) DO UPDATE SET updated_ms = excluded.updated_ms, payload = excluded.payload, seq = excluded.seq`, lane, id, seq, `{"n":${seq}}`, seq);
}

describe("schema 2", () => {
  it("a fresh library keeps no index beyond op_id's uniqueness, and its keyed tables carry no rowid", () => {
    const sql = nodeSql();
    new LibraryCore(sql).migrate();
    const m = master(sql);
    expect(m.filter((e) => e.type === "index" && e.sql !== null).map((e) => e.name)).toEqual([]);
    for (const t of ["row", "client", "meta"]) expect(m.find((e) => e.name === t)!.sql).toMatch(/WITHOUT ROWID$/);
    expect(m.find((e) => e.name === "op")!.sql).toMatch(/op_id TEXT NOT NULL UNIQUE/);
    expect(new LibraryCore(sql).meta("schema_version")).toBe(String(SCHEMA_VERSION));
  });

  it("migrates a schema 1 library once, with every row, op, cursor, conflict and meta value intact", () => {
    const sql = nodeSql();
    for (const s of SCHEMA_1) sql.exec(s);
    for (const [k, v] of [["schema_version", "1"], ["epoch", "e-1"], ["retained_from", "3"], ["seq_floor", "2"], ["rows_day", "2026-09-25"], ["rows_n", "41"]]) {
      sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", k, v);
    }
    put(sql, 3, "note", "a"); put(sql, 4, "note", "b"); put(sql, 5, "note", "a"); put(sql, 6, "card", "a");
    sql.exec("INSERT INTO client (device_id, ack_seq, last_seen_at, protocol, revoked_at) VALUES ('mac', 5, 100, 1, NULL), ('ios', 2, 90, 1, 80)");
    sql.exec("INSERT INTO conflict (id, seq, lane, row_id, loser_device, loser_updated, loser_payload, at) VALUES ('c1', 5, 'note', 'a', 'ios', 't', '{}', 7)");
    const before = dump(sql);

    const core = new LibraryCore(sql);
    core.migrate();
    expect(dump(sql)).toEqual(before);
    const m = master(sql);
    expect(m.map((e) => e.name)).not.toContain("idx_op_row");
    expect(m.map((e) => e.name)).not.toContain("idx_row_seq");
    expect(m.map((e) => e.name).filter((n) => n.endsWith("_v2"))).toEqual([]);
    for (const t of ["row", "client", "meta"]) expect(m.find((e) => e.name === t)!.sql).toMatch(/WITHOUT ROWID$/);
    expect(core.meta("schema_version")).toBe("2");
    expect(core.epoch()).toBe("e-1");
    expect(core.retainedFrom()).toBe(3);
    expect(core.maxSeq()).toBe(6);
    expect(core.meta("rows_today")).toBe("2026-09-25 41");
    expect(core.meta("rows_day")).toBeNull();

    core.migrate();
    expect(dump(sql)).toEqual(before);
  });

  it("compaction deletes exactly the ops below their row's seq, and never the newest op", () => {
    const sql = nodeSql();
    const core = new LibraryCore(sql);
    core.migrate();
    put(sql, 1, "note", "a"); put(sql, 2, "note", "b"); put(sql, 3, "note", "a"); put(sql, 4, "card", "a");
    put(sql, 5, "note", "a"); put(sql, 6, "note", "b");
    const out = core.compact(0);
    expect(out.superseded).toBe(3);
    expect(sql.exec<{ seq: number }>("SELECT seq FROM op ORDER BY seq").map((r) => r.seq)).toEqual([4, 5, 6]);
    expect(core.maxSeq()).toBe(6);
  });
});
