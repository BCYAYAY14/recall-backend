// Schema 2's one-time migration runs inside Durable Object SQLite, which is
// not Node's: the rebuild (CREATE, copy, DROP, ALTER TABLE RENAME) must be
// allowed there, in one transactionSync.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { LibraryCore } from "../../src/library-core.ts";
import type { LibraryDO } from "../../src/library-do.ts";
import { E } from "./helpers.ts";

describe("schema 2 in Durable Object SQLite", () => {
  it("migrates a schema 1 object in place", async () => {
    const stub = E.LIBRARY.getByName(`schema-${crypto.randomUUID()}`);
    const out = await runInDurableObject(stub, (i: LibraryDO, state) => {
      const sql = state.storage.sql;
      for (const t of ["op", "row", "client", "meta", "conflict"]) sql.exec(`DROP TABLE IF EXISTS ${t}`);
      sql.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE op (seq INTEGER PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL, lane TEXT NOT NULL, row_id TEXT NOT NULL, kind TEXT NOT NULL,
        updated_at TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, replaced_updated_at TEXT, replaced_device TEXT)`);
      sql.exec(`CREATE INDEX idx_op_row ON op(lane, row_id, seq)`);
      sql.exec(`CREATE TABLE row (lane TEXT NOT NULL, id TEXT NOT NULL, updated_at TEXT NOT NULL, updated_ms INTEGER NOT NULL,
        deleted_at TEXT, payload TEXT NOT NULL, seq INTEGER NOT NULL, device_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (lane, id))`);
      sql.exec(`CREATE INDEX idx_row_seq ON row(seq)`);
      sql.exec(`CREATE TABLE conflict (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, lane TEXT NOT NULL, row_id TEXT NOT NULL,
        loser_device TEXT NOT NULL, loser_updated TEXT NOT NULL, loser_payload TEXT NOT NULL, at INTEGER NOT NULL, cleared_at INTEGER)`);
      sql.exec(`CREATE TABLE client (device_id TEXT PRIMARY KEY, ack_seq INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL, protocol INTEGER NOT NULL, revoked_at INTEGER)`);
      sql.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('epoch', 'e-1'), ('retained_from', '1')`);
      sql.exec(`INSERT INTO op (seq, op_id, device_id, lane, row_id, kind, updated_at, payload, at) VALUES (1, 'o1', 'd', 'note', 'a', 'upsert', 't', '{}', 0)`);
      sql.exec(`INSERT INTO row (lane, id, updated_at, updated_ms, deleted_at, payload, seq, device_id) VALUES ('note', 'a', 't', 1, NULL, '{}', 1, 'd')`);
      sql.exec(`INSERT INTO client (device_id, ack_seq, last_seen_at, protocol) VALUES ('mac', 1, 5, 1)`);

      const core = (i as unknown as { core: LibraryCore }).core;
      core.migrate();
      return {
        version: core.meta("schema_version"),
        epoch: core.epoch(),
        rows: sql.exec("SELECT lane, id, seq FROM row").toArray(),
        clients: sql.exec("SELECT device_id, ack_seq FROM client").toArray(),
        ops: sql.exec("SELECT seq FROM op").toArray().length,
        withoutRowid: sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID'").toArray().map((r) => r.name).sort(),
        indexes: sql.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").toArray().length,
      };
    });
    expect(out).toEqual({
      version: "2", epoch: "e-1", rows: [{ lane: "note", id: "a", seq: 1 }], clients: [{ device_id: "mac", ack_seq: 1 }], ops: 1,
      withoutRowid: ["client", "meta", "row"], indexes: 0,
    });
  });
});
