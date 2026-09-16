import { describe, expect, it } from "vitest";
import isnewer from "../../fixtures/isnewer.json" with { type: "json" };
import canon from "../../fixtures/canonical-json.json" with { type: "json" };
import { canonical, compareUtf8, sha256Hex } from "../../src/canonical.ts";
import { isNewer, wireMillis } from "../../src/isnewer.ts";
import { opId, uuidv5 } from "../../src/opid.ts";

describe("isNewer parity with Recall's ISODate.swift (P21)", () => {
  it("carries at least 200 pairs", () => {
    expect(isnewer.pairs.length).toBeGreaterThanOrEqual(200);
  });
  it("reproduces every Swift verdict", () => {
    const wrong = isnewer.pairs.filter((p) => isNewer(p.a, p.b) !== p.a_newer_than_b);
    expect(wrong).toEqual([]);
  });
  it("a tie goes to the server: neither side is newer", () => {
    for (const p of isnewer.pairs.filter((p) => p.a === p.b)) {
      expect(isNewer(p.a, p.b)).toBe(false);
    }
  });
  it("refuses every non-wire timestamp", () => {
    for (const s of isnewer.rejected_on_the_wire) expect(wireMillis(s)).toBeNull();
  });
});

describe("canonical JSON (O6)", () => {
  it("reproduces all 200 canonical strings and digests", async () => {
    expect(canon.cases.length).toBe(200);
    for (const c of canon.cases) {
      expect(canonical(c.input)).toBe(c.canonical);
      expect(await sha256Hex(c.canonical)).toBe(c.sha256);
    }
  });
  it("is independent of key insertion order", () => {
    expect(canonical({ b: 1, a: [true, null, "x"] })).toBe(canonical({ a: [true, null, "x"], b: 1 }));
  });
  it("sorts keys by UTF-8 bytes, not UTF-16 units", () => {
    // U+FFEE is EF BF AE in UTF-8; U+1D518 is F0 9D 94 98, so it sorts AFTER.
    expect(compareUtf8("￮", "𝔘")).toBeLessThan(0);
    expect("￮" < "𝔘").toBe(false);
  });
  it("refuses non-JSON values", () => {
    expect(() => canonical({ a: undefined })).toThrow();
    expect(() => canonical(Number.NaN)).toThrow();
    expect(() => canonical(Infinity)).toThrow();
  });
  it("escapes a lone surrogate", () => {
    expect(canonical("\ud800")).toBe('"\\ud800"');
  });
});

describe("the operation id (O1 to O5)", () => {
  it("reproduces the fixture's five op ids", async () => {
    for (const o of canon.ops) expect(await opId(o)).toBe(o.op_id);
  });
  it("O1 and O3 and O4: distinct payloads in one millisecond give distinct ids", async () => {
    const ids = new Set(canon.ops.slice(0, 3).map((o) => o.op_id));
    expect(ids.size).toBe(3);
  });
  it("O2: the same row unchanged gives the same id", async () => {
    const o = canon.ops[0]!;
    expect(await opId({ ...o })).toBe(await opId({ ...o, env: { ...o.env } }));
  });
  it("uuidv5 matches RFC 4122's DNS example", async () => {
    expect(await uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
  });
});
