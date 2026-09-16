import { describe, expect, it } from "vitest";
import { claim, pairClaim } from "../../src/auth.ts";
import { call, E, ownerDevice, pairedDevice, SETUP } from "./helpers.ts";

const dev = () => ({ device_id: crypto.randomUUID(), label: "Test", platform: "mac" });

describe("claim (plan 8.3, S2, S3)", () => {
  it("refuses a wrong code, then claims, then refuses a second claim with 409", async () => {
    const wrong = await call("POST", "/v1/claim", { code: "not-the-code-at-all", ...dev() });
    expect(wrong.status).toBe(401);
    const o = await ownerDevice();
    expect(o.token.startsWith("rcl_")).toBe(true);
    const again = await call("POST", "/v1/claim", { code: SETUP, ...dev() });
    expect(again.status).toBe(409);
  });

  it("S2: refuses a claim 61 minutes after deployment", async () => {
    const old = { ...E, DEPLOYED_AT: new Date(Date.now() - 61 * 60_000).toISOString() };
    await expect(claim(old, { code: SETUP, ...dev() })).rejects.toMatchObject({ status: 410, code: "window_closed" });
  });

  it("refuses when no setup code of 12 characters is configured", async () => {
    await expect(claim({ ...E, OWNER_SETUP_CODE: "short" }, { code: "short", ...dev() })).rejects.toMatchObject({ status: 503 });
  });

  it("returns eight recovery codes and stores none of them in plain text", async () => {
    await ownerDevice();
    const rows = await E.META.prepare("SELECT code_sha FROM recovery_code").all<{ code_sha: string }>();
    expect(rows.results.length).toBeGreaterThanOrEqual(8);
    for (const r of rows.results) expect(r.code_sha).toMatch(/^[0-9a-f]{64}$/);
    const devices = await E.META.prepare("SELECT token_sha FROM device").all<{ token_sha: string }>();
    for (const d of devices.results) expect(d.token_sha).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("pairing (S4, S5)", () => {
  it("pairs a phone with an eight digit code", async () => {
    const phone = await pairedDevice();
    expect(phone.scope).toBe("full");
    const hello = await call("POST", "/v1/hello", { t: "hello", pv: 1, device: phone.deviceId, since: 0 }, phone.token);
    expect(hello.status).toBe(200);
  });

  it("a code is single use", async () => {
    const o = await ownerDevice();
    const begun = await call("POST", "/v1/pair/begin", undefined, o.token);
    const first = await call("POST", "/v1/pair/claim", { code: begun.json.code, ...dev(), platform: "ios" }, undefined, { "cf-connecting-ip": crypto.randomUUID() });
    expect(first.status).toBe(200);
    const second = await call("POST", "/v1/pair/claim", { code: begun.json.code, ...dev(), platform: "ios" }, undefined, { "cf-connecting-ip": crypto.randomUUID() });
    expect(second.status).toBe(401);
  });

  it("S5: five wrong attempts kill a code", async () => {
    const o = await ownerDevice();
    const begun = await call("POST", "/v1/pair/begin", undefined, o.token);
    const real = String(begun.json.code).replace(" ", "");
    const wrong = real === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 5; i++) expect((await call("POST", "/v1/pair/claim", { code: wrong, ...dev(), platform: "ios" }, undefined, { "cf-connecting-ip": crypto.randomUUID() })).status).toBe(401);
    expect((await call("POST", "/v1/pair/claim", { code: real, ...dev(), platform: "ios" }, undefined, { "cf-connecting-ip": crypto.randomUUID() })).status).toBe(401);
  });

  it("S5: a six-minute-old code is refused", async () => {
    const o = await ownerDevice();
    const begun = await call("POST", "/v1/pair/begin", undefined, o.token);
    await expect(pairClaim(E, { code: begun.json.code, ...dev(), platform: "ios" }, Date.now() + 6 * 60_000)).rejects.toMatchObject({ status: 401 });
  });

  it("a browser pairs with read_share scope and may not push", async () => {
    const web = await pairedDevice("web", "Browser");
    expect(web.scope).toBe("read_share");
    const push = await call("POST", "/v1/push", { t: "push", batch: crypto.randomUUID(), ops: [] }, web.token);
    expect(push.status).toBe(403);
    expect((await call("POST", "/v1/pair/begin", undefined, web.token)).status).toBe(403);
  });
});

describe("rotation, revocation, recovery (P16, S10)", () => {
  it("rotation: the old token works for 60 seconds, then the new one only", async () => {
    const phone = await pairedDevice();
    const rotated = await call("POST", "/v1/device/rotate", undefined, phone.token);
    const fresh = String(rotated.json.token);
    expect((await call("GET", "/v1/pull?since=0", undefined, phone.token)).status).toBe(200);
    expect((await call("GET", "/v1/pull?since=0", undefined, fresh)).status).toBe(200);
    await E.META.prepare("UPDATE device SET prev_valid_until = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), phone.deviceId).run();
    expect((await call("GET", "/v1/pull?since=0", undefined, phone.token)).status).toBe(401);
  });

  it("P16: a revoked device is refused at once; the other device is unaffected", async () => {
    const o = await ownerDevice();
    const phone = await pairedDevice();
    const r = await call("DELETE", `/v1/devices/${phone.deviceId}`, undefined, o.token);
    expect(r.status).toBe(200);
    const refused = await call("POST", "/v1/hello", { t: "hello", pv: 1, device: phone.deviceId, since: 0 }, phone.token);
    expect(refused.status).toBe(401);
    expect(refused.json.error).toBe("revoked");
    expect((await call("POST", "/v1/hello", { t: "hello", pv: 1, device: o.deviceId, since: 0 }, o.token)).status).toBe(200);
  });

  it("the device list names each device and never a token", async () => {
    const o = await ownerDevice();
    await pairedDevice();
    const list = await call("GET", "/v1/devices", undefined, o.token);
    const text = JSON.stringify(list.json);
    expect(text).not.toContain("token");
    expect((list.json.devices as { this_device: boolean }[]).some((d) => d.this_device)).toBe(true);
  });

  it("twenty pair attempts an hour from one address, then 429", async () => {
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await call("POST", "/v1/pair/claim", { code: "12345678", ...dev(), platform: "ios" }, undefined, headers)).status;
    expect(last).toBe(429);
  });

  it("an unknown or missing credential is 401 auth, never a crash", async () => {
    expect((await call("GET", "/v1/pull?since=0")).status).toBe(401);
    expect((await call("GET", "/v1/pull?since=0", undefined, "rcl_nonsense")).json.error).toBe("auth");
  });

  it("a hello naming another device is refused", async () => {
    const o = await ownerDevice();
    const r = await call("POST", "/v1/hello", { t: "hello", pv: 1, device: crypto.randomUUID(), since: 0 }, o.token);
    expect(r.status).toBe(403);
  });

  it("P18: protocol too new or too old stops with one sentence naming which side is older", async () => {
    const o = await ownerDevice();
    const newer = await call("POST", "/v1/hello", { t: "hello", pv: 2, device: o.deviceId, since: 0 }, o.token);
    expect(newer.status).toBe(426);
    expect(String(newer.json.message)).toMatch(/backend is older/);
    const older = await call("POST", "/v1/hello", { t: "hello", pv: 0, device: o.deviceId, since: 0 }, o.token);
    expect(String(older.json.message)).toMatch(/Recall is older/);
  });
});
