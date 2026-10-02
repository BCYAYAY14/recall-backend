// Find and replace over the BLOCK LIST, restated from Recall's CanvasFind
// (Sources/Core/Canvas/CanvasFind.swift) and CanvasDocument.replaceAll
// (PLAN-BETA-0.6 G10, M9). Pure: blocks in (Model.build's, a table's rows
// among its `rows`), matches and replacements out; the editor draws and
// writes them.
//
// A block's text is what is STORED, so a match can never land in a marker
// the store does not keep, and the marker it does keep (a numbered item's
// `N. `, a pre-migration row's `| `) is chrome the search never reaches. A
// `{{img:}}` token is a REFERENCE, never prose (landmine 139's first half);
// a replacement is never allowed to carry a line break, since a block is one
// stored note (its second half); and a table row's text IS its cells, so a
// replacement carrying a TAB or a `::` is refused in a cell by name.

const Find = (() => {

  const TOKEN_RE = /\{\{img:([\p{L}\p{M}\p{Nd}\p{Pc}‌‍-]+)\}\}/gu;

  // `TypedAccelerator.markerPrefix` (RichText.swift), the typed markers a
  // line can carry at its start. Code left Recall (owner 2026-09-29), so a
  // backtick fence is no marker.
  function markerPrefix(line) {
    if (line.startsWith("### ")) return { kind: "heading3", marker: "### " };
    if (line.startsWith("## ")) return { kind: "heading2", marker: "## " };
    if (line.startsWith("# ")) return { kind: "heading1", marker: "# " };
    if (line === ">") return { kind: "quote", marker: ">" };
    if (line.startsWith("> ")) return { kind: "quote", marker: "> " };
    if (line === "-") return { kind: "dash", marker: "-" };
    if (line === "*") return { kind: "bullet", marker: "*" };
    if (line.startsWith("- ")) return { kind: "dash", marker: "- " };
    if (line.startsWith("* ")) return { kind: "bullet", marker: "* " };
    for (const m of ["[] ", "[ ] ", "[x] ", "[X] "]) if (line.startsWith(m)) return { kind: "checkbox", marker: m };
    for (const m of ["[]", "[ ]", "[x]", "[X]"]) if (line === m) return { kind: "checkbox", marker: m };
    return null;
  }

  // `BlockKind.takesListMarker`: a heading, quote, task, table or picture
  // never takes one (landmine 259).
  const takesListMarker = kind => ["paragraph", "bullet", "dash", "numbered"].includes(kind || "paragraph");

  // `RichText.numberedMarker`: the length of `N. ` or `N) ` (or of a bare
  // `N.`), or 0.
  function numberedMarkerLength(line) {
    const m = /^(\d+)[.)]/.exec(line);
    if (!m) return 0;
    if (m[0].length === line.length) return line.length;
    return line[m[0].length] === " " ? m[0].length + 1 : 0;
  }

  // `CanvasFind.markerLength(of:)`: how many characters at the start of a
  // block's own text are its MARKER, in the order the caret asks them.
  function markerLength(block) {
    const line = block.text || "";
    const listMarkers = takesListMarker(block.kind);
    const p = markerPrefix(line);
    if (p && (listMarkers || (p.kind !== "bullet" && p.kind !== "dash"))) return p.marker.length;
    if (listMarkers) {
      const n = numberedMarkerLength(line);
      if (n) return n;
    }
    if (line.startsWith("| ") || line === "|") return line === "|" ? 1 : 2;
    return 0;
  }

  // A table PARENT holds no prose of its own (its text is derived, M5); its
  // ROWS are searched. A pre-migration row is a `table` with no rows.
  const isSearchable = block => block.kind !== "table" || !(block.rows && block.rows.length);

  // `CanvasDocument.flattened`: parents followed by their rows.
  const flattened = blocks => blocks.flatMap(b => [b, ...(b.rows || [])]);

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isWordUnit = c => /[\p{L}\p{N}'’]/u.test(c);

  // A whole word: no letter, digit or apostrophe on either side
  // (`isWholeWord`, the boundary `CanvasWordCount` uses).
  function isWholeWord(text, start, end) {
    if (start > 0 && isWordUnit(text[start - 1])) return false;
    if (end < text.length && isWordUnit(text[end])) return false;
    return true;
  }

  function tokenRanges(text) {
    if (!text.includes("{{img:")) return [];
    return [...text.matchAll(TOKEN_RE)].map(m => ({ start: m.index, end: m.index + m[0].length }));
  }

  // `CanvasFind.matches`: every match in document order, each naming its
  // block and a range in the block's text. An EMPTY query finds nothing; a
  // hit never overlaps the last one (Replace All could not write both); a
  // hit touching a picture token is no match.
  function matches(blocks, query, { caseSensitive = false, wholeWord = false } = {}) {
    if (!query) return [];
    const out = [];
    const re = new RegExp(escapeRe(query), caseSensitive ? "g" : "gi");
    for (const block of blocks) {
      if (!isSearchable(block)) continue;
      const hay = block.text || "";
      if (!hay) continue;
      let from = markerLength(block);
      if (from >= hay.length) continue;
      const tokens = tokenRanges(hay);
      while (from < hay.length) {
        re.lastIndex = from;
        const m = re.exec(hay);
        if (!m) break;
        const start = m.index, end = m.index + m[0].length;
        const insideToken = tokens.some(t => t.start < end && t.end > start);
        if (!insideToken && (!wholeWord || isWholeWord(hay, start, end))) out.push({ block: block.id, start, end });
        from = Math.max(start + 1, end);
      }
    }
    return out;
  }

  // `CanvasFind.replaceAll`: the text and runs of each block that changed,
  // replaced from the BACK so an earlier match's offsets hold; the runs go
  // through `Spans.mapped` (a run wholly inside a replaced range is dropped,
  // one bracketing it takes the new text, landmine 88).
  function replaceAll(blocks, query, replacement, options = {}) {
    const hits = matches(blocks, query, options);
    const byBlock = new Map();
    for (const hit of hits) {
      if (!byBlock.has(hit.block)) byBlock.set(hit.block, []);
      byBlock.get(hit.block).push(hit);
    }
    const out = new Map();
    for (const block of blocks) {
      const ranges = byBlock.get(block.id);
      if (!ranges) continue;
      let text = block.text, runs = block.runs || [];
      for (const r of ranges.slice().sort((a, b) => b.start - a.start)) {
        runs = Spans.mapped(runs, r.start, r.end - r.start, replacement.length);
        text = text.slice(0, r.start) + replacement + text.slice(r.end);
      }
      out.set(block.id, { text, runs: Spans.normalize(runs, text.length) });
    }
    return out;
  }

  const isDrawn = block => (block.kind === "table" && !!(block.rows && block.rows.length)) || block.kind === "image";

  // `CanvasDocument.replaceAll` over a document's top-level blocks: what to
  // write (`lines` and `rows`, id to text and runs) and the report. A
  // replacement with a line break is refused whole; a replacement with a
  // TAB or a `::` is refused in a table's cells, by count, and still written
  // in the prose. `only` limits the hits to the ones it names (one Replace).
  function replaceInDocument(blocks, query, replacement, options = {}, only = null) {
    const report = { replacements: 0, refusedInCells: 0, refusedLineBreak: false, lines: new Map(), rows: new Map() };
    const flat = flattened(blocks);
    let hits = matches(flat, query, options);
    if (only) hits = hits.filter(h => h.block === only.block && h.start === only.start && h.end === only.end);
    if (!hits.length) return report;
    if (/[\n\r\u2028\u2029\u0085\u000B\u000C]/.test(replacement)) { report.refusedLineBreak = true; return report; }
    const count = new Map();
    for (const hit of hits) count.set(hit.block, (count.get(hit.block) || 0) + 1);
    const out = replaceAll(flat, query, replacement, options);
    if (only) {
      // One match: the replacement is made at that range alone.
      for (const [id] of out) if (id !== only.block) out.delete(id);
      const block = flat.find(b => b.id === only.block);
      if (block) {
        const text = block.text.slice(0, only.start) + replacement + block.text.slice(only.end);
        out.set(block.id, { text, runs: Spans.normalize(Spans.mapped(block.runs || [], only.start, only.end - only.start, replacement.length), text.length) });
      }
    }
    const breaksACell = replacement.includes("\t") || replacement.includes("::");
    for (const block of blocks) {
      const change = out.get(block.id);
      if (change && (!isDrawn(block) || block.kind === "occlusion")) {
        report.lines.set(block.id, change);
        report.replacements += count.get(block.id) || 0;
      }
      for (const row of block.rows || []) {
        const rc = out.get(row.id);
        if (!rc) continue;
        if (breaksACell) { report.refusedInCells += count.get(row.id) || 0; continue; }
        report.rows.set(row.id, rc);
        report.replacements += count.get(row.id) || 0;
      }
    }
    return report;
  }

  // `replaceNotice`: one line saying what happened, a refusal named.
  function notice(report) {
    if (report.refusedLineBreak) return "A replacement cannot contain a line break. Nothing was changed.";
    const n = report.replacements;
    const made = n === 1 ? "Replaced 1 match." : `Replaced ${n} matches.`;
    if (!report.refusedInCells) return made;
    return made + " Table cells were left alone: a replacement cannot add a column or a card.";
  }

  return { matches, replaceAll, replaceInDocument, notice, markerLength, isWholeWord, flattened, tokenRanges };
})();
