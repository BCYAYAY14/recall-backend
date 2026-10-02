// CUT THEN PASTE KEEPS IDS AND CARDS (PLAN-BLOCKS P2d), restated from
// Recall's DocsDocument (`ClipboardBlock`, `ClipboardBlocks`,
// `markdownLine`, `clipboardSlice`) and the paste's line pairing
// (`restorePaste` over `DocsDocument.commit`). Pure: what a whole-line or
// block-set cut or copy puts on the clipboard beside its plain text, when a
// paste may use it, and where each pasted line lands; the store revives
// the rows (`Store.pasteBlock`).
//
// The payload rides beside the plain text on every whole-block cut and
// copy; a paste whose plain text IS the payload's text restores the DEAD
// rows (card, schedule and history aboard) instead of making fresh notes,
// and a live id (a copy) pastes a fresh copy keeping its kind and style.

const Clip = (() => {

  // The web's name for `ClipboardBlocks.pasteboardType` (a clipboard type
  // a browser carries between its own pages).
  const TYPE = "application/vnd.recall.blocks.v1+json";

  // `BlockKind.prefix`: what a kind serialises to at a text boundary.
  const PREFIX = { heading1: "# ", heading2: "## ", heading3: "### ", quote: "> ", bullet: "* ", dash: "- ", checkbox: "[] " };

  // `BlockKind.parse` for the kinds a marker names.
  function parseKind(line) {
    const h = /^(#{1,3}) /.exec(line);
    if (h) return ["heading1", "heading2", "heading3"][h[1].length - 1];
    if (line === ">" || line.startsWith("> ")) return "quote";
    if (/^\d+[.)]( |$)/.test(line)) return "numbered";
    if (line === "-" || line === "*" || line.startsWith("- ") || line.startsWith("* ")) return line.startsWith("-") ? "dash" : "bullet";
    if (line === "|" || line.startsWith("| ")) return "table";
    if (/^\[( |x|X)?\]( |$)/.test(line)) return "checkbox";
    return "paragraph";
  }

  // `DocsDocument.markdownLine`: a prefix-free row as MARKDOWN, carrying the
  // marker its kind implies; a row whose text already declares it (or any
  // dot point marker, for a dot point) travels as it stands.
  function markdownLine(kind, source) {
    const prefix = PREFIX[kind];
    if (!prefix) return source;
    const parsed = parseKind(source);
    if (parsed === kind) return source;
    if ((parsed === "bullet" || parsed === "dash") && (kind === "bullet" || kind === "dash")) return source;
    return prefix + source;
  }

  // One block as the clipboard carries it: its markdown line with its runs
  // shifted by the marker put back (`testStyleRidesTheMarkerShift`); a table
  // its rows as TSV, every row with its id, text and style, and its attrs.
  // `rows` are the table's row blocks; `cardTable` their gate.
  function blockOf(block, { rows = null, cardTable = false } = {}) {
    if (block.kind === "table" && rows && rows.length) {
      const tsv = rows.map(r => (cardTable ? Gate.cardCells(r.text) : r.text.split("\t")).join("\t")).join("\n");
      return { id: block.id, text: tsv, kind: "table", spans: null, attrs: block.attrsJson ?? null,
               rows: rows.map(r => ({ id: r.id, text: r.text, kind: "tablerow",
                                      spans: r.runs && r.runs.length ? Spans.encode(r.runs, r.text) : null })) };
    }
    const out = markdownLine(block.kind, block.text);
    const added = out.length - block.text.length;
    const runs = added > 0 ? (block.runs || []).map(r => ({ ...r, start: r.start + added, end: r.end + added })) : (block.runs || []);
    const item = { id: block.id, text: out, kind: block.kind, spans: runs.length ? Spans.encode(runs, out) : null };
    if (block.kind === "image") item.attrs = block.attrsJson ?? null;
    return item;
  }

  const encode = blocks => JSON.stringify(blocks);

  function decode(json) {
    let d;
    try { d = JSON.parse(json); } catch (_) { return null; }
    if (!Array.isArray(d)) return null;
    const ok = b => b && typeof b === "object" && typeof b.id === "string" && typeof b.text === "string" && typeof b.kind === "string"
      && (b.spans == null || typeof b.spans === "string") && (b.attrs == null || typeof b.attrs === "string")
      && (b.rows == null || (Array.isArray(b.rows) && b.rows.every(ok)));
    return d.every(ok) ? d : null;
  }

  // `ClipboardBlocks.usable`: the payload only when its blocks, joined by
  // newlines, ARE the text being pasted (a whole-line selection carries its
  // terminator, so one trailing newline is allowed).
  function usable(json, plainText) {
    const blocks = json ? decode(json) : null;
    if (!blocks || !blocks.length) return null;
    let text = String(plainText ?? "").replace(/\r\n?/g, "\n");
    if (text.endsWith("\n")) text = text.slice(0, -1);
    return blocks.map(b => b.text).join("\n") === text ? blocks : null;
  }

  const carriesTable = blocks => blocks.some(b => b.rows && b.rows.length);

  // WHERE A PASTE'S LINES LAND (`restorePaste` over the commit's pairing): the
  // text spliced at the caret, line `i` of it stating payload block `i`'s id
  // and kind. A PURE insert at a line's start displaces whole lines: every
  // line before the last is a new row ABOVE the caret's line, and the last
  // joins the front of it. Anything else (mid-line, or over a selection)
  // anchors at the caret's line: its text is what comes before the caret
  // plus the first line, and each later line is a new row BELOW, the last
  // carrying what came after the caret. A new row restores its stated id
  // when that row is dead and is a fresh copy when it is live; the caret's
  // line keeps its own id, and takes the kind its line states.
  //
  // `line`: the caret's line text, and the selection's start and end in it.
  // Answers `{ above: [], line: { text, kind, runsFrom }, below: [] }`, each
  // new row `{ text, block }` (`block` the payload's, or null past it).
  function plan(line, pasteText, blocks) {
    const lines = String(pasteText).replace(/\r\n?/g, "\n").split("\n");
    const n = lines.length;
    const at = i => (i < blocks.length ? blocks[i] : null);
    const before = line.text.slice(0, line.start), after = line.text.slice(line.end);
    if (line.start === line.end && line.start === 0) {
      return {
        above: lines.slice(0, n - 1).map((text, i) => ({ text, block: at(i) })),
        line: { text: lines[n - 1] + line.text, kind: at(n - 1) ? at(n - 1).kind : null, pasted: lines[n - 1], block: at(n - 1), at: 0 },
        below: [],
      };
    }
    return {
      above: [],
      line: { text: before + lines[0] + (n === 1 ? after : ""), kind: at(0) ? at(0).kind : null, pasted: lines[0], block: at(0), at: before.length },
      below: lines.slice(1).map((text, k) => ({ text: text + (k === n - 2 ? after : ""), block: at(k + 1) })),
    };
  }

  return { TYPE, PREFIX, parseKind, markdownLine, blockOf, encode, decode, usable, carriesTable, plan };
})();
