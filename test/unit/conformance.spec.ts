import { describe, expect, it } from "vitest";
import { ReferenceClient } from "../../client/reference-client.ts";
import { CASES, runCases, type ConformanceEnv } from "../../tools/conformance.ts";
import { coreServer } from "../support/core-server.ts";

function env(): ConformanceEnv {
  const server = coreServer();
  return {
    capabilities: new Set(["clock", "compact", "revoke"]),
    async device(label) {
      const id = crypto.randomUUID();
      void label;
      let tick = 0;
      return new ReferenceClient("http://core", id, id, server.fetch, () => server.clock.now + (tick++));
    },
    advance(ms) { server.clock.now += ms; },
    async compact() { server.core.compact(server.clock.now); },
    async revoke(deviceId) { server.core.revoke(deviceId, server.clock.now); },
  };
}

describe("protocol conformance against the core (plan 17.1)", () => {
  for (const c of CASES) {
    it(`${c.id}: ${c.name}`, async () => {
      const [r] = await runCases(env(), [c.id]);
      expect(r?.detail ?? "").toBe("");
      expect(r?.result).toBe("pass");
    });
  }
});
