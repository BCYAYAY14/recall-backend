// A paired browser is a DEVICE (PLAN-BETA-0.12 section 26, ruling W-0): the
// device list names it a browser, it connects the way a browser must (the
// token offered as a WebSocket subprotocol, never in a URL), and Remove on
// the Mac or the phone cuts it off at once, on every door.

import { describe, expect, it } from "vitest";
import { BASE, call, ownerDevice, pairedDevice, workerFetch } from "./helpers.ts";

async function browserSocket(token: string) {
  const res = await workerFetch(`${BASE}/v1/sync`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `recall.v1, recall.bearer.${token}` } });
  expect(res.status).toBe(101);
  expect(res.headers.get("sec-websocket-protocol")).toBe("recall.v1");
  const ws = res.webSocket!;
  ws.accept();
  const inbox: Record<string, unknown>[] = [];
  ws.addEventListener("message", (e) => { inbox.push(JSON.parse(String(e.data))); });
  const next = async (t: string) => {
    for (let i = 0; i < 60; i++) {
      const at = inbox.findIndex((m) => m.t === t);
      if (at >= 0) return inbox.splice(at, 1)[0]!;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no ${t} frame`);
  };
  return { ws, next };
}

describe("a paired browser in the device list", () => {
  it("is listed as a browser with full scope", async () => {
    const o = await ownerDevice();
    const web = await pairedDevice("web", "Chrome on the Mac");
    expect(web.scope).toBe("full");
    const list = await call("GET", "/v1/devices", undefined, o.token);
    const row = (list.json.devices as { id: string; platform: string; scope: string; label: string }[]).find((d) => d.id === web.deviceId);
    expect(row).toMatchObject({ platform: "web", scope: "full", label: "Chrome on the Mac" });
  });

  it("Remove on another device revokes it: socket, pull, push, hello and pairing all refuse", async () => {
    const o = await ownerDevice();
    const web = await pairedDevice("web", "Browser to remove");
    const s = await browserSocket(web.token);
    s.ws.send(JSON.stringify({ t: "hello", pv: 1, device: web.deviceId, since: 0 }));
    expect((await s.next("hello_ok")).t).toBe("hello_ok");

    const removed = await call("DELETE", `/v1/devices/${web.deviceId}`, undefined, o.token);
    expect(removed.status).toBe(200);
    expect((await s.next("bye")).reason).toBe("revoked");

    for (const [method, path, body] of [
      ["GET", "/v1/pull?since=0", undefined],
      ["POST", "/v1/push", { t: "push", batch: crypto.randomUUID(), ops: [] }],
      ["POST", "/v1/hello", { t: "hello", pv: 1, device: web.deviceId, since: 0 }],
      ["POST", "/v1/pair/begin", undefined],
    ] as const) {
      const r = await call(method, path, body, web.token);
      expect(r.status, path).toBe(401);
      expect(r.json.error, path).toBe("revoked");
    }
    const again = await workerFetch(`${BASE}/v1/sync`, { headers: { upgrade: "websocket", "sec-websocket-protocol": `recall.v1, recall.bearer.${web.token}` } });
    expect(again.status).toBe(401);

    const list = await call("GET", "/v1/devices", undefined, o.token);
    const row = (list.json.devices as { id: string; revoked_at: string | null }[]).find((d) => d.id === web.deviceId);
    expect(row?.revoked_at).toBeTruthy();
    expect((await call("GET", "/v1/pull?since=0", undefined, o.token)).status).toBe(200);
  });
});
