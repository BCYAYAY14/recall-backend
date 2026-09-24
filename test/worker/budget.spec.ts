// The daily row-write count is Cloudflare's own meter (plan 15.5): every
// statement's rowsWritten, index entries included, not an estimate per op.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import type { LibraryDO } from "../../src/library-do.ts";
import { BASE, E, pairedDevice, workerFetch } from "./helpers.ts";

const T = "2026-09-16T10:00:00.000Z";

async function used(library: string): Promise<number> {
  const stub = E.LIBRARY.getByName(`library:${library}`);
  return runInDurableObject(stub, (i: LibraryDO) => i.budget().do_rows_written.used);
}

describe("the daily row-write count", () => {
  it("counts three rows an op, as Cloudflare meters them, for new rows and for updates", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const c = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
    await c.hello();
    const nb = crypto.randomUUID();
    c.upsert("notebook", nb, { folder_id: null, position: 0, created_at: T, exam_at: null, retention_pct: null, new_per_day: null }, { name: "Doc", emoji: "x", style: null });
    await c.push();
    const ids = Array.from({ length: 10 }, () => crypto.randomUUID());
    const note = (id: string, n: number) => c.upsert("note", id, { notebook_id: nb, parent_id: null, position: n, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: T },
      { front: `note ${n} ${Math.random()}`, back: null, cloze_text: null, tags: "", spans: null, attrs: null });

    const u0 = await used(mac.library);
    ids.forEach((id, n) => note(id, n));
    await c.push();
    const u1 = await used(mac.library);
    expect(u1 - u0).toBe(30);

    ids.forEach((id, n) => note(id, n + 100));
    await c.push();
    expect((await used(mac.library)) - u1).toBe(30);
  });
});
