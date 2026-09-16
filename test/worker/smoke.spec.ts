import { describe, expect, it } from "vitest";
import { call, ownerDevice } from "./helpers.ts";

describe("smoke", () => {
  it("health, claim, hello", async () => {
    const h = await call("GET", "/v1/health");
    expect(h.status).toBe(200);
    const o = await ownerDevice();
    const hello = await call("POST", "/v1/hello", { t: "hello", pv: 1, device: o.deviceId, since: 0 }, o.token);
    expect(hello.status).toBe(200);
    expect(hello.json.t).toBe("hello_ok");
  });
});
