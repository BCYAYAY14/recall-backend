// The document model: stored rows in, a block list out.
//
// One block is one stored note (PLAN-BLOCKS P0). Nothing about a block's
// structure is inferred from its text: the kind is a column, the shape facts
// are `attrs`, and a table's rows are the table's children (R1).

const Model = (() => {

  const LIST_KINDS = ["bullet", "dash", "numbered"];

  // `note.attrs`, the typed face of the JSON blob. Keys are short because
  // the JSON rides every push.
  function decodeAttrs(json) {
    const a = { version: 0, listDepth: 0, widths: [], header: true,
                cardTable: false, mediaId: null, mediaWidth: null, crop: null,
                checked: false, reverse: false };
    if (!json) return a;
    let d;
    try { d = JSON.parse(json); } catch (_) { return a; }
    if (!d || typeof d !== "object") return a;
    a.version = typeof d.v === "number" ? d.v : 0;
    a.listDepth = typeof d.d === "number" ? d.d : 0;
    a.widths = Array.isArray(d.w) ? d.w.filter(n => typeof n === "number") : [];
    a.header = typeof d.hdr === "boolean" ? d.hdr : true;
    // `c` is the pre rewrite spelling of the card table flag.
    a.cardTable = typeof d.card === "boolean" ? d.card
                : typeof d.c === "boolean" ? d.c : false;
    a.mediaId = typeof d.m === "string" ? d.m : null;
    a.mediaWidth = typeof d.mw === "number" ? d.mw : null;
    a.crop = Array.isArray(d.crop) ? d.crop.filter(n => typeof n === "number") : null;
    // C-72: a task's TICK and a card's GATE, both shape facts about the
    // block (the tick is not in the text because storage is prefix free, and
    // the gate cannot be read back out of the two faces).
    a.checked = d.chk === true;
    a.reverse = d.rev === true;
    return a;
  }

  // The text a canvas edits, in the form `Note.outlineRawText` returns.
  function rawText(note) {
    if (note.cloze_text != null) return note.cloze_text;
    const f = note.front || "";
    const b = note.back;
    if (b) {
      if (note.kind === "table") return "| " + [f, b].join("::");
      if (note.kind === "tablerow") return f + "::" + b;
      // C-72: the gate this line was WRITTEN with. A `<->` note stores its
      // two faces exactly as a `::` note does, so the rejoin has to read
      // `attrs.rev` or the viewer shows a document the app does not.
      return f + " " + (decodeAttrs(note.attrs).reverse ? "<->" : "::") + " " + b;
    }
    return f;
  }

  // Document order, as `AppDatabase.outlineRows` computes it: a pre order
  // walk whose siblings sort by position, then created_at, then the id's
  // lowercase hex. A row whose parent is not live is a root.
  function ordered(notes) {
    const live = notes.filter(n => n.deleted_at == null);
    const byId = new Map(live.map(n => [n.id, n]));
    const kids = new Map();
    const roots = [];
    for (const n of live) {
      if (n.parent_id && byId.has(n.parent_id)) {
        if (!kids.has(n.parent_id)) kids.set(n.parent_id, []);
        kids.get(n.parent_id).push(n);
      } else {
        roots.push(n);
      }
    }
    const key = n => [
      String(n.position ?? 0).padStart(12, "0"),
      n.created_at || "",
      String(n.id || "").toLowerCase().replace(/-/g, ""),
    ].join(".");
    const sort = list => list.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    const out = [];
    const walk = (list, depth) => {
      for (const n of sort(list)) {
        if (depth > 64) return;
        out.push({ note: n, depth });
        const k = kids.get(n.id);
        if (k) walk(k, depth + 1);
      }
    };
    walk(roots, 0);
    return out;
  }

  // The block list. `cards` maps note id to { live, detached }; `diagrams`
  // is the set of note ids that own a media row carrying occlusion regions,
  // which is the honest test for a block picture (landmine 104).
  function build(notes, cards, diagrams) {
    const rows = ordered(notes);
    const tables = new Set(rows.filter(r => r.note.kind === "table").map(r => r.note.id));
    const kidsOf = new Map();
    for (const r of rows) {
      if (!r.note.parent_id) continue;
      if (!kidsOf.has(r.note.parent_id)) kidsOf.set(r.note.parent_id, []);
      kidsOf.get(r.note.parent_id).push(r);
    }
    const out = [];
    for (const r of rows) {
      const kind = r.note.kind || "paragraph";
      // Absorbed above, into the table that owns it.
      if (kind === "tablerow" && r.note.parent_id && tables.has(r.note.parent_id)) continue;
      const block = makeBlock(r, kind, cards);
      block.hasDiagram = diagrams.has(r.note.id);
      if (kind === "table") {
        block.rows = (kidsOf.get(r.note.id) || [])
          .filter(k => k.note.kind === "tablerow")
          .map(k => makeBlock(k, "tablerow", cards));
      }
      out.push(block);
    }
    return withListLabels(out);
  }

  function makeBlock(row, kind, cards) {
    const text = rawText(row.note);
    const card = cards.get(row.note.id);
    return {
      id: row.note.id,
      kind,
      text,
      runs: Spans.decode(row.note.spans, text),
      attrs: decodeAttrs(row.note.attrs),
      parentId: row.note.parent_id || null,
      structureDepth: row.depth,
      hasCard: !!card,
      detached: !!(card && card.detached),
      isCloze: row.note.cloze_text != null,
      clozeText: row.note.cloze_text,
      occMode: row.note.occ_mode === "all" ? "all" : "one",
      hasDiagram: false,
      rows: [],
      front: row.note.front || "",
      back: row.note.back || "",
      noteId: row.note.id,
      updatedAt: row.note.updated_at,
    };
  }

  // What the renderer indents by: a list item's `attrs.d`, else the
  // structural depth (R8, spent in CanvasSource.Line.indent).
  function indentOf(block) {
    return LIST_KINDS.includes(block.kind) ? block.attrs.listDepth : block.structureDepth;
  }

  // Google Docs' bullet cycle by depth: disc, hollow circle, filled square
  // (E22). A DASH list stays a dash at every depth: a different KIND of
  // list, not a different level of the same one (E23).
  const BULLET_CYCLE = ["•", "◦", "▪"];
  const DASH_GLYPH = "-";

  // `1.` then `a.` then `i.`, cycling (E25).
  function numberLabel(n, depth) {
    switch (((depth % 3) + 3) % 3) {
      case 1: return alpha(n) + ".";
      case 2: return roman(n) + ".";
      default: return n + ".";
    }
  }

  function alpha(n) {
    let s = "";
    let v = Math.max(1, n);
    while (v > 0) {
      const r = (v - 1) % 26;
      s = String.fromCharCode(97 + r) + s;
      v = Math.floor((v - 1) / 26);
    }
    return s;
  }

  function roman(n) {
    const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"],
                   [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"],
                   [5, "v"], [4, "iv"], [1, "i"]];
    let v = Math.max(1, n), s = "";
    for (const [value, mark] of table) {
      while (v >= value) { s += mark; v -= value; }
    }
    return s;
  }

  // The label and the DRAWN depth of every block.
  //
  // Numbering is computed over the whole document rather than stored, which
  // is the whole of E24: inserting a line renumbers nothing on disk. The
  // counters are keyed by the line's own indent; a non list line ends every
  // run. The drawn depth is measured from the run's outermost item, so only
  // list items indent and a list indents inside itself (CanvasIndent, owner
  // ruling 2026-09-06 G1).
  function withListLabels(blocks) {
    const counters = new Map();
    let base = null;
    for (const block of blocks) {
      const indent = Math.max(0, indentOf(block));
      const isList = LIST_KINDS.includes(block.kind);
      // A line at depth d ends every run deeper than d, whatever kind it is.
      for (const key of [...counters.keys()]) {
        if (key > indent) counters.delete(key);
      }
      if (!isList) {
        counters.delete(indent);
        base = null;
        block.drawDepth = 0;
        block.label = null;
        continue;
      }
      if (base == null) base = indent;
      block.drawDepth = Math.max(0, indent - base);
      if (block.kind === "numbered") {
        counters.set(indent, (counters.get(indent) || 0) + 1);
        block.label = { kind: "number", text: numberLabel(counters.get(indent), indent) };
      } else {
        counters.delete(indent);
        block.label = {
          kind: "bullet",
          text: block.kind === "dash" ? DASH_GLYPH : BULLET_CYCLE[indent % BULLET_CYCLE.length],
        };
      }
    }
    return blocks;
  }

  // A table row's cells. A card row's separator is the card gate; every
  // other row is TAB separated.
  function cellsOf(rowBlock, cardTable) {
    if (cardTable) return [rowBlock.front, rowBlock.back];
    return rowBlock.text.split("\t");
  }

  function isDrawn(block) {
    return block.kind === "table" || block.kind === "image";
  }

  return { build, decodeAttrs, rawText, ordered, indentOf, cellsOf, isDrawn,
           numberLabel, LIST_KINDS, BULLET_CYCLE, DASH_GLYPH };
})();
