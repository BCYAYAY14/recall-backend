import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import { BASE, call, pairedDevice, workerFetch } from "./helpers.ts";

describe("diagnostics expose nothing (plan 16.1, 16.4)", () => {
  let lines: string[] = [];
  beforeEach(() => { lines = []; vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); }); vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); }); });
  afterEach(() => vi.restoreAllMocks());

  it("a seeded run's log lines carry no token, no note text, no share token and no full device id", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const c = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
    const nb = crypto.randomUUID();
    const secretText = "canary-note-body-7f3a";
    c.upsert("notebook", nb, { folder_id: null, position: 0, created_at: "2026-09-16T10:00:00.000Z", exam_at: null, retention_pct: null, new_per_day: null }, { name: "canary-doc-title", emoji: "x", style: null });
    c.upsert("note", crypto.randomUUID(), { notebook_id: nb, parent_id: null, position: 0, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: "2026-09-16T10:00:00.000Z" }, { front: secretText, back: null, cloze_text: null, tags: "", spans: null, attrs: null });
    await c.push();
    await c.pull();
    const share = await call("POST", "/v1/shares", { notebook_id: nb }, mac.token);
    await call("POST", "/v1/share/resolve", { token: share.json.token });
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [mac.token, secretText, "canary-doc-title", String(share.json.token), mac.deviceId, mac.library]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("cross-origin and headers (plan 14.2)", () => {
  it("no response carries Access-Control-Allow-Origin, and API responses are no-store and nosniff", async () => {
    const mac = await pairedDevice("mac", "Mac");
    for (const r of [await call("GET", "/v1/health"), await call("GET", "/v1/devices", undefined, mac.token), await call("GET", "/v1/nope", undefined, mac.token)]) {
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await call("GET", "/v1/devices", undefined, mac.token)).headers.get("cache-control")).toBe("no-store");
  });

  it("health carries no secret, no account and no library id", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const h = await call("GET", "/v1/health");
    const text = JSON.stringify(h.json);
    expect(text).not.toContain(mac.library);
    expect(text).not.toContain("synthetic-setup-code");
    expect(h.json.protocol).toEqual({ min: 1, max: 1 });
  });

  it("an oversized or malformed body is refused, never a crash", async () => {
    const mac = await pairedDevice("mac", "Mac");
    expect((await call("POST", "/v1/push", "{not json", mac.token)).status).toBe(400);
    const big = JSON.stringify({ t: "push", batch: crypto.randomUUID(), ops: [], pad: "x".repeat(1_100_000) });
    expect((await call("POST", "/v1/push", big, mac.token)).status).toBe(413);
  });

  it("FI-10: a corrupted op is rejected by validation and the rest of the frame lands", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const c = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
    c.upsert("dictionary", crypto.randomUUID(), { created_at: "2026-09-16T10:00:00.000Z" }, { word: "good" });
    c.upsert("dictionary", crypto.randomUUID(), { created_at: "2026-09-16T10:00:00.000Z" }, { word: "bad" });
    const b = await c.buildBatch();
    (b.ops[1]!.content as Record<string, unknown>).word = 42;
    const ack = await call("POST", "/v1/push", { t: "push", batch: b.batch, ops: b.ops }, mac.token);
    const outcomes = (ack.json.results as { outcome: string }[]).map((r) => r.outcome);
    expect(outcomes).toEqual(["applied", "rejected"]);
  });
});
