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
        sql.exec("INSERT INTO w (key, start, n) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET start = excluded.start, n = excluded.n",
          s.h.key, s.start, s.n + 1);
      }
      if (Math.random() < 0.01) sql.exec("DELETE FROM w WHERE start < ?", now - 86_400_000);
      return { ok: true, retryAfterMs: 0 };
    });
  }
}
