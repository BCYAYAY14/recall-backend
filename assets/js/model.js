// The document model: stored rows in, a block list out.
//
// One block is one stored note (PLAN-BLOCKS P0). Nothing about a block's
// structure is inferred from its text: the kind is a column, the shape facts
// are `attrs`, and a table's rows are the table's children (R1).

const Model = (() => {

  const LIST_KINDS = ["bullet", "dash", "numbered"];

  // A block's kind as the page reads it. CODE is gone from Recall (owner,
  // 2026-09-29): a row another device stored as `code` before then is read,
  // drawn and edited as a paragraph, and its next save writes `paragraph`.
  const kindOf = note => (!note.kind || note.kind === "code" ? "paragraph" : note.kind);

  // `note.attrs`, the typed face of the JSON blob. Keys are short because
  // the JSON rides every push.
  function decodeAttrs(json) {
    const a = { version: 0, listDepth: 0, widths: [], header: true,
                cardTable: false, mediaId: null, mediaWidth: null, crop: null, tableFontSize: null,
                checked: false, mark: null, ask: null };
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
    // `ts`: a table's own text size in Docs' points (`tableFontSize`).
    a.tableFontSize = typeof d.ts === "number" && d.ts > 0 ? d.ts : null;
    // C-72: a task's TICK and a card's GATE, both shape facts about the
    // block (the tick is not in the text because storage is prefix free, and
    // the gate cannot be read back out of the two faces).
    a.checked = d.chk === true;
    // D-191: `tg`, the trigger the line was WRITTEN with (the two faces
    // cannot say which), and `ask`, a concept's or descriptor's direction
    // from the arrow's menu. C-72's `rev` reads as `<>`; nothing writes it.
    a.mark = typeof d.tg === "string" ? d.tg : (d.rev === true ? "<>" : null);
    a.ask = typeof d.ask === "string" ? d.ask : null;
    return a;
  }

  // `Note.storedMark`: the trigger `attrs` STORES, or null (the default
  // `>>` with an answer on its line, or no card).
  function storedMark(json) {
    if (!json || (json.indexOf('"tg"') < 0 && json.indexOf('"rev"') < 0)) return null;
    return Gate.markFromText(decodeAttrs(json).mark);
  }

  // `Note.cardMark`: the trigger the two faces rejoin with, `>>` when none is
  // stored (every card a writer outside the canvas stores as two columns).
  function cardMark(json) {
    return storedMark(json) || Gate.mark(">>");
  }

  // `Note.cardAsks`: the trigger's own direction, or the menu's override for
  // a concept or a descriptor ("f", "r" or "b").
  function cardAsks(json) {
    const m = cardMark(json);
    if (!Gate.takesAskOverride(m.separator) || !json || json.indexOf('"ask"') < 0) return Gate.TRIGGERS[m.separator].asks;
    return Gate.marksAsks(m, decodeAttrs(json).ask);
  }

  // `AppDatabase.isListKind` and `listDepth`: a list item counts at its
  // `attrs.d`, anything else at -1, so a paragraph's list is every list item
  // under it (D-191's list answers).
  const isListKind = kind => kind === "bullet" || kind === "dash" || kind === "numbered";
  function listDepth(note) {
    return isListKind(note.kind) ? decodeAttrs(note.attrs).listDepth : -1;
  }

  // The text a canvas edits, in the form `Note.outlineRawText` returns.
  function rawText(note) {
    if (note.cloze_text != null) return note.cloze_text;
    const f = note.front || "";
    const b = note.back;
    if (b) {
      if (note.kind === "table") return "| " + [f, b].join("::");
      if (note.kind === "tablerow") return f + "::" + b;
      // D-191: the trigger this line was WRITTEN with, a fact about the
      // block kept in `attrs.tg` because the two faces cannot say which.
      return f + " " + cardMark(note.attrs).text + " " + b;
    }
    // A LIST-SHAPED line: its trigger ends it and the lines under it are its
    // answer, so it has no back and still owns its trigger.
    if (note.kind !== "tablerow" && storedMark(note.attrs)) return f + " " + cardMark(note.attrs).text;
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
      const kind = kindOf(r.note);
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
    return withListPrompts(withListLabels(out));
  }

  // D-191: a LIST-SHAPED line (its trigger ends it) with answer lines under
  // it, the next sibling a list item deeper than it (`listAnswerLines`),
  // draws the list arrow.
  function withListPrompts(blocks) {
    blocks.forEach((b, i) => {
      b.listWithLines = false;
      const m = Gate.markFromText(b.attrs.mark);
      if (!m || m.off || b.back || !b.front || b.isCloze || ["table", "tablerow"].includes(b.kind)) return;
      const depth = isListKind(b.kind) ? b.attrs.listDepth : -1;
      for (let k = i + 1; k < blocks.length; k++) {
        const n = blocks[k];
        if ((n.parentId || null) !== (b.parentId || null)) continue;
        b.listWithLines = isListKind(n.kind) && n.attrs.listDepth > depth;
        break;
      }
    });
    return blocks;
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
      attrsJson: row.note.attrs ?? null,
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

  // A table row's cells. A card row splits at its column separator, so a
  // header stored as one front `Term::Meaning` draws as two cells, as the
  // app draws it (review 2026-09-26, web-1); every other row is TAB separated.
  function cellsOf(rowBlock, cardTable) {
    if (cardTable) return Gate.cardCells(rowBlock.text);
    return rowBlock.text.split("\t");
  }

  function isDrawn(block) {
    return block.kind === "table" || block.kind === "image";
  }

  return { build, kindOf, decodeAttrs, rawText, ordered, indentOf, cellsOf, isDrawn,
           numberLabel, storedMark, cardMark, cardAsks, isListKind, listDepth,
           LIST_KINDS, BULLET_CYCLE, DASH_GLYPH };
})();
