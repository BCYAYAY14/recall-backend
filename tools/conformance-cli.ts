// Runs the conformance suite against a DEPLOYED backend with synthetic data.
//
//   node tools/conformance-cli.ts <env file> [P<n> ...]
//
// The env file (mode 600, outside every repository) holds RECALL_CF_DEV_URL and
// RECALL_CF_DEV_SETUP_CODE; on first run this tool claims the backend and
// appends the owner token and a pool of paired device tokens to the same file.
// Nothing here prints a token. Output is one line per case plus timings.

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { ReferenceClient, type FetchLike } from "../client/reference-client.ts";
import { runCases, type ConformanceEnv } from "./conformance.ts";

const file = process.argv[2];
if (!file) { console.error("usage: node tools/conformance-cli.ts <env file>"); process.exit(2); }
const vars = new Map(readFileSync(file, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const base = vars.get("RECALL_CF_DEV_URL")!;
const save = () => { writeFileSync(file, [...vars].map(([k, v]) => `${k}=${v}`).join("\n") + "\n"); chmodSync(file, 0o600); };

const timings: number[] = [];
const timed: FetchLike = async (input, init) => {
  const t = performance.now();
  const r = await fetch(input, init);
  timings.push(performance.now() - t);
  return r;
};

async function post(path: string, body: unknown, token?: string) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const json = await r.json() as Record<string, unknown>;
  if (!r.ok) throw new Error(`${path} ${r.status} ${String(json.error)}`);
  return json;
}

if (!vars.get("RECALL_CF_DEV_OWNER_TOKEN")) {
  const id = crypto.randomUUID();
  const claimed = await post("/v1/claim", { code: vars.get("RECALL_CF_DEV_SETUP_CODE"), device_id: id, label: "Synthetic owner", platform: "mac" });
  vars.set("RECALL_CF_DEV_OWNER_ID", id);
  vars.set("RECALL_CF_DEV_OWNER_TOKEN", String(claimed.token));
  vars.set("RECALL_CF_DEV_RECOVERY", (claimed.recovery_codes as string[]).join(","));
  save();
  console.log("claimed the dev backend");
}
const owner = vars.get("RECALL_CF_DEV_OWNER_TOKEN")!;
const poolSize = 6;
for (let i = 0; i < poolSize; i++) {
  if (vars.get(`RECALL_CF_DEV_POOL_${i}`)) continue;
  const begun = await post("/v1/pair/begin", {}, owner);
  const id = crypto.randomUUID();
  const paired = await post("/v1/pair/claim", { code: begun.code, device_id: id, label: `Synthetic device ${i}`, platform: i % 2 ? "ios" : "mac" });
  vars.set(`RECALL_CF_DEV_POOL_${i}`, `${id}:${String(paired.token)}`);
  save();
}

// REVOKE (P32) is the owner's own door, DELETE /v1/devices/<id>, so a deployed
// backend can do it. A revoked pool device is paired again under the SAME id
// once the suite ends (pairing un-revokes it and issues a new token), so the
// pool stays six devices and the backend gains no device rows. The clock and
// forced compaction (P19) have no door on a deployed backend: P19 runs in the
// Workers runtime with a moved clock (test/worker/p19-clock.spec.ts).
let next = 0;
const slotOf = new Map<string, number>();
const revoked: string[] = [];
const env: ConformanceEnv = {
  capabilities: new Set(["revoke"]),
  async device() {
    let slot = next++ % poolSize;
    while (revoked.includes(vars.get(`RECALL_CF_DEV_POOL_${slot}`)!.split(":")[0]!)) slot = next++ % poolSize;
    const [id, token] = vars.get(`RECALL_CF_DEV_POOL_${slot}`)!.split(":");
    slotOf.set(id!, slot);
    return new ReferenceClient(base, id!, token!, timed);
  },
  async revoke(deviceId) {
    const r = await fetch(`${base}/v1/devices/${deviceId}`, { method: "DELETE", headers: { authorization: `Bearer ${owner}` } });
    if (r.status !== 200) throw new Error(`revoke answered ${r.status}`);
    revoked.push(deviceId);
  },
};

const only = process.argv.slice(3).filter((a: string) => /^P\d+$/.test(a));
const started = Date.now();
const results = await runCases(env, only.length ? only : undefined);
for (const id of revoked) {
  const slot = slotOf.get(id)!;
  const begun = await post("/v1/pair/begin", {}, owner);
  const paired = await post("/v1/pair/claim", { code: begun.code, device_id: id, label: `Synthetic device ${slot}`, platform: slot % 2 ? "ios" : "mac" });
  vars.set(`RECALL_CF_DEV_POOL_${slot}`, `${id}:${String(paired.token)}`);
  save();
  console.log(`re-paired the revoked pool device ${slot}`);
}
for (const r of results) console.log(`${r.result.padEnd(4)} ${r.id.padEnd(4)} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
timings.sort((a, b) => a - b);
const pct = (p: number) => timings[Math.min(timings.length - 1, Math.floor((p / 100) * timings.length))]!.toFixed(0);
console.log(`requests ${timings.length}, round trip p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${timings.at(-1)!.toFixed(0)} ms, wall ${Date.now() - started} ms`);
const failed = results.filter((r) => r.result === "fail").length;
process.exit(failed ? 1 : 0);
