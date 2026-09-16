// An in-process HTTP face over LibraryCore, for Node suites that need
// thousands of interleavings per second. Auth is a token equal to the device
// id. The real Worker (src/index.ts) is exercised in the Workers runtime by
// test/worker; this harness exercises the core's semantics only.

import { LibraryCore, Refused } from "../../src/library-core.ts";
import type { FetchLike } from "../../client/reference-client.ts";
import { nodeSql } from "./node-sql.ts";

export interface CoreServer {
  core: LibraryCore;
  fetch: FetchLike;
  clock: { now: number };
  /** Every committed wire row, as a WebSocket fan-out would deliver it. */
  fanout: { seq: number }[][];
  /** Test hooks. */
  hooks: { beforePush?: (device: string) => void; failNextPush?: boolean };
}

export function coreServer(): CoreServer {
  const core = new LibraryCore(nodeSql());
  core.migrate();
  const clock = { now: Date.parse("2026-09-16T00:00:00.000Z") };
  const fanout: { seq: number }[][] = [];
  const hooks: CoreServer["hooks"] = {};

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const device = auth.replace(/^Bearer /, "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    try {
      switch (`${init?.method ?? "GET"} ${url.pathname}`) {
        case "POST /v1/hello": return json(200, core.hello(device, body, clock.now));
        case "POST /v1/push": {
          hooks.beforePush?.(device);
          if (hooks.failNextPush) { hooks.failNextPush = false; throw new TypeError("network lost"); }
          const r = core.push(device, body, clock.now);
          if (r.committed.length) fanout.push(r.committed);
          return json(200, r.ack);
        }
        case "GET /v1/pull": return json(200, core.pull(Number(url.searchParams.get("since") ?? 0), Number(url.searchParams.get("limit") ?? 500)));
        case "POST /v1/ack": core.ack(device, Number(body.seq), clock.now, true); return json(200, { ok: true });
        case "GET /v1/snapshot": return json(200, core.snapshot(url.searchParams.get("after_lane") ?? "", url.searchParams.get("after_id") ?? "", Number(url.searchParams.get("limit") ?? 500)));
        case "GET /v1/digest": return json(200, await core.digest());
        default: return json(404, { error: "not_found" });
      }
    } catch (e) {
      if (e instanceof Refused) return json(e.status, { error: e.code, message: e.message });
      throw e;
    }
  };
  return { core, fetch, clock, fanout, hooks };
}
