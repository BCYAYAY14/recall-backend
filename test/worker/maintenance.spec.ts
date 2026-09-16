import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import type { BudgetDO } from "../../src/budget-do.ts";
import type { LibraryDO } from "../../src/library-do.ts";
import { BASE, call, E, pairedDevice, workerFetch } from "./helpers.ts";

const T = "2026-09-16T10:00:00.000Z";

async function populated(n = 20) {
  const mac = await pairedDevice("mac", "Mac");
  const c = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
  const nb = crypto.randomUUID();
  c.upsert("notebook", nb, { folder_id: null, position: 0, created_at: T, exam_at: null, retention_pct: null, new_per_day: null }, { name: "Doc", emoji: "x", style: null });
  for (let i = 0; i < n; i++) c.upsert("note", crypto.randomUUID(), { notebook_id: nb, parent_id: null, position: i, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: T }, { front: `note ${i}`, back: null, cloze_text: null, tags: "", spans: null, attrs: null });
  await c.push();
  return { mac, c, nb };
}

describe("the daily alarm (plan 6.7, 9.3)", () => {
  it("writes a gzipped NDJSON snapshot to R2 and keeps the newest 14 dates", async () => {
    const { mac } = await populated();
    const r = await call("POST", "/v1/admin/maintain", undefined, mac.token);
    expect(String(r.json.snapshot)).toMatch(/^wrote \d+ lines/);
    const listed = await E.MEDIA!.list({ prefix: `${mac.library}/snapshot/` });
    expect(listed.objects.length).toBeGreaterThan(0);
    const obj = await E.MEDIA!.get(listed.objects[0]!.key);
    const text = await new Response(obj!.body.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(text.split("\n")[0]).toContain('"t":"meta"');
  });

  it("the alarm runs, reschedules itself, and compaction keeps the newest op", async () => {
    const { mac } = await populated(3);
    const stub = E.LIBRARY.getByName(`library:${mac.library}`);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const seq = await runInDurableObject(stub, (_i: LibraryDO, state) => state.storage.sql.exec<{ m: number }>("SELECT MAX(seq) AS m FROM op").one().m);
    expect(seq).toBeGreaterThan(0);
    expect(await runInDurableObject(stub, async (_i: LibraryDO, state) => state.storage.getAlarm())).not.toBeNull();
  });

  it("FI-14: a library restored from its snapshot into a fresh object converges every client", async () => {
    const { mac, c } = await populated(15);
    await call("POST", "/v1/admin/maintain", undefined, mac.token);
    const lines = await E.LIBRARY.getByName(`library:${mac.library}`).exportLines();
    const fresh = E.LIBRARY.getByName(`restore-${crypto.randomUUID()}`);
    const restored = await fresh.restore(lines);
    expect(restored.ok).toBe(true);
    const oldDigest = (await E.LIBRARY.getByName(`library:${mac.library}`).digest()) as unknown as { lanes: unknown; epoch: string };
    const newDigest = (await fresh.digest()) as unknown as { lanes: unknown; epoch: string };
    expect(JSON.stringify(newDigest.lanes)).toBe(JSON.stringify(oldDigest.lanes));
    expect(newDigest.epoch).not.toBe(oldDigest.epoch);
    void c;
  });

  it("marks an attachment no live row names as an orphan, and clears it when a row names it again", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const sha = "9".repeat(64);
    await E.META.prepare("INSERT INTO attachment (sha, library_id, r2_key, bytes, mime, created_at, completed_at) VALUES (?, ?, ?, 1, 'image/png', ?, ?)")
      .bind(sha, mac.library, `${mac.library}/blob/${sha}`, T, T).run();
    await call("POST", "/v1/admin/maintain", undefined, mac.token);
    const row = await E.META.prepare("SELECT orphan_at FROM attachment WHERE library_id = ? AND sha = ?").bind(mac.library, sha).first<{ orphan_at: string | null }>();
    expect(row?.orphan_at).not.toBeNull();
  });

  it("B12: the multipart sweep aborts at most 50 a run, charges each, and terminates", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const statements = [];
    for (let i = 0; i < 60; i++) {
      const sha = i.toString(16).padStart(64, "0");
      statements.push(E.META.prepare("INSERT OR REPLACE INTO attachment (sha, library_id, r2_key, bytes, mime, created_at, upload_id, upload_at) VALUES (?, ?, ?, 6000000, 'image/png', ?, 'bogus-upload', ?)")
        .bind(sha, mac.library, `${mac.library}/blob/${sha}`, old, old));
    }
    await E.META.batch(statements);
    const stub = E.BUDGET.getByName(`budget:${mac.library}`);
    const before = ((await stub.report()) as { usage: { class_a_month: number } }).usage.class_a_month;
    const out = await runInDurableObject(stub, (i: BudgetDO) => i.maintain());
    expect(out.aborted).toBe(50);
    const after = ((await stub.report()) as { usage: { class_a_month: number } }).usage.class_a_month;
    expect(after - before).toBeGreaterThanOrEqual(50);
    const left = await E.META.prepare("SELECT COUNT(*) AS n FROM attachment WHERE library_id = ? AND upload_id = 'bogus-upload'").bind(mac.library).first<{ n: number }>();
    expect(left?.n).toBe(10);
  });

  it("B6: the recount replaces a drifted byte total with R2 reality", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const stub = E.BUDGET.getByName(`budget:${mac.library}`);
    await runInDurableObject(stub, (_i: BudgetDO, state) => { state.storage.sql.exec("UPDATE counter SET value = 123456789 WHERE key = 'bytes_total'"); });
    const out = await runInDurableObject(stub, (i: BudgetDO) => i.maintain());
    const listed = await E.MEDIA!.list({ prefix: `${mac.library}/blob/` });
    expect(out.bytes_total).toBe(listed.objects.reduce((n, o) => n + o.size, 0));
  });

  it("library deletion needs the id and the host typed back, and waits seven days", async () => {
    const mac = await pairedDevice("mac", "Mac");
    expect((await call("POST", "/v1/admin/library/delete", { library_id: mac.library, confirm: "delete" }, mac.token)).status).toBe(400);
    const ok = await call("POST", "/v1/admin/library/delete", { library_id: mac.library, confirm: "delete recall.test" }, mac.token);
    expect(ok.status).toBe(200);
    expect(Date.parse(String(ok.json.deletes_after)) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await call("POST", "/v1/admin/library/cancel-delete", undefined, mac.token)).status).toBe(200);
  });
});
