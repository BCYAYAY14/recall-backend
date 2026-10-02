// The web's document editor (PLAN-BETA-0.12 section 26, W-5 and W-7).
//
// One block is one stored note (PLAN-BLOCKS P0), so the page is a column of
// blocks and each text block is its own editable line:
//  - a TEXT line (paragraph, the three headings, quote, the three lists, a
//    task, an occlusion note's prompt) is a contenteditable
//    element that draws its inline style from `note.spans` and reads text and
//    runs back from what the browser holds, so bold stays bold while typing.
//    Enter splits the line into a new note, Backspace on an empty line
//    removes it, Backspace at the start demotes a heading or a list line or
//    merges into the line above; a typed `# `, `- `, `* `, `1. `, `[] ` or
//    `> ` declares the kind; a trigger (`>>`, `<<`, `<>`, `::`, `;;`,
//    `>>>`, D-191) makes a card and draws as its chip, and a `{{c1::...}}` a
//    cloze, on commit, through the app's own gate;
//  - a TABLE is a grid of editable cells over its `tablerow` notes (R1), with
//    rows and columns added and removed;
//  - a PICTURE, a DRAWING and a DIAGRAM draw as they do on the page, with a
//    bar to size, edit or delete them.
// A line commits 700 ms after the last key and when it loses focus, as whole
// note and card rows with the style mapped onto what the store holds
// (Store.saveLine). The browser's own spell checker runs in every line, in
// the doc's language when it has one.

const Editor = (() => {

  const { h, clear, chip } = UI;
  const MARKERS = { bullet: "•", dash: "–" };
  const TEXT_KINDS = ["paragraph", "heading1", "heading2", "heading3", "quote", "bullet", "dash",
                      "numbered", "checkbox"];
  // A link (`l`) is a SPAN here, underlined in the text's own ink as the read
  // view draws it, never an anchor: a click in the editor places the caret.
  // `n` is underline (D-189), drawn with a strike or a link where both apply.
  const STYLE_CLASS = { b: "sp-b", i: "sp-i", s: "sp-s", h: "sp-h", p: "sp-p", u: "sp-u", l: "sp-l", n: "sp-n" };
  // The inline style keys, a line's and a cell's: ⌘B, ⌘I, ⌘U (D-189), ⌘.
  // and ⌘, then ⇧⌘X and ⇧⌘H. (⌘E, inline code, is gone with code, owner
  // 2026-09-29.)
  const SHORTCUTS = { b: "b", i: "i", u: "n", ".": "p", ",": "u" };
  const SHIFT_SHORTCUTS = { x: "s", h: "h" };
  // What a screen reader calls each line (review 2026-09-26, web-18).
  const KIND_LABEL = { paragraph: "Text", heading1: "Heading 1", heading2: "Heading 2", heading3: "Heading 3",
                       quote: "Quote", bullet: "Bulleted item", dash: "Dashed item", numbered: "Numbered item",
                       checkbox: "Task", occlusion: "Diagram prompt" };

  // What a line SHOWS: its text without the marker its kind draws. A
  // numbered line's `N. ` rides the stored text (E24) and is hidden too: the
  // number drawn is COMPUTED from paragraph order, `1.` `a.` `i.` by depth,
  // as the canvas draws it (D-190), and a commit puts the stored marker back.
  function displayText(block) {
    return block.text.slice(Render.hiddenMarkerLength(block.text, block.kind));
  }

  function displayRuns(block) {
    const cut = Render.hiddenMarkerLength(block.text, block.kind);
    return cut ? Spans.slice(block.runs, cut, block.text.length) : block.runs;
  }

  // The `N. ` a numbered note stores, to put back in front of what it shows.
  function storedNumber(note) {
    const m = /^(\d+[.)] ?)/.exec((note && note.front) || "");
    return m ? m[1] : "1. ";
  }

  // ------------------------------------------------------------ the DOM

  // Text with its runs as nodes: one span per stretch of the same styles,
  // each span naming its styles in `data-k` so they can be read back. An
  // item is `kind` or `kind=value` with the value percent encoded, so a
  // link's address keeps every `=` and `|` it carries (D-152).
  //
  // `decos` are DRAWN ranges derived from the text and never read back (no
  // `data-k`): D-191's chip over a trigger's characters, a concept's bold
  // term and a descriptor's italic one, the characters a line HIDES (a cloze
  // span's `{{cN::`, hint and `}}`, an escaped trigger's backslash) and a
  // blank's box. A `group` deco (the box) is ONE element holding every piece
  // of its range, so a styled word inside a blank is still one box.
  //
  // `formulas` (a line's FACE, D-190) are drawn by KaTeX in place of their
  // source, each one element naming its source range in `data-start` and
  // `data-end`; the editable line itself is never painted with one.
  function paint(el, text, runs, decos = [], formulas = []) {
    clear(el);
    const cuts = new Set([0, text.length]);
    const clampTo = v => Math.max(0, Math.min(text.length, v));
    for (const r of runs) { cuts.add(clampTo(r.start)); cuts.add(clampTo(r.end)); }
    for (const d of decos) { cuts.add(clampTo(d.start)); cuts.add(clampTo(d.end)); }
    for (const f of formulas) { cuts.add(clampTo(f.start)); cuts.add(clampTo(f.end)); }
    const points = [...cuts].sort((a, b) => a - b);
    let group = null, groupNode = null, formula = null;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (b <= a) continue;
      const on = runs.filter(r => r.start <= a && r.end >= b);
      const drawn = decos.filter(d => !d.group && d.start <= a && d.end >= b);
      const box = decos.find(d => d.group && d.start <= a && d.end >= b) || null;
      let into = el;
      if (box) {
        if (box !== group) {
          group = box;
          groupNode = document.createElement("span");
          for (const c of box.className.split(" ")) if (c) groupNode.classList.add(c);
          if (box.blank != null) groupNode.dataset.blank = String(box.blank);
          if (box.label) groupNode.setAttribute("aria-label", box.label);
          el.appendChild(groupNode);
        }
        into = groupNode;
      }
      const f = formulas.find(x => x.start <= a && x.end >= b) || null;
      if (f) {
        if (f !== formula) {
          formula = f;
          const node = Render.formulaNode(f.latex, f.display, f.typed);
          node.dataset.start = String(f.start);
          node.dataset.end = String(f.end);
          into.appendChild(node);
        }
        continue;
      }
      const piece = text.slice(a, b);
      if (!on.length && !drawn.length) { into.appendChild(document.createTextNode(piece)); continue; }
      const span = document.createElement("span");
      if (on.length) span.dataset.k = on.map(r => (r.value != null ? `${r.kind}=${encodeURIComponent(r.value)}` : r.kind)).join("|");
      for (const r of on) {
        if (STYLE_CLASS[r.kind]) span.classList.add(STYLE_CLASS[r.kind]);
        if (r.kind === "h" && r.value) span.style.backgroundColor = hexWash(r.value);
        if (r.kind === "z" && r.value) span.style.fontSize = (Number(r.value) * 96 / 72).toFixed(2) + "px";
      }
      for (const d of drawn) {
        for (const c of d.className.split(" ")) if (c) span.classList.add(c);
        if (d.icon) {
          // The arrow and the box are the app's (`TriggerChipGeometry`,
          // through `Render`), one statement for the read view and here.
          span.dataset.icon = d.icon;
          span.style.setProperty("--chip-icon", Render.chipMask(d.icon));
          const icon = Render.CHIP_ICONS[d.icon] || Render.CHIP_ICONS.forward;
          span.style.setProperty("--chip-size", `${icon.width}px ${icon.height}px`);
          span.style.setProperty("--chip-w", `${Render.chipWidth(d.icon)}px`);
        }
        if (d.label) span.setAttribute("aria-label", d.label);
      }
      span.textContent = piece;
      into.appendChild(span);
    }
    if (!text) el.appendChild(document.createElement("br"));
    el.dataset.deco = decoKey(decos);
  }

  const decoKey = decos => decos.map(d => `${d.start}-${d.end}-${d.className}-${d.icon || ""}`).join(",");

  // A hidden character's element, or a blank's box.
  const HIDDEN = ".cz-hide, .trig-esc";
  const hiddenNode = node => { const p = node.parentElement; return !!(p && p.closest(HIDDEN)); };

  // Whether the DOM still draws what `decos` say: every hidden range and
  // every box holds exactly its characters. The browser can type INTO a
  // hidden element (a character after a blank's `}}` lands inside it), and
  // then the line is painted again.
  function drawnMatches(el, decos) {
    const merge = list => {
      const out = [];
      for (const x of list.sort((p, q) => p.start - q.start)) {
        const last = out[out.length - 1];
        if (last && last.tag === x.tag && last.end === x.start) last.end = x.end;
        else out.push({ ...x });
      }
      return out.map(x => `${x.tag}:${x.start}-${x.end}`).join(",");
    };
    const want = decos.filter(d => d.group || d.className === "cz-hide" || d.className.split(" ").includes("trig-esc"))
      .map(d => ({ tag: d.group ? "b" + d.blank : "h", start: d.start, end: d.end }));
    const got = [];
    let pos = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const start = pos;
      pos += n.data.length;
      if (!n.data.length) continue;
      const p = n.parentElement;
      const box = p && p.closest(".cz");
      const tag = hiddenNode(n) ? "h" : box && el.contains(box) ? "b" + box.dataset.blank : null;
      if (tag) got.push({ tag, start, end: pos });
    }
    return merge(want) === merge(got);
  }

  // D-191: what a line's text DRAWS beyond its runs. A card line (never a
  // cloze or a diagram's prompt) draws its trigger as the chip,
  // its arrow the one `Render.lineGlyph` picks from the block's `ask`, and
  // its term bold (a concept) or italic (a descriptor).
  const CHIP_WORDS = { forward: "forward card", reverse: "reverse card", both: "two way card",
                       list: "list card", descriptor: "descriptor card" };
  //
  // D-191: A CLOZE BLANK SHOWS ONLY ITS WORDS (SPEC's 2026-09-28 "Cloze";
  // `MarkdownProjection` hides `{{cN::`, `}}`, and the hint with its `::`),
  // in a dashed box whose ▾ corner opens the blank's menu. AN ESCAPED
  // TRIGGER'S BACKSLASH IS HIDDEN, so `\>>` reads as the words `>>`. Both stay
  // in the text, as the canvas keeps them.
  function hiddenParts(text, kind) {
    const out = [];
    Gate.clozeSpans(text).forEach((s, index) => {
      out.push({ start: s.open.start, end: s.open.end, whole: s.whole });
      if (s.hintMark) out.push({ start: s.hintMark.start, end: (s.hint || s.hintMark).end, whole: s.whole });
      out.push({ start: s.close.start, end: s.close.end, whole: s.whole, blank: index });
    });
    for (const k of Gate.escapedTriggerBackslashes(text)) {
      const len = text.startsWith(">>>", k + 1) ? 3 : 2;
      out.push({ start: k, end: k + 1, whole: { start: k, end: k + 1 + len }, escape: true });
    }
    return out;
  }

  //
  // `answers`: a list-shaped line has answer lines under it, so its chip is
  // the list arrow (`CanvasDocument.listPromptHasAnswer`). `held`: the caret
  // the last keystroke left in this line; a trigger ending there with no
  // space after it is drawn as the characters typed (`triggerAwaitingSpace`).
  function decorations(text, kind, { diagram = false, ask = null, answers = false, held = null } = {}) {
    const out = [];
    Gate.clozeSpans(text).forEach((s, index) => {
      if (s.inner.end > s.inner.start) out.push({ start: s.inner.start, end: s.inner.end, className: "cz", group: true, blank: index });
    });
    for (const p of hiddenParts(text, kind)) out.push({ start: p.start, end: p.end, className: p.escape ? "trig-esc" : "cz-hide" });
    if (diagram || !Gate.mayCarrySeparator(text) || Gate.clozeOrdinals(text).length) return out;
    const split = Gate.splitCard(text);
    const hits = Gate.separatorHits(text);
    if (split && hits.length && !(held != null && CardLine.triggerAwaitingSpace(text, held))) {
      const hit = hits[0];
      const icon = Render.lineGlyph(split, ask, answers);
      out.push({ start: hit.start, end: hit.end, className: "trig-text" + (hit.off ? " off" : ""), icon,
                 label: (hit.off ? "card off, " : "") + CHIP_WORDS[icon] });
      const head = text.slice(0, hit.start).replace(/[ \t]+$/, "");
      const lead = head.length - head.replace(/^[ \t]+/, "").length;
      if (hit.separator === "::" && head.length > lead) out.push({ start: lead, end: head.length, className: "concept-term" });
      if (hit.separator === ";;" && head.length > lead) out.push({ start: lead, end: head.length, className: "descriptor-term" });
    }
    return out;
  }

  function hexWash(hex) {
    const v = parseInt(String(hex).replace("#", ""), 16);
    if (!Number.isFinite(v)) return "";
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, 0.42)`;
  }

  // What the browser holds, as text and runs. A no-break space the browser
  // put in for a typed space is a space.
  function read(el) {
    let text = "";
    const runs = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const piece = node.data.replace(/\u00A0/g, " ").replace(/[\r\n]/g, " ");
      if (!piece) continue;
      const start = text.length;
      text += piece;
      let p = node.parentNode;
      while (p && p !== el) {
        if (p.dataset && p.dataset.k) {
          for (const item of p.dataset.k.split("|")) runs.push({ start, end: text.length, ...styleItem(item) });
          break;
        }
        p = p.parentNode;
      }
    }
    return { text, runs: Spans.normalize(runs, text.length) };
  }

  // One `data-k` item: the kind, then everything after the FIRST `=`,
  // decoded. A value that does not decode is taken as written.
  function styleItem(item) {
    const at = item.indexOf("=");
    if (at < 0) return { kind: item, value: null };
    const raw = item.slice(at + 1);
    let value = raw;
    try { value = decodeURIComponent(raw); } catch (_) { /* taken as written */ }
    return { kind: item.slice(0, at), value };
  }

  // The caret and the selection as offsets into the line's text: the text
  // of a range from the line's start to the point.
  function offsetOf(el, node, offset) {
    const r = document.createRange();
    r.selectNodeContents(el);
    try { r.setEnd(node, offset); } catch (_) { return 0; }
    return r.toString().length;
  }

  function selectionIn(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
    const a = offsetOf(el, r.startContainer, r.startOffset);
    const b = offsetOf(el, r.endContainer, r.endOffset);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  }

  // D-011, LANDMINE 278: A LINK IS OPENED BY ⌘-CLICK (Ctrl-click where there
  // is no ⌘), never by the click that places the caret, the Mac editors'
  // convention the canvas follows (`linkURL(at:)`), so a link never takes
  // the click that edits it. `mac` says which key the platform means.
  const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
  function opensLink(event, mac = IS_MAC) {
    if (!event || event.button !== 0 || event.shiftKey || event.altKey) return false;
    return mac ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
  }

  // The address of the link a painted element stands in, as the page may
  // open it (`Spans.linkHref`, so a stored `javascript:` opens nothing), or
  // null: the `l` item of the nearest `data-k` up to `within`.
  function linkHrefAt(node, within) {
    for (let el = node && (node.nodeType === 1 ? node : node.parentElement); el && el !== within; el = el.parentElement) {
      if (!el.dataset || !el.dataset.k) continue;
      for (const item of el.dataset.k.split("|")) {
        const { kind, value } = styleItem(item);
        if (kind === "l") return Spans.linkHref(value);
      }
      return null;
    }
    return null;
  }

  // A caret is never put INSIDE hidden characters (D-191): an offset in or
  // at the edge of a hidden range goes to the nearest visible place, the
  // next one when there is one.
  function pointAt(el, offset) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let last = null, pos = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const start = pos;
      pos += n.data.length;
      if (hiddenNode(n)) continue;
      if (offset >= start && offset <= pos) return { node: n, offset: offset - start };
      if (start > offset) return { node: n, offset: 0 };
      last = n;
    }
    return last ? { node: last, offset: last.data.length } : { node: el, offset: 0 };
  }

  function select(el, start, end = start) {
    // A line showing its face (D-190) gives the face up for its source first:
    // a hidden element takes no focus.
    const faced = el.closest && el.closest(".edit-row.show-face");
    if (faced) unface(faced);
    el.focus({ preventScroll: false });
    const sel = window.getSelection();
    const range = document.createRange();
    const a = pointAt(el, start), b = pointAt(el, end);
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // A line's face goes and its editable source shows again.
  function unface(row) {
    row.classList.remove("show-face");
    const face = row.querySelector(".edit-face");
    if (face) face.remove();
  }

  // Where a point in a face stands in the line's text: a formula's end for a
  // point in a formula; an element's point is its next text node's start.
  function faceOffset(face, node, offset) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const hit = el && el.closest(".formula, .formula-source");
    if (hit && face.contains(hit) && hit.dataset.end) return Number(hit.dataset.end);
    let point = null;
    if (node && node.nodeType !== 3) {
      point = document.createRange();
      try { point.setStart(node, offset); } catch (_) { point = null; }
    }
    let pos = 0;
    const walker = document.createTreeWalker(face, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const f = n.parentElement && n.parentElement.closest(".formula, .formula-source");
      if (point && point.comparePoint(n, 0) >= 0) return f && face.contains(f) ? Number(f.dataset.start) : pos;
      if (f && face.contains(f)) { pos = Number(f.dataset.end); continue; }
      if (n === node) return pos + Math.min(offset, n.data.length);
      pos += n.data.length;
    }
    return pos;
  }

  // The text position under a pointer, in either browser's spelling.
  function pointFrom(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    return null;
  }

  // --------------------------------------------------------------- mount

  function mount(container, docId, { onError, onChange, onFocusLine, openDrawing, openOcclusion, askLink, onNotice, pastePicture, syncMedia, showCardInfo } = {}) {
    let destroyed = false;
    let stale = false;
    const timers = new Map();
    let active = null;           // the last focused line element
    let lastSel = null;          // its selection, kept while a menu has focus
    let lang = null;
    let spell = true;           // Settings > Text > Check spelling (`spellcheck`)

    function report(error) { if (onError) onError(error); else console.error(error); }
    // A refusal said in one sentence, as the canvas says it (`notify`).
    function notice(text) { if (onNotice) onNotice(text); }

    // What each line SHOWS: its text and runs as painted from the store, the
    // stored revision they came from, and that revision's seq. A line whose
    // text and runs are unchanged is never written (review 2026-09-26,
    // web-5); a line the person changed while another device's revision
    // landed under it goes out on the seq it showed, so the backend records
    // the conflict and that device keeps a version (landmine 249 on the web,
    // web-3).
    const shown = new WeakMap();
    const lineSig = note => note ? JSON.stringify([note.kind, note.front ?? null, note.back ?? null,
                                                  note.cloze_text ?? null, note.spans ?? null]) : "";
    function remember(line, noteId) {
      const note = noteId ? Backend.get("note", noteId) : null;
      const raw = noteId ? Backend.rawRow("note", noteId) : null;
      shown.set(line, { ...read(line), sig: lineSig(note), seq: raw ? raw.base_seq : 0 });
    }
    const sameRuns = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function changedNow() {
      refreshCardDots();
      relabel();
      redecorateAll();
      schedulePages();
      if (onChange) onChange();
    }

    // A4 PAGES (K1): Settings > Text > Page layout, which syncs. Drawn again
    // a moment after anything that can move a line.
    let pagesTimer = null;
    const pagesOn = () => (Backend.library().settingsValues || {}).page_layout === "1";
    function paginateNow() {
      const c = canvasEl();
      if (c && !destroyed) Render.paginate(c, pagesOn());
    }
    function schedulePages() {
      const c = canvasEl();
      if (!pagesOn() && !(c && c.classList.contains("paged"))) return;
      clearTimeout(pagesTimer);
      pagesTimer = setTimeout(paginateNow, 120);
    }

    // The list markers the canvas draws, computed over the whole doc (E22 to
    // E25): the bullet cycle by depth and the numbers by paragraph order.
    function relabel() {
      const labels = new Map();
      for (const b of Model.build(Backend.doc(docId).notes, new Map(), new Set())) if (b.label) labels.set(b.id, b.label);
      for (const row of container.querySelectorAll(".edit-row[data-id]")) {
        const kind = row.dataset.kind;
        if (kind !== "bullet" && kind !== "dash" && kind !== "numbered") continue;
        const label = labels.get(row.dataset.id);
        const marker = row.querySelector(".edit-marker");
        if (marker && label && marker.textContent !== label.text) marker.textContent = label.text;
      }
    }

    function hasCard(noteId) {
      return Backend.library().cards.some(c => c.note_id === noteId && c.deleted_at == null && !c.detached);
    }

    // Every line's card dot at once: a line can gain or lose its card by an
    // edit to ANOTHER line (D-191: a list prompt's card is its answer lines).
    function refreshCardDots() {
      const live = new Set();
      for (const c of Backend.library().cards) if (c.deleted_at == null && !c.detached) live.add(c.note_id);
      for (const r of container.querySelectorAll(".edit-row[data-id]")) r.classList.toggle("card", live.has(r.dataset.id));
      for (const r of container.querySelectorAll(".table-grid.editing tr[data-row-id]")) r.classList.toggle("card", live.has(r.dataset.rowId));
    }

    // ----------------------------------------------------------- undo (D-190)
    //
    // ONE UNDO FOR THE DOCUMENT, as the canvas has (⌘Z, ⇧⌘Z): every edit is
    // a transaction over the rows it writes, recorded as each row's state
    // before and after, so a split, a merge, a deleted table, a block set
    // typed over and a burst of typing (one commit) each undo as one step.
    // An undo writes the old rows back as a new edit, stamped past them like
    // any other, so it syncs; a card gets back its words and its link to the
    // line but keeps the schedule it has now (a grade made meanwhile stays).
    const history = { undo: [], redo: [] };
    const MAX_STEPS = 200;
    let tx = null;

    function caretNow() {
      const line = active && container.contains(active) ? active : null;
      if (line && line.classList.contains("cell-edit")) {
        const tr = line.closest("tr");
        const sel = (document.activeElement === line ? selectionIn(line) : null) || lastSel || { start: 0, end: 0 };
        return tr ? { id: tr.dataset.rowId, col: Number(line.dataset.col || 0), cell: true, start: sel.start, end: sel.end } : null;
      }
      const row = line && line.closest(".edit-row");
      if (!row || !row.dataset.id) return null;
      const sel = (document.activeElement === line ? selectionIn(line) : null) || lastSel || { start: 0, end: 0 };
      return { id: row.dataset.id, start: sel.start, end: sel.end };
    }

    function stateOf(lane, id) {
      const r = Backend.rawRow(lane, id);
      if (!r) return null;
      const content = r.kind === "upsert" ? r.content : ((Backend.contentBefore(lane, id) || {}).content || {});
      return { kind: r.kind, env: { ...r.env }, content: { ...content } };
    }

    function transact(fn) {
      if (tx) return fn();
      tx = { before: new Map(), caret: caretNow() };
      const off = Backend.observeWrites((lane, id, prior) => {
        const k = lane + "|" + id;
        if (!tx.before.has(k)) tx.before.set(k, { lane, id, prior });
      });
      try {
        return fn();
      } finally {
        off();
        const step = tx;
        tx = null;
        if (step.before.size) {
          const entries = [...step.before.values()].map(e => ({ ...e, after: stateOf(e.lane, e.id) }));
          history.undo.push({ entries, caretBefore: step.caret, caretAfter: caretNow() });
          if (history.undo.length > MAX_STEPS) history.undo.shift();
          history.redo.length = 0;
        }
      }
    }

    // Puts one row back to a recorded state.
    function restoreRow(lane, id, state) {
      const cur = Backend.rawRow(lane, id);
      if (!state || state.kind === "tombstone") {
        if (cur && cur.kind === "upsert") Backend.write(lane, id, {}, { tombstone: true });
        return;
      }
      if (lane === "card") {
        Backend.write("card", id, { env: { detached: !!state.env.detached, suspended: !!state.env.suspended }, content: state.content });
        return;
      }
      const env = { ...state.env };
      delete env.deleted_at;
      Backend.write(lane, id, { env, content: state.content });
    }

    function replay(step, which) {
      // Notes first, so a revived card, picture or region has its line.
      const order = e => (e.lane === "note" ? 0 : 1);
      const entries = step.entries.slice().sort((a, b) => order(a) - order(b));
      try {
        for (const e of entries) restoreRow(e.lane, e.id, which === "undo" ? e.prior : e.after);
      } catch (error) { report(error); }
    }

    // An edit that moves the caret after it wrote tells its step where the
    // caret went, so a redo puts it there.
    function recaret() {
      const last = history.undo[history.undo.length - 1];
      if (last) last.caretAfter = caretNow();
    }

    // The line being typed in is saved first, so its typing is a step.
    function settleTyping() {
      for (const row of rowsInOrder()) if (timers.has(row)) commit(row);
      for (const tr of [...rowTimers.keys()]) saveRow(tr);
    }

    function undoStep() {
      settleTyping();
      const step = history.undo.pop();
      if (!step) { notice("Nothing to undo."); return false; }
      replay(step, "undo");
      history.redo.push(step);
      afterHistory(step.caretBefore, step);
      return true;
    }

    function redoStep() {
      settleTyping();
      const step = history.redo.pop();
      if (!step) return false;
      replay(step, "redo");
      history.undo.push(step);
      afterHistory(step.caretAfter, step);
      return true;
    }

    // The caret goes back where it was; a line that is gone gives it to the
    // first line the step touched that still stands, then to the nearest
    // line, and the canvas keeps the keys so the next ⌘Z still lands.
    function afterHistory(caret, step) {
      clearBlockSel();
      // A picture an undo or redo brought back is drawn from its row.
      if (syncMedia) syncMedia();
      render();
      changedNow();
      // A cell's caret goes back to its cell (D-189); a step that wrote only
      // a table row puts it at that row's first cell.
      const cell = caret && caret.cell ? cellAt(caret.id, caret.col)
        : !caret && step ? step.entries.map(e => cellAt(e.id, 0)).find(Boolean) : null;
      if (cell) {
        const len = read(cell).text.length;
        select(cell, Math.min(caret ? caret.start : len, len), Math.min(caret ? caret.end : len, len));
        return;
      }
      let row = caret && !caret.cell && container.querySelector(`.edit-row[data-id="${caret.id}"]`);
      let at = caret;
      if (!row && step) {
        for (const e of step.entries) {
          if (e.lane !== "note") continue;
          row = container.querySelector(`.edit-row[data-id="${e.id}"]`);
          if (row) { at = null; break; }
        }
      }
      if (!row) row = rowsInOrder()[rowsInOrder().length - 1] || null;
      if (row) {
        const line = row.querySelector(".edit-line");
        const len = read(line).text.length;
        if (at) select(line, Math.min(at.start, len), Math.min(at.end, len));
        else select(line, len);
      } else if (canvasEl()) {
        canvasEl().focus({ preventScroll: true });
      }
    }

    // ----------------------------------------------- the block set (R7, D-190)
    //
    // The canvas has two selection modes and never both at once: a TEXT
    // range inside one block, or a SET of whole blocks. A drag, a Shift
    // click or Shift with an arrow that crosses a block boundary makes the
    // set (a table, a picture and a line alike); ⌘A makes every block the
    // set. Delete, cut, copy, typing, a kind change and Tab act on whole
    // blocks; Escape or a click puts the caret back.
    let blockSel = null;           // { anchor, focus }: block ids
    const canvasEl = () => container.querySelector(".canvas.editor");
    const blockEls = () => { const c = canvasEl(); return c ? [...c.children].filter(el => el.dataset && "block" in el.dataset) : []; };
    const blockById = id => blockEls().find(el => el.dataset.block === id) || null;
    function blockOf(node) {
      const c = canvasEl();
      let el = node && node.nodeType === 1 ? node : node && node.parentElement;
      while (el && el.parentElement !== c) el = el.parentElement;
      return el && c && el.dataset && "block" in el.dataset ? el : null;
    }

    function selectedBlocks() {
      if (!blockSel) return [];
      const all = blockEls();
      const a = all.indexOf(blockById(blockSel.anchor)), b = all.indexOf(blockById(blockSel.focus));
      if (a < 0 || b < 0) return [];
      return all.slice(Math.min(a, b), Math.max(a, b) + 1);
    }

    function paintBlockSel() {
      const on = new Set(selectedBlocks());
      for (const el of blockEls()) el.classList.toggle("block-selected", on.has(el));
      const c = canvasEl();
      if (c) c.classList.toggle("block-selecting", on.size > 1);
    }

    // `focus` true takes the keyboard (after a drag ends, or from a key).
    function setBlockSel(anchorEl, focusEl, { focus = true } = {}) {
      if (!anchorEl || !focusEl || anchorEl === focusEl || !anchorEl.dataset.block || !focusEl.dataset.block) { clearBlockSel(); return; }
      blockSel = { anchor: anchorEl.dataset.block, focus: focusEl.dataset.block };
      paintBlockSel();
      if (focus) takeKeys();
      if (onFocusLine) onFocusLine(api);
    }

    function takeKeys() {
      const c = canvasEl();
      if (!c) return;
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      c.focus({ preventScroll: true });
    }

    function clearBlockSel() {
      if (!blockSel) return;
      blockSel = null;
      paintBlockSel();
    }

    function focusBlock(el, at) {
      if (!el) return;
      const row = el.classList.contains("edit-row") ? el : el.querySelector(".edit-row");
      if (row) { focusRow(row, at); return; }
      const cell = el.querySelector(".cell-edit");
      if (cell) cell.focus();
    }

    // The plain text a block set leaves Recall as (PLAN-EDITOR D30: other
    // apps get the stored source, markers derived at the boundary).
    const PREFIX = { heading1: "# ", heading2: "## ", heading3: "### ", quote: "> ", bullet: "* ", dash: "- ", checkbox: "[] " };
    function blockSetText() {
      const out = [];
      for (const el of selectedBlocks()) {
        const id = el.dataset.block;
        const note = id ? Backend.get("note", id) : null;
        if (!note) continue;
        if (note.kind === "table") {
          const tb = Store.tableOf(id);
          if (tb) for (const r of tb.rows) out.push(Store.rowCells(r, tb.cardTable).join("\t"));
          continue;
        }
        if (note.kind === "image") continue;
        const depth = Model.isListKind(note.kind) ? "\t".repeat(Model.decodeAttrs(note.attrs).listDepth || 0) : "";
        out.push(depth + (PREFIX[note.kind] || "") + Model.rawText(note));
      }
      return out.join("\n");
    }

    // Deletes every selected block AS BLOCKS: a table with its rows, a
    // picture with its media, a line with its cards. The caret lands where
    // the first one stood.
    function deleteSelectedBlocks({ keepSet = false } = {}) {
      const els = selectedBlocks();
      if (els.length < 2) return null;
      const all = blockEls();
      const firstAt = all.indexOf(els[0]);
      const before = all[firstAt - 1] || null;
      transact(() => {
        for (const el of els) {
          const id = el.dataset.block;
          const note = id ? Backend.get("note", id) : null;
          if (!note || note.deleted_at != null) continue;
          if (note.kind === "table") Store.deleteTable(id);
          else Store.deleteLine(id);
        }
      });
      if (!keepSet) {
        blockSel = null;
        render();
        changedNow();
        const now = blockEls();
        focusBlock(now[Math.min(firstAt, now.length - 1)] || null, 0);
        recaret();
      }
      return before ? before.dataset.block || null : "";
    }

    // TYPING OVER A BLOCK SET: the set goes and a paragraph stands where it
    // was holding what was typed (a paste's lines, each saved as a typed line).
    function replaceSelectedBlocks(text) {
      const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
      let made = null;
      transact(() => {
        let after = deleteSelectedBlocks({ keepSet: true });
        for (const piece of lines) {
          made = Store.insertLine(docId, after == null ? null : after, "", "paragraph");
          if (piece) Store.saveLine(made, piece);
          after = made;
        }
      });
      blockSel = null;
      render();
      changedNow();
      const row = made && container.querySelector(`.edit-row[data-id="${made}"]`);
      if (row) { focusRow(row, "end"); recaret(); }
    }

    // ----------------------------------------- paste keeps cards (P2d)

    // The clipboard items for notes in document order (`clipboardSlice`):
    // each line's markdown, a table's rows, a picture's attrs.
    function clipItems(ids) {
      const blocks = new Map(docBlocks().map(b => [b.id, b]));
      const out = [];
      for (const id of ids) {
        const b = blocks.get(id);
        if (!b) continue;
        const tb = b.kind === "table" ? Store.tableOf(id) : null;
        out.push(Clip.blockOf(b, { rows: b.rows, cardTable: !!(tb && tb.cardTable) }));
      }
      return out;
    }

    // The runs of a payload item, against its own text.
    const itemRuns = item => (item && item.spans ? Spans.decode(item.spans, item.text) : []);
    const shiftRuns = (runs, by) => runs.map(r => ({ ...r, start: r.start + by, end: r.end + by }));

    // A whole line's cut or copy (`performIdentityCut`); false leaves a
    // fragment to the browser.
    function copyWholeLine(event, row, line, cut) {
      if (!event.clipboardData || !row.dataset.id) return false;
      const sel = selectionIn(line);
      const cur = read(line);
      if (!sel || !cur.text) return false;
      const edges = hiddenEdges(hiddenParts(cur.text, row.dataset.kind), cur.text.length);
      if (sel.start > edges.lead || sel.end < edges.tail) return false;
      // A row with rows under it (a tree-era doc) is no block to cut whole.
      if (cut && [...Backend.library().notes.values()].some(n => n.parent_id === row.dataset.id && n.deleted_at == null)) return false;
      settle(row);
      const items = clipItems([row.dataset.id]);
      if (!items.length) return false;
      event.preventDefault();
      const next = adjacentTextRow(row, 1) || blockEls()[blockEls().indexOf(blockOf(row)) + 1];
      event.clipboardData.setData("text/plain", items[0].text + (cut && next ? "\n" : ""));
      event.clipboardData.setData(Clip.TYPE, Clip.encode(items));
      if (!cut) return true;
      let gone = false;
      try { gone = !!transact(() => Store.deleteLine(row.dataset.id)); } catch (error) { report(error); }
      if (!gone) return true;
      render();
      changedNow();
      // The caret goes where the line began: the next line's start.
      const after = next && next.dataset.block ? blockById(next.dataset.block) : null;
      if (after) focusBlock(after, 0);
      recaret();
      return true;
    }

    // A paste of Recall's own rows into a line (`restorePaste`). A payload
    // with a table goes in as blocks after the caret's line, an empty caret
    // line giving its place up (`performBlockPaste`); anything else is the
    // splice `Clip.plan` states. One undo step.
    function pasteWithIdentity(row, line, items, text) {
      if (!row.dataset.id && !ensureNote(row)) return false;
      const id = row.dataset.id;
      const cur = read(line);
      const sel = selectionIn(line) || lastSel || { start: cur.text.length, end: cur.text.length };
      let focusId = id, focusAt = null;
      try {
        transact(() => {
          const t = Date.now();
          if (Clip.carriesTable(items)) {
            const made = Store.pasteBlocks(docId, id, "below", items, t);
            if (!cur.text) Store.deleteLine(id, t);
            focusId = made[made.length - 1] || id;
            return;
          }
          const plan = Clip.plan({ text: cur.text, start: sel.start, end: sel.end }, text, items);
          const note = Backend.get("note", id);
          const numbered = row.dataset.kind === "numbered" && note && note.kind === "numbered" ? storedNumber(note) : "";
          // The caret's line: what came before, the pasted line, and (on one
          // line) what came after; its runs carried and the payload's placed.
          let lineRuns;
          if (plan.above.length || (sel.start === 0 && sel.end === 0)) {
            lineRuns = Spans.normalize([...itemRuns(plan.line.block), ...Spans.mapped(cur.runs, 0, 0, plan.line.pasted.length)]);
          } else {
            const kept = plan.below.length ? Spans.slice(cur.runs, 0, sel.start)
                                           : Spans.mapped(cur.runs, sel.start, sel.end - sel.start, plan.line.pasted.length);
            lineRuns = Spans.normalize([...kept, ...shiftRuns(itemRuns(plan.line.block), sel.start)]);
          }
          const stayNumbered = numbered && (!plan.line.kind || plan.line.kind === "numbered");
          Store.pasteIntoLine(id, (stayNumbered ? numbered : "") + plan.line.text,
                              stayNumbered ? shiftRuns(lineRuns, numbered.length) : lineRuns, plan.line.kind, t);
          const asItem = (x, extraRuns = []) => {
            if (!x.block) {
              const kind = Clip.parseKind(x.text);
              return { id: crypto.randomUUID(), text: x.text, kind: kind === "table" ? "paragraph" : kind,
                       spans: extraRuns.length ? Spans.encode(extraRuns, x.text) : null };
            }
            const runs = Spans.normalize([...itemRuns(x.block), ...extraRuns]);
            return { ...x.block, text: x.text, spans: runs.length ? Spans.encode(runs, x.text) : null };
          };
          if (plan.above.length) Store.pasteBlocks(docId, id, "above", plan.above.map(x => asItem(x)), t);
          if (plan.below.length) {
            const tailRuns = shiftRuns(Spans.slice(cur.runs, sel.end, cur.text.length),
                                       plan.below[plan.below.length - 1].text.length - (cur.text.length - sel.end));
            const made = Store.pasteBlocks(docId, id, "below",
              plan.below.map((x, k) => asItem(x, k === plan.below.length - 1 ? tailRuns : [])), t);
            focusId = made[made.length - 1] || id;
            focusAt = plan.below[plan.below.length - 1].text.length - (cur.text.length - sel.end);
          } else {
            focusAt = plan.above.length || (sel.start === 0 && sel.end === 0) ? plan.line.pasted.length : sel.start + plan.line.pasted.length;
          }
        });
      } catch (error) { report(error); return true; }
      render();
      changedNow();
      const target = container.querySelector(`.edit-row[data-id="${focusId}"]`);
      if (target) focusRow(target, focusAt == null ? "end" : focusAt);
      recaret();
      return true;
    }

    // A PASTE OVER A BLOCK SET: the set goes as blocks and the payload's rows
    // stand where it was, revived or copied.
    function replaceSelectedBlocksWith(items) {
      let made = [];
      transact(() => {
        const t = Date.now();
        const all = blockEls();
        const set = selectedBlocks();
        const after = all[all.indexOf(set[set.length - 1]) + 1] || null;
        const before = deleteSelectedBlocks({ keepSet: true });
        if (before) made = Store.pasteBlocks(docId, before, "below", items, t);
        else if (after && after.dataset.block) made = Store.pasteBlocks(docId, after.dataset.block, "above", items, t);
        else made = Store.pasteBlocks(docId, null, "below", items, t);
      });
      blockSel = null;
      render();
      changedNow();
      const last = made.length && container.querySelector(`[data-block="${made[made.length - 1]}"]`);
      if (last) { focusBlock(last, "end"); recaret(); }
    }

    function kindForSelectedBlocks(kind) {
      const els = selectedBlocks();
      const ids = els.filter(el => el.classList.contains("edit-row") && el.dataset.block).map(el => el.dataset.block);
      transact(() => { for (const id of ids) Store.setKind(id, kind); });
      render();
      paintBlockSel();
      takeKeys();
      changedNow();
    }

    function indentSelectedBlocks(delta) {
      const ids = selectedBlocks().filter(el => el.classList.contains("edit-row") && el.dataset.block
        && ["bullet", "dash", "numbered", "checkbox"].includes(el.dataset.kind)).map(el => el.dataset.block);
      transact(() => {
        for (const id of ids) {
          const note = Backend.get("note", id);
          if (note) Store.setListDepth(id, (Model.decodeAttrs(note.attrs).listDepth || 0) + delta);
        }
      });
      render();
      paintBlockSel();
      takeKeys();
      changedNow();
    }

    // ⌥⌘[ and ⌥⌘]: the caret's block, or the block set, one block up or down.
    function moveCaretBlocks(up) {
      const set = selectedBlocks();
      let ids;
      let caretRow = null, caret = null;
      if (set.length > 1) {
        ids = set.map(el => el.dataset.block).filter(Boolean);
      } else {
        const line = active && container.contains(active) ? active : null;
        const row = line && line.closest(".edit-row");
        const b = row && blockOf(row);
        if (!b || !b.dataset.block) return false;
        settle(row);
        caretRow = row.dataset.id;
        caret = selectionIn(line) || lastSel || { start: 0, end: 0 };
        ids = [b.dataset.block];
      }
      let moved = false;
      try { moved = transact(() => Store.moveBlocks(docId, ids, up)); } catch (error) { report(error); return false; }
      if (!moved) return false;
      const keep = blockSel ? { ...blockSel } : null;
      render();
      changedNow();
      if (keep) { blockSel = keep; paintBlockSel(); takeKeys(); }
      else if (caretRow) {
        const row = container.querySelector(`.edit-row[data-id="${caretRow}"]`);
        if (row) { select(row.querySelector(".edit-line"), caret.start, caret.end); recaret(); }
      }
      return true;
    }

    function selectAllBlocks() {
      const all = blockEls().filter(el => el.dataset.block);
      if (all.length < 2) return false;
      settleTyping();
      setBlockSel(all[0], all[all.length - 1]);
      return true;
    }

    // --------------------------------------------------------- text lines

    function decosFor(row, text) {
      if (!row) return [];
      const note = row.dataset.id ? Backend.get("note", row.dataset.id) : null;
      const split = Gate.mayCarrySeparator(text) ? Gate.splitCard(text) : null;
      // D-191: a trigger that ends its line draws the list arrow only once
      // answer lines sit under it.
      const answers = !!(split && split.listShaped && !split.off && note && Store.listAnswerLines(note).lines.length);
      const held = split ? heldCaret(row) : null;
      if (held != null && CardLine.triggerAwaitingSpace(text, held)) holding = row.querySelector(".edit-line");
      return decorations(text, row.dataset.kind, { diagram: row.dataset.diagram === "1",
                                                  ask: note ? Model.decodeAttrs(note.attrs).ask : null,
                                                  answers, held });
    }
    // The line whose trigger is drawn as text, waiting for its space.
    let holding = null;

    // THE CARET THE LAST KEYSTROKE LEFT in this row's line, while the caret
    // is still there (`noteTypedCaret`), or null.
    function heldCaret(row) {
      const line = row.querySelector(".edit-line");
      if (!line || document.activeElement !== line || !lastEdit || lastEdit.line !== line) return null;
      const sel = selectionIn(line);
      return sel && sel.start === sel.end && sel.start === lastEdit.offset ? lastEdit.offset : null;
    }

    // Paints a line with what its text draws (the chip, the term).
    function draw(line, text, runs) {
      const row = line.closest(".edit-row");
      paint(line, text, runs, decosFor(row, text));
      scheduleFace(row);
    }

    // ------------------------------------------------ formula faces (D-190)
    //
    // A FORMULA IS RENDERED WHILE ITS LINE IS NOT BEING EDITED, as the canvas
    // renders a line's `$...$` once the caret leaves it (Ink 18 R11): a line
    // holding a formula it may render (never a cloze, `Render.formulaSites`)
    // shows a FACE, the line painted
    // with each formula drawn by KaTeX, over its hidden editable source, the
    // only thing ever read or written. A press on the face puts the caret
    // where it pointed (a formula's end for a press on the formula) and the
    // source comes back; a face writes nothing to the store.
    function faceFormulas(row, text, runs) {
      if (!row || Gate.clozeOrdinals(text).length) return [];
      return Render.formulaSites(text, runs);
    }

    function refreshFace(row) {
      const line = row && row.querySelector(".edit-line");
      if (!line || !container.contains(row)) return;
      const cur = read(line);
      const sites = document.activeElement === line || composing ? [] : faceFormulas(row, cur.text, cur.runs);
      if (!sites.length) { unface(row); return; }
      let face = row.querySelector(".edit-face");
      if (!face) {
        face = h("div.edit-line.edit-face", { "aria-label": line.getAttribute("aria-label") || "Text" });
        if (lang) face.setAttribute("lang", lang);
        face.addEventListener("mouseup", event => pressFace(row, line, face, event));
        line.after(face);
      }
      paint(face, cur.text, cur.runs, decosFor(row, cur.text), sites);
      row.classList.add("show-face");
    }

    // Faces follow a repaint on the next frame, so a line painted and then
    // given the caret (the common case) never builds one.
    const faceQueue = new Set();
    function scheduleFace(row) {
      if (!row) return;
      if (!faceQueue.size) requestAnimationFrame(() => {
        const rows = [...faceQueue];
        faceQueue.clear();
        if (!destroyed) for (const r of rows) refreshFace(r);
      });
      faceQueue.add(row);
    }

    // A press on a face: its selection, or the point under the pointer, in
    // the source; a drag that made a block set is the set's.
    function pressFace(row, line, face, event) {
      if (event.button !== 0 || blockSel) return;
      const sel = window.getSelection();
      let a, b;
      if (sel && sel.rangeCount && !sel.isCollapsed && face.contains(sel.anchorNode) && face.contains(sel.focusNode)) {
        a = faceOffset(face, sel.anchorNode, sel.anchorOffset);
        b = faceOffset(face, sel.focusNode, sel.focusOffset);
      } else {
        const p = pointFrom(event.clientX, event.clientY);
        a = b = p && face.contains(p.node) ? faceOffset(face, p.node, p.offset) : read(line).text.length;
      }
      select(line, Math.min(a, b), Math.max(a, b));
    }

    // Repaints a line whose drawn ranges moved (a trigger typed, deleted or
    // turned off), keeping the caret; nothing is painted mid composition.
    let composing = false;
    function redecorate(row) {
      const line = row && row.querySelector(".edit-line");
      if (!line || composing) return;
      const cur = read(line);
      const decos = decosFor(row, cur.text);
      if (decoKey(decos) === (line.dataset.deco || "") && drawnMatches(line, decos)) return;
      const sel = document.activeElement === line ? selectionIn(line) : null;
      paint(line, cur.text, cur.runs, decos);
      if (sel) select(line, sel.start, sel.end);
      else scheduleFace(row);
    }

    function redecorateAll() {
      for (const row of rowsInOrder()) redecorate(row);
    }

    function lineRow(block) {
      const row = h("div.edit-row", { dataset: { id: block.id, kind: block.kind, depth: String((block.attrs && block.attrs.listDepth) || 0) } });
      row.classList.add("kind-" + block.kind);
      if (block.hasDiagram) row.dataset.diagram = "1";
      if (block.attrs && block.attrs.listDepth) row.style.setProperty("--depth", String(block.attrs.listDepth));
      const marker = h("span.edit-marker", { contenteditable: "false" });
      setMarker(marker, block.kind, block.attrs && block.attrs.checked, block.id, block.label);
      const line = h("div.edit-line", { contenteditable: "true", spellcheck: spell ? "true" : "false", role: "textbox",
                                        "aria-label": KIND_LABEL[block.kind] || "Text", "aria-multiline": "false" });
      if (lang) line.setAttribute("lang", lang);
      row.append(marker, line);
      draw(line, displayText(block), displayRuns(block));
      remember(line, block.id);
      row.classList.toggle("card", hasCard(block.id));
      wire(row, line);
      return row;
    }

    function setMarker(marker, kind, checked, noteId, label) {
      clear(marker);
      if (label && label.text && (kind === "bullet" || kind === "dash" || kind === "numbered")) marker.textContent = label.text;
      else if (MARKERS[kind]) marker.textContent = MARKERS[kind];
      if (kind === "checkbox") {
        const box = h("button.edit-box", { type: "button", "aria-label": checked ? "Done" : "Not done", text: checked ? "☑" : "☐" });
        box.addEventListener("mousedown", e => e.preventDefault());
        box.addEventListener("click", () => {
          const on = box.textContent === "☐";
          box.textContent = on ? "☑" : "☐";
          try { transact(() => Store.setChecked(noteId, on)); changedNow(); } catch (error) { report(error); }
        });
        marker.appendChild(box);
      }
    }

    function restyle(row, kind) {
      const old = row.dataset.kind;
      row.classList.remove("kind-" + old);
      row.dataset.kind = kind;
      row.classList.add("kind-" + kind);
      const note = Backend.get("note", row.dataset.id);
      const attrs = note ? Model.decodeAttrs(note.attrs) : {};
      setMarker(row.querySelector(".edit-marker"), kind, attrs.checked, row.dataset.id);
      const line = row.querySelector(".edit-line");
      if (line) line.setAttribute("aria-label", KIND_LABEL[kind] || "Text");
      if (attrs.listDepth) row.style.setProperty("--depth", String(attrs.listDepth));
      else row.style.removeProperty("--depth");
      row.dataset.depth = String(attrs.listDepth || 0);
    }

    function rowsInOrder() { return [...container.querySelectorAll(".edit-row")]; }

    function ensureNote(row) {
      if (row.dataset.id) return row.dataset.id;
      const id = Store.insertLine(docId, null, "", "paragraph");
      row.dataset.id = id;
      delete row.dataset.pending;
      return id;
    }

    // `ask` (the arrow's menu) is the direction the block stores in the same
    // write (`Store.saveLine`).
    function commit(row, { ask = undefined } = {}) {
      const line = row.querySelector(".edit-line");
      if (!line) return;
      clearTimeout(timers.get(row));
      timers.delete(row);
      try {
        const { text, runs } = read(line);
        const before = shown.get(line);
        const stored = row.dataset.id ? Backend.get("note", row.dataset.id) : null;
        if (before && stored && before.text === text && sameRuns(before.runs, runs)) {
          // Untouched: nothing to write, and a revision that landed
          // meanwhile stays; it is drawn when the caret leaves.
          if (before.sig !== lineSig(stored)) stale = true;
          return;
        }
        const focused = document.activeElement === line;
        const sel = focused ? selectionIn(line) : null;
        const unseen = before && stored && before.sig !== lineSig(stored);
        // A numbered line shows no number of its own; the stored one goes back.
        const wasNumbered = row.dataset.kind === "numbered" && stored && stored.kind === "numbered";
        const prefix = wasNumbered ? storedNumber(stored) : "";
        const saveText = prefix + text;
        const saveRuns = prefix ? runs.map(r => ({ ...r, start: r.start + prefix.length, end: r.end + prefix.length })) : runs;
        let id = null, wrote = false;
        transact(() => {
          id = ensureNote(row);
          wrote = Store.saveLine(id, saveText, Date.now(), saveRuns, { base: unseen ? before.seq : null, ask });
        });
        const note = Backend.get("note", id);
        const declared = Gate.declaredKind(text);
        const typedNumber = !wasNumbered && note && note.kind === "numbered" ? ((/^\d+[.)] ?/.exec(text) || [""])[0].length) : 0;
        if (note && declared && (declared.marker > 0 || typedNumber > 0) && note.kind === declared.kind) {
          // The marker became the line's KIND (storage is prefix free; a
          // number is drawn, not shown), so the line stops showing it.
          const cut = declared.marker || typedNumber;
          const block = Model.build([note], new Map(), new Set())[0];
          restyle(row, note.kind);
          draw(line, displayText(block), displayRuns(block));
          if (sel) select(line, Math.max(0, sel.start - cut));
        }
        if (note && note.kind !== row.dataset.kind) restyle(row, note.kind);
        row.classList.toggle("card", hasCard(id));
        redecorate(row);
        const above = rowsInOrder()[rowsInOrder().indexOf(row) - 1];
        if (above) redecorate(above);
        refreshCardDots();
        remember(line, id);
        if (wrote) changedNow();
      } catch (error) { report(error); }
    }

    function scheduleCommit(row) {
      clearTimeout(timers.get(row));
      timers.set(row, setTimeout(() => commit(row), 700));
    }

    function focusRow(row, at) {
      if (!row) return;
      const line = row.querySelector(".edit-line");
      if (!line) return;
      const len = read(line).text.length;
      select(line, at === "end" ? len : Math.min(at || 0, len));
    }

    // A new line after `row`, stored, holding `text` and `runs`.
    function newLineAfter(row, text, runs, kind = "paragraph") {
      const afterId = row.dataset.table || ensureNote(row);
      const id = Store.insertLine(docId, afterId, "", kind);
      if (text || (runs && runs.length)) Store.saveLine(id, text, Date.now(), runs || []);
      const note = Backend.get("note", id);
      const block = Model.build([note], new Map(), new Set())[0];
      const next = lineRow(block);
      row.after(next);
      changedNow();
      return next;
    }

    function wire(row, line) {
      line.addEventListener("focus", () => {
        active = line;
        unface(row);
        if (blockSel) clearBlockSel();
        if (onFocusLine) onFocusLine(api);
      });
      line.addEventListener("blur", () => {
        lastSel = selectionIn(line) || lastSel;
        commit(row);
        // The caret LEFT the line (not the window) and its formulas render.
        if (document.hasFocus()) refreshFace(row);
        setTimeout(() => { if (!destroyed && stale && !container.contains(document.activeElement)) render(); }, 50);
      });
      line.addEventListener("beforeinput", event => {
        const t = event.inputType;
        if (t === "formatBold") { event.preventDefault(); format("b"); }
        else if (t === "formatItalic") { event.preventDefault(); format("i"); }
        else if (t === "formatUnderline") { event.preventDefault(); format("n"); }
        else if (t === "formatStrikeThrough") { event.preventDefault(); format("s"); }
        else if (t === "historyUndo") { event.preventDefault(); undoStep(); }
        else if (t === "historyRedo") { event.preventDefault(); redoStep(); }
        else if (t === "insertParagraph" || t === "insertLineBreak" || t === "insertFromDrop") event.preventDefault();
        else if (!event.isComposing && !composing) guardHidden(row, line, event);
      });
      line.addEventListener("compositionstart", () => { composing = true; });
      line.addEventListener("compositionend", () => { composing = false; redecorate(row); });
      line.addEventListener("input", event => afterEdit(row, line, event.inputType, event.isComposing, null, event.data));
      // D-191: a press on the chip opens the arrow's menu, a press on a
      // blank's ▾ corner its menu; neither moves the caret.
      line.addEventListener("mousedown", event => {
        lastEdit = null;
        if (openLinkFrom(event, line)) return;
        if (event.button !== 0 || event.shiftKey) return;
        const target = event.target instanceof Element ? event.target : null;
        const trig = target && target.closest(".trig-text");
        if (trig && line.contains(trig)) {
          event.preventDefault();
          if (!CardMenu.justClosed(event, "chip:" + row.dataset.id)) openChipMenu(row);
          return;
        }
        const box = target && target.closest(".cz");
        if (box && line.contains(box) && inCorner(event, box)) {
          event.preventDefault();
          const index = Number(box.dataset.blank);
          if (!CardMenu.justClosed(event, `blank:${row.dataset.id}:${index}`)) openBlankMenu(row, index);
        }
      });
      line.addEventListener("paste", event => {
        event.preventDefault();
        // A PICTURE on the clipboard is pasted as a picture block after the
        // line (the canvas's paste of an image), uploaded by sha.
        const files = event.clipboardData ? [...event.clipboardData.files] : [];
        const picture = files.find(f => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
        if (picture && pastePicture) {
          settle(row);
          pastePicture(picture, ensureNote(row));
          return;
        }
        const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
        if (!text) return;
        settle(row);
        // P2d: a whole-line or block-set cut or copy of Recall's own brings its
        // rows back as themselves (a cut) or as copies keeping their kinds
        // and styles (a copy).
        const items = Clip.usable(event.clipboardData.getData(Clip.TYPE), text);
        if (items && pasteWithIdentity(row, line, items, text)) return;
        const sel = selectionIn(line) || { start: 0, end: 0 };
        const cur = read(line);
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        const before = cur.text.slice(0, sel.start), after = cur.text.slice(sel.end);
        // A line holding hidden characters (D-191) takes a one-line paste as
        // typing: kept around what it hides, after a blank at its end.
        const parts = lines.length === 1 ? hiddenParts(cur.text, row.dataset.kind) : [];
        if (parts.length) {
          let a = sel.start, b = sel.end;
          const tail = a === b && Gate.clozeSpans(cur.text).find(x => x.inner.end > x.inner.start && x.inner.end === a);
          if (tail && !(lastEdit && lastEdit.line === line && lastEdit.offset === a)) a = b = tail.whole.end;
          const out = splice(cur, parts, a, b, lines[0]);
          draw(line, out.text, out.runs);
          select(line, out.caret);
          lastEdit = { line, offset: out.caret };
          scheduleCommit(row);
          return;
        }
        let runs = Spans.mapped(cur.runs, sel.start, sel.end - sel.start, lines[0].length);
        if (lines.length === 1) {
          draw(line, before + lines[0] + after, runs);
          select(line, sel.start + lines[0].length);
          scheduleCommit(row);
          return;
        }
        const tail = Spans.slice(runs, sel.start + lines[0].length, (before + lines[0] + after).length);
        runs = Spans.slice(runs, 0, sel.start + lines[0].length);
        let last = row;
        transact(() => {
          draw(line, before + lines[0], runs);
          commit(row);
          for (let i = 1; i < lines.length; i++) {
            const isLast = i === lines.length - 1;
            last = newLineAfter(last, lines[i] + (isLast ? after : ""), isLast ? tail.map(r => ({ ...r, start: r.start + lines[i].length, end: r.end + lines[i].length })) : []);
          }
        });
        focusRow(last, lines[lines.length - 1].length);
      });
      // P2d: A WHOLE LINE cut or copied carries its identity beside its
      // markdown text; a cut takes the line away as a block (its hidden
      // markers and its card with it) and carries its separator. A piece of
      // a line is the browser's own.
      line.addEventListener("copy", event => copyWholeLine(event, row, line, false));
      line.addEventListener("cut", event => copyWholeLine(event, row, line, true));
      line.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (/^(Arrow|Home$|End$|Page)/.test(event.key)) lastEdit = null;
        const mod = event.metaKey || event.ctrlKey;
        const k = event.key.toLowerCase();
        const code = event.code || "";
        // THE CANVAS'S KEYS (the keyboard scheme): undo and redo for the
        // whole document, ⌘A the whole document as a block set, ⌘L a link,
        // ⌘\ clear, ⇧⌘C make card, ⇧⌥⌘C a cloze, ⌃⇧⌘C a cloze on the same
        // card, ⌥⌘1 to ⌥⌘3 the headings.
        if (mod && !event.altKey && k === "z") { event.preventDefault(); if (event.shiftKey) redoStep(); else undoStep(); return; }
        if (mod && !event.altKey && !event.shiftKey && k === "y") { event.preventDefault(); redoStep(); return; }
        if (mod && !event.altKey && !event.shiftKey && k === "a") {
          if (blockEls().filter(el => el.dataset.block).length > 1) { event.preventDefault(); commit(row); selectAllBlocks(); }
          return;
        }
        if (mod && !event.altKey && !event.shiftKey && k === "l") { event.preventDefault(); linkCommand(); return; }
        if (mod && !event.altKey && !event.shiftKey && k === "\\") { event.preventDefault(); clearFormat(); return; }
        // `code` names the key whatever ⌥ types with it; a synthetic key
        // may carry only `key`.
        const isC = code === "KeyC" || k === "c";
        const digit = /^Digit[123]$/.test(code) ? code.slice(5) : (/^[123]$/.test(event.key) ? event.key : null);
        if (event.metaKey && event.shiftKey && isC) {
          event.preventDefault();
          if (event.altKey) makeCloze(false);
          else if (event.ctrlKey) makeCloze(true);
          else makeCard();
          return;
        }
        const bracket = code === "BracketLeft" || event.key === "[" ? "up" : code === "BracketRight" || event.key === "]" ? "down" : null;
        if (mod && event.altKey && !event.shiftKey && bracket) {
          event.preventDefault();
          moveCaretBlocks(bracket === "up");
          return;
        }
        if (mod && event.altKey && !event.shiftKey && digit) {
          event.preventDefault();
          setKind("heading" + digit);
          return;
        }
        if (mod && !event.altKey) {
          const shortcut = !event.shiftKey ? SHORTCUTS[k] : SHIFT_SHORTCUTS[k];
          if (shortcut) { event.preventDefault(); format(shortcut); return; }
        }
        const rows = rowsInOrder();
        const i = rows.indexOf(row);
        const sel = selectionIn(line) || { start: 0, end: 0 };
        const cur = read(line);
        const kind = row.dataset.kind;
        // D-191: a line that hides characters is at its start or its end by
        // what it SHOWS (a caret after a blank that ends the line is at the
        // line's end, though a hidden `}}` follows it).
        const edges = hiddenEdges(hiddenParts(cur.text, kind), cur.text.length);
        const atStart = sel.start === sel.end && sel.start <= edges.lead;
        const atEnd = sel.end >= edges.tail;
        // A SELECTION THAT CROSSES THE LINE'S EDGE BECOMES A BLOCK SET (R7).
        if (event.shiftKey && !mod && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          const down = event.key === "ArrowDown";
          if ((down && atEnd) || (!down && sel.start <= edges.lead)) {
            const all = blockEls();
            const me = blockOf(row);
            const next = all[all.indexOf(me) + (down ? 1 : -1)];
            if (me && next && next.dataset.block && me.dataset.block) {
              event.preventDefault();
              commit(row);
              setBlockSel(me, next);
            }
            return;
          }
        }
        if (event.key === "Enter" && !event.shiftKey && !mod) {
          event.preventDefault();
          settle(row);
          // D-191: RETURN AT THE END OF A LINE WHOSE TRIGGER ENDS IT STARTS
          // ITS ANSWER: a bullet one level deeper (depth 0 under a line that
          // is not a list item), with no trigger of its own
          // (`canvasReturnAfterTrigger`).
          const typedNow = read(line);
          const selNow = selectionIn(line) || sel;
          const answerDepth = row.dataset.diagram === "1" || selNow.start !== selNow.end ? null
            : CardLine.returnAfterTrigger(typedNow.text, selNow.start, row.dataset.kind, Number(row.dataset.depth || 0));
          if (answerDepth != null) {
            try {
              let next = null;
              transact(() => {
                commit(row);
                next = newLineAfter(row, "", [], "bullet");
                Store.setListDepth(next.dataset.id, answerDepth);
              });
              if (next) { restyleFromStore(next); focusRow(next, 0); recaret(); }
              changedNow();
            } catch (error) { report(error); }
            return;
          }
          const listLike = ["bullet", "dash", "numbered", "checkbox"].includes(kind);
          if (listLike && !cur.text.trim()) {
            // Enter on an empty list line ends the list.
            try { transact(() => Store.setKind(ensureNote(row), "paragraph")); restyle(row, "paragraph"); changedNow(); } catch (error) { report(error); }
            return;
          }
          // A split never lands inside what the line hides (a blank's
          // markers, an escaped trigger's backslash).
          const cut = sel.start === sel.end ? splitPoint(cur.text, sel.start, kind) : null;
          const at = cut == null ? sel : { start: cut, end: cut };
          const beforeRuns = Spans.slice(cur.runs, 0, at.start);
          const afterRuns = Spans.slice(cur.runs, at.end, cur.text.length);
          const nextKind = listLike ? (kind === "numbered" ? "numbered" : kind) : "paragraph";
          let rest = cur.text.slice(at.end);
          let restRuns = afterRuns;
          if (nextKind === "numbered") { rest = "1. " + rest; restRuns = Spans.mapped(restRuns, 0, 0, 3); }
          try {
            let next = null;
            transact(() => {
              draw(line, cur.text.slice(0, at.start), beforeRuns);
              commit(row);
              next = newLineAfter(row, rest, restRuns, nextKind);
              const note = Backend.get("note", row.dataset.id);
              if (note && listLike) {
                const depth = Model.decodeAttrs(note.attrs).listDepth;
                if (depth) Store.setListDepth(next.dataset.id, depth);
              }
            });
            if (next) { restyleFromStore(next); focusRow(next, 0); recaret(); }
            changedNow();
          } catch (error) { report(error); }
          return;
        }
        if (event.key === "Tab" && ["bullet", "dash", "numbered", "checkbox"].includes(kind)) {
          event.preventDefault();
          settle(row);
          const note = Backend.get("note", row.dataset.id);
          const depth = note ? Model.decodeAttrs(note.attrs).listDepth : 0;
          try {
            if (transact(() => Store.setListDepth(ensureNote(row), depth + (event.shiftKey ? -1 : 1)))) { restyle(row, kind); changedNow(); }
          } catch (error) { report(error); }
          return;
        }
        // D-191: BACKSPACE INSIDE AN ESCAPED TRIGGER takes the character and,
        // once nothing is left to escape, the hidden backslash with it, so
        // `\>>` becomes `>` and never a visible `\>` (`backspaceInEscapedTrigger`).
        if (event.key === "Backspace" && !mod && !event.altKey && sel.start === sel.end
            && row.dataset.diagram !== "1") {
          const cuts = CardLine.backspaceInEscapedTrigger(cur.text, sel.start);
          if (cuts) {
            event.preventDefault();
            let text = cur.text, runs = cur.runs;
            for (const cut of cuts) {
              text = text.slice(0, cut.start) + text.slice(cut.start + cut.length);
              runs = Spans.mapped(runs, cut.start, cut.length, 0);
            }
            draw(line, text, Spans.normalize(runs, text.length));
            select(line, sel.start - cuts.length);
            afterEdit(row, line, "deleteContentBackward", false, sel.start - cuts.length);
            return;
          }
        }
        // D-191: BACKSPACE RIGHT AFTER A CHIP GIVES THE TRIGGER BACK AS
        // WORDS: a backslash goes before the trigger (`\>>`, hidden), the
        // line stops being a card, and the next Backspace takes a `>` like
        // any character (`canvasUnchipAtCaret`). A line that draws no chip
        // (a cloze, a diagram's prompt) keeps the plain key.
        if (event.key === "Backspace" && !mod && !event.altKey && sel.start === sel.end && sel.start > 0
            && row.dataset.diagram !== "1" && !Gate.clozeOrdinals(cur.text).length
            && CardLine.unchipAt(cur.text, sel.start) != null
            // A trigger still being typed is drawn as its characters, so
            // Backspace takes one of them like any character.
            && !(heldCaret(row) === sel.start && CardLine.triggerAwaitingSpace(cur.text, sel.start))) {
          event.preventDefault();
          settle(row);
          const now = read(line);
          const at = CardLine.unchipAt(now.text, sel.start);
          if (at == null) return;
          const text = now.text.slice(0, at) + "\\" + now.text.slice(at);
          try { transact(() => { draw(line, text, Spans.mapped(now.runs, at, 0, 1)); commit(row); }); } catch (error) { report(error); return; }
          select(line, sel.start + 1);
          lastEdit = null;
          recaret();
          changedNow();
          return;
        }
        if (event.key === "Backspace" && atStart) {
          settle(row);
          if (cur.text === "" && rows.length > 1) {
            event.preventDefault();
            clearTimeout(timers.get(row));
            try { if (row.dataset.id && !transact(() => Store.deleteLine(row.dataset.id))) return; } catch (error) { report(error); return; }
            const prev = rows[i - 1] || rows[i + 1];
            row.remove();
            focusRow(prev, "end");
            recaret();
            changedNow();
            return;
          }
          if (kind !== "paragraph") {
            // The heading demote: the line keeps its words and becomes body.
            event.preventDefault();
            try { transact(() => { commit(row); Store.setKind(ensureNote(row), "paragraph"); }); } catch (error) { report(error); }
            const note = Backend.get("note", row.dataset.id);
            restyle(row, "paragraph");
            if (note) { const block = Model.build([note], new Map(), new Set())[0]; draw(line, displayText(block), displayRuns(block)); remember(line, note.id); }
            select(line, 0);
            changedNow();
            return;
          }
          const prev = adjacentTextRow(row, -1);
          const pline = prev && prev.querySelector(".edit-line");
          if (pline && cur.text !== "") {
            // Merge into the line above, which keeps its identity and card.
            event.preventDefault();
            mergeRows(prev, row);
            return;
          }
        }
        if (event.key === "Delete" && sel.start === sel.end && atEnd) {
          // Forward delete at a line's end joins the next line to it; a drawn
          // block after it is never eaten by a key (R2).
          const next = adjacentTextRow(row, 1);
          if (next) { event.preventDefault(); settle(row); mergeRows(row, next); }
          return;
        }
        if (event.key === "ArrowUp" && atStart && rows[i - 1]) {
          event.preventDefault();
          focusRow(rows[i - 1], "end");
        } else if (event.key === "ArrowDown" && sel.start >= edges.tail && rows[i + 1]) {
          event.preventDefault();
          focusRow(rows[i + 1], 0);
        } else if (event.key === "Escape") {
          line.blur();
        }
      });
    }

    // ⌘-click on a link in a line or a cell (landmine 278): the address opens
    // in a new tab and the caret stays where it was.
    function openLinkFrom(event, within) {
      if (!opensLink(event)) return false;
      const href = linkHrefAt(event.target, within);
      if (!href) return false;
      event.preventDefault();
      window.open(href, "_blank", "noopener,noreferrer");
      return true;
    }

    // Commits a line the person typed in and has not saved yet, as its own
    // undo step, before an edit that is about the line's structure.
    function settle(row) {
      if (row && timers.has(row)) commit(row);
    }

    // The text line right before or after `row` when nothing drawn stands
    // between them (a diagram's prompt counts as drawn).
    function adjacentTextRow(row, step) {
      const all = blockEls();
      const me = blockOf(row);
      if (!me || me !== row) return null;
      const other = all[all.indexOf(me) + step];
      return other && other.classList.contains("edit-row") ? other : null;
    }

    // `lower` joins onto the end of `upper`, which keeps its identity and card.
    function mergeRows(upper, lower) {
      const uline = upper.querySelector(".edit-line"), lline = lower.querySelector(".edit-line");
      const p = read(uline), c = read(lline);
      const joined = p.text + c.text;
      const runs = [...p.runs, ...c.runs.map(r => ({ ...r, start: r.start + p.text.length, end: r.end + p.text.length }))];
      clearTimeout(timers.get(lower));
      timers.delete(lower);
      try {
        transact(() => {
          draw(uline, joined, Spans.normalize(runs, joined.length));
          commit(upper);
          if (lower.dataset.id) Store.deleteLine(lower.dataset.id);
        });
      } catch (error) { report(error); }
      lower.remove();
      focusRow(upper, p.text.length);
      recaret();
      changedNow();
    }

    // A row's kind and depth as the store now holds them.
    function restyleFromStore(row) {
      const note = row && row.dataset.id ? Backend.get("note", row.dataset.id) : null;
      if (note) restyle(row, note.kind);
    }

    // ------------------------------------------- typing around hidden text

    // Where the last edit left the caret in its line: typing at a blank's
    // end continues the blank only straight after an edit that left the
    // caret there (the canvas keeps its source caret inside the span then);
    // a caret PLACED there types after the blank, as the canvas maps it.
    let lastEdit = null;

    // What a line does after the browser (or `guardHidden`) changed it: the
    // drawing follows the text, a typed `{{word}}` becomes a blank, a typed
    // marker becomes the kind at once, and the line commits 700 ms later.
    //
    // `lastEdit` records where the edit LEFT the caret, read before the
    // drawing follows the text: a `}}` typed at a line's end closes a blank,
    // the repaint shows the caret at the blank's words, and the next key
    // still types after the blank.
    function afterEdit(row, line, inputType, composingNow = false, caret = null, data = null) {
      let typedTo = caret != null ? caret : (selectionIn(line) || { end: null }).end;
      // D-191: A SPACE TYPED RIGHT AFTER AN ESCAPED TRIGGER MAKES IT A CHIP
      // AGAIN (`rechippingOnSpace`): the hidden backslash goes, and the typed
      // space too when the one the chip kept still follows.
      if (inputType === "insertText" && data === " " && !composingNow && typedTo != null && row.dataset.diagram !== "1") {
        const cur = read(line);
        const chip = CardLine.rechippingOnSpace(cur.text, typedTo, row.dataset.kind);
        if (chip) {
          let runs = cur.runs;
          for (const cut of chip.cuts) runs = Spans.mapped(runs, cut.start, cut.length, 0);
          draw(line, chip.text, Spans.normalize(runs, chip.text.length));
          select(line, chip.caret);
          typedTo = chip.caret;
        }
      }
      // Where this keystroke left the caret, read by the drawing that
      // follows: a trigger ending there waits for its space.
      lastEdit = typedTo != null ? { line, offset: typedTo } : null;
      if (!composingNow) redecorate(row);
      const expanded = inputType === "insertText" && !composingNow ? expandTypedBlank(row, line) : null;
      const sel = selectionIn(line);
      const at = expanded != null ? expanded : typedTo;
      lastEdit = at != null ? { line, offset: at } : null;
      schedulePages();
      const { text } = read(line);
      // THE TYPED MARKER: `# T` is a heading the moment it has a title.
      const d = Gate.declaredKind(text);
      const typed = d ? (d.marker || (d.kind === "numbered" && row.dataset.kind !== "numbered" ? ((/^\d+[.)] /.exec(text) || [""])[0].length) : 0)) : 0;
      if (typed > 0 && sel && sel.start >= typed) { commit(row); return; }
      scheduleCommit(row);
    }

    // D-191: TYPING `{{word}}` MAKES AN OWN-CARD BLANK (`ClozeBlanks
    // .expandingTyped`): the closing `}}` just typed rewrites the span to
    // `{{cN::word}}`, N one past the line's highest ordinal, never on a line
    // that is already a card or a picture token. Answers the caret after the
    // span, or null.
    function expandTypedBlank(row, line) {
      const sel = selectionIn(line);
      if (!sel || sel.start !== sel.end) return null;
      const cur = read(line);
      const r = ClozeBlanks.expandingTyped(cur.text, sel.start, cur.text, [row.dataset.kind]);
      if (!r) return null;
      draw(line, r.display, Spans.mapped(cur.runs, r.at, 0, r.inserted.length));
      select(line, r.caret);
      return r.caret;
    }

    // D-191: EDITS AROUND HIDDEN CHARACTERS. The browser edits the DOM it
    // sees, and a line's hidden characters (a cloze span's `{{cN::`, hint and
    // `}}`, an escaped trigger's backslash) are DOM too: Backspace after a
    // blank would take its `}}` with the last letter. So a deletion keeps
    // every hidden character whose whole (the span, the escaped trigger) it
    // does not take entirely, and typing at the end of a blank's words goes
    // after the blank unless the last edit left the caret there.
    function guardHidden(row, line, event) {
      const t = event.inputType || "";
      const isDelete = t.startsWith("delete");
      const isType = t === "insertText" && typeof event.data === "string";
      if (!isDelete && !isType) return;
      const cur = read(line);
      const parts = hiddenParts(cur.text, row.dataset.kind);
      if (!parts.length) return;
      const sel = selectionIn(line);
      if (!sel) return;
      let a = sel.start, b = sel.end;
      if (isDelete && a === b) {
        // The browser REPORTS the visible character it takes and then
        // deletes everything from it to the caret, hidden elements between
        // included; so the range is the report joined to the caret.
        const ranges = typeof event.getTargetRanges === "function" ? event.getTargetRanges() : [];
        if (!ranges.length) return;
        const x = offsetOf(line, ranges[0].startContainer, ranges[0].startOffset);
        const y = offsetOf(line, ranges[0].endContainer, ranges[0].endOffset);
        a = Math.min(x, y, sel.start);
        b = Math.max(x, y, sel.start);
      }
      const touches = parts.some(p => p.start < b && p.end > a);
      let at = null;
      if (isType && a === b && !touches) {
        const tail = Gate.clozeSpans(cur.text).find(x => x.inner.end > x.inner.start && x.inner.end === a);
        const continuing = lastEdit && lastEdit.line === line && lastEdit.offset === a;
        if (tail && !continuing) at = tail.whole.end;
      }
      if (!touches && at == null) return;
      event.preventDefault();
      const out = at != null ? splice(cur, parts, at, at, event.data)
                             : splice(cur, parts, a, b, isType ? event.data : "");
      draw(line, out.text, out.runs);
      select(line, out.caret);
      afterEdit(row, line, isType ? "insertText" : t, false, out.caret, isType ? event.data : null);
    }

    // How far the hidden characters at a line's two ends reach: the caret
    // stands at the start at or before `lead`, at the end at or after `tail`.
    function hiddenEdges(parts, length) {
      const sorted = parts.slice().sort((p, q) => p.start - q.start);
      let lead = 0, tail = length;
      for (const p of sorted) if (p.start <= lead && p.end > lead) lead = p.end;
      for (const p of sorted.reverse()) if (p.end >= tail && p.start < tail) tail = p.start;
      return { lead, tail };
    }

    // Where Return splits a line for a caret at `o`: never inside a blank (at
    // or before its words' start, before the blank; anywhere else in it,
    // after it) nor between an escaped trigger and its backslash.
    function splitPoint(text, o, kind) {
      for (const s2 of Gate.clozeSpans(text)) {
        if (o > s2.whole.start && o < s2.whole.end) return o <= s2.inner.start ? s2.whole.start : s2.whole.end;
      }
      for (const p of hiddenParts(text, kind)) if (p.escape && o === p.end) return p.start;
      return o;
    }

    // [a, b) of a line taken out, all but the hidden characters whose whole
    // lies outside it, then `insert` put where the first removed character
    // stood; style runs mapped through both.
    function splice(cur, parts, a, b, insert) {
      const keep = new Set();
      for (const p of parts) {
        if (p.whole.start >= a && p.whole.end <= b) continue;
        for (let k = Math.max(a, p.start); k < Math.min(b, p.end); k++) keep.add(k);
      }
      const cuts = [];
      for (let i = a; i < b;) {
        if (keep.has(i)) { i++; continue; }
        let j = i;
        while (j < b && !keep.has(j)) j++;
        cuts.push([i, j]);
        i = j;
      }
      let text = cur.text, runs = cur.runs;
      for (let k = cuts.length - 1; k >= 0; k--) {
        const [i, j] = cuts[k];
        text = text.slice(0, i) + text.slice(j);
        runs = Spans.mapped(runs, i, j - i, 0);
      }
      const at = cuts.length ? cuts[0][0] : a;
      if (insert) {
        text = text.slice(0, at) + insert + text.slice(at);
        runs = Spans.mapped(runs, at, 0, insert.length);
      }
      return { text, runs: Spans.normalize(runs, text.length), caret: at + insert.length };
    }

    // D-191: A CARET NEVER STANDS INSIDE A CHIP (`snapCaretOutOfChip`): one
    // that lands between a trigger's characters goes to the chip's far side
    // in the direction it was travelling, to its end when it came from the
    // left.
    let prevCaret = null;
    function snapOutOfChip(line) {
      const sel = selectionIn(line);
      if (!sel || sel.start !== sel.end) { prevCaret = null; return false; }
      const text = read(line).text;
      if (!Gate.mayCarrySeparator(text)) { prevCaret = { line, offset: sel.start }; return false; }
      const chipAt = decosFor(line.closest(".edit-row"), text)
        .find(d => d.icon && sel.start > d.start && sel.start < d.end);
      if (!chipAt) { prevCaret = { line, offset: sel.start }; return false; }
      const from = prevCaret && prevCaret.line === line ? prevCaret.offset : sel.start;
      const to = from <= chipAt.start ? chipAt.end : chipAt.start;
      prevCaret = { line, offset: to };
      select(line, to);
      return true;
    }

    // ------------------------------------------ the arrow's menu (D-191)

    const rowById = id => (id ? container.querySelector(`.edit-row[data-id="${id}"]`) : null);
    // Where the caret goes back to when a menu closes; a change made from
    // the menu moves it as the canvas moves its caret.
    let menuCaret = null;

    // The card Card info and Preview card read: the forward card first.
    function cardIdOf(noteId) {
      const rank = c => (c.detached ? 1e9 : 0) + (c.cloze_ordinal == null ? -1e6 : c.cloze_ordinal);
      const live = Backend.library().cards.filter(c => c.note_id === noteId && c.deleted_at == null)
        .sort((a, b) => rank(a) - rank(b));
      return live.length ? live[0].id : null;
    }

    function chipStateOf(id) {
      const row = rowById(id), note = Backend.get("note", id);
      const line = row && row.querySelector(".edit-line");
      if (!line || !note) return null;
      return CardLine.state(read(line).text, Model.decodeAttrs(note.attrs).ask,
                            Store.listAnswerLines(note).lines.map(n => n.kind), cardIdOf(id));
    }

    // One change from the arrow's menu, as one undo step, answering the
    // line's state after it (null when refused). Type, Asks and Card on
    // rewrite only the trigger and `attrs.ask`; Answer re-kinds the lines
    // under the line (`applyChipChange`).
    function applyChip(id, change) {
      const row = rowById(id), note = Backend.get("note", id);
      const line = row && row.querySelector(".edit-line");
      if (!line || !note) return null;
      settle(row);
      try {
        if (change.answer) {
          if (!transact(() => Store.setAnswerShape(id, change.answer))) return null;
          render();
        } else {
          const cur = read(line);
          const edit = CardLine.chipEdit(cur.text, Model.decodeAttrs(note.attrs).ask, change);
          if (!edit) return null;
          transact(() => {
            if (edit.text != null) {
              const text = cur.text.slice(0, edit.start) + edit.text + cur.text.slice(edit.end);
              draw(line, text, Spans.mapped(cur.runs, edit.start, edit.end - edit.start, edit.text.length));
              commit(row, { ask: edit.ask });
              shiftMenuCaret(id, edit.end, edit.text.length - (edit.end - edit.start));
            } else {
              Store.setCardAsk(id, edit.ask);
            }
          });
        }
      } catch (error) { report(error); return null; }
      changedNow();
      return chipStateOf(id);
    }

    function shiftMenuCaret(id, from, delta) {
      if (!menuCaret || menuCaret.id !== id || !delta) return;
      if (menuCaret.start >= from) menuCaret.start += delta;
      if (menuCaret.end >= from) menuCaret.end += delta;
    }

    // PREVIEW CARD (`cardPeek`): the line's card, front and back.
    function peekOf(id) {
      const note = Backend.get("note", id);
      if (!note || !hasCard(id)) return null;
      return CardLine.peek(Model.rawText(note), Store.listAnswerLines(note).lines.map(n => Model.rawText(n)));
    }

    function openChipMenu(row) {
      settleTyping();
      const id = row.dataset.id;
      const st = id ? chipStateOf(id) : null;
      if (!st) return;
      const restore = caretNow();
      menuCaret = restore;
      CardMenu.chip({
        key: "chip:" + id,
        anchor: () => { const r = rowById(id); return r && r.querySelector(".trig-text"); },
        state: st,
        apply: change => applyChip(id, change),
        preview: () => peekOf(id),
        // The caret goes back first, so the sheet gives the focus back to it.
        cardInfo: cardId => { putCaretBack(restore); if (showCardInfo) showCardInfo(cardId); },
        onClose: () => backToCaret(restore),
      });
    }

    // A BLANK'S MENU (`blankState`, `applyBlankChange`).
    function blankStateOf(id, index) {
      const row = rowById(id);
      const line = row && row.querySelector(".edit-line");
      if (!line) return null;
      const text = read(line).text;
      const spans = ClozeBlanks.spans(text);
      if (!spans[index]) return null;
      return { own: ClozeBlanks.isOwnCard(text, index), canJoin: spans.length > 1, hint: ClozeBlanks.hint(text, index) };
    }

    function applyBlank(id, index, change) {
      const row = rowById(id);
      const line = row && row.querySelector(".edit-line");
      if (!line) return null;
      settle(row);
      const cur = read(line);
      const edit = change.remove ? ClozeBlanks.removing(cur.text, index)
        : typeof change.own === "boolean" ? ClozeBlanks.settingOwnCard(cur.text, index, change.own)
        : ClozeBlanks.settingHint(cur.text, index, change.hint);
      if (!edit) return null;
      const text = cur.text.slice(0, edit.start) + edit.text + cur.text.slice(edit.end);
      try {
        transact(() => { draw(line, text, Spans.mapped(cur.runs, edit.start, edit.end - edit.start, edit.text.length)); commit(row); });
      } catch (error) { report(error); return null; }
      shiftMenuCaret(id, edit.end, edit.text.length - (edit.end - edit.start));
      changedNow();
      return change.remove ? null : blankStateOf(id, index);
    }

    function openBlankMenu(row, index) {
      settle(row);
      const id = row.dataset.id;
      const st = id ? blankStateOf(id, index) : null;
      if (!st) return;
      const restore = caretNow();
      menuCaret = restore;
      CardMenu.blank({
        key: `blank:${id}:${index}`,
        anchor: () => { const r = rowById(id); return r && r.querySelector(`.cz[data-blank="${index}"]`); },
        state: st,
        apply: change => applyBlank(id, index, change),
        onClose: () => backToCaret(restore),
      });
    }

    // The ▾ is drawn after the blank's words, inside its box, on its last line.
    function inCorner(event, box) {
      const rects = box.getClientRects();
      const r = rects[rects.length - 1];
      return !!r && event.clientX >= r.right - 16 && event.clientX <= r.right + 2
        && event.clientY >= r.top - 2 && event.clientY <= r.bottom + 2;
    }

    // A closed menu gives the caret back where it was, unless the press that
    // closed it put the focus somewhere else.
    function backToCaret(c) {
      if (menuCaret === c) menuCaret = null;
      setTimeout(() => {
        if (destroyed || !c || UI.sheetOpen() || CardMenu.isOpen()) return;
        const a = document.activeElement;
        if (a && a !== document.body) return;
        putCaretBack(c);
      }, 0);
    }

    function putCaretBack(c) {
      const row = c && rowById(c.id);
      const line = row && row.querySelector(".edit-line");
      if (!line) return;
      const len = read(line).text.length;
      select(line, Math.min(c.start, len), Math.min(c.end, len));
    }

    // --------------------------------------------------------- formatting

    // The selection the format bar acts on: the live one, or the last one a
    // menu took the focus from. In a TABLE CELL (D-189) `line` is the cell,
    // `tr` its row and `col` its column, and there is no `row`.
    function target() {
      const line = active && container.contains(active) ? active : null;
      if (!line) return null;
      let sel = document.activeElement === line ? selectionIn(line) : null;
      if (!sel) sel = lastSel;
      if (!sel) return null;
      if (line.classList.contains("cell-edit")) {
        return { line, row: null, tr: line.closest("tr"), col: Number(line.dataset.col || 0), cell: true, sel };
      }
      return { line, row: line.closest(".edit-row"), sel };
    }

    // Typing not yet saved is saved first, as its own undo step.
    function settleTarget(t) {
      if (t.cell) { if (rowTimers.has(t.tr)) saveRow(t.tr); }
      else settle(t.row);
    }

    // New text and runs for what a command acts on, written as one undo
    // step: a line commits; a cell's row saves its runs cell by cell.
    function applyRuns(t, text, runs) {
      if (t.cell) transact(() => { paint(t.line, text, runs); saveRow(t.tr); });
      else transact(() => { draw(t.line, text, runs); commit(t.row); });
    }

    function wordAround(text, at) {
      let a = at, b = at;
      while (a > 0 && /\S/.test(text[a - 1])) a--;
      while (b < text.length && /\S/.test(text[b])) b++;
      return { start: a, end: b };
    }

    // Toggles one inline style over the selection (`InlineSpans.toggle`); an
    // empty selection takes the word around the caret. A style never lands
    // on a picture token or on whitespace at either end (`styleableRanges`).
    // D-189: A CELL TAKES THE STYLES A LINE TAKES (bold, italic, underline,
    // strikethrough, highlight, a link, the two scripts), never a size of its
    // own: a table has one text size.
    function format(kind, value) {
      const t = target();
      if (!t) return false;
      // A size asked in a cell is the TABLE's (`canvasFontTableTarget`): a
      // table is painted as one block, so the face belongs to the table.
      if (t.cell && kind === "z") return setTableSize(t, value);
      settleTarget(t);
      const cur = read(t.line);
      let { start, end } = t.sel;
      if (start === end) ({ start, end } = wordAround(cur.text, start));
      if (start === end) return false;
      const parts = Spans.styleableRanges(cur.text, start, end);
      if (!parts.length) return false;
      let runs = cur.runs;
      if (value === null && (kind === "h" || kind === "z")) {
        for (const p of parts) runs = Spans.remove(runs, [kind], p.start, p.end);
      } else if (value == null && parts.every(p => Spans.covers(runs, kind, p.start, p.end))) {
        for (const p of parts) runs = Spans.remove(runs, [kind], p.start, p.end);
      } else {
        for (const p of parts) {
          if (value != null) runs = Spans.remove(runs, [kind], p.start, p.end);
          runs = Spans.normalize([...runs, { start: p.start, end: p.end, kind, value: value ?? null }], cur.text.length);
        }
      }
      applyRuns(t, cur.text, runs);
      select(t.line, t.sel.start, t.sel.end);
      lastSel = t.sel;
      return true;
    }

    // THE TABLE'S TEXT SIZE (`setTableFont`): the menu's number (11 when it
    // names the document's own), one undo step, the caret kept in its cell.
    function setTableSize(t, value) {
      const tableId = t.tr.closest(".edit-table").dataset.id;
      const caret = { rowId: t.tr.dataset.rowId, col: t.col, sel: t.sel };
      settleTarget(t);
      let wrote = false;
      try { wrote = transact(() => Store.setTableFontSize(tableId, value == null ? 11 : value)); } catch (error) { report(error); return false; }
      if (!wrote) return false;
      changedNow();
      render();
      const cell = cellAt(caret.rowId, caret.col);
      if (cell) { const len = read(cell).text.length; select(cell, Math.min(caret.sel.start, len), Math.min(caret.sel.end, len)); }
      return true;
    }

    // THE LINK COMMAND (D-011, ⌘L and the strip's link button, D-190): over a
    // link it takes the WHOLE link off; words that are an address link to it
    // with no question; other words ask for the address; nothing selected
    // says what it needs. Nothing links a bare URL unasked.
    function linkCommand() {
      const t = target();
      if (!t) { notice("Select the words to link."); return false; }
      settleTarget(t);
      const cur = read(t.line);
      const { start, end } = t.sel;
      const links = cur.runs.filter(r => r.kind === "l");
      const touched = end === start
        ? links.filter(r => start > r.start && start <= r.end).slice(0, 1)
        : links.filter(r => r.start < end && r.end > start);
      if (touched.length) {
        const runs = Spans.normalize(cur.runs.filter(r => !touched.includes(r)), cur.text.length);
        applyRuns(t, cur.text, runs);
        select(t.line, start, end);
        return true;
      }
      if (end === start) { notice("Select the words to link."); return false; }
      const words = cur.text.slice(start, end);
      const self = Spans.selfLink(words);
      const range = { start, end };
      const where = t.cell ? { rowId: t.tr.dataset.rowId, col: t.col } : { noteId: ensureNote(t.row) };
      if (self) return applyLink(where, range, self);
      const oneToken = !/\s/.test(words);
      if (askLink) askLink(oneToken ? words : "", address => applyLink(where, range, address));
      return true;
    }

    // Links `range` of the line or cell (as it was when the question was
    // asked) to `address`, or says why not. It is found by its note (a cell by
    // its row and column): another device's row may have redrawn the editor
    // while the question was up.
    function applyLink(where, range, address) {
      const value = Spans.linkTarget(address);
      if (!value) { notice("That is not an address a link can open."); return false; }
      if (stale && !container.contains(document.activeElement)) render();
      const t = locate(where);
      if (!t) return false;
      const cur = read(t.line);
      let runs = cur.runs;
      for (const p of Spans.styleableRanges(cur.text, range.start, Math.min(range.end, cur.text.length))) {
        runs = Spans.remove(runs, ["l"], p.start, p.end);
        runs = Spans.normalize([...runs, { start: p.start, end: p.end, kind: "l", value }], cur.text.length);
      }
      applyRuns(t, cur.text, runs);
      select(t.line, range.start, range.end);
      lastSel = { ...range };
      return true;
    }

    // A line by its note, or a cell by its row and column, as `target` names it.
    function locate(where) {
      if (where.rowId) {
        const cell = cellAt(where.rowId, where.col);
        return cell ? { line: cell, row: null, tr: cell.closest("tr"), col: where.col, cell: true } : null;
      }
      const row = container.querySelector(`.edit-row[data-id="${where.noteId}"]`);
      const line = row && row.querySelector(".edit-line");
      return line ? { line, row } : null;
    }

    const cellAt = (rowId, col) => container.querySelector(`tr[data-row-id="${rowId}"] .cell-edit[data-col="${col}"]`);

    // MAKE CLOZE (⇧⌥⌘C, v0.8 owner ruling 8): the selection wrapped in
    // `{{cN::...}}`, N one past the line's highest ordinal, or the line's LAST
    // ordinal with `sameCard` (⌃⇧⌘C: one card hides two blanks). Refused on a
    // line that is already a card and in a cell; one line at a time.
    function makeCloze(sameCard = false) {
      const t = target();
      if (t && t.cell) {
        notice("A table cell cannot hold a cloze. Make it on a line of its own.");
        return false;
      }
      if (!t || t.sel.start === t.sel.end) { notice("Select the words to hide, then make a cloze."); return false; }
      const id = t.row.dataset.id;
      const cur = read(t.line);
      const isCloze = Gate.clozeOrdinals(cur.text).length > 0;
      if (id && hasCard(id) && !isCloze) { notice("This line is already a card. Cloze belongs on a plain line."); return false; }
      const hidden = cur.text.slice(t.sel.start, t.sel.end);
      if (!/\S/.test(hidden)) { notice("Select the words to hide, then make a cloze."); return false; }
      const used = Math.max(0, ...Gate.clozeOrdinals(cur.text));
      const next = sameCard ? Math.max(1, used) : used + 1;
      const open = `{{c${next}::`;
      const text = cur.text.slice(0, t.sel.start) + open + hidden + "}}" + cur.text.slice(t.sel.end);
      let runs = Spans.mapped(cur.runs, t.sel.end, 0, 2);
      runs = Spans.mapped(runs, t.sel.start, 0, open.length);
      const caret = t.sel.start + open.length + hidden.length + 2;
      settle(t.row);
      transact(() => { draw(t.line, text, runs); commit(t.row); });
      select(t.line, caret);
      lastSel = { start: caret, end: caret };
      lastEdit = null;
      return true;
    }

    // Removes every inline style over the selection (`clearFormatting`).
    function clearFormat() {
      const t = target();
      if (!t) return false;
      settleTarget(t);
      const cur = read(t.line);
      const { start, end } = t.sel.start === t.sel.end ? { start: 0, end: cur.text.length } : t.sel;
      applyRuns(t, cur.text, Spans.remove(cur.runs, null, start, end));
      select(t.line, t.sel.start, t.sel.end);
      return true;
    }

    function setKind(kind) {
      if (blockSel && selectedBlocks().length > 1) { kindForSelectedBlocks(kind); return true; }
      const t = target();
      if (!t) return false;
      // A cell is one run of text, not a paragraph (D-189).
      if (t.cell) { notice("A heading, a list or a quote does not apply inside a table's cells."); return false; }
      settle(t.row);
      let id = null;
      try { transact(() => { commit(t.row); id = ensureNote(t.row); Store.setKind(id, kind); }); } catch (error) { report(error); return false; }
      const note = Backend.get("note", id);
      const block = Model.build([note], new Map(), new Set())[0];
      draw(t.line, displayText(block), displayRuns(block));
      remember(t.line, id);
      restyle(t.row, kind);
      select(t.line, Math.min(read(t.line).text.length, t.sel.end));
      changedNow();
      return true;
    }

    // `Make card` (⇧⌘C, `DocsDocument.makeCardEdit`, D-191's `>>`): a
    // selection becomes the answer side (`head >> answer tail`, the caret
    // after the answer); with none, `>> ` lands at the caret (no space before
    // it after a space or at the line's start). A line that already has its
    // card selects its trigger instead.
    function makeCard() {
      const t = target();
      if (!t) return false;
      if (t.cell) { notice("A table row cannot be a card. Make the card on a line of its own."); return false; }
      // D-191: WITH A SELECTION, ⇧⌘C MAKES A BLANK (own card, SPEC's
      // "Cloze"); with none it makes a card as before.
      if (t.sel.end > t.sel.start) return makeCloze(false);
      const cur = read(t.line);
      const id = t.row.dataset.id;
      if (id && hasCard(id)) {
        const hit = Gate.separatorHits(cur.text)[0];
        if (hit && !Gate.clozeOrdinals(cur.text).length) { select(t.line, hit.start, hit.end); lastSel = { start: hit.start, end: hit.end }; }
        return true;
      }
      const { start, end } = t.sel;
      let text, caret, runs;
      if (end > start) {
        text = cur.text.slice(0, start) + " >> " + cur.text.slice(start, end) + cur.text.slice(end);
        runs = Spans.mapped(cur.runs, start, 0, 4);
        caret = start + 4 + (end - start);
      } else {
        const head = cur.text.slice(0, start);
        const glue = head.endsWith(" ") || head === "" ? ">> " : " >> ";
        text = head + glue + cur.text.slice(start);
        runs = Spans.mapped(cur.runs, start, 0, glue.length);
        caret = start + glue.length;
      }
      draw(t.line, text, runs);
      select(t.line, caret);
      lastSel = { start: caret, end: caret };
      scheduleCommit(t.row);
      return true;
    }

    // Wraps the selection in two markers (`ƒ(x)` wraps it in `$`, so the
    // canvas renders it as a formula); an empty selection puts the caret
    // between them.
    function wrap(before, after) {
      const t = target();
      if (!t) return false;
      // A table is one drawn block: the canvas renders no formula in a cell.
      if (t.cell) { notice("A formula does not apply inside a table's cells."); return false; }
      const cur = read(t.line);
      const { start, end } = t.sel;
      const text = cur.text.slice(0, start) + before + cur.text.slice(start, end) + after + cur.text.slice(end);
      let runs = Spans.mapped(cur.runs, end, 0, after.length);
      runs = Spans.mapped(runs, start, 0, before.length);
      draw(t.line, text, runs);
      select(t.line, start + before.length, end + before.length);
      lastSel = { start: start + before.length, end: end + before.length };
      scheduleCommit(t.row);
      return true;
    }

    // The state the format bar draws: the kind of the line and the styles
    // over its selection.
    function state() {
      const t = target();
      if (!t) return null;
      const cur = read(t.line);
      const on = {};
      for (const k of ["b", "i", "n", "s", "h", "p", "u", "l"]) on[k] = Spans.covers(cur.runs, k, t.sel.start, t.sel.end);
      if (t.cell) {
        const table = Backend.get("note", t.tr.closest(".edit-table").dataset.id);
        const ts = table ? Model.decodeAttrs(table.attrs).tableFontSize : null;
        return { kind: "paragraph", on, size: ts, noteId: t.tr.dataset.rowId, cell: true };
      }
      const z = cur.runs.find(r => r.kind === "z" && r.start <= t.sel.start && r.end >= Math.max(t.sel.end, t.sel.start + 1));
      return { kind: t.row.dataset.kind, on, size: z ? Number(z.value) : null, noteId: t.row.dataset.id };
    }

    // The note a new block goes after: the focused line's, else the last.
    function anchorId() {
      const t = target();
      if (t && t.cell) return t.tr.closest(".edit-table").dataset.id;
      if (t && t.row.dataset.id) return t.row.dataset.id;
      const all = [...container.querySelectorAll("[data-id]")];
      const last = all[all.length - 1];
      return last ? (last.dataset.table || last.dataset.id) : null;
    }

    // -------------------------------------------------------------- tables

    function tableBlock(block) {
      const tb = Store.tableOf(block.id);
      const wrap = h("div.edit-table", { dataset: { id: block.id, table: block.id } });
      if (!tb) return wrap;
      const cols = tb.cardTable ? 2 : Math.max(1, ...tb.rows.map(r => Store.rowCells(r, false).length));
      const grid = h("table.table-grid.editing");
      // The table's own text size (`ts`), else the document's; its stored
      // column widths fitted into the measure, else content sized.
      if (block.attrs.tableFontSize) grid.style.fontSize = (block.attrs.tableFontSize * 96 / 72).toFixed(3) + "px";
      const widths = Render.tableWidths(block, cols, availableWidth());
      const body = h("tbody");
      tb.rows.forEach((r, ri) => {
        const cells = Store.rowCells(r, tb.cardTable);
        // D-189: each cell's style, its row's runs clipped at its edges.
        const runs = Spans.cellRuns(Model.rawText({ ...r, kind: "tablerow" }), Store.rowRunsOf(r), tb.cardTable);
        while (cells.length < cols) cells.push("");
        const tr = h("tr", { dataset: { rowId: r.id } });
        if (ri === 0 && tb.header) tr.classList.add("header-row");
        // A card row of either kind (a normal row gates on a cell's `::`).
        if (hasCard(r.id)) tr.classList.add("card");
        cells.slice(0, cols).forEach((c, ci) => {
          const cell = h("div.cell-edit", { contenteditable: "true", spellcheck: spell ? "true" : "false", role: "textbox",
                                             "aria-label": `Row ${ri + 1}, column ${ci + 1}`, dataset: { col: String(ci) } });
          const td = h("td", cell);
          if (widths && ri === 0) td.style.width = widths[ci].toFixed(2) + "px";
          if (lang) cell.setAttribute("lang", lang);
          paint(cell, c, runs[ci] || []);
          cellShown.set(cell, heldKey(read(cell)));
          cell.addEventListener("focus", () => {
            active = cell;
            if (blockSel) clearBlockSel();
            if (onFocusLine) onFocusLine(api);
          });
          cell.addEventListener("input", () => scheduleRowSave(tr));
          // A cell's link opens as a line's does (D-189's ruling).
          cell.addEventListener("mousedown", event => { openLinkFrom(event, cell); });
          cell.addEventListener("blur", () => { lastSel = selectionIn(cell) || lastSel; saveRow(tr); });
          cell.addEventListener("beforeinput", cellInput);
          cell.addEventListener("paste", e => pasteInCell(e, cell, tr));
          cell.addEventListener("keydown", e => cellKey(e, wrap, tr, ci, cols));
          tr.appendChild(td);
        });
        // E18: a card table's header is a label and is never deleted.
        const del = tb.cardTable && tb.header && ri === 0 ? h("span.row-delete-none") : h("button.row-delete", { type: "button", title: "Delete row", "aria-label": `Delete row ${ri + 1}`, text: "×",
          onclick: () => { try { if (transact(() => Store.deleteTableRow(r.id))) { changedNow(); render(); } } catch (error) { report(error); } } });
        tr.appendChild(h("td.row-tools", del));
        body.appendChild(tr);
      });
      grid.appendChild(body);
      if (widths) {
        grid.classList.add("fixed");
        grid.style.width = (widths.reduce((a, w) => a + w, 0) + ROW_TOOLS).toFixed(2) + "px";
      }
      wireColumnResize(grid, block.id, cols);
      const tools = h("div.block-bar",
        chip("Row", { onclick: () => { try { transact(() => Store.addTableRow(block.id)); changedNow(); render(); } catch (error) { report(error); } }, title: "Add a row" }),
        tb.cardTable ? null : chip("Column", { onclick: () => { try { transact(() => Store.addTableColumn(block.id)); changedNow(); render(); } catch (error) { report(error); } }, title: "Add a column" }),
        tb.cardTable || cols <= 1 ? null : chip("Remove last column", { onclick: () => { try { transact(() => Store.deleteTableColumn(block.id, cols - 1)); changedNow(); render(); } catch (error) { report(error); } } }),
        chip("Header row", { on: tb.header, onclick: () => { try { transact(() => Store.setTableHeader(block.id, !tb.header)); changedNow(); render(); } catch (error) { report(error); } } }),
        // FIT TO PAGE (Ink 18 R26) forgets the stored widths, so the table is
        // content sized again; offered only when it would change something.
        widths ? chip("Fit to page", { title: "Size the columns to their content", onclick: () => {
          try { if (transact(() => Store.setTableWidths(block.id, []))) { changedNow(); render(); } } catch (error) { report(error); }
        } }) : null,
        tb.cardTable ? h("span.bar-note", { text: "Card table: each row is a card" }) : null,
        h("span.spacer"),
        chip("Delete table", { className: "danger", onclick: () => { try { transact(() => Store.deleteTable(block.id)); changedNow(); render(); } catch (error) { report(error); } } }));
      wrap.append(grid, tools);
      return wrap;
    }

    // ------------------------------------------------ column widths (drag)
    //
    // A COLUMN EDGE IS A HANDLE (`tableResizeHit`, O4): within 7pt of a
    // column's right rule (the table's right edge included) the pointer
    // takes the column; the drag moves that column alone, never under 44pt
    // (`TableBlock.minimumColumnWidth`), live, and the store takes the
    // widths ONCE, when the button rises, as the table draws them (fitted
    // into the measure): one undo step, synced as any width change is.
    const ROW_TOOLS = 26;
    // The column a table fits into (`canvasTableAvailableWidth`: the
    // measure); the web's row tools hang past it.
    function availableWidth() {
      const c = canvasEl();
      const w = c ? c.clientWidth : 0;
      return w > 0 ? Math.min(w, Render.MEASURE) : Render.MEASURE;
    }

    // The data columns' drawn widths, from the first row's cells.
    function drawnWidths(grid, cols) {
      const first = grid.querySelector("tr");
      if (!first) return [];
      return [...first.children].slice(0, cols).map(td => td.getBoundingClientRect().width);
    }

    let columnDrag = null;
    function wireColumnResize(grid, tableId, cols) {
      if (cols < 2) return;
      const edge = event => {
        const r = grid.getBoundingClientRect();
        if (event.clientY < r.top || event.clientY > r.bottom) return -1;
        return Geometry.edgeAt(event.clientX - r.left, drawnWidths(grid, cols));
      };
      grid.addEventListener("mousemove", event => {
        if (columnDrag) return;
        grid.classList.toggle("col-resize", edge(event) >= 0);
      });
      grid.addEventListener("mouseleave", () => { if (!columnDrag) grid.classList.remove("col-resize"); });
      grid.addEventListener("mousedown", event => {
        if (event.button !== 0) return;
        const column = edge(event);
        if (column < 0) return;
        // The edge, not the cell under it: no caret, no block set.
        event.preventDefault();
        event.stopPropagation();
        settleTyping();
        columnDrag = { grid, tableId, column, x: event.clientX, start: drawnWidths(grid, cols), widths: null };
        grid.classList.add("col-resize", "resizing");
      }, true);
    }

    function paintWidths(grid, widths) {
      grid.classList.add("fixed");
      const first = grid.querySelector("tr");
      if (first) widths.forEach((w, i) => { if (first.children[i]) first.children[i].style.width = w.toFixed(2) + "px"; });
      grid.style.width = (widths.reduce((a, w) => a + w, 0) + ROW_TOOLS).toFixed(2) + "px";
    }

    function onColumnMove(event) {
      if (!columnDrag) return;
      event.preventDefault();
      columnDrag.widths = Geometry.resizeColumn(columnDrag.start, columnDrag.column, event.clientX - columnDrag.x);
      paintWidths(columnDrag.grid, columnDrag.widths);
    }

    function onColumnUp() {
      if (!columnDrag) return;
      const drag = columnDrag;
      columnDrag = null;
      drag.grid.classList.remove("resizing", "col-resize");
      if (!drag.widths) return;
      try {
        if (transact(() => Store.setTableWidths(drag.tableId, Geometry.fit(drag.widths, availableWidth())))) changedNow();
      } catch (error) { report(error); }
      render();
    }

    const rowTimers = new Map();
    // What each cell SHOWS, as painted or last saved: a row whose cells all
    // still show it is never written (a line's web-5 rule), so the blur a
    // redraw gives a removed cell cannot write back what an undo replaced.
    const cellShown = new WeakMap();
    const heldKey = held => JSON.stringify([held.text, held.runs]);
    function scheduleRowSave(tr) {
      clearTimeout(rowTimers.get(tr));
      rowTimers.set(tr, setTimeout(() => saveRow(tr), 700));
    }

    // A row's cells, text and runs as the browser holds them, saved as the
    // row's text and its `spans` (D-189, `Store.saveTableRow`).
    function saveRow(tr) {
      clearTimeout(rowTimers.get(tr));
      rowTimers.delete(tr);
      // A row a redraw took away holds what the store said before it (the
      // browser blurs a removed cell): saving it would undo the redraw.
      if (!tr.isConnected) return;
      const els = [...tr.querySelectorAll(".cell-edit")];
      const held = els.map(c => read(c));
      if (els.every((c, i) => cellShown.get(c) === heldKey(held[i]))) return;
      try {
        if (transact(() => Store.saveTableRow(tr.dataset.rowId, held.map(x => x.text), Date.now(), held.map(x => x.runs)))) changedNow();
        els.forEach((c, i) => cellShown.set(c, heldKey(held[i])));
        tr.classList.toggle("card", hasCard(tr.dataset.rowId));
      } catch (error) { report(error); }
    }

    // The browser's own style commands in a cell (its ⌘B and the Edit menu)
    // become the sidecar's, as a line's do; a line break is never typed into
    // a cell (Return is the next row).
    const INPUT_STYLES = { formatBold: "b", formatItalic: "i", formatUnderline: "n", formatStrikeThrough: "s",
                           formatSuperscript: "p", formatSubscript: "u" };
    function cellInput(event) {
      const t = event.inputType || "";
      if (INPUT_STYLES[t]) { event.preventDefault(); format(INPUT_STYLES[t]); }
      else if (t === "historyUndo") { event.preventDefault(); undoStep(); }
      else if (t === "historyRedo") { event.preventDefault(); redoStep(); }
      else if (t.startsWith("format") || t === "insertParagraph" || t === "insertLineBreak" || t === "insertFromDrop") event.preventDefault();
    }

    // A paste into a cell is typing: plain text, one line, the cell's runs
    // mapped through it as a line's are (sticky right; a run wholly replaced
    // goes, landmine 88).
    function pasteInCell(event, cell, tr) {
      event.preventDefault();
      const text = (event.clipboardData ? event.clipboardData.getData("text/plain") : "").replace(/[\t\r\n]+/g, " ");
      if (!text) return;
      const sel = selectionIn(cell) || { start: 0, end: 0 };
      const cur = read(cell);
      const runs = Spans.mapped(cur.runs, sel.start, sel.end - sel.start, text.length);
      const next = cur.text.slice(0, sel.start) + text + cur.text.slice(sel.end);
      paint(cell, next, Spans.normalize(runs, next.length));
      select(cell, sel.start + text.length);
      scheduleRowSave(tr);
    }

    function cellKey(e, wrap, tr, ci, cols) {
      const cellsIn = row => [...row.querySelectorAll(".cell-edit")];
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && k === "z") {
        e.preventDefault();
        saveRow(tr);
        if (e.shiftKey) redoStep(); else undoStep();
        return;
      }
      // D-189: the style keys act on the cell's selection as on a line's; a
      // heading, a card or a cloze says why it does not apply.
      if (mod && !e.altKey) {
        const shortcut = !e.shiftKey ? SHORTCUTS[k] : SHIFT_SHORTCUTS[k];
        if (shortcut) { e.preventDefault(); format(shortcut); return; }
        if (!e.shiftKey && k === "l") { e.preventDefault(); linkCommand(); return; }
        if (!e.shiftKey && k === "\\") { e.preventDefault(); clearFormat(); return; }
      }
      if (e.metaKey && e.shiftKey && (e.code === "KeyC" || k === "c")) {
        e.preventDefault();
        if (e.altKey || e.ctrlKey) makeCloze(); else makeCard();
        return;
      }
      if (mod && e.altKey && !e.shiftKey && /^Digit[123]$/.test(e.code || "")) {
        e.preventDefault();
        setKind("heading" + e.code.slice(5));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const all = [...wrap.querySelectorAll(".cell-edit")];
        const at = all.indexOf(e.target);
        const next = all[at + (e.shiftKey ? -1 : 1)];
        if (next) next.focus();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        saveRow(tr);
        const nextRow = tr.nextElementSibling;
        if (nextRow) { cellsIn(nextRow)[ci].focus(); return; }
        try {
          const id = transact(() => Store.addTableRow(wrap.dataset.id, tr.dataset.rowId));
          changedNow();
          render();
          const made = container.querySelector(`tr[data-row-id="${id}"] .cell-edit`);
          if (made) made.focus();
        } catch (error) { report(error); }
      }
    }

    // ---------------------------------------------------- pictures, diagrams

    function pictureBlock(block, ctx) {
      const wrap = h("div.edit-picture", { dataset: { id: block.id } });
      wrap.tabIndex = -1;
      const mediaId = block.attrs.mediaId;
      const row = mediaId ? Media.row(mediaId) : null;
      const drawing = row && Media.isDrawing(row);
      // CROP MODE shows the WHOLE picture to choose from (`beginCrop`).
      const croppingThis = !!(cropping && row && cropping.mediaId === row.id);
      const figure = h("div.blk.blk-image", { dataset: { noteId: block.id } });
      figure.appendChild(mediaId ? ctx.picture(mediaId, croppingThis ? { noteId: block.id, crop: null } : { noteId: block.id })
                                 : Render.missing("This picture has no media row."));
      wrap.appendChild(figure);
      if (row && !drawing) wirePicture(wrap, block.id, row.id);
      const width = (row && row.display_width) || block.attrs.mediaWidth || null;
      const size = delta => {
        const cur = width || 420;
        try { transact(() => Store.setPictureWidth(block.id, row.id, Geometry.clampWidth(cur + delta, availableWidth()))); changedNow(); render(); } catch (error) { report(error); }
      };
      const cropped = !!(row && Geometry.parseCrop(row.crop));
      const bar = h("div.block-bar",
        row ? chip("Smaller", { onclick: () => size(-60), title: "Draw it narrower" }) : null,
        row ? chip("Larger", { onclick: () => size(60), title: "Draw it wider" }) : null,
        row && !drawing && !croppingThis ? chip("Crop", { title: "Choose the part of the picture that shows", onclick: () => beginCrop(block.id, row.id) }) : null,
        row && !drawing && cropped && !croppingThis ? chip("Show whole picture", { onclick: () => resetCrop(row.id) }) : null,
        drawing && openDrawing ? chip("Edit drawing", { onclick: () => openDrawing({ noteId: block.id, mediaId: row.id }) }) : null,
        !drawing && row && openOcclusion ? chip("Label parts", { title: "Make a diagram whose parts are cards",
          onclick: () => openOcclusion({ fromPicture: { noteId: block.id, mediaId: row.id, sha: row.bytes_sha, mime: row.mime } }) }) : null,
        h("span.spacer"),
        chip("Delete", { className: "danger", onclick: () => { try { transact(() => Store.deleteLine(block.id)); changedNow(); render(); } catch (error) { report(error); } } }));
      wrap.appendChild(bar);
      return wrap;
    }

    // ------------------------------------ a picture: select, resize, crop
    //
    // A PICTURE IS AN OBJECT (O1, landmine 100): a click selects it, framed
    // in the accent with a handle at each corner (Ink 17 section 6, D24);
    // Backspace or Delete takes it away; Escape or a click elsewhere lets it
    // go. ANY corner resizes it (`CanvasImageResize`), keeping its shape (one
    // stored number, `media.display_width`), anchored where the column puts
    // it, between 96pt and the measure; the store takes the width once, when
    // the button rises. CROP is a MODE (`CanvasImageCrop`): the whole
    // picture shows, what goes is washed out, four corners move the crop,
    // and Reset, Cancel and Done sit inside the picture's bottom left
    // (Return and Escape too); a click elsewhere commits. A crop that would
    // hide a live mask is refused and says which (C-26).
    let selectedPicture = null;   // the framed picture's note id
    let cropping = null;          // { noteId, mediaId, draft }
    let pictureDrag = null;       // a resize or a crop corner held

    function pictureWrap(noteId) { return container.querySelector(`.edit-picture[data-id="${noteId}"]`); }

    // The drawn picture inside a block's figure (the image, its crop frame or
    // its diagram holder), once its bytes have arrived.
    function drawnPicture(wrap) {
      const holder = wrap && wrap.querySelector(".blk-image > .figure");
      if (!holder) return null;
      return [...holder.children].find(n => !n.classList.contains("pic-chrome") && !n.classList.contains("missing")) || null;
    }

    function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
    const place = (el, r) => { el.style.left = r.x + "px"; el.style.top = r.y + "px"; el.style.width = r.w + "px"; el.style.height = r.h + "px"; };

    // The frame and handles, or the crop's wash, rectangle, corners and
    // chips, drawn over the picture in its own coordinates.
    function decoratePicture(wrap) {
      if (!wrap) return;
      const holder = wrap.querySelector(".blk-image > .figure");
      if (!holder) return;
      for (const old of holder.querySelectorAll(".pic-chrome")) old.remove();
      const id = wrap.dataset.id;
      const drawn = drawnPicture(wrap);
      const isCropping = !!(cropping && cropping.noteId === id);
      wrap.classList.toggle("picture-selected", selectedPicture === id && !isCropping);
      if (!drawn || (selectedPicture !== id && !isCropping)) return;
      const pic = rectOf(drawn);
      const layer = h("span.pic-chrome", { "aria-hidden": "true" });
      place(layer, { x: 0, y: 0, w: pic.w, h: pic.h });
      if (isCropping) {
        const c = Geometry.cropRect(cropping.draft, { x: 0, y: 0, w: pic.w, h: pic.h });
        for (const band of [{ x: 0, y: 0, w: pic.w, h: c.y }, { x: 0, y: c.y + c.h, w: pic.w, h: pic.h - c.y - c.h },
                            { x: 0, y: c.y, w: c.x, h: c.h }, { x: c.x + c.w, y: c.y, w: pic.w - c.x - c.w, h: c.h }]) {
          if (band.w > 0 && band.h > 0) { const b = h("span.crop-band"); place(b, band); layer.appendChild(b); }
        }
        const frame = h("span.crop-rect");
        place(frame, c);
        layer.appendChild(frame);
        for (const corner of ["topLeft", "topRight", "bottomLeft", "bottomRight"]) {
          const handle = h("span.crop-handle", { dataset: { corner } });
          place(handle, Geometry.cropHandle(corner, c));
          layer.appendChild(handle);
        }
        const chips = h("span.crop-chips");
        chips.style.left = "8px";
        chips.style.top = Math.max(0, pic.h - 24 - 8) + "px";
        const act = (label, run, primary) => {
          const b = h("button.crop-chip" + (primary ? ".primary" : ""), { type: "button", text: label });
          b.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
          b.addEventListener("click", e => { e.stopPropagation(); run(); });
          return b;
        };
        chips.append(act("Reset", () => { cropping.draft = { ...Geometry.WHOLE }; decoratePicture(wrap); }),
                     act("Cancel", cancelCrop), act("Done", commitCrop, true));
        layer.appendChild(chips);
      } else {
        layer.appendChild(h("span.pic-frame"));
        for (const corner of ["topLeft", "topRight", "bottomLeft", "bottomRight"]) layer.appendChild(h("span.pic-dot", { dataset: { corner } }));
      }
      holder.appendChild(layer);
    }

    function decoratePictures() {
      for (const wrap of container.querySelectorAll(".edit-picture")) decoratePicture(wrap);
    }

    function selectPicture(noteId) {
      if (selectedPicture === noteId) return;
      const was = selectedPicture;
      selectedPicture = noteId;
      if (was) decoratePicture(pictureWrap(was));
      if (noteId) decoratePicture(pictureWrap(noteId));
    }

    function wirePicture(wrap, noteId, mediaId) {
      wrap.addEventListener("mousedown", event => {
        if (event.button !== 0 || event.target.closest(".block-bar")) return;
        const drawn = drawnPicture(wrap);
        if (!drawn) return;
        const pic = rectOf(drawn);
        const point = { x: event.clientX - pic.x, y: event.clientY - pic.y };
        const box = { x: 0, y: 0, w: pic.w, h: pic.h };
        if (cropping && cropping.noteId === noteId) {
          // CROP MODE owns every press on its picture: a corner drags, and
          // anywhere else on the picture does nothing.
          event.preventDefault();
          event.stopPropagation();
          const corner = Geometry.cropCorner(point, Geometry.cropRect(cropping.draft, box));
          if (corner) pictureDrag = { kind: "crop", wrap, corner, pic };
          return;
        }
        const onPicture = point.x >= -Geometry.RESIZE.slop && point.y >= -Geometry.RESIZE.slop
          && point.x <= pic.w + Geometry.RESIZE.slop && point.y <= pic.h + Geometry.RESIZE.slop;
        if (!onPicture) return;
        event.preventDefault();
        event.stopPropagation();
        if (blockSel) clearBlockSel();
        settleTyping();
        const corner = selectedPicture === noteId ? Geometry.resizeCorner(point, box) : null;
        if (corner) {
          pictureDrag = { kind: "resize", wrap, noteId, mediaId, corner, x: event.clientX, start: pic.w, width: null, drawn, pic };
          wrap.classList.add("resizing");
          return;
        }
        selectPicture(noteId);
        wrap.focus({ preventScroll: true });
      });
      wrap.addEventListener("mousemove", event => {
        if (pictureDrag || selectedPicture !== noteId || cropping) { if (!pictureDrag) wrap.style.removeProperty("cursor"); return; }
        const drawn = drawnPicture(wrap);
        if (!drawn) return;
        const pic = rectOf(drawn);
        const corner = Geometry.resizeCorner({ x: event.clientX - pic.x, y: event.clientY - pic.y }, { x: 0, y: 0, w: pic.w, h: pic.h });
        if (corner) wrap.style.cursor = corner === "topLeft" || corner === "bottomRight" ? "nwse-resize" : "nesw-resize";
        else wrap.style.removeProperty("cursor");
      });
      wrap.addEventListener("keydown", event => {
        if (cropping && cropping.noteId === noteId) {
          if (event.key === "Enter") { event.preventDefault(); commitCrop(); }
          else if (event.key === "Escape") { event.preventDefault(); cancelCrop(); }
          return;
        }
        if (selectedPicture !== noteId) return;
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          selectedPicture = null;
          try { if (transact(() => Store.deleteLine(noteId))) { changedNow(); render(); } } catch (error) { report(error); }
        } else if (event.key === "Escape") {
          event.preventDefault();
          selectPicture(null);
        }
      });
    }

    function onPictureMove(event) {
      if (!pictureDrag) return;
      event.preventDefault();
      const d = pictureDrag;
      if (d.kind === "resize") {
        d.width = Geometry.clampWidth(Geometry.resizedWidth(d.start, event.clientX - d.x, d.corner), availableWidth());
        // Live: the picture follows the pointer, nothing is written.
        const k = d.width / d.start;
        d.drawn.style.transformOrigin = "0 0";
        d.drawn.style.transform = `scale(${k})`;
        const holder = d.drawn.parentElement;
        holder.style.width = d.width + "px";
        holder.style.height = d.pic.h * k + "px";
        const layer = holder.querySelector(".pic-chrome");
        if (layer) place(layer, { x: 0, y: 0, w: d.width, h: d.pic.h * k });
      } else {
        const drawn = drawnPicture(d.wrap);
        if (!drawn) return;
        const pic = rectOf(drawn);
        cropping.draft = Geometry.adjustCrop(cropping.draft, d.corner, { x: event.clientX - pic.x, y: event.clientY - pic.y },
                                             { x: 0, y: 0, w: pic.w, h: pic.h });
        decoratePicture(d.wrap);
      }
    }

    function onPictureUp() {
      if (!pictureDrag) return;
      const d = pictureDrag;
      pictureDrag = null;
      d.wrap.classList.remove("resizing");
      if (d.kind !== "resize" || d.width == null) return;
      // The end of the drag, and the only write it makes.
      try { if (transact(() => Store.setPictureWidth(d.noteId, d.mediaId, d.width))) changedNow(); } catch (error) { report(error); }
      render();
    }

    // A press anywhere but the picture being cropped COMMITS the crop (E9):
    // the crop is stored and Show whole picture undoes it, so committing is
    // recoverable where throwing the work away is not.
    function onOutsideCrop(event) {
      if (!cropping || pictureDrag) return;
      const wrap = pictureWrap(cropping.noteId);
      const drawn = wrap && drawnPicture(wrap);
      if (drawn && drawn.parentElement.contains(event.target)) return;
      if (wrap && event.target.closest && event.target.closest(".block-bar") && wrap.contains(event.target)) return;
      commitCrop();
    }

    function beginCrop(noteId, mediaId) {
      settleTyping();
      const row = Media.row(mediaId);
      cropping = { noteId, mediaId, draft: Geometry.parseCrop(row && row.crop) || { ...Geometry.WHOLE } };
      selectedPicture = null;
      render();
      const wrap = pictureWrap(noteId);
      if (wrap) wrap.focus({ preventScroll: true });
    }

    function cancelCrop() {
      if (!cropping) return;
      cropping = null;
      render();
    }

    // Done or Return: keep the choice, unless it would hide a live mask.
    function commitCrop() {
      if (!cropping) return;
      const { mediaId, draft, noteId } = cropping;
      cropping = null;
      let refused = null;
      try { transact(() => { refused = Store.commitCrop(mediaId, draft); }); } catch (error) { report(error); }
      if (refused) notice(refused);
      else changedNow();
      selectedPicture = noteId;
      render();
    }

    function resetCrop(mediaId) {
      try { if (transact(() => Store.setMediaCrop(mediaId, null))) changedNow(); } catch (error) { report(error); }
      render();
    }

    // An occlusion note: its prompt is an editable line; its diagram draws
    // as it does on the page, with the editor one press away.
    function diagramBlock(block, ctx) {
      const wrap = h("div.edit-diagram");
      const row = lineRow(block);
      wrap.appendChild(row);
      const figure = Render.block({ ...block, text: "", runs: [] }, ctx);
      figure.classList.add("diagram-figure");
      wrap.appendChild(figure);
      wrap.appendChild(h("div.block-bar",
        openOcclusion ? chip("Edit diagram", { onclick: () => { commit(row); openOcclusion({ noteId: block.id }); } }) : null,
        h("span.spacer"),
        chip("Delete", { className: "danger", onclick: () => { try { transact(() => Store.deleteLine(block.id)); changedNow(); render(); } catch (error) { report(error); } } })));
      return wrap;
    }

    // ------------------------------------------ find and replace (G10, M9)
    //
    // ⌘F opens the find bar over the doc; it searches the BLOCKS as the
    // store holds them (`Find`, CanvasFind), a table's cells as its rows,
    // never a list or row marker and never inside a picture token. Every
    // match is washed (the CSS highlight registry, so the lines are not
    // repainted), the current one stronger; Return and ⌘G step forward,
    // ⇧Return and ⇧⌘G back. Replace writes the current match, Replace all
    // every one, each as ONE undo step on the rows by id (a replaced line
    // keeps its card and schedule), and says what it did in one line.
    const find = { open: false, hits: [], index: -1, bar: null, query: null, replacement: null, count: null,
                   caseSensitive: false, wholeWord: false };

    function docBlocks() {
      const rows = Backend.doc(docId);
      const flags = new Map();
      for (const c of rows.cards) flags.set(c.note_id, { detached: !!c.detached });
      return Model.build(rows.notes, flags, new Set(Media.diagramsByNote().keys()));
    }

    function findOptions() { return { caseSensitive: find.caseSensitive, wholeWord: find.wholeWord }; }

    function buildFindBar() {
      const input = (placeholder, label) => {
        const el = h("input.find-field", { type: "text", placeholder, "aria-label": label, spellcheck: "false" });
        el.setAttribute("autocomplete", "off");
        return el;
      };
      find.query = input("Find", "Find");
      find.replacement = input("Replace", "Replace with");
      find.count = h("span.find-count", { "aria-live": "polite" });
      const toggle = (label, title, key) => {
        const b = h("button.chip.find-toggle", { type: "button", title, "aria-label": title, "aria-pressed": "false", text: label });
        b.addEventListener("click", () => {
          find[key] = !find[key];
          b.classList.toggle("on", find[key]);
          b.setAttribute("aria-pressed", find[key] ? "true" : "false");
          research(true);
        });
        return b;
      };
      const button = (label, title, run) => h("button.chip", { type: "button", title, "aria-label": title, text: label, onclick: run });
      find.query.addEventListener("input", () => research(true));
      find.query.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
      });
      find.replacement.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); replaceCurrent(); }
      });
      const bar = h("div.find-bar", { role: "search", "aria-label": "Find and replace" },
        h("div.find-row", find.query, find.count,
          button("‹", "Previous match (⇧⌘G)", () => step(-1)), button("›", "Next match (⌘G)", () => step(1)),
          toggle("Aa", "Match case", "caseSensitive"), toggle("Word", "Whole words", "wholeWord")),
        h("div.find-row", find.replacement,
          button("Replace", "Replace this match", replaceCurrent), button("Replace all", "Replace every match", replaceEvery),
          h("span.spacer"), button("Done", "Close find (esc)", closeFind)));
      bar.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); closeFind(); return; }
        const mod = event.metaKey || event.ctrlKey;
        if (mod && !event.altKey && event.key.toLowerCase() === "g") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
        else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); find.query.select(); }
      });
      return bar;
    }

    function openFind() {
      settleTyping();
      // The selection in one line is what is looked for, as a find bar takes it.
      const t = target();
      const seed = t && t.sel && t.sel.end > t.sel.start ? read(t.line).text.slice(t.sel.start, t.sel.end) : "";
      if (!find.bar) find.bar = buildFindBar();
      if (!find.bar.isConnected && container.parentElement) container.parentElement.insertBefore(find.bar, container);
      find.open = true;
      if (seed && !/[\n\t]/.test(seed)) find.query.value = seed;
      find.query.focus();
      find.query.select();
      research(true);
    }

    function closeFind() {
      if (!find.open) return;
      find.open = false;
      const current = find.hits[find.index];
      clearHighlights();
      if (find.bar) find.bar.remove();
      find.hits = [];
      find.index = -1;
      // The match found last is the selection, as the Mac's bar leaves it.
      const r = current && hitDom(current);
      if (r) select(r.el, r.a, r.b);
      else if (active && container.contains(active)) active.focus({ preventScroll: true });
    }

    // The matches again; `fresh` restarts at the first match after the caret.
    function research(fresh = false) {
      if (!find.open) return;
      const q = find.query.value;
      const before = find.hits[find.index] || null;
      find.hits = q ? Find.matches(Find.flattened(docBlocks()), q, findOptions()) : [];
      if (!find.hits.length) find.index = -1;
      else if (fresh || !before) find.index = 0;
      else find.index = Math.min(find.index, find.hits.length - 1);
      paintFind(fresh);
    }

    function step(delta) {
      if (!find.hits.length) return;
      find.index = (find.index + delta + find.hits.length) % find.hits.length;
      paintFind(true);
    }

    // A match as a DOM range: its line (or its row's cell) and the offsets
    // in what that element holds.
    function hitDom(hit) {
      const row = container.querySelector(`.edit-row[data-id="${hit.block}"]`);
      if (row) {
        const line = row.querySelector(".edit-line:not(.edit-face)");
        const note = Backend.get("note", hit.block);
        const block = note ? Model.build([note], new Map(), new Set())[0] : null;
        const cut = block ? Render.hiddenMarkerLength(block.text, block.kind) : 0;
        return line ? { el: line, a: Math.max(0, hit.start - cut), b: Math.max(0, hit.end - cut), row } : null;
      }
      const tr = container.querySelector(`tr[data-row-id="${hit.block}"]`);
      if (!tr) return null;
      const note = Backend.get("note", hit.block);
      const tb = note ? Store.tableOf(note.parent_id) : null;
      if (!tb) return null;
      const text = Model.rawText({ ...note, kind: "tablerow" });
      const cells = Spans.cellRanges(text, tb.cardTable);
      const i = cells.findIndex(c => hit.start >= c.start && hit.end <= c.end);
      const cell = i >= 0 ? tr.querySelector(`.cell-edit[data-col="${i}"]`) : null;
      return cell ? { el: cell, a: hit.start - cells[i].start, b: hit.end - cells[i].start } : null;
    }

    // The Range between two offsets of an element's text, hidden text
    // included (the offsets are the stored text's).
    function textRange(el, a, b) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let pos = 0, start = null, end = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.data.length;
        if (!start && a <= pos + len) start = { node: n, offset: a - pos };
        if (b <= pos + len) { end = { node: n, offset: b - pos }; break; }
        pos += len;
      }
      if (!start || !end) return null;
      const r = document.createRange();
      r.setStart(start.node, start.offset);
      r.setEnd(end.node, end.offset);
      return r;
    }

    const HIGHLIGHTS = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";
    function clearHighlights() {
      if (!HIGHLIGHTS) return;
      CSS.highlights.delete("recall-find");
      CSS.highlights.delete("recall-find-current");
    }

    function paintFind(reveal) {
      const n = find.hits.length;
      find.count.textContent = !find.query.value ? "" : n ? `${find.index + 1} of ${n}` : "No matches";
      clearHighlights();
      const current = find.hits[find.index];
      const here = current ? hitDom(current) : null;
      // A line showing its formulas gives them up so the match shows.
      if (here && here.row && here.row.classList.contains("show-face")) unface(here.row);
      if (HIGHLIGHTS && n) {
        const all = [];
        for (const hit of find.hits) {
          if (hit === current) continue;
          const d = hitDom(hit);
          const r = d && textRange(d.el, d.a, d.b);
          if (r) all.push(r);
        }
        CSS.highlights.set("recall-find", new Highlight(...all));
        const cr = here && textRange(here.el, here.a, here.b);
        if (cr) CSS.highlights.set("recall-find-current", new Highlight(cr));
      }
      if (reveal && here) {
        const box = here.el.closest(".edit-row, tr") || here.el;
        box.scrollIntoView({ block: "center", behavior: "auto" });
      }
    }

    // Writes a replacement report's rows as one undo step and says what it
    // did (`replaceNotice`).
    function applyReplace(only) {
      if (!find.open || !find.query.value) return;
      settleTyping();
      const done = Find.replaceInDocument(docBlocks(), find.query.value, find.replacement.value, findOptions(), only);
      if (!done.replacements && !done.refusedInCells && !done.refusedLineBreak) return;
      if (done.replacements) {
        try {
          transact(() => {
            const t = Date.now();
            for (const [id, change] of done.lines) Store.replaceLineText(id, change.text, change.runs, t);
            for (const [id, change] of done.rows) {
              const note = Backend.get("note", id);
              const tb = note ? Store.tableOf(note.parent_id) : null;
              if (!tb) continue;
              const cells = tb.cardTable ? Gate.cardCells(change.text) : change.text.split("\t");
              Store.saveTableRow(id, cells, t, Spans.cellRuns(change.text, change.runs, tb.cardTable));
            }
          });
        } catch (error) { report(error); return; }
        render();
        changedNow();
      }
      notice(Find.notice(done));
      research(false);
    }

    function replaceCurrent() {
      const hit = find.hits[find.index];
      if (hit) applyReplace(hit);
    }
    function replaceEvery() { applyReplace(null); }

    // ⌘F anywhere in the doc, and ⌘G while the bar is open.
    container.addEventListener("keydown", event => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      const k = event.key.toLowerCase();
      if (k === "f" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); openFind(); }
      else if (k === "g" && find.open) { event.preventDefault(); event.stopPropagation(); step(event.shiftKey ? -1 : 1); }
    }, true);

    // --------------------------------------------------------------- render

    function render() {
      stale = false;
      const rows = Backend.doc(docId);
      const flags = new Map();
      for (const c of rows.cards) flags.set(c.note_id, { detached: !!c.detached });
      const diagrams = Media.diagramsByNote();
      const blocks = Model.build(rows.notes, flags, new Set(diagrams.keys()));
      const doc = Backend.get("notebook", docId);
      const style = Render.docStyle(doc ? doc.style : null, Backend.styleDefaults());
      lang = style.language || null;
      spell = (Backend.library().settingsValues || {}).spellcheck !== "0";
      const canvas = h("div.canvas.editor");
      Render.applyDocStyle(canvas, style);
      const ctx = Pictures.context(style);
      canvas.tabIndex = -1;
      for (const b of blocks) {
        let el;
        try {
          if (b.kind === "table" && b.rows.length) el = tableBlock(b);
          else if (b.kind === "image") el = pictureBlock(b, ctx);
          else if (b.hasDiagram) el = diagramBlock(b, ctx);
          else if (TEXT_KINDS.includes(b.kind) || b.kind === "occlusion") el = lineRow(b);
          else el = h("div.edit-static", Render.block(b, ctx));
        } catch (error) {
          el = h("div.edit-static", Render.missing("This block could not be drawn."));
          console.warn(error);
        }
        // Every top level block names its note, which is what a block set
        // (R7) is made of.
        el.dataset.block = b.id;
        canvas.appendChild(el);
      }
      if (!canvas.querySelector(".edit-row")) {
        // A doc with no line to type in gets one, stored the moment it is
        // used; the syntax is taught once, by its placeholder (I15).
        const row = lineRow({ id: "", kind: "paragraph", text: "", runs: [], attrs: {} });
        row.dataset.id = "";
        row.dataset.block = "";
        row.dataset.pending = "1";
        const first = row.querySelector(".edit-line");
        first.dataset.placeholder = "Type a line. A line with >> in it becomes a card; # makes a heading.";
        first.classList.add("blank");
        first.addEventListener("input", () => first.classList.toggle("blank", !read(first).text));
        canvas.appendChild(row);
      }
      clear(container);
      container.appendChild(canvas);
      redecorateAll();
      for (const row of rowsInOrder()) refreshFace(row);
      paintBlockSel();
      // Pictures arrive when their bytes do; their frame, handles and crop
      // are drawn over them then.
      ctx.resolve().then(() => { if (!destroyed) { decoratePictures(); paginateNow(); } });
      paginateNow();
      if (find.open) research(false);
    }

    // ------------------------------------------ the block set: pointer and keys

    // A drag that leaves the block it began in makes a block set from there
    // to the block under the pointer; coming back makes it a text range
    // again. Shift click on another block extends to it.
    let drag = null;
    function onMouseDown(e) {
      if (e.button !== 0) return;
      const b = blockOf(e.target);
      if (e.shiftKey && b) {
        const anchor = blockSel ? blockById(blockSel.anchor) : (active && container.contains(active) ? blockOf(active) : null);
        if (anchor && anchor !== b) {
          e.preventDefault();
          if (active && container.contains(active)) { const r = active.closest(".edit-row"); if (r) commit(r); }
          setBlockSel(anchor, b);
          return;
        }
      }
      if (blockSel && !e.target.closest(".block-bar")) clearBlockSel();
      // A press anywhere but the framed picture lets it go.
      if (selectedPicture && !(e.target.closest && e.target.closest(`.edit-picture[data-id="${selectedPicture}"]`))) selectPicture(null);
      drag = b ? { start: b } : null;
    }
    function onMouseMove(e) {
      if (!drag || !(e.buttons & 1)) return;
      const over = blockOf(document.elementFromPoint(e.clientX, e.clientY));
      if (!over) return;
      if (over !== drag.start) {
        if (!blockSel || blockSel.focus !== over.dataset.block) setBlockSel(drag.start, over, { focus: false });
      } else if (blockSel) {
        clearBlockSel();
      }
    }
    function onMouseUp() {
      if (drag && blockSel) {
        if (active && container.contains(active)) { const r = active.closest(".edit-row"); if (r) commit(r); }
        takeKeys();
      }
      drag = null;
    }

    const holdsKeys = () => !!blockSel && document.activeElement === canvasEl();
    function onBlockKey(e) {
      // Only a key the canvas itself received: a line's key that made the
      // set bubbles here too, and must not act on it a second time.
      if (e.target !== canvasEl()) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (!holdsKeys()) {
        // The canvas holding the keys with no set (after an undo that left no
        // line to stand in) still answers undo and redo.
        if (document.activeElement === canvasEl() && mod && !e.altKey && k === "z") {
          e.preventDefault();
          if (e.shiftKey) redoStep(); else undoStep();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        const a = blockById(blockSel.anchor);
        clearBlockSel();
        focusBlock(a, "end");
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        deleteSelectedBlocks();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const down = e.key === "ArrowDown";
        const all = blockEls();
        if (e.shiftKey) {
          const next = all[all.indexOf(blockById(blockSel.focus)) + (down ? 1 : -1)];
          if (next && next.dataset.block) setBlockSel(blockById(blockSel.anchor), next);
        } else {
          const set = selectedBlocks();
          const edge = down ? set[set.length - 1] : set[0];
          clearBlockSel();
          focusBlock(edge, down ? "end" : 0);
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        indentSelectedBlocks(e.shiftKey ? -1 : 1);
      } else if (mod && e.altKey && (e.code === "BracketLeft" || e.code === "BracketRight" || e.key === "[" || e.key === "]")) {
        e.preventDefault();
        moveCaretBlocks(e.code === "BracketLeft" || e.key === "[");
      } else if (mod && !e.altKey && k === "a") {
        e.preventDefault();
        selectAllBlocks();
      } else if (mod && !e.altKey && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redoStep(); else undoStep();
      } else if (!mod && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        replaceSelectedBlocks(e.key);
      }
    }
    // A BLOCK SET copies and cuts as WHOLE blocks (finding 9) with their
    // identity (`blockSetClipboard`); a cut carries the separator its
    // deletion took, as a whole-line cut does, so pasting it back at a
    // line's start restores every block rather than joining the last one to
    // that line.
    function onBlockCopy(e) {
      if (!holdsKeys()) return;
      e.preventDefault();
      const items = clipItems(selectedBlocks().map(el => el.dataset.block).filter(Boolean));
      const text = items.map(i => i.text).join("\n") + (e.type === "cut" && items.length ? "\n" : "");
      if (e.clipboardData) {
        e.clipboardData.setData("text/plain", text);
        if (items.length) e.clipboardData.setData(Clip.TYPE, Clip.encode(items));
      }
      if (e.type === "cut") deleteSelectedBlocks();
    }
    function onBlockPaste(e) {
      if (!holdsKeys()) return;
      e.preventDefault();
      const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
      const items = e.clipboardData ? Clip.usable(e.clipboardData.getData(Clip.TYPE), text) : null;
      if (items) { replaceSelectedBlocksWith(items); return; }
      replaceSelectedBlocks(text);
    }
    container.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mousemove", onColumnMove);
    document.addEventListener("mouseup", onColumnUp);
    document.addEventListener("mousemove", onPictureMove);
    document.addEventListener("mouseup", onPictureUp);
    document.addEventListener("mousedown", onOutsideCrop, true);
    window.addEventListener("resize", schedulePages);
    container.addEventListener("keydown", onBlockKey);
    container.addEventListener("copy", onBlockCopy);
    container.addEventListener("cut", onBlockCopy);
    container.addEventListener("paste", onBlockPaste);

    // One listener for the whole editor: the focused line's selection is
    // remembered so a menu that takes the focus can still act on it.
    function onSelection() {
      if (destroyed || !active || document.activeElement !== active) return;
      // D-191: the caret left where the last key put it, so a trigger held
      // as text there becomes its chip (`releaseTypedCaret`).
      if (lastEdit && lastEdit.line === active) {
        const sel = selectionIn(active);
        if (!sel || sel.start !== sel.end || sel.start !== lastEdit.offset) lastEdit = null;
      }
      if (holding === active && heldCaret(active.closest(".edit-row")) == null) {
        holding = null;
        redecorate(active.closest(".edit-row"));
      }
      if (snapOutOfChip(active)) return;
      lastSel = selectionIn(active) || lastSel;
      if (onFocusLine) onFocusLine(api);
    }
    document.addEventListener("selectionchange", onSelection);
    // A tab closed or hidden within 700 ms of a key still saves the line
    // (review 2026-09-26, web-8).
    const unhookFlush = Backend.onFlush(() => { if (!destroyed) api.flush(); });

    render();

    const api = {
      // A change arrived from another device: redraw now if nobody is typing,
      // else when the caret leaves.
      refresh() {
        if (destroyed) return;
        if (container.contains(document.activeElement)) { stale = true; return; }
        render();
      },
      flush() {
        for (const row of rowsInOrder()) if (timers.has(row)) commit(row);
        for (const tr of [...rowTimers.keys()]) saveRow(tr);
      },
      destroy() {
        destroyed = true;
        CardMenu.close();
        clearHighlights();
        if (find.bar) find.bar.remove();
        unhookFlush();
        document.removeEventListener("selectionchange", onSelection);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("mousemove", onColumnMove);
        document.removeEventListener("mouseup", onColumnUp);
        document.removeEventListener("mousemove", onPictureMove);
        document.removeEventListener("mouseup", onPictureUp);
        document.removeEventListener("mousedown", onOutsideCrop, true);
        window.removeEventListener("resize", schedulePages);
        clearTimeout(pagesTimer);
        api.flush();
        for (const t of timers.values()) clearTimeout(t);
      },
      format, clearFormat, setKind, makeCard, wrap, state, anchorId,
      link: linkCommand, makeCloze, undo: undoStep, redo: redoStep, record: fn => transact(fn),
      find: openFind, closeFind,
      get blockSet() { return selectedBlocks().map(el => el.dataset.block); },
      // Scrolls to a line and puts the caret in it (the palette's note).
      reveal(noteId) {
        const row = container.querySelector(`.edit-row[data-id="${noteId}"]`) || container.querySelector(`[data-id="${noteId}"]`);
        if (!row) return;
        row.scrollIntoView({ block: "center" });
        if (row.classList.contains("edit-row")) focusRow(row, "end");
      },
      rerender: render,
      get hasFocus() { return container.contains(document.activeElement); },
    };
    return api;
  }

  return { mount, paint, read, opensLink, linkHrefAt };
})();
