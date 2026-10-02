// Abuse limits for the doors a stranger can knock on (plan 14.3): claim, pair,
// recover, share resolution. Fixed windows in SQLite, so a redeploy or an
// eviction does not reset an attacker's count. One object per deployment.
//
// This is NOT the R2 budget breaker (that is BudgetDO, plan 36.5c).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

export interface Hit { key: string; limit: number; windowMs: number }

export class LimiterDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS w (key TEXT PRIMARY KEY, start INTEGER NOT NULL, n INTEGER NOT NULL)`);
      // `until` is when the window ends, so the purge never drops a window
      // that is still counting (review 2026-09-26, BACKEND-11).
      const cols = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(w)").toArray();
      if (!cols.some((c) => c.name === "until")) this.ctx.storage.sql.exec("ALTER TABLE w ADD COLUMN until INTEGER");
    });
  }

  /** Counts one attempt against EVERY window; refuses if any is already full. */
  hit(hits: Hit[], now = Date.now()): { ok: boolean; retryAfterMs: number } {
    const sql = this.ctx.storage.sql;
    let retry = 0;
    return this.ctx.storage.transactionSync(() => {
      const states = hits.map((h) => {
        const row = sql.exec<{ start: number; n: number }>("SELECT start, n FROM w WHERE key = ?", h.key).toArray()[0];
        const fresh = !row || now - row.start >= h.windowMs;
        return { h, start: fresh ? now : row!.start, n: fresh ? 0 : row!.n };
      });
      for (const s of states) {
        if (s.n >= s.h.limit) retry = Math.max(retry, s.start + s.h.windowMs - now);
      }
      if (retry > 0) return { ok: false, retryAfterMs: retry };
      for (const s of states) {
        sql.exec("INSERT INTO w (key, start, n, until) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET start = excluded.start, n = excluded.n, until = excluded.until",
          s.h.key, s.start, s.n + 1, s.start + s.h.windowMs);
      }
      // A row from before `until` was kept is purged only past the longest window any door uses (a year).
      if (Math.random() < 0.01) sql.exec("DELETE FROM w WHERE COALESCE(until, start + 31536000000) < ?", now);
      return { ok: true, retryAfterMs: 0 };
    });
  }
}
