// P19 through the real Worker, D1 and LibraryDO, with the clock MOVED.
//
// A deployed backend has no door that moves its clock, so P19 cannot run
// against recall-dev (tools/conformance-cli.ts skips it by name). Here the
// Worker and its Durable Objects run in the same workerd isolate as the test,
// so `vi.setSystemTime` moves `Date.now()` for the Worker, the LibraryDO's
// op stamps and compaction, and the reference clients alike. Compaction is
// the owner's own door, POST /v1/admin/maintain, the same code the daily
// alarm runs. The negative control runs the same case with the clock held
// still: it must fail, or the pass above proves nothing about the clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import { runCases, type ConformanceEnv } from "../../tools/conformance.ts";
import { BASE, call, ownerDevice, pairedDevice, workerFetch } from "./helpers.ts";

function clockEnv(moveClock: boolean): ConformanceEnv {
  return {
    capabilities: new Set(["clock", "compact", "revoke"]),
    async device(label) {
      const d = await pairedDevice("ios", label);
      return new ReferenceClient(BASE, d.deviceId, d.token, workerFetch);
    },
    advance(ms) {
      if (moveClock) vi.setSystemTime(Date.now() + ms);
    },
    async compact() {
      const o = await ownerDevice();
      const r = await call("POST", "/v1/admin/maintain", undefined, o.token);
      if (r.status !== 200) throw new Error(`maintain answered ${r.status}`);
    },
    async revoke(deviceId) {
      const o = await ownerDevice();
      const r = await call("DELETE", `/v1/devices/${deviceId}`, undefined, o.token);
      if (r.status !== 200) throw new Error("revoke failed");
    },
  };
}

describe("P19 with a moved clock (plan 17.1, F-17)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-27T00:00:00.000Z") }); });
  afterEach(() => { vi.useRealTimers(); });

  it("P19: a device offline past retention bootstraps and converges", async () => {
    const [r] = await runCases(clockEnv(true), ["P19"]);
    expect(r?.detail ?? "").toBe("");
    expect(r?.result).toBe("pass");
  });

  it("negative control: with the clock held still, the absent device is NOT sent to bootstrap", async () => {
    const [r] = await runCases(clockEnv(false), ["P19"]);
    expect(r?.result).toBe("fail");
    expect(r?.detail).toBe("no bootstrap after a 106-day absence");
  });
});
