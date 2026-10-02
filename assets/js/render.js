// Blocks to DOM.
//
// The document's own look, as the canvas draws it since v0.9 (Google Docs'
// page): an 11pt body (14.667 CSS px, because a CSS px IS the canvas's 1/96
// inch) on a 624px measure inside a 96px margin, a line height that is the
// doc's spacing times the face's natural height, the doc's own heading sizes
// and weights, ONE font for the whole doc (v0.9.7), the 26px indent step, the
// 30px number column, the 2px quote bar and the accent card dot in the
// margin. A card's trigger is drawn as its chip (D-191); a cloze's markers
// are HIDDEN and the hidden words carry a solid rule (v0.8.6).

const Render = (() => {

  // ---------------------------------------------------------------- markers
  //
  // Migration v2.9 stripped the style kind prefixes from stored text, so a
  // heading, a quote and a dot point arrive prefix free. NUMBERED and TABLE
  // markers stay in the text (numbering and cells compute from them), and a
  // library written before the strip can still carry the others, so each is
  // taken off here if it is there.

  function hiddenMarkerLength(text, kind) {
    if (kind === "heading1" || kind === "heading2" || kind === "heading3") {
      const m = /^(#{1,3}) /.exec(text);
      return m ? m[1].length + 1 : 0;
    }
    if (kind === "quote") {
      if (text === ">") return 1;
      return text.startsWith("> ") ? 2 : 0;
    }
    if (kind === "table" || kind === "tablerow") {
      if (text === "|") return 1;
      return text.startsWith("| ") ? 2 : 0;
    }
    if (kind === "numbered") {
      // Digits, then "." or ")", then a space or the end of the line.
      const m = /^(\d+)([.)])( ?)/.exec(text);
      if (!m) return 0;
      if (m[3] === "" && text.length > m[0].length) return 0;
      return m[0].length;
    }
    if (kind === "bullet" || kind === "dash") {
      if (text === "-" || text === "*") return 1;
      return /^[-*] /.test(text) ? 2 : 0;
    }
    // C-72 (OR-4, 2026-09-16): a task. Prefix free at rest like the kinds
    // above, so this only takes a marker off a row written before the strip
    // or imported from outside. (Code lines are gone, owner 2026-09-29; a
    // legacy one reads as a paragraph, `Model.kindOf`.)
    if (kind === "checkbox") {
      const m = /^\[[ xX]?\]( ?)/.exec(text);
      if (!m) return 0;
      if (m[1] === "" && text.length > m[0].length) return 0;
      return m[0].length;
    }
    return 0;
  }

  // ------------------------------------------------------------ inline text
  //
  // One block's text becomes a list of pieces. Style runs, math, `{{img:}}`
  // tokens and cloze spans all live in the same string and the ranges are
  // UTF-16 offsets, which is what a JS string index already is.

  const CLOZE_RE = /\{\{c\d+::[\s\S]*?\}\}/g;
  const IMG_RE = /\{\{img:([^}]+)\}\}/g;

  // --------------------------------------------------------------- formulas
  //
  // FORMULAS RENDER ON THEIR OWN (Ink 18 R11; D-190 on the web, owner
  // 2026-09-29): in the app a typed or imported `$...$` becomes its KaTeX
  // picture once the caret leaves its line, so the page draws every formula
  // the canvas would render, with the KaTeX Recall bundles (vendored, static).
  // Never in a cloze line (`MathText.renderableSites`, `formulaSites`), never
  // money (`$5-$10`,
  // `Gate.mathRanges`), and a formula KaTeX refuses is drawn as its own
  // source, as the canvas keeps one it cannot render.

  // `MathText.delimited`: the latex inside a formula's delimiters and which
  // kind it is, or null when the text is not one delimited formula.
  function delimited(typed) {
    const t = String(typed == null ? "" : typed).replace(/^[^\S\r\n]+|[^\S\r\n]+$/g, "");
    const count = [...t].length;
    if (t.startsWith("$$") && t.endsWith("$$") && count > 4) return { latex: t.slice(2, -2), display: true };
    if (t.startsWith("$") && t.endsWith("$") && count > 2) {
      const body = t.slice(1, -1);
      return body.includes("$") ? null : { latex: body, display: false };
    }
    return null;
  }

  // Every formula one line may render, with its range, what was typed and
  // its latex. (`runs` is kept in the signature: since inline code left
  // Recall, 2026-09-29, no run keeps its dollars.)
  function formulaSites(text, runs) {
    if (!text || text.indexOf("$") < 0) return [];
    const out = [];
    for (const r of Gate.mathRanges(text)) {
      const typed = text.slice(r.start, r.end);
      const d = delimited(typed);
      if (!d || !d.latex.trim()) continue;
      out.push({ start: r.start, end: r.end, typed, latex: d.latex, display: d.display });
    }
    return out;
  }

  // A formula as KaTeX draws it; its own source (`typed`) when KaTeX refuses
  // it or is not loaded. Never throws. `trust: false` keeps `\href` and its
  // kin from making a link.
  function formulaNode(latex, display, typed) {
    const node = document.createElement("span");
    node.className = "formula" + (display ? " display" : "");
    if (window.katex) {
      try {
        window.katex.render(String(latex), node, { displayMode: !!display, throwOnError: true, trust: false, strict: "ignore" });
        return node;
      } catch (_) {
        node.textContent = "";
      }
    }
    node.className = "formula-source";
    node.textContent = typed != null ? String(typed) : (display ? `$$${latex}$$` : `$${latex}$`);
    return node;
  }

  // Every span run that covers `i`, as class names.
  function classesAt(runs, i) {
    const out = [];
    for (const r of runs) {
      if (i >= r.start && i < r.end) out.push(r);
    }
    return out;
  }

  function sameRuns(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].kind !== b[i].kind || (a[i].value || "") !== (b[i].value || "")) return false;
    }
    return true;
  }

  // A styled text node run, honouring the marker pen's stored colour.
  function styledSpan(text, runs) {
    if (!runs.length) return document.createTextNode(text);
    let node = document.createTextNode(text);
    for (const r of runs) {
      // A family run is inert (one document, one font), and drawing a span
      // for it would only add a node.
      if (r.kind === "f") continue;
      // D-011: A LINK IS AN ANCHOR, underlined in the text's own ink (the
      // accent's jobs are taken), opening in a new tab. Its href is asked of
      // `Spans.linkHref`, so a destination no writer should have stored (a
      // `javascript:` one) is drawn as its words and nothing else. Inside the
      // editor's contenteditable a click places the caret, as the canvas's.
      if (r.kind === "l") {
        const href = Spans.linkHref(r.value);
        if (!href) continue;
        const a = document.createElement("a");
        a.className = "sp-l";
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.style.color = "inherit";
        a.appendChild(node);
        node = a;
        continue;
      }
      const span = document.createElement("span");
      span.className = "sp-" + r.kind;
      if (r.kind === "z" && r.value) {
        // Docs' POINTS, drawn at 96 to the inch like the canvas.
        const points = Number(r.value);
        if (Number.isFinite(points) && points > 0) {
          span.style.fontSize = (points * 96 / 72).toFixed(3) + "px";
        }
      }
      if (r.kind === "h" && r.value) {
        // A wash, never a tint: the ink under it is unchanged, so a
        // highlight is read THROUGH.
        span.style.background = washFor(r.value);
      }
      span.appendChild(node);
      node = span;
    }
    return node;
  }

  function washFor(hex) {
    const h = String(hex).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return "";
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const dark = document.documentElement.dataset.appearance === "dark";
    return `rgba(${r},${g},${b},${dark ? 0.30 : 0.40})`;
  }

  // Text plus its runs, with the ranges the caller wants left alone (math,
  // tokens, cloze markers) already handled by the caller.
  function styledText(text, runs, offset) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;
    let start = 0;
    let current = classesAt(runs, offset);
    for (let i = 1; i <= text.length; i++) {
      const next = i < text.length ? classesAt(runs, offset + i) : null;
      if (next && sameRuns(current, next)) continue;
      frag.appendChild(styledSpan(text.slice(start, i), current));
      start = i;
      current = next || [];
    }
    return frag;
  }

  // One line of text as DOM: style runs, math, pictures and cloze spans.
  //
  // MATH OWNS `^` AND `*`, and cloze owns `::`, so both are found FIRST and
  // the styled text is only ever built for what is left (landmine 62's mask,
  // and `AuthoringParser.maskingCloze` for the same reason).
  //
  // `hideEscapes` (a document line): an escaped trigger's
  // backslash is drawn as nothing, so `\>>` reads as the words `>>` (D-191,
  // SPEC: "a backslash is written before it and hidden").
  //
  // `math` false keeps every `$` as text: a cloze line and a table cell (a
  // table is one drawn block, so the canvas renders no formula inside it).
  function inlineDOM(text, runs, ctx, hideEscapes = false, math = true) {
    const frag = document.createDocumentFragment();
    const marks = [];

    for (const m of text.matchAll(CLOZE_RE)) {
      marks.push({ start: m.index, end: m.index + m[0].length, kind: "cloze", text: m[0] });
    }
    for (const m of text.matchAll(IMG_RE)) {
      if (marks.some(x => m.index >= x.start && m.index < x.end)) continue;
      marks.push({ start: m.index, end: m.index + m[0].length, kind: "image", id: m[1] });
    }
    if (hideEscapes) {
      for (const k of Gate.escapedTriggerBackslashes(text)) {
        if (!marks.some(x => k >= x.start && k < x.end)) marks.push({ start: k, end: k + 1, kind: "hide" });
      }
    }
    // Formulas, over the parts no other mark claimed.
    if (math) {
      for (const f of formulaSites(text, runs)) {
        if (!marks.some(x => f.start < x.end && f.end > x.start)) marks.push({ ...f, kind: "math" });
      }
    }

    marks.sort((a, b) => a.start - b.start);

    let at = 0;
    for (const mark of marks) {
      if (mark.start < at) continue;
      if (mark.start > at) {
        frag.appendChild(styledText(text.slice(at, mark.start), runs, at));
      }
      if (mark.kind === "math") {
        frag.appendChild(formulaNode(mark.latex, mark.display, mark.typed));
      } else if (mark.kind === "image") {
        frag.appendChild(ctx.picture(mark.id, { inline: true }));
      } else if (mark.kind === "hide") {
        // Drawn as nothing.
      } else {
        frag.appendChild(clozeNode(mark.text, runs, mark.start));
      }
      at = mark.end;
    }
    if (at < text.length) frag.appendChild(styledText(text.slice(at), runs, at));

    // `\$` escapes a literal dollar sign.
    return frag;
  }

  // A CLOZE SPAN IS A BLANK WHERE IT SITS (owner 2026-09-12; D-191, SPEC's
  // 2026-09-28 "Cloze"): `{{c1::`, `}}`, the hint AND its `::` are hidden,
  // and the words the card hides stay ink inside a dashed box in the accent
  // (the mockup's `.cz`). The read view offers no menu, so it draws no
  // corner; the editor's blank carries its ▾.
  const CLOZE_PIECES = /^\{\{c(\d+)::([\s\S]*?)(::[^}]*)?\}\}$/;

  function clozeNode(raw, runs, offset) {
    const m = CLOZE_PIECES.exec(raw);
    const wrap = document.createElement("span");
    if (!m) { wrap.textContent = raw; return wrap; }
    if (!m[2]) return wrap;
    const innerStart = raw.indexOf("::") + 2;
    const blank = document.createElement("span");
    blank.className = "cloze-blank";
    blank.appendChild(styledText(m[2], runs, offset + innerStart));
    wrap.appendChild(blank);
    return wrap;
  }

  // THE CHIP (D-191, SPEC's 2026-09-28 flashcard model): the trigger is drawn
  // as ONE raised tile with its arrow (forward, reverse, both, list, a dashed
  // arrow for a descriptor), at 45 per cent when a `-` turned the card off;
  // a concept's term is bold and a descriptor's italic.
  //
  // THE GEOMETRY IS THE APP'S, NUMBER FOR NUMBER (`TriggerChipGeometry`,
  // Sources/Core/TriggerChipGeometry.swift): the box, the pen and each
  // arrow's strokes in its own viewBox units (open polylines, round caps and
  // joins). The read view builds the SVG from them and the editor its mask
  // (`chipMask`); test/unit/web-chip-geometry.spec.ts reads the Swift file
  // and holds these numbers and the stylesheet's box to it.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const CHIP = { height: 20, minWidth: 26, padding: 4, margin: 6, radius: 6, strokeWidth: 1.6, offOpacity: 0.45 };
  const CHIP_ICONS = {
    forward: { width: 16, height: 10, strokes: [[[1, 5], [13, 5]], [[9, 1], [13, 5], [9, 9]]], dash: [] },
    reverse: { width: 16, height: 10, strokes: [[[15, 5], [3, 5]], [[7, 1], [3, 5], [7, 9]]], dash: [] },
    both: { width: 18, height: 10, strokes: [[[4, 5], [14, 5]], [[5, 1], [1, 5], [5, 9]], [[13, 1], [17, 5], [13, 9]]], dash: [] },
    // ONE ELBOW along the line and down into the lines under it, then the head.
    list: { width: 16, height: 12, strokes: [[[1.5, 3], [9.5, 3], [11.5, 5], [11.5, 10.5]],
                                             [[8.5, 7.5], [11.5, 10.5], [14.5, 7.5]]], dash: [] },
  };
  CHIP_ICONS.descriptor = { ...CHIP_ICONS.forward, dash: [2.2, 2] };
  const CHIP_WORDS = { forward: "forward card", reverse: "reverse card", both: "two way card",
                       list: "list card", descriptor: "descriptor card" };

  const chipIcon = name => CHIP_ICONS[name] || CHIP_ICONS.forward;
  // An arrow's strokes as one SVG path (`TriggerChipGeometry.path`).
  const chipPath = name => chipIcon(name).strokes.map(s => "M" + s.map(p => p.join(" ")).join("L")).join("");
  // The chip's width: the arrow and its air, never under the minimum.
  const chipWidth = name => Math.max(CHIP.minWidth, chipIcon(name).width + 2 * CHIP.padding);
  // The arrow as a CSS image, for the editor's mask (a URL the CSP's
  // `img-src data:` allows).
  function chipMask(name) {
    const icon = chipIcon(name);
    const dash = icon.dash.length ? ` stroke-dasharray='${icon.dash.join(" ")}'` : "";
    const svg = `<svg xmlns='${SVG_NS}' viewBox='0 0 ${icon.width} ${icon.height}'><path d='${chipPath(name)}' fill='none' `
      + `stroke='black' stroke-width='${CHIP.strokeWidth}' stroke-linecap='round' stroke-linejoin='round'${dash}/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  }

  // Which arrow a line draws (`CardChipGlyph.glyph(for:asks:hasAnswerLines:)`):
  // the list arrow for `>>>`, and for a LIST-SHAPED line (its trigger ends
  // it) only once answer lines sit under it, so a `<>` typed at a line's end
  // keeps its own arrow (owner 2026-09-29); the dashed arrow for `;;`; else
  // the direction the card asks, so a concept the arrow's menu turned round
  // draws its own arrow. `asks` is `Model.cardAsks`' "f", "r" or "b".
  function chipGlyph(separator, listShaped, asks, hasAnswerLines = false) {
    if (separator === ">>>" || (listShaped && hasAnswerLines)) return "list";
    if (separator === ";;") return "descriptor";
    return asks === "r" ? "reverse" : asks === "b" ? "both" : "forward";
  }

  // The glyph a split line draws with the block's `attrs.ask`.
  function lineGlyph(split, ask, hasAnswerLines = false) {
    return chipGlyph(split.separator, split.listShaped, Gate.marksAsks(split.mark, ask), hasAnswerLines);
  }

  function chipNode(name, off) {
    const icon = chipIcon(name);
    const chip = document.createElement("span");
    chip.className = "trig" + (off ? " off" : "");
    chip.dataset.icon = name;
    chip.setAttribute("role", "img");
    chip.setAttribute("aria-label", (off ? "card off, " : "") + (CHIP_WORDS[name] || CHIP_WORDS.forward));
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(icon.width));
    svg.setAttribute("height", String(icon.height));
    svg.setAttribute("viewBox", `0 0 ${icon.width} ${icon.height}`);
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", chipPath(name));
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", String(CHIP.strokeWidth));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (icon.dash.length) path.setAttribute("stroke-dasharray", icon.dash.join(" "));
    svg.appendChild(path);
    chip.appendChild(svg);
    return chip;
  }

  // A card line as the canvas draws it: the question, the chip, the answer.
  // `hit` is the trigger `Gate.separatorHits` found in `text` (masked, so a
  // trigger inside a formula or a styled run is never the one drawn).
  function withTriggerChip(text, runs, ctx, hit, glyph, hideEscapes = false, math = true) {
    const frag = document.createDocumentFragment();
    const term = document.createElement("span");
    if (hit.separator === "::") term.className = "concept-term";
    else if (hit.separator === ";;") term.className = "descriptor-term";
    const head = text.slice(0, hit.start).replace(/[ \t]+$/, "");
    term.appendChild(inlineDOM(head, Spans.slice(runs, 0, head.length), ctx, hideEscapes, math));
    frag.appendChild(term);
    frag.appendChild(chipNode(glyph, hit.off));
    const at = hit.end + ((text.slice(hit.end).match(/^[ \t]*/) || [""])[0].length);
    frag.appendChild(inlineDOM(text.slice(at), Spans.slice(runs, at, text.length), ctx, hideEscapes, math));
    return frag;
  }

  // The trigger a block's text is a card line at, or null: never a cloze or
  // a table (a table's `::` is storage, drawn as a column).
  function triggerHit(block, text) {
    if (block.isCloze || block.kind === "table" || block.kind === "tablerow" || block.hasDiagram) return null;
    const split = Gate.splitCard(text);
    if (!split) return null;
    return Gate.separatorHits(text)[0] || null;
  }

  // ----------------------------------------------------------------- blocks

  function blockDOM(block, ctx) {
    const kind = block.kind;

    if (kind === "table") return tableDOM(block, ctx);
    if (kind === "image") return imageBlockDOM(block, ctx);

    const hidden = hiddenMarkerLength(block.text, kind);
    const text = block.text.slice(hidden);
    const runs = hidden ? Spans.slice(block.runs, hidden, block.text.length) : block.runs;

    const node = document.createElement("div");
    node.className = "blk blk-" + kindClass(kind);
    if (block.hasCard) node.classList.add("card");
    if (block.detached) node.classList.add("detached");
    node.dataset.noteId = block.id;

    if (block.drawDepth) node.style.marginLeft = `calc(${block.drawDepth} * var(--indent))`;

    const body = document.createElement(headingTag(kind) || "div");
    if (headingTag(kind)) body.className = "blk-heading";

    // A bullet's glyph is INLINE, so a wrapped line returns to the base
    // indent; a number HANGS in its own right aligned column.
    if (block.label && block.label.kind === "bullet") {
      const glyph = document.createElement("span");
      glyph.className = "marker";
      glyph.textContent = block.label.text + " ";
      body.appendChild(glyph);
    }

    // C-72: A TASK'S BOX IS DRAWN, never a character in the text, exactly as
    // the canvas draws it in the marker column. The viewer is READ ONLY, so
    // it states the tick and does not offer it.
    if (kind === "checkbox") {
      const box = document.createElement("span");
      box.className = "marker task-box";
      box.textContent = (block.attrs.checked ? "\u2611" : "\u2610") + " ";
      body.appendChild(box);
    }

    const hit = triggerHit(block, text);
    const math = !block.isCloze;
    const content = hit
      ? withTriggerChip(text, runs, ctx, hit, lineGlyph(Gate.splitCard(text), block.attrs.ask, !!block.listWithLines), true, math)
      : inlineDOM(text, runs, ctx, true, math);

    if (block.label && block.label.kind === "number") {
      const label = document.createElement("span");
      label.className = "marker";
      label.textContent = block.label.text;
      const inner = document.createElement("div");
      inner.className = "body";
      inner.appendChild(content);
      if (!text) inner.appendChild(document.createTextNode(" "));
      node.append(label, inner);
      return node;
    }

    body.appendChild(content);
    if (!text && !block.hasDiagram) body.appendChild(document.createTextNode(" "));
    node.appendChild(body);

    // A MIXED BLOCK: the prompt is ordinary text and the diagram it asks
    // about is the one anchor after it (P7, R2). The note's text never names
    // the picture, so it is asked for by note.
    if (block.hasDiagram) {
      for (const mediaId of ctx.diagramsFor(block.id)) {
        node.appendChild(ctx.picture(mediaId, { noteId: block.id }));
      }
    }
    return node;
  }

  function kindClass(kind) {
    switch (kind) {
      case "heading1": return "h1";
      case "heading2": return "h2";
      case "heading3": return "h3";
      case "quote": return "quote";
      case "bullet": return "bullet";
      case "dash": return "bullet";
      case "numbered": return "number";
      case "occlusion": return "occlusion-block";
      case "checkbox": return "task";
      default: return "p";
    }
  }

  function headingTag(kind) {
    return kind === "heading1" ? "h1" : kind === "heading2" ? "h2"
         : kind === "heading3" ? "h3" : null;
  }

  // A table is a parent note whose rows are its children (R1). The header is
  // the ONE weighted row: no fill and no colour, because a table is
  // structure and the rules are what separate it from the prose around it.
  function tableDOM(block, ctx) {
    const wrap = document.createElement("div");
    wrap.className = "blk blk-table";
    wrap.dataset.noteId = block.id;
    const table = document.createElement("table");
    const cardTable = block.attrs.cardTable;

    const rows = block.rows;
    const columns = cardTable ? 2
      : Math.max(1, ...rows.map(r => Model.cellsOf(r, false).length));
    // A table drawn at widths a person stored (a column drag) keeps them,
    // fitted into the measure (`TableBlock.fit`); anything else is content
    // sized. Its text size is its own (`ts`), else the document's.
    const widths = tableWidths(block, columns, MEASURE);
    if (widths) {
      table.classList.add("fixed");
      table.style.width = widths.reduce((a, w) => a + w, 0).toFixed(2) + "px";
    }
    if (block.attrs.tableFontSize) table.style.fontSize = (block.attrs.tableFontSize * 96 / 72).toFixed(3) + "px";

    rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      const header = block.attrs.header && index === 0;
      if (row.hasCard) tr.classList.add("card-row");
      const cells = Model.cellsOf(row, cardTable);
      for (let c = 0; c < columns; c++) {
        const cell = document.createElement(header ? "th" : "td");
        if (widths && index === 0) cell.style.width = widths[c].toFixed(2) + "px";
        const text = cells[c] != null ? cells[c] : "";
        const start = cellOffset(cells, c, cardTable);
        // D-189: the cell's own runs, clipped at its edges (a run never
        // crosses a cell, `Spans.clipToCells`).
        cell.appendChild(inlineDOM(text,
          Spans.slice(row.runs, start, start + text.length), ctx, false, false));
        if (!text) cell.appendChild(document.createTextNode(" "));
        tr.appendChild(cell);
      }
      table.appendChild(tr);
    });

    wrap.appendChild(table);
    return wrap;
  }

  // The canvas's measure in CSS px (`CanvasTypography.measure`).
  const MEASURE = 624;

  // A table's drawn column widths: its stored ones (`w`), fitted into
  // `available`, when they still describe it (one per column, each
  // positive), else null for content sizing (`CanvasTableLayout`).
  function tableWidths(block, columns, available) {
    const stored = block.attrs.widths || [];
    return Geometry.hasStoredWidths(stored, columns) ? Geometry.fit(stored, available) : null;
  }

  // Where a cell's text starts inside the row's own text, so its style runs
  // can be rebased. A card row's separator is `::`; every other row's is TAB.
  function cellOffset(cells, index, cardTable) {
    let at = 0;
    for (let i = 0; i < index && i < cells.length; i++) {
      at += (cells[i] || "").length + (cardTable ? 2 : 1);
    }
    return at;
  }

  // A block PICTURE: the whole content is one media row and `attrs` names it.
  function imageBlockDOM(block, ctx) {
    const node = document.createElement("div");
    node.className = "blk blk-image";
    node.dataset.noteId = block.id;
    if (block.attrs.mediaId) {
      // Drawn at the MEDIA ROW's width (`media.display_width`), the one the
      // canvas reads; `attrs.mw` is read by nothing in the app.
      node.appendChild(ctx.picture(block.attrs.mediaId, { noteId: block.id }));
    } else {
      node.appendChild(missing("This picture has no media row."));
    }
    return node;
  }

  function missing(text) {
    const node = document.createElement("span");
    node.className = "missing";
    node.textContent = text;
    return node;
  }

  // ------------------------------------------------------------ doc style
  //
  // `notebook.style`, the doc's own text styles (Sources/Core/DocStyle.swift):
  // `h` three heading levels in POINTS with a weight 0..3, `ls` the line
  // spacing multiple, `f` the doc's one font. Anything missing is the app's
  // standard; the owner's Settings defaults live on each device and do not
  // sync, so the standard is what a browser can know.
  const STANDARD_HEADINGS = [{ size: 18, weight: 3 }, { size: 15, weight: 2 },
                             { size: 13, weight: 1 }];
  const WEIGHTS = [400, 500, 600, 700];

  // A doc's style: what the doc stored (`DocStyle`), else the library's
  // defaults (`defaults`: the settings lane's `heading_styles`,
  // `line_spacing` and `font_family`, when the caller has a library), else
  // the standard. A doc has ONE font.
  function docStyle(json, defaults) {
    let wire = {};
    try { wire = json ? JSON.parse(json) || {} : {}; } catch (_) { wire = {}; }
    const d = defaults || {};
    const levels = list => list.map((l, i) => ({
      size: clamp(Number(l && l.size) || STANDARD_HEADINGS[i].size, 4, 400),
      weight: clamp(Math.round(Number(l && l.weight)), 0, 3),
    }));
    let libraryHeadings = null;
    try {
      const parsed = d.headingStyles ? JSON.parse(d.headingStyles) : null;
      if (Array.isArray(parsed) && parsed.length === 3) libraryHeadings = levels(parsed);
    } catch (_) { libraryHeadings = null; }
    const headings = Array.isArray(wire.h) && wire.h.length === 3 ? levels(wire.h) : (libraryHeadings || STANDARD_HEADINGS);
    const librarySpacing = Number(d.lineSpacing);
    const spacing = typeof wire.ls === "number" ? clamp(wire.ls, 0.8, 3)
      : Number.isFinite(librarySpacing) && librarySpacing > 0 ? clamp(librarySpacing, 0.8, 3) : 1.15;
    const family = typeof wire.f === "string" && wire.f.trim() ? wire.f.trim()
      : typeof d.fontFamily === "string" && d.fontFamily.trim() ? d.fontFamily.trim() : null;
    const language = typeof wire.lang === "string" && wire.lang.trim() ? wire.lang.trim() : null;
    return { headings, spacing, family, language, own: { h: Array.isArray(wire.h), ls: typeof wire.ls === "number", f: typeof wire.f === "string" && !!wire.f, lang: !!language } };
  }

  const STANDARD = () => STANDARD_HEADINGS.map(l => ({ ...l }));

  function clamp(v, lo, hi) {
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
  }

  // The three named families the format bar offers, each with a fallback a
  // machine without it can draw, and any other family (an added font, loaded
  // by app.js) ahead of the system stack.
  function fontStack(family) {
    switch (family) {
      case "Arial": return 'Arial, "Helvetica Neue", Helvetica, sans-serif';
      case "Calibri": return 'Calibri, Carlito, "Segoe UI", sans-serif';
      case "Times New Roman": return '"Times New Roman", Times, serif';
      default:
        return family ? `"${family.replace(/["\\]/g, "")}", var(--font)` : "var(--font)";
    }
  }

  // The style as CSS custom properties on the canvas, which is all the
  // stylesheet reads.
  function applyDocStyle(node, style) {
    const s = style || docStyle(null);
    node.style.setProperty("--doc-font", fontStack(s.family));
    node.style.setProperty("--spacing", String(s.spacing));
    s.headings.forEach((l, i) => {
      node.style.setProperty(`--h${i + 1}-size`, (l.size * 96 / 72).toFixed(3) + "px");
      node.style.setProperty(`--h${i + 1}-weight`, String(WEIGHTS[l.weight] || 700));
    });
  }

  // ------------------------------------------------------------ A4 pages
  //
  // PAGE LAYOUT (PLAN-BETA-0.6 K1, Settings > Text, `page_layout`, off by
  // default): pages are a VIEW of the canvas. Nothing is measured again; a
  // block that would straddle a page's end (or starts in its gutter) moves
  // to the next page's top, a block taller than a page stays where it is,
  // and each page's foot is ONE hairline across the measure in the third
  // ink at 35 per cent, with no page numbers and no paper edges
  // (`drawPageBreaks`). The canvas pushes a line FRAGMENT; a web block moves
  // whole, so a paragraph that would wrap across a page's end starts the
  // next page. Drawn and undrawn in place, so a line being typed in keeps
  // its caret.
  function paginate(canvas, on) {
    for (const old of [...canvas.querySelectorAll(":scope > .page-gap, :scope > .page-rule")]) old.remove();
    canvas.classList.toggle("paged", !!on);
    if (!on) return;
    const page = Geometry.a4();
    const base = () => canvas.getBoundingClientRect().top;
    for (const el of [...canvas.children]) {
      if (el.classList.contains("page-gap") || el.classList.contains("page-rule")) continue;
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      const top = r.top - base();
      const y = Geometry.push(page, top, r.height);
      if (y == null) continue;
      const gap = document.createElement("div");
      gap.className = "page-gap";
      gap.setAttribute("aria-hidden", "true");
      gap.style.height = (y - top).toFixed(2) + "px";
      canvas.insertBefore(gap, el);
      // A spacer keeps two margins from collapsing into one; what that
      // moved is taken back, so the block's top is the page's.
      const off = el.getBoundingClientRect().top - base() - y;
      if (Math.abs(off) > 0.5) gap.style.height = Math.max(0, y - top - off).toFixed(2) + "px";
    }
    const height = canvas.getBoundingClientRect().height;
    for (const y of Geometry.gutters(page, 0, height)) {
      const rule = document.createElement("div");
      rule.className = "page-rule";
      rule.setAttribute("aria-hidden", "true");
      rule.style.top = y + "px";
      canvas.appendChild(rule);
    }
  }

  function document_(blocks, ctx) {
    const root = document.createElement("div");
    root.className = "canvas";
    applyDocStyle(root, ctx && ctx.style);
    for (const block of blocks) root.appendChild(blockDOM(block, ctx));
    return root;
  }

  return {
    document: document_, block: blockDOM, missing, hiddenMarkerLength, inlineDOM,
    docStyle, applyDocStyle, styledText, fontStack, STANDARD, WEIGHTS, chipNode, chipGlyph, lineGlyph,
    CHIP, CHIP_ICONS, chipPath, chipWidth, chipMask,
    delimited, formulaSites, formulaNode, tableWidths, MEASURE, paginate,
  };
})();
