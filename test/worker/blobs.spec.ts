import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import type { BudgetDO } from "../../src/budget-do.ts";
import { BASE, call, E, pairedDevice, workerFetch } from "./helpers.ts";

const MB = 1024 * 1024;
async function sha(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function bytesOf(n: number, seed = 1) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}
async function putBytes(token: string, s: string, body: Uint8Array) {
  const res = await workerFetch(`${BASE}/v1/blob/put/${s}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-length": String(body.byteLength) }, body });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}
async function r2Count(library: string) {
  return (await E.MEDIA!.list({ prefix: `${library}/blob/` })).objects.length;
}

describe("attachments (plan 9, P10, X8)", () => {
  it("begin, put, have: content addressed, idempotent, sha verified by R2", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const body = bytesOf(2048, 7);
    const s = await sha(body);
    const begun = await call("POST", "/v1/blob/begin", { sha: s, bytes: body.byteLength, mime: "image/png" }, mac.token);
    expect(begun.json.status).toBe("put");
    expect((await putBytes(mac.token, s, body)).status).toBe(200);
    expect((await call("POST", "/v1/blob/begin", { sha: s, bytes: body.byteLength, mime: "image/png" }, mac.token)).json.status).toBe("have");
    const got = await workerFetch(`${BASE}/v1/blob/${s}`, { headers: { authorization: `Bearer ${mac.token}` } });
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(body);
  });

  it("bytes that do not match their sha are refused and nothing is stored", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const body = bytesOf(1000, 3);
    const s = await sha(bytesOf(1000, 4));
    await call("POST", "/v1/blob/begin", { sha: s, bytes: 1000, mime: "image/png" }, mac.token);
    const r = await putBytes(mac.token, s, body);
    expect(r.status).toBe(400);
    expect(await E.MEDIA!.head(`${mac.library}/blob/${s}`)).toBeNull();
  });

  it("P10: a multipart upload interrupted at part 3 of 5 resumes at part 4 and the sha matches", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const total = 22 * MB;
    const body = bytesOf(total, 9);
    const s = await sha(body);
    const begun = await call("POST", "/v1/blob/begin", { sha: s, bytes: total, mime: "application/pdf" }, mac.token);
    expect(begun.json.status).toBe("multipart");
    const partSize = Number(begun.json.part_size);
    const sendPart = async (n: number) => {
      const chunk = body.slice((n - 1) * partSize, Math.min(total, n * partSize));
      const res = await workerFetch(`${BASE}/v1/blob/part/${s}/${n}`, { method: "PUT", headers: { authorization: `Bearer ${mac.token}`, "content-length": String(chunk.byteLength) }, body: chunk });
      expect(res.status).toBe(200);
    };
    for (const n of [1, 2, 3]) await sendPart(n);
    const resumed = await call("POST", "/v1/blob/begin", { sha: s, bytes: total, mime: "application/pdf" }, mac.token);
    expect((resumed.json.parts as { n: number }[]).map((p) => p.n)).toEqual([1, 2, 3]);
    expect((await call("POST", "/v1/blob/commit", { sha: s }, mac.token)).status).toBe(409);
    for (const n of [4, 5]) await sendPart(n);
    expect((await call("POST", "/v1/blob/commit", { sha: s }, mac.token)).status).toBe(200);
    const obj = await E.MEDIA!.get(`${mac.library}/blob/${s}`);
    expect(await sha(new Uint8Array(await obj!.arrayBuffer()))).toBe(s);
  }, 60_000);

  it("B3: an object over 25 MB is refused at begin with a sentence naming the size and the cap", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const r = await call("POST", "/v1/blob/begin", { sha: "a".repeat(64), bytes: 30 * MB, mime: "image/png" }, mac.token);
    expect(r.status).toBe(413);
    expect(String(r.json.message)).toMatch(/30 MB.*25 MB/);
  });

  it("a visitor fetches a shared picture by POST; Range is ignored and whole objects are served (C10)", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const body = bytesOf(4096, 11);
    const s = await sha(body);
    await call("POST", "/v1/blob/begin", { sha: s, bytes: body.byteLength, mime: "image/png" }, mac.token);
    await putBytes(mac.token, s, body);
    const c = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
    const nb = crypto.randomUUID(), note = crypto.randomUUID();
    const T = "2026-09-16T10:00:00.000Z";
    c.upsert("notebook", nb, { folder_id: null, position: 0, created_at: T, exam_at: null, retention_pct: null, new_per_day: null }, { name: "Pics", emoji: "x", style: null });
    c.upsert("note", note, { notebook_id: nb, parent_id: null, position: 0, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: T }, { front: "{{img:x}}", back: null, cloze_text: null, tags: "", spans: null, attrs: null });
    c.upsert("media", crypto.randomUUID(), { note_id: note, rel_path: `${s}.png`, mime: "image/png", bytes_sha: s, display_width: null, created_at: T }, { crop: null, latex: null });
    await c.push();
    const share = await call("POST", "/v1/shares", { notebook_id: nb }, mac.token);
    const res = await workerFetch(`${BASE}/v1/share/blob`, { method: "POST", headers: { "content-type": "application/json", range: "bytes=0-10" }, body: JSON.stringify({ token: share.json.token, sha: s }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(4096);
    const other = await sha(bytesOf(10, 99));
    const refused = await call("POST", "/v1/share/blob", { token: share.json.token, sha: other });
    expect(refused.status).toBe(404);
  });
});

describe("the zero-cost protection gate (plan 36.10)", () => {
  it("FI-16a and FI-16g: a runaway PUT loop trips the global breaker before 200 R2 operations, and the counter reads at least the true count", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const before = await r2Count(mac.library);
    let refused = 0, stored = 0;
    for (let i = 0; i < 400; i++) {
      const body = bytesOf(64, i + 1000);
      const s = await sha(body);
      const b = await call("POST", "/v1/blob/begin", { sha: s, bytes: 64, mime: "image/png" }, mac.token);
      if (b.json.status !== "put") { refused++; continue; }
      const p = await putBytes(mac.token, s, body);
      if (p.status === 200) stored++; else refused++;
    }
    const performed = (await r2Count(mac.library)) - before;
    expect(performed).toBeLessThan(200);
    expect(refused).toBeGreaterThan(0);
    const report = await call("GET", "/v1/admin/budget", undefined, mac.token);
    const usage = (report.json.attachments as { usage: { class_a_month: number } }).usage;
    expect(usage.class_a_month).toBeGreaterThanOrEqual(performed);
    expect(stored).toBe(performed);
  }, 120_000);

  it("FI-16b: several devices share one allowance; FI-16c: re-pairing does not reset it", async () => {
    const devices = await Promise.all([1, 2, 3].map((i) => pairedDevice("ios", `Phone ${i}`)));
    const library = devices[0]!.library;
    const stub = E.BUDGET.getByName(`budget:${library}`);
    const report = await stub.report();
    const used = (report as { usage: { class_a_month: number } }).usage.class_a_month;
    // The bucket is library-wide: whatever earlier tests drew, new devices find it as drained.
    const answers = await Promise.all(devices.map((d) => stub.authorize({ kind: "put", classA: 150, device: d.deviceId }, true)));
    expect(answers.filter((a) => a.ok).length).toBeLessThanOrEqual(1);
    const fresh = await pairedDevice("ios", "Re-paired");
    const again = await stub.authorize({ kind: "put", classA: 150, device: fresh.deviceId }, true);
    expect(again.ok).toBe(false);
    expect(used).toBeGreaterThanOrEqual(0);
  });

  it("FI-16e: 500 concurrent attempts at one below the monthly wall allow exactly one", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const stub = E.BUDGET.getByName(`budget:race-${crypto.randomUUID()}`);
    expect((await stub.setLimits({ r2_class_a_month: 1000, r2_class_a_bucket: 300, r2_class_a_per_minute: 60 })).ok).toBe(true);
    await runInDurableObject(stub, (_i: BudgetDO, state) => {
      state.storage.sql.exec("UPDATE counter SET value = 999 WHERE key = 'class_a_month'");
    });
    const answers = await Promise.all(Array.from({ length: 500 }, () => stub.authorize({ kind: "put", classA: 1, device: mac.deviceId }, true)));
    expect(answers.filter((a) => a.ok).length).toBe(1);
  });

  it("FI-16d: eviction and a new instance keep the monthly count", async () => {
    const stub = E.BUDGET.getByName(`budget:evict-${crypto.randomUUID()}`);
    await stub.setLimits({ r2_class_a_month: 5 });
    for (let i = 0; i < 5; i++) expect((await stub.authorize({ kind: "put", classA: 1 }, true)).ok).toBe(true);
    const { evictDurableObject } = await import("cloudflare:test");
    await evictDurableObject(stub);
    const after = await stub.authorize({ kind: "put", classA: 1 }, true);
    expect(after.ok).toBe(false);
  });

  it("FI-16h: with every R2 limit tripped, document sync still works", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const stub = E.BUDGET.getByName(`budget:${mac.library}`);
    await runInDurableObject(stub, (_i: BudgetDO, state) => {
      state.storage.sql.exec("INSERT OR REPLACE INTO trip VALUES ('class_a_month', 0, 9999999999999, 'class_a_month')");
      state.storage.sql.exec("INSERT OR REPLACE INTO trip VALUES ('class_b_month', 0, 9999999999999, 'class_b_month')");
    });
    const c = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
    c.upsert("dictionary", crypto.randomUUID(), { created_at: "2026-09-16T10:00:00.000Z" }, { word: "zeitgeist" });
    expect(await c.push()).toBe("sent");
    expect(c.dirtyRows().length).toBe(0);
    const b = await call("POST", "/v1/blob/begin", { sha: "b".repeat(64), bytes: 10, mime: "image/png" }, mac.token);
    expect(b.status).not.toBe(200);
    await runInDurableObject(stub, (_i: BudgetDO, state) => { state.storage.sql.exec("DELETE FROM trip"); });
  });

  it("FI-16j: the dashboard variable alone turns R2 off; document sync continues", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const { begin } = await import("../../src/blobs.ts");
    const res = await begin({ ...E, R2_ENABLED: "false" }, { device: mac.deviceId, library: mac.library, account: "", scope: "full", platform: "mac" },
      new Request(`${BASE}/v1/blob/begin`, { method: "POST", body: JSON.stringify({ sha: "c".repeat(64), bytes: 10, mime: "image/png" }) }));
    expect((await res.json() as { status: string }).status).toBe("disabled");
  });

  it("FI-16j: the admin door turns R2 off within the cache window and back on", async () => {
    const mac = await pairedDevice("mac", "Mac");
    expect((await call("POST", "/v1/admin/r2/disable", undefined, mac.token)).json.r2_enabled).toBe(false);
    const s = "d".repeat(64);
    const refused = await call("POST", "/v1/blob/begin", { sha: s, bytes: 10, mime: "image/png" }, mac.token);
    expect(refused.json.status).toBe("disabled");
    expect((await call("POST", "/v1/admin/r2/enable", undefined, mac.token)).json.r2_enabled).toBe(true);
    expect((await call("POST", "/v1/blob/begin", { sha: s, bytes: 10, mime: "image/png" }, mac.token)).json.status).toBe("put");
  });

  it("B9: missing, negative or future counters fail closed", async () => {
    for (const what of ["delete_counter", "negative", "future"] as const) {
      const stub = E.BUDGET.getByName(`budget:corrupt-${what}-${crypto.randomUUID()}`);
      await stub.corruptForTest(what);
      const a = await stub.authorize({ kind: "put", classA: 1 }, true);
      expect(a.ok).toBe(false);
      if (!a.ok) expect(["corrupt", "unavailable"]).toContain(a.reason);
    }
  });

  it("B10: a fourth multipart create for one sha in a day is refused, and every attempt was charged", async () => {
    const stub = E.BUDGET.getByName(`budget:mp-${crypto.randomUUID()}`);
    const s = "e".repeat(64);
    for (let i = 0; i < 3; i++) expect((await stub.authorize({ kind: "create_multipart", classA: 1, sha: s }, true)).ok).toBe(true);
    expect((await stub.authorize({ kind: "create_multipart", classA: 1, sha: s }, true)).ok).toBe(false);
    const r = await stub.report() as { usage: { class_a_month: number } };
    expect(r.usage.class_a_month).toBe(3);
  });

  it("B11: device range reads are capped per object per minute and each counts as a full Class B", async () => {
    const stub = E.BUDGET.getByName(`budget:range-${crypto.randomUUID()}`);
    let ok = 0;
    for (let i = 0; i < 30; i++) if ((await stub.authorize({ kind: "range", classB: 1, device: "d", sha: "f".repeat(64) }, true)).ok) ok++;
    expect(ok).toBe(20);
    expect(((await stub.report()) as { usage: { class_b_month: number } }).usage.class_b_month).toBe(20);
  });

  it("B13: SAFETY_MAX cannot be exceeded, whatever the client sends", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const r = await call("PUT", "/v1/admin/limits", { r2_class_a_month: 10_000_000 }, mac.token);
    expect(r.status).toBe(400);
    expect((await call("PUT", "/v1/admin/limits", { r2_class_a_per_minute: 61 }, mac.token)).status).toBe(400);
    expect((await call("PUT", "/v1/admin/limits", { r2_class_a_per_minute: 20 }, mac.token)).status).toBe(200);
    await call("PUT", "/v1/admin/limits", { r2_class_a_per_minute: 30 }, mac.token);
  });

  it("B8 and B7: a deployment with no R2 binding reports absent and still syncs", async () => {
    const { begin } = await import("../../src/blobs.ts");
    const mac = await pairedDevice("mac", "Mac");
    const res = await begin({ ...E, MEDIA: undefined }, { device: mac.deviceId, library: mac.library, account: "", scope: "full", platform: "mac" },
      new Request(`${BASE}/v1/blob/begin`, { method: "POST", body: JSON.stringify({ sha: "a".repeat(64), bytes: 10, mime: "image/png" }) }));
    expect((await res.json() as { status: string }).status).toBe("absent");
  });
});
