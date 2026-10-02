// Protocol 1's byte-exact pieces, for the browser: canonical JSON, the payload
// digest, the operation id, the wire timestamp and the last-write-wins rule.
//
// This is src/canonical.ts, src/opid.ts and src/isnewer.ts restated for a page
// with no build step. test/unit/web-wire.spec.ts runs THIS file against
// fixtures/canonical-json.json and fixtures/isnewer.json (generated from
// Recall's Swift), so the browser cannot drift from the Mac by one byte: a
// digest that differs turns every retry into a new operation.

const Wire = (() => {

  const encoder = new TextEncoder();
  const OP_NAMESPACE = "c31e75f6-172f-4c64-a83b-94df6e707132";
  const WIRE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

  // Keys sort by their UTF-8 bytes, not by UTF-16 units.
  function compareUtf8(a, b) {
    if (a === b) return 0;
    const x = encoder.encode(a);
    const y = encoder.encode(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) {
      const d = x[i] - y[i];
      if (d !== 0) return d;
    }
    return x.length - y.length;
  }

  function hex4(code) {
    return "\\u" + code.toString(16).padStart(4, "0");
  }

  function canonicalString(s) {
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
        if (d >= 0xdc00 && d <= 0xdfff) { out += s[i] + s[i + 1]; i++; continue; }
        out += hex4(c); continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) { out += hex4(c); continue; }
      out += s[i];
    }
    return out + '"';
  }

  function canonicalNumber(n) {
    if (!Number.isFinite(n)) throw new Error("a number must be finite");
    if (Object.is(n, -0)) return "0";
    return String(n);
  }

  function canonical(value) {
    if (value === null) return "null";
    switch (typeof value) {
      case "boolean": return value ? "true" : "false";
      case "number": return canonicalNumber(value);
      case "string": return canonicalString(value);
      case "object": {
        if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
        const keys = Object.keys(value).sort(compareUtf8);
        const parts = [];
        for (const k of keys) {
          const v = value[k];
          if (v === undefined) throw new Error("undefined is not JSON");
          parts.push(canonicalString(k) + ":" + canonical(v));
        }
        return "{" + parts.join(",") + "}";
      }
      default:
        throw new Error(typeof value + " is not JSON");
    }
  }

  function toHex(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = "";
    for (const x of b) s += x.toString(16).padStart(2, "0");
    return s;
  }

  async function sha256Hex(text) {
    return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  }

  function uuidBytes(uuid) {
    const hex = uuid.replace(/-/g, "");
    if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("not a lowercase uuid");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function formatUuid(b) {
    const h = toHex(b.slice(0, 16));
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  async function uuidv5(namespace, name) {
    const ns = uuidBytes(namespace);
    const nameBytes = encoder.encode(name);
    const input = new Uint8Array(ns.length + nameBytes.length);
    input.set(ns, 0);
    input.set(nameBytes, ns.length);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    return formatUuid(hash);
  }

  function payloadOf(op) {
    return op.content === undefined ? { env: op.env } : { content: op.content, env: op.env };
  }

  async function payloadDigest(op) {
    return sha256Hex(canonical(payloadOf(op)));
  }

  async function opId(op) {
    const ms = wireMillis(op.updated_at);
    if (ms === null) throw new Error("updated_at is not a wire timestamp");
    const digest = await payloadDigest(op);
    return uuidv5(OP_NAMESPACE, `${op.device}|${op.lane}|${op.id}|${ms}|${digest}`);
  }

  // Milliseconds since the epoch, or null when `s` is not a wire timestamp.
  function wireMillis(s) {
    if (typeof s !== "string") return null;
    const m = WIRE.exec(s);
    if (!m) return null;
    const [y, mo, d, h, mi, se, ms] = m.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return null;
    const t = Date.UTC(y, mo - 1, d, h, mi, se, ms);
    const back = new Date(t);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return t;
  }

  // Strictly newer, compared in milliseconds: a TIE GOES TO THE SERVER
  // (Recall landmine 83), so neither side of a tie is newer.
  function isNewer(a, b) {
    const x = wireMillis(a);
    const y = wireMillis(b);
    if (x === null || y === null) throw new Error("not a wire timestamp");
    return x > y;
  }

  function wireTime(ms) {
    return new Date(ms).toISOString();
  }

  // A write's stamp: now, or one millisecond past the row's own stamp when
  // the clock has not moved past it (`ISODate.stamp(after:)`), so an edit
  // always wins over the revision it replaces.
  function stampAfter(previous, now = Date.now()) {
    const prev = previous ? wireMillis(previous) : null;
    return wireTime(prev !== null && now <= prev ? prev + 1 : now);
  }

  return { canonical, compareUtf8, sha256Hex, uuidv5, payloadOf, payloadDigest, opId,
           wireMillis, isNewer, wireTime, stampAfter, OP_NAMESPACE };
})();
