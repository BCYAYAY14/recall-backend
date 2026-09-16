// The operation identifier (PROTOCOL.md section 4, plan section 6.14):
//
//   payload_digest = sha256_hex(canonical({ "content": ..., "env": ... }))
//   op_id = uuidv5(OP_NAMESPACE,
//                  device_id | lane | row_id | updated_at_ms | payload_digest)
//
// Deterministic, so a retry after an ambiguous failure is the same operation;
// distinct for two mutations that share a millisecond, because the payload
// differs. Computed by CLIENTS. The Worker never needs it.

import { canonical, sha256Hex, toHex } from "./canonical.ts";
import { wireMillis } from "./isnewer.ts";

export const OP_NAMESPACE = "c31e75f6-172f-4c64-a83b-94df6e707132";

export function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("not a lowercase uuid");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function formatUuid(b: Uint8Array): string {
  const h = toHex(b.slice(0, 16));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function uuidv5(namespace: string, name: string): Promise<string> {
  const ns = uuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns, 0);
  input.set(nameBytes, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return formatUuid(hash);
}

export interface OpIdentity {
  device: string;
  lane: string;
  id: string;
  updated_at: string;
  env: Record<string, unknown>;
  content?: Record<string, unknown>;
}

export function payloadOf(op: { env: Record<string, unknown>; content?: Record<string, unknown> }): Record<string, unknown> {
  return op.content === undefined ? { env: op.env } : { content: op.content, env: op.env };
}

export async function payloadDigest(op: { env: Record<string, unknown>; content?: Record<string, unknown> }): Promise<string> {
  return sha256Hex(canonical(payloadOf(op)));
}

export async function opId(op: OpIdentity): Promise<string> {
  const ms = wireMillis(op.updated_at);
  if (ms === null) throw new Error("updated_at is not a wire timestamp");
  const digest = await payloadDigest(op);
  return uuidv5(OP_NAMESPACE, `${op.device}|${op.lane}|${op.id}|${ms}|${digest}`);
}
