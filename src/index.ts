// The Worker: routing, authentication, protocol negotiation, share resolution,
// attachment streaming and health. It holds no durable state. Static assets
// are served before this code runs for every path outside /v1/* (wrangler
// run_worker_first), so the web app loads even when the API is refused.

import { authenticate, claim, listDevices, pairBegin, pairClaim, recover, requireFull, revokeDevice, rotate, touchDevice, type Caller } from "./auth.ts";
import { begin, clearTripCache, commit, download, part, put, shareBlob, writeTripCache } from "./blobs.ts";
import { BudgetDO } from "./budget-do.ts";
import type { Env } from "./env.ts";
import { HttpFailure, failure, json, logLine, readJson, readText, sha256HexOf } from "./http.ts";
import { LibraryDO, type Result } from "./library-do.ts";
import { LimiterDO, type Hit } from "./limiter-do.ts";
import { LIMITS, PROTOCOL_MAX, PROTOCOL_MIN } from "./protocol.ts";
import { createShare, listShares, resolveShare, revokeShare } from "./shares.ts";

export { BudgetDO, LibraryDO, LimiterDO };

export const SCHEMA = 219;

function unwrap<T>(r: Result<T>): T {
  if (r.ok) return r.value;
  throw new HttpFailure(r.status, r.code, r.message, r.extra);
}

async function limit(env: Env, hits: Hit[]): Promise<void> {
  const answer = await env.LIMITER.getByName("limiter").hit(hits);
  if (!answer.ok) throw new HttpFailure(429, "rate", "Too many attempts. Try again later.", { retry_after_ms: answer.retryAfterMs });
}

async function ipKey(request: Request): Promise<string> {
  return (await sha256HexOf("ip:" + (request.headers.get("cf-connecting-ip") ?? "unknown"))).slice(0, 32);
}

function library(env: Env, caller: Caller) {
  return env.LIBRARY.getByName(`library:${caller.library}`);
}

async function health(env: Env): Promise<Response> {
  const cacheKey = new Request("https://health.recall.invalid/v1/health");
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  let d1 = "ok", claimed = false, doState = "unclaimed";
  try {
    const row = await env.META.prepare("SELECT library.id AS id FROM library LIMIT 1").first<{ id: string }>();
    claimed = !!row;
    if (row) {
      try { doState = (await env.LIBRARY.getByName(`library:${row.id}`).ping()) === "ok" ? "ok" : "error"; } catch { doState = "error"; }
    }
  } catch { d1 = "error"; }
  const r2 = !env.MEDIA ? "absent" : env.R2_ENABLED === "false" ? "disabled" : "ok";
  const body = {
    ok: d1 === "ok" && doState !== "error",
    protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
    schema: SCHEMA,
    build: (env.CF_VERSION_METADATA?.id ?? "local").slice(0, 8),
    deployed_at: env.CF_VERSION_METADATA?.timestamp ?? env.DEPLOYED_AT ?? null,
    services: { do: doState, d1, r2 },
    claimed,
    time: new Date().toISOString(),
  };
  const response = json(body, body.ok ? 200 : 503, { "cache-control": "public, max-age=10" });
  await caches.default.put(cacheKey, response.clone());
  return response;
}

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<{ response: Response; route: string; device?: string }> {
  const method = request.method;
  const path = url.pathname;
  const seg = path.split("/").filter(Boolean); // ["v1", ...]

  // MARK: public doors
  if (method === "GET" && path === "/v1/health") return { response: await health(env), route: "health" };
  if (method === "GET" && path === "/v1/version") {
    return { response: json({ pv_min: PROTOCOL_MIN, pv_max: PROTOCOL_MAX, schema: SCHEMA, build: (env.CF_VERSION_METADATA?.id ?? "local").slice(0, 8) }), route: "version" };
  }
  if (method === "POST" && path === "/v1/claim") {
    const ip = await ipKey(request);
    await limit(env, [{ key: `claim:ip:${ip}`, limit: 5, windowMs: 3_600_000 }, { key: `claim:all:${env.CF_VERSION_METADATA?.id ?? "local"}`, limit: 10, windowMs: 365 * 86_400_000 }]);
    return { response: json(await claim(env, await readJson(request, 4096))), route: "claim" };
  }
  if (method === "POST" && path === "/v1/pair/claim") {
    const ip = await ipKey(request);
    await limit(env, [{ key: `pair:ip:${ip}`, limit: 20, windowMs: 3_600_000 }]);
    return { response: json(await pairClaim(env, await readJson(request, 4096))), route: "pair.claim" };
  }
  if (method === "POST" && path === "/v1/recover") {
    const ip = await ipKey(request);
    await limit(env, [{ key: `recover:ip:${ip}`, limit: 5, windowMs: 3_600_000 }]);
    return { response: json(await recover(env, await readJson(request, 4096))), route: "recover" };
  }
  if (method === "POST" && path === "/v1/share/resolve") {
    const body = await readJson(request, 4096);
    const ip = await ipKey(request);
    const tokenKey = typeof body.token === "string" ? (await sha256HexOf(body.token)).slice(0, 32) : "none";
    await limit(env, [{ key: `share:token:${tokenKey}`, limit: 60, windowMs: 60_000 }, { key: "share:all", limit: 600, windowMs: 60_000 }, { key: `share:ip:${ip}`, limit: 120, windowMs: 60_000 }]);
    return { response: await resolveShare(env, body, ctx), route: "share.resolve" };
  }
  if (method === "POST" && path === "/v1/share/blob") {
    const ip = await ipKey(request);
    const clone = request.clone();
    const peek = await readJson(clone, 4096);
    const tokenKey = typeof peek.token === "string" ? (await sha256HexOf(peek.token)).slice(0, 32) : "none";
    await limit(env, [{ key: `shareblob:token:${tokenKey}`, limit: 60, windowMs: 60_000 }, { key: "share:all", limit: 600, windowMs: 60_000 }, { key: `share:ip:${ip}`, limit: 120, windowMs: 60_000 }]);
    return { response: await shareBlob(env, request, ctx, ip), route: "share.blob" };
  }

  if (seg[0] !== "v1") throw new HttpFailure(404, "not_found", "No such endpoint.");

  // MARK: authenticated
  const caller = await authenticate(request, env);
  const lib = library(env, caller);
  const r = (response: Response, name: string) => ({ response, route: name, device: caller.device });

  if (method === "GET" && path === "/v1/sync") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpFailure(426, "upgrade", "This endpoint is a WebSocket.");
    const headers = new Headers({ upgrade: "websocket", "x-recall-device": caller.device, "x-recall-scope": caller.scope });
    for (const h of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    const res = await lib.fetch(new Request("https://library.internal/sync", { headers }));
    if (res.status === 101 && request.headers.get("sec-websocket-protocol")?.includes("recall.v1")) {
      return r(new Response(null, { status: 101, webSocket: res.webSocket, headers: { "sec-websocket-protocol": "recall.v1" } }), "sync");
    }
    return r(res, "sync");
  }
  if (method === "POST" && path === "/v1/hello") {
    const frame = await readJson(request, 16_384);
    const ok = unwrap((await lib.hello(caller.device, frame, caller.library)) as Result<Record<string, unknown>>);
    ctx.waitUntil(touchDevice(env, caller, typeof frame.app === "string" ? frame.app.slice(0, 32) : null, typeof frame.pv === "number" ? frame.pv : null).catch(() => undefined));
    return r(json(ok), "hello");
  }
  if (method === "POST" && path === "/v1/push") {
    requireFull(caller);
    const text = await readText(request, LIMITS.bytes_per_batch);
    const ack = (await lib.push(caller.device, caller.scope, text)) as Result<Record<string, unknown>>;
    if (!ack.ok && ack.status === 429) return r(json({ t: "limit", error: ack.code, service: ack.code === "limit" ? "do_rows_written" : "push_rate", message: ack.message }, 429), "push");
    return r(json(unwrap(ack)), "push");
  }
  if (method === "GET" && path === "/v1/pull") {
    const since = Number(url.searchParams.get("since") ?? "0");
    const n = Number(url.searchParams.get("limit") ?? "500");
    if (!Number.isSafeInteger(since) || since < 0) throw new HttpFailure(400, "bad_since", "since is a whole number.");
    return r(json(unwrap((await lib.pull(caller.device, since, Number.isFinite(n) ? n : 500)) as Result<Record<string, unknown>>)), "pull");
  }
  if (method === "POST" && path === "/v1/ack") {
    const body = await readJson(request, 1024);
    unwrap((await lib.ack(caller.device, Number(body.seq))) as Result<boolean>);
    return r(json({ ok: true }), "ack");
  }
  if (method === "GET" && path === "/v1/snapshot") {
    return r(json(unwrap((await lib.snapshot(url.searchParams.get("after_lane") ?? "", url.searchParams.get("after_id") ?? "", Number(url.searchParams.get("limit") ?? "500"))) as Result<Record<string, unknown>>)), "snapshot");
  }
  if (method === "GET" && path === "/v1/digest") return r(json(await lib.digest()), "digest");

  if (method === "POST" && path === "/v1/pair/begin") return r(json(await pairBegin(env, caller)), "pair.begin");
  if (method === "POST" && path === "/v1/device/rotate") return r(json(await rotate(env, caller)), "device.rotate");
  if (method === "GET" && path === "/v1/devices") return r(json(await listDevices(env, caller)), "devices");
  if (method === "DELETE" && seg[1] === "devices" && seg[2] && seg.length === 3) return r(json(await revokeDevice(env, caller, seg[2])), "devices.revoke");

  if (method === "POST" && path === "/v1/shares") return r(json(await createShare(env, caller, await readJson(request, 4096), url.origin)), "shares.create");
  if (method === "GET" && path === "/v1/shares") return r(json(await listShares(env, caller)), "shares");
  if (method === "DELETE" && seg[1] === "shares" && seg[2] && seg.length === 3) return r(json(await revokeShare(env, caller, seg[2])), "shares.revoke");

  if (method === "POST" && path === "/v1/blob/begin") return r(await begin(env, caller, request), "blob.begin");
  if (method === "PUT" && seg[1] === "blob" && seg[2] === "put" && seg[3] && seg.length === 4) return r(await put(env, caller, request, seg[3]), "blob.put");
  if (method === "PUT" && seg[1] === "blob" && seg[2] === "part" && seg[3] && seg[4] && seg.length === 5) return r(await part(env, caller, request, seg[3], seg[4]), "blob.part");
  if (method === "POST" && path === "/v1/blob/commit") return r(await commit(env, caller, request), "blob.commit");
  if (method === "GET" && seg[1] === "blob" && seg[2] && seg.length === 3) return r(await download(env, caller, request, seg[2]), "blob.get");

  if (method === "GET" && path === "/v1/export") {
    const lines = await lib.exportLines();
    const stream = new Blob([lines.join("\n") + "\n"]).stream().pipeThrough(new CompressionStream("gzip"));
    return r(new Response(stream, { headers: { "content-type": "application/x-ndjson", "content-encoding": "gzip", "cache-control": "no-store", "content-disposition": "attachment; filename=\"recall-export.ndjson.gz\"" } }), "export");
  }

  if (seg[1] === "admin") {
    requireFull(caller);
    const budget = env.BUDGET.getByName(`budget:${caller.library}`);
    if (method === "GET" && seg[2] === "conflicts") return r(json({ conflicts: await lib.conflicts(100) }), "admin.conflicts");
    if (method === "GET" && seg[2] === "runs") {
      const rows = await env.META.prepare(`SELECT id, substr(device_id, 1, 6) AS device, started_at, ended_at, transport, ops_in, ops_out, stale, conflicts, rejected, outcome
        FROM sync_run WHERE library_id = ? ORDER BY started_at DESC LIMIT 200`).bind(caller.library).all();
      return r(json({ runs: rows.results }), "admin.runs");
    }
    if (method === "GET" && seg[2] === "budget") {
      return r(json({ attachments: env.MEDIA ? await budget.report() : { ok: true, status: "absent" }, documents: await lib.budget(), r2_env_enabled: env.R2_ENABLED !== "false" }), "admin.budget");
    }
    if (method === "PUT" && seg[2] === "limits") {
      const answer = await budget.setLimits(await readJson(request, 4096));
      if (!answer.ok) throw new HttpFailure(400, "limit_refused", answer.refused ?? "Refused.");
      await clearTripCache(caller.library);
      return r(json({ ok: true }), "admin.limits");
    }
    if (method === "POST" && seg[2] === "r2" && (seg[3] === "disable" || seg[3] === "enable")) {
      const enable = seg[3] === "enable";
      await budget.setR2Enabled(enable);
      if (enable) await clearTripCache(caller.library);
      else await writeTripCache(caller.library, { ok: false, status: 503, reason: "disabled", message: "Attachment storage is switched off on this backend. Your files are safe on this device.", resets_at: new Date(Date.now() + 10_000).toISOString(), trip: true }, ["a", "b"]);
      return r(json({ r2_enabled: enable }), "admin.r2");
    }
    if (method === "POST" && seg[2] === "maintain") return r(json(await lib.maintain()), "admin.maintain");
    if (method === "POST" && seg[2] === "library" && seg[3] === "delete") {
      const body = await readJson(request, 4096);
      if (body.library_id !== caller.library || body.confirm !== `delete ${url.hostname}`) {
        throw new HttpFailure(400, "confirm", `Type the library id and "delete ${url.hostname}" to confirm.`);
      }
      const at = await lib.requestDelete(caller.library);
      await env.META.prepare("UPDATE library SET delete_requested_at = ? WHERE id = ?").bind(at, caller.library).run();
      return r(json({ ok: true, deletes_after: new Date(Date.parse(at) + 7 * 86_400_000).toISOString() }), "admin.delete");
    }
    if (method === "POST" && seg[2] === "library" && seg[3] === "cancel-delete") {
      await lib.cancelDelete();
      await env.META.prepare("UPDATE library SET delete_requested_at = NULL WHERE id = ?").bind(caller.library).run();
      return r(json({ ok: true }), "admin.cancel-delete");
    }
  }
  throw new HttpFailure(404, "not_found", "No such endpoint.");
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) {
      // Only reached when run_worker_first did not match (tests, local tools).
      return env.ASSETS ? env.ASSETS.fetch(request) : failure(404, "not_found", "No such path.");
    }
    let outcome: { response: Response; route: string; device?: string };
    try {
      outcome = await route(request, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpFailure) {
        outcome = { response: failure(e.status, e.code, e.message, e.extra), route: "error" };
      } else {
        console.error(JSON.stringify({ route: "error", error: (e as Error)?.name ?? "unknown" }));
        outcome = { response: failure(500, "internal", "The backend could not complete this request."), route: "error" };
      }
    }
    logLine({ route: outcome.route, status: outcome.response.status, ms: Date.now() - started, device: outcome.device });
    return outcome.response;
  },
} satisfies ExportedHandler<Env>;
