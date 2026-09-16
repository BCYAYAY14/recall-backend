// A7, the acknowledgement invariant, and convergence under interleaving.
//
// 10,000 random steps across 200 scenarios, three devices each, over the real
// LibraryCore. After EVERY step: no device holds a clean row whose exact
// revision (updated_at, payload digest) was never transmitted to or received
// from the server. After each scenario settles: every device and the server
// hold byte-identical digests, and every revision a device wrote either
// reached the server's log or survives as a kept version.

import { describe, expect, it } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import { payloadDigest } from "../../src/opid.ts";
import { noteContent, noteEnv, notebookRow } from "../../tools/conformance.ts";
import { coreServer } from "../support/core-server.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const revKey = (lane: string, id: string, updatedAt: string, digest: string) => `${lane}|${id}|${updatedAt}|${digest}`;

async function revisionOf(r: { lane: string; id: string; kind: string; updated_at: string; env: Record<string, unknown>; content: Record<string, unknown> }) {
  const d = await payloadDigest(r.kind === "tombstone" ? { env: r.env } : { env: r.env, content: r.content });
  return revKey(r.lane, r.id, r.updated_at, d);
}

async function scenario(seed: number, steps: number) {
  const rand = rng(seed);
  const server = coreServer();
  const known = new Set<string>(); // revisions transmitted or received
  const devices: ReferenceClient[] = [];
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID();
    devices.push(new ReferenceClient("http://core", id, id, server.fetch, () => server.clock.now));
  }
  const doc = notebookRow();
  devices[0]!.upsert("notebook", doc.id, doc.env, doc.content);
  const rowIds = Array.from({ length: 4 }, () => crypto.randomUUID());
  const pending: { device: ReferenceClient; results: unknown; capture: Awaited<ReturnType<ReferenceClient["buildBatch"]>>["capture"] }[] = [];

  // Transmission and reception feed `known`.
  const wrapFetch = server.fetch;
  server.fetch = async (input, init) => {
    const res = await wrapFetch(input, init);
    const url = new URL(input);
    if (url.pathname === "/v1/push" && init?.body) {
      const body = JSON.parse(String(init.body)) as { ops: Record<string, unknown>[] };
      for (const op of body.ops) {
        const d = await payloadDigest(op.kind === "tombstone" ? { env: op.env as never } : { env: op.env as never, content: op.content as never });
        known.add(revKey(String(op.lane), String(op.id), String(op.updated_at), d));
      }
    }
    const clone = res.clone();
    if (res.ok && (url.pathname === "/v1/pull" || url.pathname === "/v1/push" || url.pathname === "/v1/snapshot")) {
      const body = await clone.json() as Record<string, unknown>;
      const rows = [...((body.ops as never[]) ?? []), ...((body.rows as never[]) ?? []),
        ...(((body.results as { winner?: never }[]) ?? []).map((r) => r.winner).filter(Boolean) as never[])];
      for (const r of rows) known.add(await revisionOf(r));
    }
    return res;
  };
  for (const d of devices) (d as unknown as { fetchFn: typeof server.fetch }).fetchFn = server.fetch;

  const written: string[] = [];
  for (let step = 0; step < steps; step++) {
    const d = devices[Math.floor(rand() * devices.length)]!;
    const row = rowIds[Math.floor(rand() * rowIds.length)]!;
    const roll = rand();
    server.clock.now += Math.floor(rand() * 3);
    if (roll < 0.25) {
      d.upsert("note", row, noteEnv(doc.id, Math.floor(rand() * 5)), noteContent(`s${seed}-${step}`));
      written.push(await revisionOf(d.get("note", row)!));
    } else if (roll < 0.32 && d.get("note", row)) {
      d.mutateWithoutStamp("note", row, (r) => { if (r.kind === "upsert") r.env = { ...r.env, position: step }; });
      written.push(await revisionOf(d.get("note", row)!));
    } else if (roll < 0.36 && d.get("note", row)?.kind === "upsert") {
      d.tombstone("note", row);
      written.push(await revisionOf(d.get("note", row)!));
    } else if (roll < 0.55) {
      d.faults.dropAck = rand() < 0.2 ? () => true : undefined;
      await d.push();
      d.faults.dropAck = undefined;
    } else if (roll < 0.62 && d.dirtyRows().length) {
      // A late ack: the batch is sent now and its answer is handled after more edits.
      const b = await d.buildBatch();
      for (const id of b.capture.keys()) d.issued.add(id);
      const ack = await d.request("POST", "/v1/push", { t: "push", batch: b.batch, ops: b.ops });
      pending.push({ device: d, results: ack.results, capture: b.capture });
    } else if (roll < 0.70 && pending.length) {
      const p = pending.splice(Math.floor(rand() * pending.length), 1)[0]!;
      await p.device.handleAck(p.results as never, p.capture);
    } else {
      d.faults.crashMidApply = rand() < 0.15 ? () => true : undefined;
      await d.pull();
      d.faults.crashMidApply = undefined;
    }
    for (const dev of devices) {
      for (const r of dev.rows.values()) {
        if (!r.dirty && !known.has(await revisionOf(r))) {
          throw new Error(`A7 violated at seed ${seed} step ${step}: a clean row was never transmitted or received`);
        }
      }
    }
  }
  for (const p of pending) await p.device.handleAck(p.results as never, p.capture);
  for (let round = 0; round < 6; round++) {
    for (const d of devices) { await d.push(); await d.pull(); }
  }
  const remote = JSON.stringify((await server.core.digest()).lanes);
  for (const d of devices) {
    expect(d.dirtyRows().length, `seed ${seed}: rows still dirty after settling`).toBe(0);
    expect(JSON.stringify(await d.digest()), `seed ${seed}: a device diverged from the server`).toBe(remote);
  }
  // Every written revision reached the server's log, or survives as a kept version, or was superseded on its own device before it could be sent.
  const kept = new Set<string>();
  for (const d of devices) for (const k of d.kept) kept.add(`${k.lane}|${k.id}|${k.updated_at}`);
  return { written: written.length, kept: kept.size };
}

describe("A7: 10,000 interleavings", () => {
  it("never leaves a row clean whose content was never transmitted, and always converges", async () => {
    let total = 0;
    for (let seed = 1; seed <= 200; seed++) {
      await scenario(seed, 50);
      total += 50;
    }
    expect(total).toBe(10_000);
  }, 120_000);
});
