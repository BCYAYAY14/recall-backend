// The Sql interface over Node's built-in SQLite, for the fuzz and fault suites.
import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../../src/library-core.ts";

export function nodeSql(path = ":memory:"): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(path);
  let depth = 0;
  return {
    db,
    exec<T>(sql: string, ...params: unknown[]): T[] {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
}
