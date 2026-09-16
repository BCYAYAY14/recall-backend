// The last-write-wins comparison, byte-for-byte Recall's `ISODate.isNewer`
// (landmine 83): both sides quantise to the MILLISECOND they store, and a tie
// goes to the SERVER. fixtures/isnewer.json is generated from the Swift source
// and test/fixtures.spec.ts reproduces every verdict.
//
// On the wire a timestamp is exactly `YYYY-MM-DDTHH:MM:SS.sssZ`. Anything else
// is refused rather than guessed at, because a second parser is how two
// devices come to disagree about one row for ever.

const WIRE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/** Milliseconds since the epoch, or null when `s` is not a wire timestamp. */
export function wireMillis(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = WIRE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se, ms] = m.slice(1).map(Number) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || h! > 23 || mi! > 59 || se! > 59) return null;
  const t = Date.UTC(y!, mo! - 1, d!, h!, mi!, se!, ms!);
  const back = new Date(t);
  // Refuses 2026-02-30 and friends: Date.UTC rolls them over silently.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo! - 1 || back.getUTCDate() !== d) return null;
  return t;
}

export function isWireTime(s: unknown): s is string {
  return wireMillis(s) !== null;
}

/** True when `a` is strictly newer than `b`. Both must be wire timestamps. */
export function isNewer(a: string, b: string): boolean {
  const x = wireMillis(a);
  const y = wireMillis(b);
  if (x === null || y === null) throw new Error("not a wire timestamp");
  return x > y;
}

export function wireTime(ms: number): string {
  return new Date(ms).toISOString();
}
