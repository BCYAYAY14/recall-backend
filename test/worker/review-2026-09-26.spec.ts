// The 2026-09-26 review's backend findings that need the real Worker, D1,
// R2 and the library object (BACKEND-7 to -12, D-071's blob-404).
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { begin, download } from "../../src/blobs.ts";
import { sha256HexOf } from "../../src/http.ts";
import type { LimiterDO } from "../../src/limiter-do.ts";
import { BASE, call, E, ownerDevice, pairedDevice, workerFetch } from "./helpers.ts";

const T = "2026-09-16T10:00:00.000Z";

async function sha(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("review 2026-09-26, backend", () => {
  it("BACKEND-7: health's time is stamped on every answer and the answer is never cached", async () => {
    const a = await call("GET", "/v1/health");
    await new Promise((r) => setTimeout(r, 30));
    const b = await call("GET", "/v1/health");
    expect(b.headers.get("cache-control")).toBe("no-store");
    expect(Date.parse(String(b.json.time))).toBeGreaterThan(Date.parse(String(a.json.time)));
  });

  it("BACKEND-8: a range past the object is clamped, one that ends before it starts is refused", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const body = new Uint8Array(1024).map((_, i) => i & 0xff);
    const s = await sha(body);
    await call("POST", "/v1/blob/begin", { sha: s, bytes: body.byteLength, mime: "image/png" }, mac.token);
    await workerFetch(`${BASE}/v1/blob/put/${s}`, { method: "PUT", headers: { authorization: `Bearer ${mac.token}`, "content-length": "1024" }, body });
    const get = (range: string) => workerFetch(`${BASE}/v1/blob/${s}`, { headers: { authorization: `Bearer ${mac.token}`, range } });
    const over = await get("bytes=1000-99999999");
    expect(over.status).toBe(206);
    expect(over.headers.get("content-range")).toBe("bytes 1000-1023/1024");
    expect((await over.arrayBuffer()).byteLength).toBe(24);
    expect((await get("bytes=10-2")).status).toBe(416);
    expect((await get("bytes=2000-")).status).toBe(416);
  });

  it("BACKEND-9: a snapshot with a nonsense limit answers a page, not a 500", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const r = await call("GET", "/v1/snapshot?limit=abc", undefined, mac.token);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.rows)).toBe(true);
  });

  it("BACKEND-12: the daily snapshot restores into an empty object, and the door refuses a library that has rows", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const nb = crypto.randomUUID();
    const op = { op_id: crypto.randomUUID(), lane: "notebook", id: nb, kind: "upsert", updated_at: new Date().toISOString(), base_seq: 0,
      env: { folder_id: null, position: 0, created_at: T, deleted_at: null, exam_at: null, retention_pct: null, new_per_day: null },
      content: { name: "Kept in the snapshot", emoji: "x", style: null } };
    expect((await call("POST", "/v1/push", { t: "push", batch: crypto.randomUUID(), ops: [op] }, mac.token)).status).toBe(200);
    expect(String((await call("POST", "/v1/admin/maintain", undefined, mac.token)).json.snapshot)).toMatch(/^wrote/);
    const dates = (await call("GET", "/v1/admin/snapshots", undefined, mac.token)).json.dates as string[];
    expect(dates.length).toBeGreaterThan(0);
    const refused = await call("POST", "/v1/admin/restore", { confirm: "restore recall.test" }, mac.token);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("not_empty");
    expect((await call("POST", "/v1/admin/restore", { confirm: "no" }, mac.token)).status).toBe(400);
    const fresh = E.LIBRARY.getByName(`restore-${crypto.randomUUID()}`);
    const out = await fresh.restoreFromSnapshot(mac.library, dates[dates.length - 1]!);
    expect(out.ok).toBe(true);
    expect((await fresh.snapshot("", "", 1000) as unknown as { ok: true; value: { rows: { id: string }[] } }).value.rows.some((r) => r.id === nb)).toBe(true);
    expect((await fresh.restoreFromSnapshot(mac.library, "1999-01-01")).ok).toBe(false);
  });
  it("D-143: a restored library keeps its id, so its next maintenance writes a snapshot and marks orphans", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const nb = crypto.randomUUID();
    const op = { op_id: crypto.randomUUID(), lane: "notebook", id: nb, kind: "upsert", updated_at: new Date().toISOString(), base_seq: 0,
      env: { folder_id: null, position: 0, created_at: T, deleted_at: null, exam_at: null, retention_pct: null, new_per_day: null },
      content: { name: "Kept in the snapshot", emoji: "x", style: null } };
    expect((await call("POST", "/v1/push", { t: "push", batch: crypto.randomUUID(), ops: [op] }, mac.token)).status).toBe(200);
    expect(String((await call("POST", "/v1/admin/maintain", undefined, mac.token)).json.snapshot)).toMatch(/^wrote/);
    const dates = (await call("GET", "/v1/admin/snapshots", undefined, mac.token)).json.dates as string[];
    // Through the restore door: an empty object that never saw a claim.
    const fresh = E.LIBRARY.getByName(`restore-${crypto.randomUUID()}`);
    expect((await fresh.restoreFromSnapshot(mac.library, dates[dates.length - 1]!)).ok).toBe(true);
    const after = (await fresh.maintain()) as unknown as Record<string, unknown>;
    expect(String(after.snapshot)).toMatch(/^wrote/);
    expect(String(after.orphans)).not.toBe("skipped");
    // Through the snapshot's lines alone: the meta line carries the id.
    const lines = await E.LIBRARY.getByName(`library:${mac.library}`).exportLines();
    expect(JSON.parse(lines[0]!).library_id).toBe(mac.library);
    const bare = E.LIBRARY.getByName(`restore-${crypto.randomUUID()}`);
    expect((await bare.restore(lines)).ok).toBe(true);
    expect(String(((await bare.maintain()) as unknown as Record<string, unknown>).snapshot)).toMatch(/^wrote/);
  });

  it("BACKEND-10: ten parallel pairing claims count at most five against a code", async () => {
    const o = await ownerDevice();
    const begun = await call("POST", "/v1/pair/begin", undefined, o.token);
    const real = String(begun.json.code).replace(" ", "");
    const wrong = real === "00000000" ? "11111111" : "00000000";
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => call("POST", "/v1/pair/claim",
      { code: wrong, device_id: crypto.randomUUID(), label: "Guess", platform: "ios" }, undefined, { "cf-connecting-ip": `203.0.113.${100 + i}` })));
    for (const c of claims) expect(c.status).toBe(401);
    const salt = (await E.META.prepare("SELECT value FROM deploy_meta WHERE key = 'pair_salt'").first<{ value: string }>())!.value;
    const row = await E.META.prepare("SELECT attempts FROM pairing_code WHERE code_sha = ?").bind(await sha256HexOf(salt + real)).first<{ attempts: number }>();
    expect(row!.attempts).toBe(5);
    const late = await call("POST", "/v1/pair/claim", { code: real, device_id: crypto.randomUUID(), label: "Late", platform: "ios" }, undefined, { "cf-connecting-ip": "203.0.113.99" });
    expect(late.status).toBe(401);
  });

  it("BACKEND-11: a 365-day limiter window survives a purge that drops a finished minute window", async () => {
    const stub = E.LIMITER.getByName(`limiter-${crypto.randomUUID()}`);
    const year = { key: "claim:all:test", limit: 10, windowMs: 365 * 86_400_000 };
    const minute = { key: "pair:ip:test", limit: 20, windowMs: 60_000 };
    const t0 = Date.parse("2026-09-26T00:00:00.000Z");
    await runInDurableObject(stub, (i: LimiterDO, state) => {
      const random = Math.random;
      Math.random = () => 0; // every hit purges
      try {
        expect(i.hit([year, minute], t0).ok).toBe(true);
        expect(i.hit([{ key: "other", limit: 5, windowMs: 60_000 }], t0 + 2 * 86_400_000).ok).toBe(true);
        const keys = state.storage.sql.exec<{ key: string; n: number }>("SELECT key, n FROM w ORDER BY key").toArray();
        expect(keys.map((k) => k.key)).toEqual(["claim:all:test", "other"]);
        // The year window still counts from its first hit.
        expect(i.hit([year], t0 + 3 * 86_400_000).ok).toBe(true);
        expect(state.storage.sql.exec<{ n: number }>("SELECT n FROM w WHERE key = ?", year.key).one().n).toBe(2);
      } finally {
        Math.random = random;
      }
    });
  });

  it("blob-404: a notes-only backend answers a download `absent`, as begin does, never a bare 404", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const caller = { device: mac.deviceId, library: mac.library, account: "", scope: "full" as const, platform: "mac" };
    const s = "9".repeat(64);
    const notesOnly = { ...E, MEDIA: undefined };
    const begun = await begin(notesOnly, caller, new Request(`${BASE}/v1/blob/begin`, { method: "POST", body: JSON.stringify({ sha: s, bytes: 10, mime: "image/png" }) }));
    expect((await begun.json() as { status: string }).status).toBe("absent");
    await expect(download(notesOnly, caller, new Request(`${BASE}/v1/blob/${s}`), s))
      .rejects.toMatchObject({ status: 501, code: "absent", extra: { status: "absent" } });
    // Storage switched off says so too; storage present and the sha unknown is still 404.
    await expect(download({ ...E, R2_ENABLED: "false" }, caller, new Request(`${BASE}/v1/blob/${s}`), s))
      .rejects.toMatchObject({ status: 503, extra: { status: "disabled" } });
    const missing = await call("GET", `/v1/blob/${s}`, undefined, mac.token);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe("not_found");
  });
});
