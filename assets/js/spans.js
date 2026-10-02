// The inline style sidecar, read exactly as Sources/Core/InlineSpans.swift
// writes it. `note.spans` is JSON runs fingerprinted against the note's
// `outlineRawText`; a length or fingerprint MISMATCH drops the style and
// keeps the text (ruling R3), which is the whole forward compatibility story.

const Spans = (() => {

  // `f` (a family) and `z` (a size in points) carry a value. A family run
  // is INERT since 2026-09-13 (one document, one font) and is kept only so
  // normalising a stored array does not reorder it. `l` is a LINK (D-011):
  // its value is the destination (`linkTarget`), and a link with none is
  // not stored. `n` is UNDERLINE (D-189, owner 2026-09-29): a span only,
  // toggled by ⌘U and the strip, with no typed marker and no value. Inline
  // CODE (`c`) is gone (owner, 2026-09-29): a stored `c` run is an unknown
  // kind, dropped on decode with its text kept, like any other.
  const KINDS = ["b", "i", "s", "h", "p", "u", "f", "z", "l", "n"];
  const REFUSED_SCHEMES = ["javascript", "vbscript", "data", "file", "blob"];
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
      const raw = item.length >= 4 && typeof item[3] === "string" ? item[3] : null;
      // Every value through its kind's rule, as Swift decodes it: a kind
      // with none (bold, underline) keeps none, so a stray fourth element
      // cannot keep two touching runs apart.
      const value = normalizedValue(kind, raw);
      out.push({ start, end, kind, value });
    }
    return normalize(out, obj.n);
  }

  // Sorted, clamped, non empty, with same kind AND same colour runs that
  // touch or overlap merged. Grouping by colour is deliberate: two adjacent
  // highlights in different colours are two runs, and merging them would
  // repaint one with the other's colour.
  function normalize(runs, length) {
    runs = runs.filter(r => r.kind !== "l" || (r.value != null && r.value !== ""));
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
    // A start tie sorts by the kind's LETTER, as Swift sorts by `rawValue`,
    // so a Mac blob re-encodes to the same bytes and an untouched line is
    // not rewritten (review 2026-09-26, web-5).
    return resolveExclusive(out).sort((a, b) =>
      a.start !== b.start ? a.start - b.start : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
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

  // `LinkTarget.scheme`: the scheme, lowercased, or null when the text
  // names none. A dot is not allowed in it, so `www.x.org:8080` is a host.
  function linkScheme(s) {
    const m = /^([A-Za-z][A-Za-z0-9+-]*):/.exec(s);
    return m ? m[1].toLowerCase() : null;
  }

  // `LinkTarget.normalized` (D-011): trimmed, one token, `https://` when no
  // scheme is written, never a scheme that runs code or reads a file, `(`
  // and `)` percent-encoded (the `[text](url)` spelling closes at `)`), at
  // most 2048 units.
  function linkTarget(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s || /[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/.test(s)) return null;
    if (linkScheme(s) == null) s = "https://" + s;
    const scheme = linkScheme(s);
    if (!scheme || REFUSED_SCHEMES.includes(scheme)) return null;
    s = s.replace(/\(/g, "%28").replace(/\)/g, "%29");
    return s.length <= 2048 ? s : null;
  }

  // `LinkTarget.selfLink`: words that are themselves a destination (a scheme
  // and `//`, `mailto:`, `tel:` or `www.`) link with no question; nothing
  // links a bare URL unasked (D-011).
  function selfLink(words) {
    const t = String(words || "").trim();
    const lower = t.toLowerCase();
    const looks = lower.startsWith("www.") || lower.startsWith("mailto:") || lower.startsWith("tel:")
      || (linkScheme(t) != null && t.includes("://"));
    return looks ? linkTarget(t) : null;
  }

  // The `href` a stored destination may be drawn with, or null. Asked at the
  // DOM, so a value some other writer put in the blob never reaches it raw.
  function linkHref(value) {
    return linkTarget(value);
  }

  // `SpanKind.normalizedValue`: a highlight's colour is `#rrggbb` or the
  // hue-free wash, a family a short name, a size a number from 4 to 400, a
  // link a destination.
  function normalizedValue(kind, raw) {
    if (raw == null) return null;
    if (kind === "l") return linkTarget(raw);
    if (kind === "h") {
      let v = String(raw).trim().toLowerCase();
      if (!v.startsWith("#")) v = "#" + v;
      return /^#[0-9a-f]{6}$/.test(v) ? v : null;
    }
    if (kind === "f") {
      const name = String(raw).trim();
      return name && name.length <= 64 ? name : null;
    }
    if (kind === "z") {
      const v = Number(raw);
      return Number.isFinite(v) && v >= 4 && v <= 400 ? String(v) : null;
    }
    return null;
  }

  // `InlineSpans.encode`: nil when there is nothing to store, else
  // `{"v":1,"n":<utf16 length>,"h":"<fingerprint>","r":[[s,e,"b"]]}` with a
  // fourth element only for a run that has a value.
  function encode(runs, anchor) {
    const clean = normalize(runs, anchor.length);
    if (!clean.length) return null;
    const items = clean.map(r => {
      const head = `[${r.start},${r.end},"${r.kind}"`;
      const v = normalizedValue(r.kind, r.value);
      if (v == null) return head + "]";
      return head + ',"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]';
    });
    return `{"v":1,"n":${anchor.length},"h":"${fingerprint(anchor)}","r":[${items.join(",")}]}`;
  }

  // `InlineSpans.mapped`: a pure insertion carries the two stickiness rules
  // (typing at a run's end joins it, except a LINK's, D-011; typing at its
  // start stays outside); a
  // replacement keeps what each run had before and after the replaced range,
  // and drops a run wholly inside it (landmine 88). A run that brackets the
  // replacement takes the new text ("typing in a bold word stays bold").
  function mapped(runs, lo, removedLength, insertedLength) {
    const hi = lo + Math.max(0, removedLength);
    const delta = insertedLength - (hi - lo);
    const out = [];
    if (hi === lo) {
      for (const r of runs) {
        let s = r.start <= lo ? r.start : r.start + delta;
        let e = r.end <= lo ? r.end : r.end + delta;
        if (insertedLength > 0 && r.end === lo && r.start < lo && r.kind !== "l") e = lo + insertedLength;
        if (insertedLength > 0 && r.start === lo) { s = lo + insertedLength; e = Math.max(e, s); }
        if (e > s) out.push({ ...r, start: s, end: e });
      }
      return normalize(out);
    }
    for (const r of runs) {
      if (r.start <= lo && r.end >= hi) {
        const e = r.end + delta;
        if (e > r.start) out.push({ ...r, end: e });
        continue;
      }
      if (r.start < lo) {
        const e = Math.min(r.end, lo);
        if (e > r.start) out.push({ ...r, end: e });
      }
      if (r.end > hi) {
        const s2 = Math.max(r.start, hi) + delta;
        const e = r.end + delta;
        if (e > s2) out.push({ ...r, start: s2, end: e });
      }
    }
    return normalize(out);
  }

  // `InlineSpans.mappedThroughDiff`: the one replaced middle between two
  // whole texts (common prefix and suffix), then `mapped`.
  function mappedThroughDiff(runs, from, to) {
    if (!runs.length) return [];
    if (from === to) return normalize(runs, to.length);
    const cap = Math.min(from.length, to.length);
    let p = 0;
    while (p < cap && from.charCodeAt(p) === to.charCodeAt(p)) p++;
    let suffix = 0;
    while (suffix < cap - p && from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)) suffix++;
    return normalize(mapped(runs, p, from.length - suffix - p, to.length - suffix - p), to.length);
  }

  // Every character of [lo, hi) already carries `kind` (an empty range asks
  // the character before the caret, the sticky-right rule).
  function covers(runs, kind, lo, hi) {
    if (hi <= lo) return runs.some(r => r.kind === kind && lo > r.start && lo <= r.end);
    let covered = lo;
    for (const r of normalize(runs)) {
      if (r.kind === kind && r.start <= covered && r.end > covered) covered = r.end;
    }
    return covered >= hi;
  }

  function remove(runs, kinds, lo, hi) {
    const out = [];
    for (const r of runs) {
      if (kinds && !kinds.includes(r.kind)) { out.push(r); continue; }
      if (r.end <= lo || r.start >= hi) { out.push(r); continue; }
      if (r.start < lo) out.push({ ...r, end: lo });
      if (r.end > hi) out.push({ ...r, start: hi });
    }
    return normalize(out);
  }

  // `InlineSpans.toggle`: on where any character lacks it, off where all have it.
  function toggle(runs, kind, lo, hi, value) {
    if (hi <= lo) return runs;
    if (value == null && covers(runs, kind, lo, hi)) return remove(runs, [kind], lo, hi);
    const base = value != null ? remove(runs, [kind], lo, hi) : runs;
    return normalize([...base, { start: lo, end: hi, kind, value: value ?? null }]);
  }

  // `InlineSpans.styleableRanges` for one line: a style never lands on a
  // `{{img:}}` token or on the whitespace at either end of a piece.
  function styleableRanges(text, lo, hi) {
    if (hi <= lo) return [];
    let pieces = [{ start: Math.max(0, lo), end: Math.min(text.length, hi) }];
    for (const m of String(text).matchAll(/\{\{img:[^}]*\}\}/g)) {
      const a = m.index, b = m.index + m[0].length;
      const next = [];
      for (const p of pieces) {
        if (b <= p.start || a >= p.end) { next.push(p); continue; }
        if (a > p.start) next.push({ start: p.start, end: a });
        if (b < p.end) next.push({ start: b, end: p.end });
      }
      pieces = next;
    }
    const out = [];
    for (const p of pieces) {
      let a = p.start, b = p.end;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b > a) out.push({ start: a, end: b });
    }
    return out;
  }

  // ------------------------------------------------- table cells (D-189)
  //
  // `TableCellRuns` (Sources/Core/Tables.swift): A CELL'S STYLE LIVES IN ITS
  // ROW'S `spans`, offsets into the row's stored text, where the cells are
  // joined by a TAB (a card table's by its `::` column gate, `Gate`). THE ONE
  // RULE: a run never crosses a cell, so the separator carries nothing.

  // Each cell's [start, end) in the row's text (`cellRanges`).
  function cellRanges(text, cardTable) {
    const s = String(text || "");
    if (cardTable) {
      const hit = Gate.columnSeparator(s);
      if (!hit) return [{ start: 0, end: s.length }, { start: s.length, end: s.length }];
      return [{ start: 0, end: hit.start }, { start: hit.end, end: s.length }];
    }
    const out = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) === 9) { out.push({ start, end: i }); start = i + 1; }
    }
    out.push({ start, end: s.length });
    return out;
  }

  // The row's runs cell by cell, each relative to its cell; a run crossing a
  // boundary is split into the cells it covers (`cellRuns`).
  function cellRuns(text, runs, cardTable) {
    return cellRanges(text, cardTable).map(c => slice(runs || [], c.start, c.end));
  }

  // The inverse: each cell's runs placed back into the row's text, clipped
  // to the cell (`rowRuns`).
  function rowRuns(cells, text, cardTable) {
    const ranges = cellRanges(text, cardTable);
    const out = [];
    (cells || []).forEach((runs, i) => {
      const cell = ranges[i];
      if (!cell) return;
      const length = cell.end - cell.start;
      for (const r of runs || []) {
        const start = Math.min(length, Math.max(0, r.start)) + cell.start;
        const end = Math.min(length, Math.max(0, r.end)) + cell.start;
        if (end > start) out.push({ ...r, start, end });
      }
    });
    return normalize(out, String(text || "").length);
  }

  // The row's runs split at every cell boundary they cross (`normalized`).
  function clipToCells(text, runs, cardTable) {
    return rowRuns(cellRuns(text, runs, cardTable), text, cardTable);
  }

  return { decode, encode, normalize, fingerprint, slice, mapped, mappedThroughDiff, covers, remove, toggle,
           normalizedValue, linkTarget, linkHref, selfLink, styleableRanges, cellRanges, cellRuns, rowRuns,
           clipToCells, KINDS };
})();
