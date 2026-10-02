// The card gate and the line grammar the web editor needs, restated from
// Recall's AuthoringParser (Sources/Core/Outline.swift, the six triggers of
// D-191, SPEC's 2026-09-28 flashcard model), MarkdownProjection
// (the six span patterns and the escape mask), MathText (the formula
// ranges), RichText (the block markers) and AppDatabase.clozeOrdinals.
//
// Ruling W-B (2026-09-23): a JS port of exactly these rules, held to the
// Swift suite's own cases by test/unit/web-gate.spec.ts (CardGateTests,
// FlashcardModelTests, OwnerRound20260909Tests, ReverseCardTests), so the web
// cannot make a card the Mac would refuse, or refuse one it would make.
//
// Every index is a UTF-16 offset, which is what a JS string index is and
// what NSString ranges are.

const Gate = (() => {

  // ------------------------------------------------------------------ math

  // `MathText.mathRanges`: display `$$...$$` and inline `$...$`, the earlier
  // of the two at each step, display winning a tie. An inline formula's
  // closing `$` is never followed by a digit (Pandoc's rule, the app's since
  // review 2026-09-26): "costs $5-$10" is money, not the formula `5-`.
  const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
  const INLINE_RE = /(?<!\\)\$(\S[^$\n]*?\S|\S)\$(?!\d)/g;

  function firstFrom(re, text, from) {
    re.lastIndex = from;
    const m = re.exec(text);
    return m ? { start: m.index, end: m.index + m[0].length } : null;
  }

  function mathRanges(line) {
    if (!line.includes("$")) return [];
    const out = [];
    let cursor = 0;
    while (cursor < line.length) {
      const d = firstFrom(DISPLAY_RE, line, cursor);
      const i = firstFrom(INLINE_RE, line, cursor);
      const pick = d && i ? (d.start <= i.start ? d : i) : (d || i);
      if (!pick) break;
      out.push(pick);
      cursor = pick.end;
    }
    return out;
  }

  // -------------------------------------------------------------- the spans

  // Code is gone from Recall (owner, 2026-09-29): no backtick span and no
  // escaped backtick, so a backtick is an ordinary character.
  const ESCAPABLE = new Set(["*", "~", "=", "^", "\\"]);

  // `MarkdownProjection.spanPatternSources`, in ACCEPT ORDER.
  const SPAN_PATTERNS = [
    /==\S(?:[^=\n]*\S)?==/g,
    /~~\S(?:[^~\n]*\S)?~~/g,
    /\*\*\S(?:[^*\n]*\S)?\*\*/g,
    /\*\S(?:[^*\n]*\S)?\*/g,
    /(?<![\s^])\^[^\s^]+\^/g,
    /(?<![\s~])~[^\s~]+~/g,
  ];

  function blankRanges(text, ranges, fill) {
    if (!ranges.length) return text;
    const chars = text.split("");
    for (const r of ranges) {
      for (let k = r.start; k < Math.min(r.end, chars.length); k++) chars[k] = fill;
    }
    return chars.join("");
  }

  // `spanScratch`: math blanked first (math owns `^` and `*`, landmine 62),
  // then every ESCAPED marker blanked, length preserved.
  function spanScratch(line) {
    const masked = blankRanges(line, mathRanges(line), "\u0000");
    if (!masked.includes("\\")) return masked;
    let out = "";
    for (let i = 0; i < masked.length; i++) {
      if (masked[i] === "\\" && i + 1 < masked.length && ESCAPABLE.has(masked[i + 1])) {
        out += "\u0000\u0000";
        i += 1;
      } else {
        out += masked[i];
      }
    }
    return out;
  }

  // Flat, non-overlapping inline spans; an overlapping later match loses.
  function inlineSpans(line) {
    const scratch = spanScratch(line);
    if (!/[=~*^]/.test(scratch)) return [];
    const spans = [];
    for (const re of SPAN_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(scratch)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (m[0].length === 0) { re.lastIndex++; continue; }
        if (spans.some(s => start < s.end && end > s.start)) continue;
        spans.push({ start, end });
      }
    }
    return spans.sort((a, b) => a.start - b.start);
  }

  // ------------------------------------------------------------------ cloze

  const CLOZE_SPAN_RE = /\{\{c\d+::.*?\}\}/g;
  const CLOZE_ORDINAL_RE = /\{\{c(\d+)::/g;

  function maskingCloze(line) {
    if (!line.includes("{{c")) return line;
    return line.replace(CLOZE_SPAN_RE, m => " ".repeat(m.length));
  }

  // `AuthoringParser.clozeSpans`: each span's PIECES in the line's own
  // offsets, what the document hides (`{{c1::`, a hint's `::` and the hint,
  // `}}`) and what it keeps (the words), and its ordinal (0 when the number
  // does not parse).
  const CLOZE_PIECES_RE = /\{\{c(\d+)::(.*?)(::[^}]*)?\}\}/g;

  function clozeSpans(line) {
    if (!line || !line.includes("{{c")) return [];
    const out = [];
    for (const m of line.matchAll(CLOZE_PIECES_RE)) {
      const start = m.index, end = m.index + m[0].length;
      const innerStart = start + 3 + m[1].length + 2;
      const innerEnd = innerStart + m[2].length;
      let hintMark = null, hint = null;
      if (m[3] && m[3].length >= 2) {
        hintMark = { start: innerEnd, end: innerEnd + 2 };
        if (m[3].length > 2) hint = { start: innerEnd + 2, end: innerEnd + m[3].length };
      }
      const n = Number(m[1]);
      out.push({ open: { start, end: innerStart }, inner: { start: innerStart, end: innerEnd }, hintMark, hint,
                 close: { start: end - 2, end }, whole: { start, end }, ordinal: Number.isSafeInteger(n) ? n : 0 });
    }
    return out;
  }

  // `AppDatabase.clozeOrdinals`: unique, sorted.
  function clozeOrdinals(text) {
    if (!text || !text.includes("{{c")) return [];
    const found = new Set();
    for (const m of text.matchAll(CLOZE_ORDINAL_RE)) {
      const v = parseInt(m[1], 10);
      if (Number.isSafeInteger(v)) found.add(v);
    }
    return [...found].sort((a, b) => a - b);
  }

  // -------------------------------------------------------------- the gate

  // THE TRIGGERS, NAMED ONCE (D-191, SPEC's 2026-09-28 flashcard model;
  // `AuthoringParser.CardSeparator`). The order is the SCAN order at one
  // position, so `>>>` is tried before `>>` and the longest trigger wins.
  // `<->` is no trigger any more and `::` is a CONCEPT, asked both ways.
  const TRIGGERS = {
    ">>>": { name: "list", kind: "basic", asks: "f" },
    ">>": { name: "forward", kind: "basic", asks: "f" },
    "<<": { name: "reverse", kind: "basic", asks: "r" },
    "<>": { name: "both", kind: "basic", asks: "b" },
    "::": { name: "concept", kind: "concept", asks: "b" },
    ";;": { name: "descriptor", kind: "descriptor", asks: "f" },
  };

  // `CardMark(text:)`: a trigger with an optional `-`, or null.
  function markFromText(text) {
    if (typeof text !== "string") return null;
    let t = text, off = false;
    if (t.endsWith("-")) { off = true; t = t.slice(0, -1); }
    if (!TRIGGERS[t]) return null;
    return mark(t, off);
  }

  function mark(separator, off = false) {
    return { separator, off, text: separator + (off ? "-" : "") };
  }

  // `CardMark.asks(override:)`: a Basic card's direction IS its trigger, so
  // only a concept or a descriptor takes the menu's `attrs.ask`.
  function marksAsks(m, override) {
    const t = TRIGGERS[m.separator];
    if (t.kind !== "basic" && (override === "f" || override === "r" || override === "b")) return override;
    return t.asks;
  }

  const takesAskOverride = separator => TRIGGERS[separator].kind !== "basic";

  // `mayCarrySeparator`: two of `>`, `<`, `:` or `;` side by side in one of
  // the six shapes, in ONE pass (landmine 146).
  function mayCarrySeparator(line) {
    let prev = 0;
    for (let i = 0; i < line.length; i++) {
      const b = line.charCodeAt(i);
      if ((prev === 0x3E && b === 0x3E) || (prev === 0x3C && b === 0x3C) || (prev === 0x3C && b === 0x3E)
          || (prev === 0x3A && b === 0x3A) || (prev === 0x3B && b === 0x3B)) return true;
      prev = b;
    }
    return false;
  }

  // A trigger inside a cloze span, a formula or a styled run belongs to that
  // span (C-10); the mask blanks all three, length preserved.
  function separatorMask(line) {
    if (!mayCarrySeparator(line)) return line;
    const cloze = maskingCloze(line);
    const math = mathRanges(cloze);
    if (!math.length && !inlineSpans(cloze).length) return cloze.length === line.length ? cloze : line;
    let out = blankRanges(cloze, math, " ");
    out = blankRanges(out, inlineSpans(out), " ");
    return out.length === line.length ? out : line;
  }

  // `separatorHits`: every masked trigger, in order, the dash included in
  // its range. A trigger with a BACKSLASH right before it is literal text
  // (`\>>`).
  function separatorHits(line) {
    return scanTriggers(line).hits;
  }

  // `escapedTriggerBackslashes`: where each ESCAPED trigger's backslash
  // stands. The editor hides it (SPEC: "a backslash is written before it and
  // hidden"), so Backspace after a chip gives the trigger back as words.
  function escapedTriggerBackslashes(line) {
    return scanTriggers(line).escapes;
  }

  // The one walk both of the above read.
  function scanTriggers(line) {
    if (!mayCarrySeparator(line)) return { hits: [], escapes: [] };
    const masked = separatorMask(line);
    const n = masked.length;
    const at = k => (k < n ? masked.charCodeAt(k) : 0);
    const out = [];
    const escapes = [];
    let i = 0;
    while (i < n - 1) {
      const c = at(i);
      if (c !== 0x3E && c !== 0x3C && c !== 0x3A && c !== 0x3B) { i += 1; continue; }
      const d = at(i + 1);
      let sep = null;
      if (c === 0x3E && d === 0x3E) sep = at(i + 2) === 0x3E ? ">>>" : ">>";
      else if (c === 0x3C && d === 0x3C) sep = "<<";
      else if (c === 0x3C && d === 0x3E) sep = "<>";
      else if (c === 0x3A && d === 0x3A) sep = "::";
      else if (c === 0x3B && d === 0x3B) sep = ";;";
      if (!sep) { i += 1; continue; }
      if (i > 0 && at(i - 1) === 0x5C) { escapes.push(i - 1); i += sep.length; continue; }
      const off = at(i + sep.length) === 0x2D;
      const end = i + sep.length + (off ? 1 : 0);
      out.push({ start: i, end, separator: sep, off, mark: mark(sep, off) });
      i = end;
    }
    return { hits: out, escapes };
  }

  // Swift's `.whitespaces`: spaces and tabs, never a newline.
  function trimSpaces(s) {
    return s.replace(/^[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+|[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+$/g, "");
  }

  // `AuthoringParser.splitCard`: a line's two sides and the trigger between
  // them. ONE non-space character before the trigger (owner 2026-09-09);
  // the BACK may be empty, which is a LIST-SHAPED line (its answer is the
  // lines under it) or a card being typed, and neither is a one-line card.
  function splitCard(raw) {
    if (!mayCarrySeparator(raw)) return null;
    const line = trimSpaces(raw);
    if (!line) return null;
    const hit = separatorHits(line)[0];
    if (!hit) return null;
    const front = trimSpaces(line.slice(0, hit.start));
    const back = trimSpaces(line.slice(hit.end));
    if (!/\S/.test(front)) return null;
    return { front, back, mark: hit.mark, separator: hit.separator, off: hit.off,
             listShaped: back === "", isOneLineCard: !hit.off && back !== "" };
  }

  // `splitOutlineCard`: the two sides of a line that is a ONE-LINE CARD by
  // its own text (on, something on both sides), or null.
  function splitOutlineCard(raw) {
    const s = splitCard(raw);
    return s && s.isOneLineCard ? { front: s.front, back: s.back } : null;
  }

  // `hasSecondSeparator`: `a >> b >> c` reads as two cards.
  function hasSecondSeparator(line) {
    return separatorHits(line).length > 1;
  }

  // `columnSeparatorRange`: a table's column gate is `::` and nothing else
  // (C-72, restated by D-191); a cell naming another trigger is one cell.
  function columnSeparator(line) {
    return separatorHits(line).find(h => h.separator === "::" && !h.off) || null;
  }

  // A card table row's two cells (`CanvasBlock.cells(cardTable:)`): split at
  // the column separator, or the whole text and an empty second cell.
  function cardCells(text) {
    const hit = columnSeparator(text);
    if (!hit) return [text, ""];
    return [text.slice(0, hit.start), text.slice(hit.end)];
  }

  // `CanvasBlock.storedText(cardGate:)` for a table row: the line terminator
  // off, and with the gate, the spaces and tabs round the column separator.
  function storedRowText(text, cardGate) {
    const trimmed = String(text ?? "").replace(/^[\n\r\u2028\u2029\u0085\u000B\u000C]+|[\n\r\u2028\u2029\u0085\u000B\u000C]+$/g, "");
    const hit = cardGate ? columnSeparator(trimmed) : null;
    if (!hit) return trimmed;
    return trimSpaces(trimmed.slice(0, hit.start)) + "::" + trimSpaces(trimmed.slice(hit.end));
  }

  // `CanvasBlock.rowGates` for a NORMAL table's body row: a cell holding a
  // `::` that splits the row into a front and a back the store gives back
  // unchanged, spaces aside, is a card row (`std::vector` in the first cell
  // stores `std` and `vector<TAB>...`). Answers the stored text and faces,
  // or null. A card table's rows and any header are the caller's.
  function tableRowGate(text) {
    const t = storedRowText(text, false);
    if (!t.includes("::")) return null;
    const stored = storedRowText(t, true);
    const split = splitCard(stored);
    if (!split || split.separator !== "::" || split.off || !split.back
        || split.front + "::" + split.back !== stored) return null;
    return stored.replace(/ /g, "") === t.replace(/ /g, "") ? { stored, front: split.front, back: split.back } : null;
  }

  // `flattenTriggers` (`importSide`): a side from OUTSIDE the canvas (an
  // import, a generated card) with every trigger flattened to a lookalike,
  // so the line it lands in splits where the writer meant.
  function flattenTriggers(s) {
    const text = String(s ?? "");
    if (!mayCarrySeparator(text)) return text;
    return text.split("::").join(":").split(";;").join(";")
      .split(">>").join("\u00BB").split("<<").join("\u00AB").split("<>").join("\u2260");
  }

  // `blankingTriggers`: every trigger blanked to spaces, length preserving,
  // for readers that count words or speak a line.
  function blankingTriggers(line) {
    const hits = separatorHits(line);
    if (!hits.length) return line;
    return blankRanges(line, hits, " ");
  }

  // `CardDrafts.line`: `question >> answer` for a card written from outside
  // (Make Cards), triggers flattened, a leading marker dropped, or null.
  function draftLine(question, answer) {
    const clean = s => flattenTriggers(s).replace(/\s+/g, " ").replace(/^[ \t]+|[ \t]+$/g, "")
      .replace(/^(#+|[-*>|]|\d+\.)\s*/, "").replace(/^[ \t]+|[ \t]+$/g, "");
    const q = clean(question), a = clean(answer);
    if (!q || !a) return null;
    const line = q + " >> " + a;
    return splitOutlineCard(line) ? line : null;
  }

  // ---------------------------------------------------------------- markers

  // `BlockKind.parse` for the kinds a typed line can declare, with the
  // marker length the store takes off (storage is prefix free, v2.9). A
  // numbered line keeps its marker: its number is a position fact (E24).
  // A `# ` with nothing after it is not a heading (landmine 33).
  function declaredKind(line) {
    const h = /^(#{1,3}) (.*)$/s.exec(line);
    if (h) {
      if (!h[2].trim()) return null;
      return { kind: ["heading1", "heading2", "heading3"][h[1].length - 1], marker: h[1].length + 1 };
    }
    if (line === ">") return { kind: "quote", marker: 1 };
    if (line.startsWith("> ")) return { kind: "quote", marker: 2 };
    if (/^\d+[.)]( |$)/.test(line)) return { kind: "numbered", marker: 0 };
    if (line.startsWith("- ")) return { kind: "dash", marker: 2 };
    if (line.startsWith("* ")) return { kind: "bullet", marker: 2 };
    const box = /^\[( |x|X)?\] /.exec(line);
    if (box) return { kind: "checkbox", marker: box[0].length, checked: /[xX]/.test(box[1] || "") };
    return null;
  }

  // `RichText.storedTrim`: whitespace and newlines off both ends, but a bare
  // `N. ` keeps its space (landmine 141).
  function storedTrim(text) {
    const trimmed = text.replace(/^\s+|\s+$/g, "");
    if (/^\d+[.)]$/.test(trimmed)) return trimmed + " ";
    return trimmed;
  }

  return { mathRanges, inlineSpans, spanScratch, maskingCloze, clozeOrdinals, clozeSpans,
           separatorMask, separatorHits, escapedTriggerBackslashes, trimSpaces, splitCard, splitOutlineCard, hasSecondSeparator,
           declaredKind, storedTrim, mayCarrySeparator, columnSeparator, cardCells, storedRowText, tableRowGate,
           flattenTriggers, blankingTriggers, draftLine, markFromText, mark, marksAsks,
           takesAskOverride, TRIGGERS };
})();
