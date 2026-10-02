// A doc's flashcards: the deck, the faces, and the PRACTICE column.
//
// Owner 2026-09-13: "flashcards in web view". A share link's visitor
// PRACTISES: a card is shown, turned and passed with the grade quartet's
// capsules (Ink 17 section 11), and nothing is graded, no schedule moves and
// no row is written. A paired browser STUDIES through js/study.js since
// section 26 (ruling W-0), with real FSRS grades; the faces are the ones
// drawn here.
//
// The faces follow the review card (Sources/UI/ReviewSessionView.swift and
// CardFace in Theme.swift): a basic card asks its front and adds its back
// under a rule; a cloze asks its sentence with the target blanked (`[…]`, or
// `[hint]`) and answers with the target words marked; an occlusion card masks
// its target region (and every region in hide-all mode) and answers with the
// picture uncovered and the label. The deck is the doc's order.

const Cards = (() => {

  const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(::[^}]*)?\}\}/g;

  // `ReverseCard.ordinal`, restated (Sources/Core/ReverseCard.swift).
  const REVERSE_ORDINAL = -1;
  // `ListReview.lineOrdinal`: a list line forgotten twice (D-191).
  const LINE_ORDINAL = -2;

  // ------------------------------------------------------------------- deck

  // Every card this doc can practise, in document order. `cardRows` are
  // `card` rows (id, note_id, cloze_ordinal, suspended, detached). A
  // suspended or detached card is left out, as a study session leaves it
  // out.
  function deck(blocks, cardRows) {
    const byNote = new Map();
    for (const c of cardRows || []) {
      if (c.deleted_at != null || c.detached || c.suspended) continue;
      if (!byNote.has(c.note_id)) byNote.set(c.note_id, []);
      byNote.get(c.note_id).push(c);
    }
    const out = [];
    let heading = null;
    const visit = (block, index) => {
      // The forward card first: its ordinal is NULL, and since C-72 `-1` is
      // a real ordinal (the other direction), so the sentinel has to sort
      // below it rather than tie with it.
      const rows = (byNote.get(block.id) || []).slice()
        .sort((a, b) => (a.cloze_ordinal ?? -1.5) - (b.cloze_ordinal ?? -1.5));
      for (const row of rows) {
        const ordinal = row.cloze_ordinal;
        let kind = "basic";
        // C-72: `-1` is the back-to-front card (D-191: `<<`, `<>`, `::`, or a
        // concept or descriptor turned round). A NEGATIVE ordinal, so no
        // cloze span and no occlusion region can ever produce it, and
        // `cloze_ordinal IS NULL` still means the forward card.
        const reverse = ordinal === REVERSE_ORDINAL;
        // A LINE card (`-2`, `ListReview.lineOrdinal`: a list line forgotten
        // twice) asks its prompt with the list shown and its own line hidden
        // (D-191). Any other negative ordinal is no card this page knows.
        const line = ordinal === LINE_ORDINAL;
        if (ordinal != null && ordinal < REVERSE_ORDINAL && !line) continue;
        if (line) {
          if (index == null) continue;
          out.push({ id: row.id, kind: "line", block, ordinal, reverse: false, heading,
                     context: null, line: lineContextOf(blocks, index) });
          continue;
        }
        if (block.isCloze) kind = "cloze";
        else if (block.hasDiagram && ordinal != null && !reverse) kind = "occlusion";
        if (kind === "cloze" && ordinal == null) continue;
        if (kind === "cloze" && reverse) continue;
        const context = kind === "basic" && index != null ? contextOf(blocks, index) : null;
        if (kind === "basic" && !block.back && !(context && context.answerLines.length)) continue;
        out.push({ id: row.id, kind, block, ordinal, reverse, heading, context });
      }
    };
    blocks.forEach((block, index) => {
      if (/^heading[123]$/.test(block.kind)) {
        const hidden = Render.hiddenMarkerLength(block.text, block.kind);
        heading = block.text.slice(hidden).trim() || null;
      }
      visit(block, index);
      for (const row of block.rows || []) visit(row, null);
    });
    return out;
  }

  // ------------------------------------------------- the flashcard model

  // D-191 over a block list in document order (`AppDatabase.cardContext`,
  // restated on blocks so a share link's page can ask it too): a
  // list-shaped line's answer lines and whether they are asked in order, and
  // a descriptor's concept. Siblings are the blocks with the same parent;
  // a list item counts at its `attrs.d`, anything else at -1.
  const isListKind = kind => kind === "bullet" || kind === "dash" || kind === "numbered";
  const depthOf = b => (isListKind(b.kind) ? (b.attrs.listDepth || 0) : -1);
  const markOf = b => Gate.markFromText(b.attrs && b.attrs.mark);

  function isListPrompt(b) {
    if (!b || b.isCloze || b.back || !b.front) return false;
    const m = markOf(b);
    return !!m && !m.off && b.kind !== "tablerow" && b.kind !== "table";
  }

  function contextOf(blocks, index) {
    const block = blocks[index];
    const parent = block.parentId || null;
    const out = { answerLines: [], ordered: false, concept: null };
    if (isListPrompt(block)) {
      const depth = depthOf(block);
      for (let i = index + 1; i < blocks.length && out.answerLines.length < 400; i++) {
        const b = blocks[i];
        if ((b.parentId || null) !== parent) continue;
        if (!isListKind(b.kind) || depthOf(b) <= depth) break;
        out.answerLines.push(b);
      }
      out.ordered = out.answerLines.length > 0 && out.answerLines[0].kind === "numbered";
    }
    const m = markOf(block);
    if (m && m.separator === ";;") {
      const depth = depthOf(block);
      for (let i = index - 1; i >= 0; i--) {
        const b = blocks[i];
        if ((b.parentId || null) !== parent) continue;
        if (/^heading[123]$/.test(b.kind)) break;
        const d = depthOf(b);
        if (d > depth) continue;
        const bm = markOf(b);
        if (d === depth && bm && bm.separator === ";;") continue;
        if (bm && bm.separator === "::" && b.front) out.concept = b.front;
        break;
      }
    }
    return out;
  }

  // `AppDatabase.listPrompt(of:)` and `lineCardContext(for:)` over the same
  // block list: the list-shaped line whose answer the block at `index` is,
  // found by walking back through its sibling group over the list items
  // above it (at most 400), with the whole list, which line is hidden and a
  // descriptor's concept; null when the line answers no list any more.
  function lineContextOf(blocks, index) {
    const line = blocks[index];
    if (!line || !isListKind(line.kind)) return null;
    const parent = line.parentId || null;
    let seen = 0;
    for (let k = index - 1; k >= 0 && seen < 400; k--) {
      const b = blocks[k];
      if ((b.parentId || null) !== parent) continue;
      seen += 1;
      if (isListPrompt(b)) {
        const ctx = contextOf(blocks, k);
        const at = ctx.answerLines.indexOf(line);
        if (at >= 0) return { prompt: b, concept: ctx.concept, lines: ctx.answerLines, index: at, ordered: ctx.ordered };
      }
      if (!isListKind(b.kind)) break;
    }
    return null;
  }

  // ------------------------------------------------------------------ faces

  // A basic card's two sides, with the style runs each one carries. The
  // runs are measured against `outlineRawText`, which joins the sides with
  // ` <trigger> ` (D-191, the trigger stored in `attrs.tg`), or with `::`
  // on a table row.
  function sides(block, reverse) {
    const front = block.front || "";
    const back = block.back || "";
    const trigger = Gate.markFromText(block.attrs && block.attrs.mark) || Gate.mark(">>");
    const gap = block.kind === "tablerow" || block.kind === "table" ? 2 : trigger.text.length + 2;
    const hidden = Render.hiddenMarkerLength(front, block.kind);
    const sides = {
      front: front.slice(hidden),
      frontRuns: Spans.slice(block.runs, hidden, front.length),
      back,
      backRuns: Spans.slice(block.runs, front.length + gap, front.length + gap + back.length),
    };
    // THE SWAP, and the ONE place it happens, exactly as `ReverseCard.sides`
    // is that one place in the app: the direction belongs to the CARD, not
    // to the note's columns.
    if (!reverse) return sides;
    return { front: sides.back, frontRuns: sides.backRuns,
             back: sides.front, backRuns: sides.frontRuns };
  }

  // One answer line's words as a face prints them (`listLineText`): a
  // numbered item without its `N. `, the face numbering the lines itself.
  function lineWords(line, ctx) {
    const hidden = line.kind === "numbered" ? Render.hiddenMarkerLength(line.text, line.kind) : 0;
    return Render.inlineDOM(line.text.slice(hidden), Spans.slice(line.runs || [], hidden, line.text.length), ctx);
  }

  // D-191: A LIST ANSWER'S ROWS IN REVIEW (`ListAnswerRows`, ListFace.swift;
  // the mockup's "In review"). A set shows every line, each with its ✕ to
  // mark what was forgotten; an ordered list numbers its lines and shows
  // `shown` of them, the rest as `· · ·`; a line card hides line `hidden` in
  // a gap until the answer is up. `toggle(noteId)` marks a line (nil where
  // nothing can be marked); a marked line is struck in Again's ink.
  function listRows(lines, { ordered = false, shown = lines.length, marks = new Set(), toggle = null,
                             hidden = null, revealed = false } = {}, ctx) {
    const wrap = el("div", "face-lines");
    lines.forEach((line, i) => {
      const forgot = marks.has(line.id);
      const row = el("div", "face-line" + (forgot ? " forgot" : ""));
      if (ordered) row.appendChild(el("span", "list-num", `${i + 1}.`));
      if (i >= shown) {
        row.appendChild(el("span", "list-more", "\u00B7 \u00B7 \u00B7"));
      } else if (i === hidden) {
        row.appendChild(faceGap(line, revealed, ctx));
      } else {
        const words = el("span", "list-text");
        words.appendChild(lineWords(line, ctx));
        row.appendChild(words);
      }
      row.appendChild(el("span", "spacer"));
      if (toggle && i < shown && i !== hidden) {
        const words = (line.text || "").slice(line.kind === "numbered" ? Render.hiddenMarkerLength(line.text, line.kind) : 0);
        const x = el("button", "list-x" + (forgot ? " on" : ""), "\u2715");
        x.type = "button";
        x.dataset.line = line.id;
        x.setAttribute("aria-pressed", forgot ? "true" : "false");
        x.setAttribute("aria-label", forgot ? `Forgotten: ${words}` : `Mark forgotten: ${words}`);
        x.addEventListener("click", event => { event.stopPropagation(); toggle(line.id); });
        row.appendChild(x);
      }
      wrap.appendChild(row);
    });
    return wrap;
  }

  // `FaceGap`: the dashed box carrying `· · ·`, and the line in the accent,
  // underlined, once shown; the box keeps the answer's width either way.
  function faceGap(line, revealed, ctx) {
    const gap = el("span", "face-gap" + (revealed ? " revealed" : ""));
    const answer = el("span", "face-gap-answer");
    answer.appendChild(lineWords(line, ctx));
    gap.appendChild(answer);
    if (!revealed) {
      gap.appendChild(el("span", "face-gap-hint", "\u00B7 \u00B7 \u00B7"));
      gap.setAttribute("aria-label", "blank");
    }
    return gap;
  }

  // A list answer (D-191): each line under the prompt, numbered when it is
  // asked in order, a bullet when it is a set. (The reverse card's question.)
  function listFace(lines, ordered, ctx) {
    const list = document.createElement(ordered ? "ol" : "ul");
    list.className = "face-list";
    for (const line of lines) {
      const item = document.createElement("li");
      const hidden = line.kind === "numbered" ? Render.hiddenMarkerLength(line.text, line.kind) : 0;
      item.appendChild(Render.inlineDOM(line.text.slice(hidden), Spans.slice(line.runs || [], hidden, line.text.length), ctx));
      list.appendChild(item);
    }
    return list;
  }

  // A descriptor's question reads `Concept · descriptor`, the descriptor in
  // italic (SPEC's 2026-09-28 amendment); with no concept, its own front.
  function descriptorFace(concept, s, ctx) {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(concept + " · "));
    const em = document.createElement("span");
    em.className = "face-descriptor";
    em.appendChild(Render.inlineDOM(s.front, s.frontRuns, ctx));
    frag.appendChild(em);
    return frag;
  }

  // A cloze sentence for one ordinal. `answer` marks the target words;
  // otherwise the target is a blank and every other span shows its words.
  function clozeFace(text, runs, ordinal, answer) {
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const m of text.matchAll(CLOZE_RE)) {
      if (m.index > at) frag.appendChild(Render.styledText(text.slice(at, m.index), runs, at));
      const innerAt = m.index + m[0].indexOf("::") + 2;
      const inner = m[2] || "";
      if (Number(m[1]) === ordinal) {
        const node = document.createElement("span");
        if (answer) {
          node.className = "cloze-answer";
          node.appendChild(Render.styledText(inner, runs, innerAt));
        } else {
          node.className = "cloze-ask";
          const hint = m[3] && m[3].length > 2 ? m[3].slice(2).trim() : "";
          node.textContent = hint ? `[${hint}]` : "[…]";
        }
        frag.appendChild(node);
      } else {
        frag.appendChild(Render.styledText(inner, runs, innerAt));
      }
      at = m.index + m[0].length;
    }
    if (at < text.length) frag.appendChild(Render.styledText(text.slice(at), runs, at));
    return frag;
  }

  function face(className, child) {
    const node = document.createElement("div");
    node.className = "face " + className;
    if (child) node.appendChild(child);
    return node;
  }

  // The question and the answer of one card, as two nodes. `together` says
  // whether the answer is drawn UNDER the question (a basic card) or in its
  // place (a cloze or a diagram, whose answer is the question uncovered).
  function faces(card, ctx) {
    const block = card.block;
    if (card.kind === "line") return lineCardFaces(card, ctx);
    if (card.kind === "cloze") {
      const text = block.clozeText || "";
      return {
        question: face("face-q", clozeFace(text, block.runs, card.ordinal, false)),
        answer: face("face-q", clozeFace(text, block.runs, card.ordinal, true)),
        together: false,
      };
    }
    if (card.kind === "occlusion") {
      const draw = revealed => {
        const node = face("face-q");
        const prompt = sides(block).front;
        if (prompt.trim()) {
          const p = document.createElement("div");
          p.className = "face-prompt";
          p.appendChild(Render.inlineDOM(prompt, sides(block).frontRuns, ctx));
          node.appendChild(p);
        }
        for (const mediaId of ctx.diagramsFor(block.id)) {
          node.appendChild(ctx.picture(mediaId, {
            noteId: block.id,
            face: { target: card.ordinal, mode: block.occMode, revealed },
          }));
        }
        if (revealed) {
          const label = targetLabel(card, ctx);
          if (label) {
            const chip = document.createElement("div");
            chip.className = "answer-chip";
            chip.textContent = label;
            node.appendChild(chip);
          }
        }
        return node;
      };
      return { question: draw(false), answer: draw(true), together: false };
    }
    // D-191: a list-shaped line's answer is the lines under it, and a
    // descriptor's question carries its concept. Either may be asked the
    // other way round, and the swap is still the card's.
    const context = card.context || { answerLines: [], ordered: false, concept: null };
    const s = sides(block, false);
    const promptSide = () => context.concept ? descriptorFace(context.concept, s, ctx) : Render.inlineDOM(s.front, s.frontRuns, ctx);
    // D-191: A LIST CARD IS REVIEWED AS A SET OR IN ORDER (`ListReview`): its
    // question is the prompt, and its answer lines are rows the session
    // draws with its own state (`rows`). The card asked the other way round
    // keeps the list as its question.
    if (!card.reverse && !s.back && context.answerLines.length) {
      const lines = context.answerLines;
      return {
        list: true, together: true, ordered: context.ordered, lines, total: lines.length,
        question: face("face-q", promptSide()),
        // A set shows its rows once the card is up; an ordered list from the
        // start, one more per "Show line N".
        rows: st => (context.ordered || st.showing
          ? listRows(lines, { ordered: context.ordered, shown: context.ordered ? st.shown : lines.length,
                              marks: st.marks, toggle: st.toggle }, ctx)
          : null),
      };
    }
    const answerSide = () => (!s.back && context.answerLines.length)
      ? listFace(context.answerLines, context.ordered, ctx) : Render.inlineDOM(s.back, s.backRuns, ctx);
    return {
      question: face("face-q", card.reverse ? answerSide() : promptSide()),
      answer: face("face-a", card.reverse ? promptSide() : answerSide()),
      together: true,
    };
  }

  // D-191: A LINE CARD asks its prompt (with a descriptor's concept) with
  // the list shown and its own line hidden in a gap; the answer fills it in
  // place. A line that answers no list any more asks its own words.
  function lineCardFaces(card, ctx) {
    const line = card.line;
    if (!line) {
      const s = sides(card.block, false);
      return { question: face("face-q", Render.inlineDOM(s.front, s.frontRuns, ctx)), answer: face("face-a"), together: true };
    }
    const p = sides(line.prompt, false);
    const q = document.createDocumentFragment();
    if (line.concept) q.appendChild(document.createTextNode(line.concept + " \u00B7 "));
    q.appendChild(Render.inlineDOM(p.front, p.frontRuns, ctx));
    return {
      list: true, line: true, together: true, ordered: line.ordered, lines: line.lines, total: line.lines.length,
      question: face("face-q", q),
      rows: st => listRows(line.lines, { ordered: line.ordered, shown: line.lines.length, hidden: line.index,
                                         revealed: !!st.showing }, ctx),
    };
  }

  function targetLabel(card, ctx) {
    for (const mediaId of ctx.diagramsFor(card.block.id)) {
      const hit = Media.regionsFor(mediaId, card.block.id)
        .find(r => r.ordinal === card.ordinal);
      if (hit && String(hit.label || "").trim()) return String(hit.label).trim();
    }
    return null;
  }

  // ------------------------------------------------------------------ mount

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, act, className, key) {
    const b = el("button", className);
    b.type = "button";
    b.dataset.act = act;
    b.appendChild(el("span", "dock-label", label));
    if (key) b.appendChild(el("span", "keycap", key));
    return b;
  }

  const GRADES = [["again", "Again", "1"], ["hard", "Hard", "2"], ["good", "Good", "3"], ["easy", "Easy", "4"]];

  // The practice column: progress under the bar, the card at its own height,
  // then the dock. Nothing it does is saved.
  function mount(container, cards, ctx, { docName = "" } = {}) {
    let order = cards.map((_, i) => i);
    let at = 0;
    let revealed = false;
    let tally = [0, 0, 0, 0];
    // D-191: an ordered list's lines shown, and a set's ✕ marks, for the card
    // up; practice records neither (nothing is saved).
    let shown = 0;
    let marks = new Set();
    const up = () => (at < cards.length ? cards[order[at]] : null);
    // The lines an ordered list still holds face down (`orderedLinesLeft`).
    function linesLeft() {
      const card = up();
      const f = card ? faces(card, ctx) : null;
      return f && f.list && !f.line && f.ordered ? Math.max(0, f.total - shown) : null;
    }

    function crumb(card) {
      return [docName, card.heading].filter(Boolean).join(" · ");
    }

    function draw() {
      container.textContent = "";
      const column = el("div", "practice-column");
      container.appendChild(column);

      if (!cards.length) {
        const empty = el("article", "review-card end-card");
        empty.appendChild(el("div", "end-title", "No cards in this doc yet"));
        empty.appendChild(el("p", "end-line", "A line with >> in it, a cloze or a labelled diagram makes one."));
        column.appendChild(empty);
        return;
      }

      const head = el("div", "practice-head");
      head.appendChild(el("span", "eyebrow", "Practice · nothing is saved"));
      head.appendChild(el("span", "practice-count", at < cards.length ? `${cards.length - at} left` : "0 left"));
      head.appendChild(button("Shuffle", "shuffle", "chip"));
      column.appendChild(head);

      const bar = el("div", "progress");
      const fill = el("div", "progress-fill");
      fill.style.width = `${Math.round((Math.min(at, cards.length) / cards.length) * 100)}%`;
      bar.appendChild(fill);
      column.appendChild(bar);

      if (at >= cards.length) {
        const end = el("article", "review-card end-card");
        const ring = el("div", "end-ring");
        ring.appendChild(el("span", null, "✓"));
        end.appendChild(ring);
        end.appendChild(el("div", "end-title", "All caught up"));
        end.appendChild(el("div", "end-line", `${cards.length} card${cards.length === 1 ? "" : "s"} · practice, nothing graded`));
        end.appendChild(tallyStripe(tally));
        column.appendChild(end);
        const dock = el("div", "dock-row");
        dock.appendChild(button("Shuffle", "shuffle", "dock"));
        dock.appendChild(button("Start again", "restart", "dock primary", "Space"));
        column.appendChild(dock);
        return;
      }

      const card = cards[order[at]];
      const c = crumb(card);
      if (c) column.appendChild(el("div", "eyebrow review-crumb", c));
      const article = el("article", "review-card");
      const f = faces(card, ctx);
      let suggested = null;
      if (f.list) {
        article.appendChild(f.question);
        const rows = f.rows({ showing: revealed, shown, marks,
                              toggle: f.line ? null : id => { if (marks.has(id)) marks.delete(id); else marks.add(id); draw(); } });
        if (rows) {
          article.appendChild(el("div", "face-rule" + (revealed ? "" : " quiet")));
          article.appendChild(rows);
        }
        // The capsule a set's marks suggest (`ListReview.suggestedRating`).
        if (!f.line) suggested = Store.suggestedRating(marks.size, f.total);
      } else if (!revealed) {
        article.appendChild(f.question);
      } else if (f.together) {
        article.appendChild(f.question);
        article.appendChild(el("div", "face-rule"));
        article.appendChild(f.answer);
      } else {
        article.appendChild(f.answer);
      }
      column.appendChild(article);
      if (ctx.resolve) ctx.resolve();

      const dock = el("div", "dock-row");
      if (!revealed) {
        const left = linesLeft();
        dock.appendChild(button(left ? `Show line ${shown + 1}` : "Show answer", "reveal", "dock", "Space"));
      } else {
        const grades = el("div", "grades");
        for (const [k, label, key] of GRADES) {
          const b = button(label, "grade-" + k, "grade grade-" + k, key);
          if (suggested === GRADES.findIndex(g => g[0] === k) + 1) b.classList.add("suggested");
          grades.appendChild(b);
        }
        dock.appendChild(grades);
      }
      column.appendChild(dock);
    }

    function act(name) {
      if (name.startsWith("grade-")) {
        const i = GRADES.findIndex(g => "grade-" + g[0] === name);
        if (i >= 0) tally[i] += 1;
        at = Math.min(cards.length, at + 1);
        revealed = false;
        shown = 0;
        marks = new Set();
        draw();
        return;
      }
      switch (name) {
        case "reveal": {
          // An ordered list turns over one line at a time; its last line
          // turns the card (`showNextLine`).
          const left = linesLeft();
          if (left) { shown += 1; if (left === 1) revealed = true; } else revealed = true;
          break;
        }
        case "restart": at = 0; revealed = false; shown = 0; marks = new Set(); tally = [0, 0, 0, 0]; break;
        case "shuffle":
          order = cards.map((_, i) => i);
          for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
          }
          at = 0; revealed = false; shown = 0; marks = new Set(); tally = [0, 0, 0, 0];
          break;
        default: return;
      }
      draw();
    }

    function onClick(event) {
      const target = event.target.closest("[data-act]");
      if (target && container.contains(target) && !target.disabled) act(target.dataset.act);
    }

    function onKey(event) {
      if (!container.isConnected || container.offsetParent === null) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
      const space = event.key === " " || event.key === "Spacebar" || event.code === "Space";
      if (space || event.key === "Enter") {
        event.preventDefault();
        if (!cards.length) return;
        if (at >= cards.length) act("restart");
        else if (!revealed) act("reveal");
        else act("grade-good");
      } else if (revealed && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        act("grade-" + GRADES[Number(event.key) - 1][0]);
      }
    }

    container.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    draw();
    return {
      destroy() {
        container.removeEventListener("click", onClick);
        document.removeEventListener("keydown", onKey);
      },
    };
  }

  // The session's tally as the end card draws it: the quartet's widths and a
  // legend under them.
  function tallyStripe(tally) {
    const wrap = el("div", "tally");
    const stripe = el("div", "stripe");
    stripe.style.height = "8px";
    const total = tally.reduce((a, b) => a + b, 0);
    GRADES.forEach(([k], i) => {
      if (!tally[i] && total) return;
      const seg = el("i", "seg-" + k);
      seg.style.flex = String(total ? tally[i] : 1);
      stripe.appendChild(seg);
    });
    wrap.appendChild(stripe);
    const legend = el("div", "legend");
    GRADES.forEach(([k, label], i) => {
      const item = el("span");
      item.appendChild(el("i", "seg-" + k));
      item.appendChild(document.createTextNode(`${tally[i]} ${label.toLowerCase()}`));
      legend.appendChild(item);
    });
    wrap.appendChild(legend);
    return wrap;
  }

  return { deck, mount, clozeFace, faces, sides, tallyStripe, contextOf, lineContextOf, isListPrompt, listRows,
           LINE_ORDINAL };
})();
