import type { BudgetDO } from "./budget-do.ts";
import type { LibraryDO } from "./library-do.ts";
import type { LimiterDO } from "./limiter-do.ts";

export interface Env {
  LIBRARY: DurableObjectNamespace<LibraryDO>;
  BUDGET: DurableObjectNamespace<BudgetDO>;
  LIMITER: DurableObjectNamespace<LimiterDO>;
  META: D1Database;
  /** Absent on a notes-only deployment (no R2 subscription). */
  MEDIA?: R2Bucket;
  ASSETS?: Fetcher;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** The one-use setup code the deploy prompt set. A secret. */
  OWNER_SETUP_CODE?: string;
  /** "false" is the dashboard emergency switch for every R2 operation (plan 36.5e). */
  R2_ENABLED?: string;
  /** An explicit deploy time for the claim window; else the version's upload time. */
  DEPLOYED_AT?: string;
  /** The estimated daily DO row-write allowance the push refuses beyond. "0" disables. */
  DO_ROWS_DAILY_LIMIT?: string;
  /** The owner's OpenRouter key for Make Cards and the quiz on the web. A secret; absent means off. */
  OPENROUTER_KEY?: string;
  /** Where the completion goes; OpenRouter's own endpoint unless a local test points elsewhere. */
  OPENROUTER_ENDPOINT?: string;
}
