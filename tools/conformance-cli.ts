// Runs the conformance suite against a DEPLOYED backend with synthetic data.
//
//   node tools/conformance-cli.ts <env file>
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

let next = 0;
const env: ConformanceEnv = {
  capabilities: new Set(),
  async device() {
    const [id, token] = vars.get(`RECALL_CF_DEV_POOL_${next++ % poolSize}`)!.split(":");
    return new ReferenceClient(base, id!, token!, timed);
  },
};

const started = Date.now();
const results = await runCases(env);
for (const r of results) console.log(`${r.result.padEnd(4)} ${r.id.padEnd(4)} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
timings.sort((a, b) => a - b);
const pct = (p: number) => timings[Math.min(timings.length - 1, Math.floor((p / 100) * timings.length))]!.toFixed(0);
console.log(`requests ${timings.length}, round trip p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${timings.at(-1)!.toFixed(0)} ms, wall ${Date.now() - started} ms`);
const failed = results.filter((r) => r.result === "fail").length;
process.exit(failed ? 1 : 0);
