// The inline style sidecar, read exactly as Sources/Core/InlineSpans.swift
// writes it. `note.spans` is JSON runs fingerprinted against the note's
// `outlineRawText`; a length or fingerprint MISMATCH drops the style and
// keeps the text (ruling R3), which is the whole forward compatibility story.

const Spans = (() => {

  // `f` (a family) and `z` (a size in points) carry a value. A family run
  // is INERT since 2026-09-13 (one document, one font) and is kept only so
  // normalising a stored array does not reorder it.
  const KINDS = ["b", "i", "s", "c", "h", "p", "u", "f", "z"];
  const EXCLUSIVE = { p: ["p", "u"], u: ["p", "u"] };

  const MASK = (1n << 64n) - 1n;
  const PRIME = 0x100000001b3n;

  // FNV-1a over UTF-16 code units, low byte then high byte. Swift's own
  // `Hasher` is seeded per process, which would silently drop every note's
  // style on the next launch (landmine 68); this is stable by construction,
  // and a JS string is UTF-16 already, so the units match unit for unit.
  function fingerprint(text) {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      h = ((h ^ BigInt(unit & 0xff)) * PRIME) & MASK;
      h = ((h ^ BigInt(unit >> 8)) * PRIME) & MASK;
    }
    return h.toString(16);
  }

  function decode(json, anchor) {
    if (!json) return [];
    let obj;
    try { obj = JSON.parse(json); } catch (_) { return []; }
    if (!obj || typeof obj !== "object") return [];
    if (obj.n !== anchor.length) return [];
    if (obj.h !== fingerprint(anchor)) return [];
    if (!Array.isArray(obj.r)) return [];
    const out = [];
    for (const item of obj.r) {
      if (!Array.isArray(item) || item.length < 3) continue;
      const [start, end, kind] = item;
      if (typeof start !== "number" || typeof end !== "number") continue;
      if (!KINDS.includes(kind)) continue;
      const value = item.length >= 4 && typeof item[3] === "string" ? item[3] : null;
      out.push({ start, end, kind, value });
    }
    return normalize(out, obj.n);
  }

  // Sorted, clamped, non empty, with same kind AND same colour runs that
  // touch or overlap merged. Grouping by colour is deliberate: two adjacent
  // highlights in different colours are two runs, and merging them would
  // repaint one with the other's colour.
  function normalize(runs, length) {
    const out = [];
    for (const kind of KINDS) {
      const colours = [...new Set(runs.filter(r => r.kind === kind)
        .map(r => r.value || ""))].sort();
      for (const colour of colours) {
        const group = runs
          .filter(r => r.kind === kind && (r.value || "") === colour)
          .map(r => ({
            start: Math.max(0, r.start),
            end: length == null ? r.end : Math.min(r.end, length),
            kind: r.kind,
            value: r.value,
          }))
          .filter(r => r.end > r.start)
          .sort((a, b) => a.start - b.start);
        const merged = [];
        for (const r of group) {
          const last = merged[merged.length - 1];
          if (last && last.end >= r.start) last.end = Math.max(last.end, r.end);
          else merged.push({ ...r });
        }
        out.push(...merged);
      }
    }
    return resolveExclusive(out).sort((a, b) =>
      a.start === b.start ? KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)
                          : a.start - b.start);
  }

  // A character can never be raised and lowered at once. The winner is
  // decided by POSITION, then by declaration order, never by input order.
  function resolveExclusive(runs) {
    if (!runs.some(r => EXCLUSIVE[r.kind])) return runs;
    const ranked = [...runs].sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      const ka = KINDS.indexOf(a.kind), kb = KINDS.indexOf(b.kind);
      if (ka !== kb) return ka - kb;
      return b.end - a.end;
    });
    const kept = [];
    for (const run of ranked) {
      let pieces = [run];
      for (const winner of kept) {
        if (winner.kind === run.kind) continue;
        if (!(EXCLUSIVE[run.kind] || []).includes(winner.kind)) continue;
        pieces = pieces.flatMap(p => subtract(winner, p));
      }
      kept.push(...pieces);
    }
    return kept;
  }

  function subtract(cut, run) {
    const lo = Math.max(cut.start, run.start);
    const hi = Math.min(cut.end, run.end);
    if (lo >= hi) return [run];
    const out = [];
    if (run.start < lo) out.push({ ...run, end: lo });
    if (hi < run.end) out.push({ ...run, start: hi });
    return out;
  }

  // Runs rebased into a sub range, for a card's two faces.
  function slice(runs, start, end) {
    const out = [];
    for (const r of runs) {
      const lo = Math.max(r.start, start);
      const hi = Math.min(r.end, end);
      if (hi <= lo) continue;
      out.push({ ...r, start: lo - start, end: hi - start });
    }
    return out;
  }

  return { decode, normalize, fingerprint, slice, KINDS };
})();
