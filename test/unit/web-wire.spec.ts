// The web's wire helpers (assets/js/wire.js) against the protocol fixtures
// the server and Recall's Swift client already reproduce: canonical JSON,
// digests, op ids and the millisecond LWW (PLAN-BETA-0.12 section 26, W-2).

import { describe, expect, it } from "vitest";
import isnewer from "../../fixtures/isnewer.json" with { type: "json" };
import canon from "../../fixtures/canonical-json.json" with { type: "json" };
import { opId as serverOpId } from "../../src/opid.ts";
import { loadAssets } from "../support/web-assets.ts";

interface WireModule {
  canonical(v: unknown): string;
  sha256Hex(s: string): Promise<string>;
  opId(op: unknown): Promise<string>;
  isNewer(a: string, b: string): boolean;
  wireMillis(s: unknown): number | null;
  stampAfter(previous: string | null, now?: number): string;
}

const { Wire } = loadAssets<{ Wire: WireModule }>(["wire.js"], ["Wire"]);

describe("the browser speaks protocol 1's bytes", () => {
  it("reproduces all 200 canonical strings and digests", async () => {
    for (const c of canon.cases) {
      expect(Wire.canonical(c.input)).toBe(c.canonical);
      expect(await Wire.sha256Hex(c.canonical)).toBe(c.sha256);
    }
  });

  it("derives every fixture op id, the server's too", async () => {
    for (const o of canon.ops) {
      expect(await Wire.opId(o)).toBe(o.op_id);
      expect(await serverOpId(o)).toBe(o.op_id);
    }
  });

  it("reproduces every isNewer verdict; a tie goes to the server", () => {
    const wrong = isnewer.pairs.filter((p) => Wire.isNewer(p.a, p.b) !== p.a_newer_than_b);
    expect(wrong).toEqual([]);
    for (const s of isnewer.rejected_on_the_wire) expect(Wire.wireMillis(s)).toBeNull();
  });

  it("an edit's stamp always passes the revision it replaces", () => {
    const prev = "2026-09-23T10:00:00.500Z";
    expect(Wire.stampAfter(prev, Date.parse(prev))).toBe("2026-09-23T10:00:00.501Z");
    expect(Wire.stampAfter(prev, Date.parse(prev) - 5000)).toBe("2026-09-23T10:00:00.501Z");
    expect(Wire.stampAfter(prev, Date.parse(prev) + 10)).toBe("2026-09-23T10:00:00.510Z");
    expect(Wire.stampAfter(null, 0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
