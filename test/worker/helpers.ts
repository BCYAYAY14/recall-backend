import { env, exports } from "cloudflare:workers";
import { ReferenceClient, type FetchLike } from "../../client/reference-client.ts";

export const BASE = "https://recall.test";
export const SETUP = "synthetic-setup-code-0001";
export const workerFetch: FetchLike = (input, init) => (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default.fetch(new Request(input, init));
export const E = env as unknown as import("../../src/env.ts").Env & { TEST_MIGRATIONS: unknown };

export async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await workerFetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

let owner: { token: string; deviceId: string; library: string } | null = null;

/** Claims the test backend once per isolate and returns the owner's Mac. */
export async function ownerDevice() {
  if (owner) return owner;
  const deviceId = crypto.randomUUID();
  const r = await call("POST", "/v1/claim", { code: SETUP, device_id: deviceId, label: "Synthetic Mac", platform: "mac" });
  if (r.status !== 200) throw new Error(`claim failed ${r.status} ${JSON.stringify(r.json)}`);
  owner = { token: String(r.json.token), deviceId, library: String(r.json.library_id) };
  return owner;
}

export async function pairedDevice(platform = "ios", label = "Synthetic iPhone") {
  const o = await ownerDevice();
  const begun = await call("POST", "/v1/pair/begin", undefined, o.token);
  const deviceId = crypto.randomUUID();
  const ip = `198.51.100.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const r = await call("POST", "/v1/pair/claim", { code: begun.json.code, device_id: deviceId, label, platform }, undefined, { "cf-connecting-ip": ip });
  if (r.status !== 200) throw new Error(`pair failed ${r.status} ${JSON.stringify(r.json)}`);
  return { token: String(r.json.token), deviceId, library: String(r.json.library_id), scope: String(r.json.scope) };
}

export async function client(platform = "ios") {
  const d = await pairedDevice(platform);
  return new ReferenceClient(BASE, d.deviceId, d.token, workerFetch);
}
