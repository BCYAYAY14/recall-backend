import { describe, expect, it } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import { BASE, call, pairedDevice, workerFetch } from "./helpers.ts";

const T = "2026-09-16T10:00:00.000Z";

async function seededDoc() {
  const mac = await pairedDevice("mac", "Mac");
  const c = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
  const nb = crypto.randomUUID();
  const note = crypto.randomUUID();
  const card = crypto.randomUUID();
  c.upsert("notebook", nb, { folder_id: null, position: 0, created_at: T, exam_at: null, retention_pct: null, new_per_day: null }, { name: "Shared doc", emoji: "x", style: null });
  c.upsert("note", note, { notebook_id: nb, parent_id: null, position: 0, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: T },
    { front: "<img src=x onerror=alert(1)> :: answer", back: "answer", cloze_text: null, tags: "", spans: null, attrs: null });
  c.upsert("card", card, { note_id: note, cloze_ordinal: null, flag: 0, suspended: false, stability: 3.2, difficulty: 5.1, due: T, state: "review", last_review_at: T, introduced_on: T, reps: 4, lapses: 1, detached: false },
    { q_snapshot: "secret question snapshot", a_snapshot: "secret answer snapshot" });
  await c.push();
  return { mac, nb, note, card };
}

describe("shares (plan 10.2, W3, W5, W6, F-14)", () => {
  it("a link carries the token in the fragment only, resolves by POST, and never shows a schedule", async () => {
    const { mac, nb } = await seededDoc();
    const made = await call("POST", "/v1/shares", { notebook_id: nb }, mac.token);
    expect(made.status).toBe(200);
    const url = String(made.json.url);
    expect(url).toMatch(/^https:\/\/recall\.test\/#share=[A-Za-z0-9_-]{43}$/);
    const token = url.split("#share=")[1]!;
    const doc = await call("POST", "/v1/share/resolve", { token });
    expect(doc.status).toBe(200);
    const text = JSON.stringify(doc.json);
    expect(text).toContain("Shared doc");
    for (const forbidden of ["stability", "difficulty", "due", "reps", "lapses", "q_snapshot", "secret answer snapshot", mac.library, mac.deviceId, "rel_path"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("the share list never carries a token", async () => {
    const { mac, nb } = await seededDoc();
    const made = await call("POST", "/v1/shares", { notebook_id: nb }, mac.token);
    const list = await call("GET", "/v1/shares", undefined, mac.token);
    const token = String(made.json.token);
    expect(JSON.stringify(list.json)).not.toContain(token);
    const stored = await (await import("./helpers.ts")).E.META.prepare("SELECT token_sha FROM share WHERE id = ?").bind(made.json.id).first<{ token_sha: string }>();
    expect(stored?.token_sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("W6: a revoked link says it was stopped and returns no content", async () => {
    const { mac, nb } = await seededDoc();
    const made = await call("POST", "/v1/shares", { notebook_id: nb }, mac.token);
    await call("DELETE", `/v1/shares/${made.json.id}`, undefined, mac.token);
    const r = await call("POST", "/v1/share/resolve", { token: made.json.token });
    expect(r.status).toBe(410);
    expect(r.json.message).toBe("This link has been stopped.");
    expect(JSON.stringify(r.json)).not.toContain("Shared doc");
  });

  it("W5: an expired link says so and returns no content", async () => {
    const { mac, nb } = await seededDoc();
    const expires = new Date(Date.now() + 1500).toISOString();
    const made = await call("POST", "/v1/shares", { notebook_id: nb, expires_at: expires }, mac.token);
    expect(made.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1600));
    const r = await call("POST", "/v1/share/resolve", { token: made.json.token });
    expect(r.status).toBe(410);
    expect(r.json.message).toBe("This link has expired.");
  });

  it("a wrong token is not found, and the path never carries one", async () => {
    const r = await call("POST", "/v1/share/resolve", { token: "A".repeat(43) });
    expect(r.status).toBe(404);
    expect((await call("GET", `/v1/share/${"A".repeat(43)}`)).status).toBe(401);
  });

  it("a share of a document not in the library is refused", async () => {
    const mac = await pairedDevice("mac", "Mac");
    expect((await call("POST", "/v1/shares", { notebook_id: crypto.randomUUID() }, mac.token)).status).toBe(404);
  });
});
