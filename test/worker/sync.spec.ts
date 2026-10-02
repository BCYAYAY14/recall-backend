import { describe, expect, it } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import { CASES, runCases, type ConformanceEnv } from "../../tools/conformance.ts";
import { BASE, call, E, ownerDevice, pairedDevice, workerFetch } from "./helpers.ts";

function runtimeEnv(): ConformanceEnv {
  return {
    capabilities: new Set(["revoke"]),
    async device(label) {
      const d = await pairedDevice("ios", label);
      return new ReferenceClient(BASE, d.deviceId, d.token, workerFetch);
    },
    async revoke(deviceId) {
      const o = await ownerDevice();
      const r = await call("DELETE", `/v1/devices/${deviceId}`, undefined, o.token);
      if (r.status !== 200) throw new Error("revoke failed");
    },
  };
}

describe("protocol conformance through the real Worker, D1 and LibraryDO", () => {
  for (const c of CASES) {
    const skip = c.needs?.some((n) => n !== "revoke");
    (skip ? it.skip : it)(`${c.id}: ${c.name}`, async () => {
      const [r] = await runCases(runtimeEnv(), [c.id]);
      expect(r?.detail ?? "").toBe("");
      expect(r?.result).toBe("pass");
    });
  }
});

async function socket(token: string) {
  const res = await workerFetch(`${BASE}/v1/sync`, { headers: { upgrade: "websocket", authorization: `Bearer ${token}` } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const inbox: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => { inbox.push(JSON.parse(String(e.data))); waiters.splice(0).forEach((w) => w()); });
  const next = async (t: string, timeout = 2000) => {
    const start = Date.now();
    for (;;) {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return inbox.splice(i, 1)[0]!;
      if (Date.now() - start > timeout) throw new Error(`no ${t} frame`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { ws, next, inbox };
}

describe("the WebSocket (plan 6.3, P14, X3)", () => {
  it("hello, push over the socket, fan-out to the other device, own ops to the sender", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const phone = await pairedDevice("ios", "Phone");
    const a = await socket(mac.token);
    const b = await socket(phone.token);
    a.ws.send(JSON.stringify({ t: "hello", pv: 1, device: mac.deviceId, since: 0 }));
    expect((await a.next("hello_ok")).t).toBe("hello_ok");
    const client = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
    const nb = crypto.randomUUID();
    client.upsert("notebook", nb, { folder_id: null, position: 0, created_at: "2026-09-16T10:00:00.000Z", exam_at: null, retention_pct: null, new_per_day: null }, { name: "Doc", emoji: "x", style: null });
    const batch = await client.buildBatch();
    a.ws.send(JSON.stringify({ t: "push", batch: batch.batch, ops: batch.ops }));
    const ack = await a.next("push_ack");
    expect((ack.results as { outcome: string }[])[0]!.outcome).toBe("applied");
    const fan = await b.next("ops");
    expect((fan.ops as { id: string }[])[0]!.id).toBe(nb);
    const own = await a.next("ops");
    expect((own.ops as { op_id: string }[])[0]!.op_id).toBe(batch.ops[0]!.op_id);
    a.ws.close(); b.ws.close();
  });

  it("the runtime answers ping without waking the object", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const a = await socket(mac.token);
    a.ws.send('{"t":"ping"}');
    expect((await a.next("pong")).t).toBe("pong");
    a.ws.close();
  });

  it("revoking a device closes its socket with bye revoked (X6)", async () => {
    const o = await ownerDevice();
    const phone = await pairedDevice("ios", "Phone");
    const b = await socket(phone.token);
    await call("DELETE", `/v1/devices/${phone.deviceId}`, undefined, o.token);
    expect((await b.next("bye")).reason).toBe("revoked");
  });

  it("a socket upgrade without a credential is refused", async () => {
    const res = await workerFetch(`${BASE}/v1/sync`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("a read_share socket may pull but not push", async () => {
    // A browser pairs with full scope since ruling W-0 (2026-09-23); a
    // read_share row is one issued before it, and keeps its old reach.
    const web = await pairedDevice("web", "Old browser");
    await E.META.prepare("UPDATE device SET scope = 'read_share' WHERE id = ?").bind(web.deviceId).run();
    const s = await socket(web.token);
    s.ws.send(JSON.stringify({ t: "push", batch: crypto.randomUUID(), ops: [] }));
    expect((await s.next("error")).reason).toBe("scope");
    s.ws.send(JSON.stringify({ t: "pull", since: 0 }));
    expect((await s.next("ops")).t).toBe("ops");
    s.ws.close();
  });
});

describe("digest and bootstrap (plan 6.6, 6.8)", () => {
  it("a new device bootstraps by snapshot and its digest matches the server", async () => {
    const mac = await pairedDevice("mac", "Mac");
    const c = new ReferenceClient(BASE, mac.deviceId, mac.token, workerFetch);
    const nb = crypto.randomUUID();
    c.upsert("notebook", nb, { folder_id: null, position: 0, created_at: "2026-09-16T10:00:00.000Z", exam_at: null, retention_pct: null, new_per_day: null }, { name: "Doc", emoji: "x", style: null });
    for (let i = 0; i < 30; i++) {
      c.upsert("note", crypto.randomUUID(), { notebook_id: nb, parent_id: null, position: i, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: "2026-09-16T10:00:00.000Z" }, { front: `n${i}`, back: null, cloze_text: null, tags: "", spans: null, attrs: null });
    }
    await c.push();
    const phone = await pairedDevice("ios", "Phone");
    const p = new ReferenceClient(BASE, phone.deviceId, phone.token, workerFetch);
    await p.bootstrap();
    await p.pull();
    const remote = await call("GET", "/v1/digest", undefined, phone.token);
    expect(JSON.stringify(await p.digest())).toBe(JSON.stringify(remote.json.lanes));
  });
});
