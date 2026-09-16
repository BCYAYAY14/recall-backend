// Blocks to DOM.
//
// The document's own look, as the canvas draws it since v0.9 (Google Docs'
// page): an 11pt body (14.667 CSS px, because a CSS px IS the canvas's 1/96
// inch) on a 624px measure inside a 96px margin, a line height that is the
// doc's spacing times the face's natural height, the doc's own heading sizes
// and weights, ONE font for the whole doc (v0.9.7), the 26px indent step, the
// 30px number column, the 2px quote bar and the accent card dot in the
// margin. `::` stays visible in tertiary; a cloze's markers are HIDDEN and the
// hidden words carry a solid rule (v0.8.6).

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
    // C-72 (OR-4, 2026-09-16): a code line and a task. Prefix free at rest
    // like the kinds above, so this only takes a marker off a row written
    // before the strip or imported from outside.
    if (kind === "code") {
      if (text === "```") return 3;
      if (text.startsWith("``` ")) return 4;
      return text.startsWith("```") ? 3 : 0;
    }
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

  // THE CANVAS DOES NOT RENDER `$...$`. In the app, maths is literal text
  // until "Render LaTeX" turns it into a media row carrying its own `latex`
  // (P7), and "Unlatex" puts it back. A viewer that drew every dollar sign
  // as a formula would show a document the app never shows, so this is OFF
  // and the setting is one line: `Render.renderMath = true` before a draw.
  let renderMath = false;

  const CLOZE_RE = /\{\{c\d+::[\s\S]*?\}\}/g;
  const IMG_RE = /\{\{img:([^}]+)\}\}/g;
  const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/;
  const INLINE_MATH_RE = /(?<!\\)\$(\S[^$\n]*?\S|\S)\$/;

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

  // Math is rendered where KaTeX is present and left as its own source where
  // it is not, which is what the app does when a formula cannot be drawn.
  function mathNode(latex, display) {
    const node = document.createElement(display ? "div" : "span");
    if (window.katex) {
      try {
        window.katex.render(latex, node, { displayMode: display, throwOnError: false });
        return node;
      } catch (_) { /* fall through to the source */ }
    }
    node.className = "sp-c";
    node.textContent = display ? `$$${latex}$$` : `$${latex}$`;
    return node;
  }

  // One line of text as DOM: style runs, math, pictures and cloze spans.
  //
  // MATH OWNS `^` AND `*`, and cloze owns `::`, so both are found FIRST and
  // the styled text is only ever built for what is left (landmine 62's mask,
  // and `AuthoringParser.maskingCloze` for the same reason).
  function inlineDOM(text, runs, ctx) {
    const frag = document.createDocumentFragment();
    const marks = [];

    for (const m of text.matchAll(CLOZE_RE)) {
      marks.push({ start: m.index, end: m.index + m[0].length, kind: "cloze", text: m[0] });
    }
    for (const m of text.matchAll(IMG_RE)) {
      if (marks.some(x => m.index >= x.start && m.index < x.end)) continue;
      marks.push({ start: m.index, end: m.index + m[0].length, kind: "image", id: m[1] });
    }
    // Math, scanned over the parts no other mark claimed.
    let cursor = renderMath ? 0 : text.length;
    while (cursor < text.length) {
      const rest = text.slice(cursor);
      const d = DISPLAY_MATH_RE.exec(rest);
      const i = INLINE_MATH_RE.exec(rest);
      let pick = null;
      if (d && i) pick = d.index <= i.index ? { m: d, display: true } : { m: i, display: false };
      else if (d) pick = { m: d, display: true };
      else if (i) pick = { m: i, display: false };
      if (!pick) break;
      const start = cursor + pick.m.index;
      const end = start + pick.m[0].length;
      if (!marks.some(x => start < x.end && end > x.start)) {
        marks.push({ start, end, kind: "math", latex: pick.m[1], display: pick.display });
      }
      cursor = end;
    }

    marks.sort((a, b) => a.start - b.start);

    let at = 0;
    for (const mark of marks) {
      if (mark.start < at) continue;
      if (mark.start > at) {
        frag.appendChild(styledText(text.slice(at, mark.start), runs, at));
      }
      if (mark.kind === "math") {
        frag.appendChild(mathNode(mark.latex, mark.display));
      } else if (mark.kind === "image") {
        frag.appendChild(ctx.picture(mark.id, { inline: true }));
      } else {
        frag.appendChild(clozeNode(mark.text, runs, mark.start));
      }
      at = mark.end;
    }
    if (at < text.length) frag.appendChild(styledText(text.slice(at), runs, at));

    // `\$` escapes a literal dollar sign.
    return frag;
  }

  // A CLOZE SPAN IS A BLANK WHERE IT SITS (owner 2026-09-12, which reversed
  // v0.8's visible markers): `{{c1::`, a hint's `::` and `}}` are hidden, the
  // hidden words stay ink over a solid rule in the strong hairline, and a
  // hint reads after them in tertiary. `MarkdownProjection`'s
  // `clozeBlank` / `clozeHint` styles, restated.
  const CLOZE_PIECES = /^\{\{c(\d+)::([\s\S]*?)(::[^}]*)?\}\}$/;

  function clozeNode(raw, runs, offset) {
    const m = CLOZE_PIECES.exec(raw);
    const wrap = document.createElement("span");
    if (!m || !m[2]) { wrap.textContent = raw; return wrap; }
    const innerStart = raw.indexOf("::") + 2;
    const blank = document.createElement("span");
    blank.className = "cloze-blank";
    blank.appendChild(styledText(m[2], runs, offset + innerStart));
    wrap.appendChild(blank);
    if (m[3] && m[3].length > 2) {
      const hint = document.createElement("span");
      hint.className = "cloze-hint";
      hint.textContent = " " + m[3].slice(2).trim();
      wrap.appendChild(hint);
    }
    return wrap;
  }

  // The gate stays visible and is drawn tertiary, exactly as the canvas
  // paints it. Since OR-4 it is `::` or `<->` (C-72), and which one it is is
  // a fact about the NOTE (`attrs.rev`), not something the two faces can be
  // asked: `Model.rawText` rejoins with it, so this looks for the one the
  // text in hand actually carries.
  function withCardSeparator(text, runs, ctx, gate) {
    const sepText = gate || "::";
    const at = text.indexOf(sepText);
    if (at < 0) return inlineDOM(text, runs, ctx);
    const frag = document.createDocumentFragment();
    frag.appendChild(inlineDOM(text.slice(0, at), Spans.slice(runs, 0, at), ctx));
    const sep = document.createElement("span");
    sep.className = "card-sep";
    sep.textContent = sepText;
    frag.appendChild(sep);
    frag.appendChild(inlineDOM(text.slice(at + sepText.length),
                               Spans.slice(runs, at + sepText.length, text.length), ctx));
    return frag;
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

    const content = block.hasCard && !block.isCloze
      ? withCardSeparator(text, runs, ctx, block.attrs.reverse ? "<->" : "::")
      : inlineDOM(text, runs, ctx);

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
      case "code": return "code";
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
    const widths = block.attrs.widths || [];

    const rows = block.rows;
    const columns = cardTable ? 2
      : Math.max(1, ...rows.map(r => Model.cellsOf(r, false).length));

    rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      const header = block.attrs.header && index === 0;
      if (row.hasCard) tr.classList.add("card-row");
      const cells = Model.cellsOf(row, cardTable);
      for (let c = 0; c < columns; c++) {
        const cell = document.createElement(header ? "th" : "td");
        if (widths[c]) cell.style.width = Math.round(widths[c]) + "px";
        const text = cells[c] != null ? cells[c] : "";
        const start = cellOffset(cells, c, cardTable);
        cell.appendChild(inlineDOM(text,
          Spans.slice(row.runs, start, start + text.length), ctx));
        if (!text) cell.appendChild(document.createTextNode(" "));
        tr.appendChild(cell);
      }
      table.appendChild(tr);
    });

    wrap.appendChild(table);
    return wrap;
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
      node.appendChild(ctx.picture(block.attrs.mediaId, {
        noteId: block.id,
        width: block.attrs.mediaWidth,
        crop: block.attrs.crop,
      }));
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

  function docStyle(json) {
    let wire = {};
    try { wire = json ? JSON.parse(json) || {} : {}; } catch (_) { wire = {}; }
    const headings = Array.isArray(wire.h) && wire.h.length === 3
      ? wire.h.map((l, i) => ({
          size: clamp(Number(l && l.size) || STANDARD_HEADINGS[i].size, 4, 400),
          weight: clamp(Math.round(Number(l && l.weight)), 0, 3),
        }))
      : STANDARD_HEADINGS;
    const spacing = typeof wire.ls === "number" ? clamp(wire.ls, 0.8, 3) : 1.15;
    const family = typeof wire.f === "string" && wire.f.trim() ? wire.f.trim() : null;
    return { headings, spacing, family };
  }

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

  function document_(blocks, ctx) {
    const root = document.createElement("div");
    root.className = "canvas";
    applyDocStyle(root, ctx && ctx.style);
    for (const block of blocks) root.appendChild(blockDOM(block, ctx));
    return root;
  }

  return {
    document: document_, block: blockDOM, missing, hiddenMarkerLength, inlineDOM,
    docStyle, applyDocStyle, styledText,
    get renderMath() { return renderMath; },
    set renderMath(on) { renderMath = !!on; },
  };
})();
