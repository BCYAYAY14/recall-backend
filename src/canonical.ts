// Canonical JSON: the ONE byte form a payload digest is taken over.
//
// Recall computes `payload_digest = sha256(canonical(payload))` on the CLIENT
// and folds it into the operation id (PROTOCOL.md section 4). Two encoders that
// disagree by one byte turn every retry into a new operation, so Swift and
// TypeScript are pinned to fixtures/canonical-json.json.
//
// The rules, all of them:
//   * objects: keys sorted by their UTF-8 bytes, no duplicate keys
//   * no insignificant whitespace
//   * strings: `"` and `\` escaped; U+0008 \b, U+0009 \t, U+000A \n,
//     U+000C \f, U+000D \r; every other code point below U+0020 as \u00xx
//     (lowercase hex); a lone surrogate as \udxxx (lowercase); everything
//     else, `/` and non-ASCII included, written as itself
//   * numbers: ECMAScript Number::toString (RFC 8785); -0 is 0; a NaN or an
//     infinity is refused
//   * true, false, null; `undefined` is refused
//
// The Worker never canonicalises a large value (plan finding F-20). It
// compares stored and incoming rows through this only for single rows.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const encoder = new TextEncoder();

export function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function hex4(code: number): string {
  return "\\u" + code.toString(16).padStart(4, "0");
}

export function canonicalString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; continue;
      case 0x5c: out += "\\\\"; continue;
      case 0x08: out += "\\b"; continue;
      case 0x09: out += "\\t"; continue;
      case 0x0a: out += "\\n"; continue;
      case 0x0c: out += "\\f"; continue;
      case 0x0d: out += "\\r"; continue;
    }
    if (c < 0x20) { out += hex4(c); continue; }
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { out += s[i]! + s[i + 1]!; i++; continue; }
      out += hex4(c); continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) { out += hex4(c); continue; }
    out += s[i];
  }
  return out + '"';
}

export function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) throw new CanonicalError("a number must be finite");
  if (Object.is(n, -0)) return "0";
  return String(n);
}

export class CanonicalError extends Error {}

export function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number": return canonicalNumber(value);
    case "string": return canonicalString(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(compareUtf8);
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) throw new CanonicalError("undefined is not JSON");
        parts.push(canonicalString(k) + ":" + canonical(v));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new CanonicalError(`${typeof value} is not JSON`);
  }
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}
