// A doc's flashcards, practised in the browser.
//
// Owner 2026-09-13: "flashcards in web view", and the ruling the same day
// that it is PRACTICE ONLY. A card is shown, turned and passed; nothing is
// graded, no schedule moves and no row is written, for the owner and for a
// visitor on a share link alike. The app is where cards are studied.
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
    const visit = block => {
      // The forward card first: its ordinal is NULL, and since C-72 `-1` is
      // a real ordinal (the other direction), so the sentinel has to sort
      // below it rather than tie with it.
      const rows = (byNote.get(block.id) || []).slice()
        .sort((a, b) => (a.cloze_ordinal ?? -2) - (b.cloze_ordinal ?? -2));
      for (const row of rows) {
        const ordinal = row.cloze_ordinal;
        let kind = "basic";
        // C-72: `-1` is the back-to-front card of a `<->` note. A NEGATIVE
        // ordinal, so no cloze span and no occlusion region can ever produce
        // it, and `cloze_ordinal IS NULL` still means the forward card.
        const reverse = ordinal === REVERSE_ORDINAL;
        if (block.isCloze) kind = "cloze";
        else if (block.hasDiagram && ordinal != null && !reverse) kind = "occlusion";
        if (kind === "cloze" && ordinal == null) continue;
        if (kind === "cloze" && reverse) continue;
        if (kind === "basic" && !block.back) continue;
        out.push({ id: row.id, kind, block, ordinal, reverse, heading });
      }
    };
    for (const block of blocks) {
      if (/^heading[123]$/.test(block.kind)) {
        const hidden = Render.hiddenMarkerLength(block.text, block.kind);
        heading = block.text.slice(hidden).trim() || null;
      }
      visit(block);
      for (const row of block.rows || []) visit(row);
    }
    return out;
  }

  // ------------------------------------------------------------------ faces

  // A basic card's two sides, with the style runs each one carries. The
  // runs are measured against `outlineRawText`, which joins the sides with
  // ` :: `, or with `::` on a table row.
  function sides(block, reverse) {
    const front = block.front || "";
    const back = block.back || "";
    // The runs are measured against `outlineRawText`, so the gap is the gate
    // the note was written with: `::` on a table row (2), ` :: ` (4), and
    // since OR-4 ` <-> ` (5) on a reverse note (C-72).
    const gap = block.kind === "tablerow" || block.kind === "table" ? 2
              : (block.attrs.reverse ? 5 : 4);
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
    const s = sides(block, card.reverse);
    return {
      question: face("face-q", Render.inlineDOM(s.front, s.frontRuns, ctx)),
      answer: face("face-a", Render.inlineDOM(s.back, s.backRuns, ctx)),
      together: true,
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
    b.appendChild(document.createTextNode(label));
    if (key) b.appendChild(el("kbd", null, key));
    return b;
  }

  // Draws the practice column into `container` and takes the keyboard while
  // it is on screen. Returns a handle whose `destroy` gives the keys back.
  function mount(container, cards, ctx, { docName = "" } = {}) {
    let order = cards.map((_, i) => i);
    let at = 0;
    let revealed = false;

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
        empty.appendChild(el("p", "end-line",
          "A line with :: in it, a cloze or a labelled diagram makes one in the app."));
        column.appendChild(empty);
        return;
      }

      const head = el("div", "practice-head");
      head.appendChild(el("span", "practice-count",
        at < cards.length ? `${at + 1} of ${cards.length}` : `${cards.length} of ${cards.length}`));
      head.appendChild(el("span", "practice-note", "Practice · nothing is graded"));
      head.appendChild(button("Shuffle", "shuffle", "chip"));
      column.appendChild(head);

      const bar = el("div", "progress");
      const fill = el("div", "progress-fill");
      fill.style.width = `${Math.round((Math.min(at, cards.length) / cards.length) * 100)}%`;
      bar.appendChild(fill);
      column.appendChild(bar);

      if (at >= cards.length) {
        const end = el("article", "review-card end-card");
        end.appendChild(el("div", "end-check", "✓"));
        end.appendChild(el("div", "end-title",
          `That is all ${cards.length} card${cards.length === 1 ? "" : "s"}`));
        end.appendChild(el("p", "end-line",
          "Nothing was graded. Study them in the app to schedule them."));
        column.appendChild(end);
        const dock = el("div", "dock");
        dock.appendChild(button("Shuffle", "shuffle", "dock-button"));
        dock.appendChild(button("Start again", "restart", "dock-button go", "Space"));
        column.appendChild(dock);
        return;
      }

      const card = cards[order[at]];
      const article = el("article", "review-card");
      const c = crumb(card);
      if (c) article.appendChild(el("div", "crumb", c));
      const f = faces(card, ctx);
      if (!revealed) {
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

      const dock = el("div", "dock");
      if (!revealed) {
        dock.appendChild(button("Show answer", "reveal", "dock-button reveal", "Space"));
      } else {
        const prev = button("Previous", "prev", "dock-button");
        prev.disabled = at === 0;
        dock.appendChild(prev);
        dock.appendChild(button("Next", "next", "dock-button go", "Space"));
      }
      column.appendChild(dock);
    }

    function act(name) {
      switch (name) {
        case "reveal": revealed = true; break;
        case "next": at = Math.min(cards.length, at + 1); revealed = false; break;
        case "prev": at = Math.max(0, at - 1); revealed = false; break;
        case "restart": at = 0; revealed = false; break;
        case "shuffle":
          order = cards.map((_, i) => i);
          for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
          }
          at = 0; revealed = false;
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
      // A focused button (the Cards tab just pressed) would take Space as
      // its own click; the column answers it first. Some keyboards report
      // the key only by its code.
      const space = event.key === " " || event.key === "Spacebar" || event.code === "Space";
      if (space || event.key === "Enter") {
        event.preventDefault();
        if (!cards.length) return;
        if (at >= cards.length) act("restart");
        else act(revealed ? "next" : "reveal");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        if (at < cards.length) act("next");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        act("prev");
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

  return { deck, mount, clozeFace };
})();
