// The review takeover (Ink 17 section 1) and the session it runs, restated
// from Recall's ReviewEngine: the queue keyed once per session (P0.8), the
// grade written as a card row and an append-only grade event from THIS
// device, Again back two places later (at most three times), a note's other
// cards buried eight places back (a diagram's regions and a two-way pair leave
// the session), the leech policy, and undo of the last three grades.
//
// The card keeps its own height at its anchor; after the reveal the notes
// block and the schedule line arrive UNDER it, never inside it, and the grade
// row takes the dock. The end is the same card in the same slot.

const Study = (() => {

  const { h, chip, clear } = UI;
  const MAX_UNDO = 3;          // `ReviewEngine.maxUndoSteps`
  const REAPPEAR_BUDGET = 3;   // `reappearanceBudget`
  const BURY_DISTANCE = 8;     // `siblingBuryDistance`
  const GRADES = [["again", "Again", 1], ["hard", "Hard", 2], ["good", "Good", 3], ["easy", "Easy", 4]];

  let session = null;
  let root = null;
  let hooks = {};
  let noticeTimer = null;

  // -------------------------------------------------------------- the deck

  let blockCache = { version: -1, docs: new Map() };

  function blocksFor(docId) {
    if (blockCache.version !== Backend.version) blockCache = { version: Backend.version, docs: new Map() };
    if (blockCache.docs.has(docId)) return blockCache.docs.get(docId);
    const rows = Backend.doc(docId);
    const flags = new Map();
    for (const c of rows.cards) {
      const e = flags.get(c.note_id);
      flags.set(c.note_id, { detached: (e && e.detached) || !!c.detached });
    }
    const diagrams = Media.diagramsByNote();
    const blocks = Model.build(rows.notes, flags, new Set(diagrams.keys()));
    blockCache.docs.set(docId, blocks);
    return blocks;
  }

  // Everything the takeover draws for one card.
  function describe(cardId) {
    const L = Backend.library();
    const card = Backend.get("card", cardId);
    if (!card) return null;
    const note = L.notes.get(card.note_id);
    if (!note) return null;
    const doc = L.docs.get(note.notebook_id);
    if (!doc) return null;
    const folder = doc.folder_id ? L.folders.get(doc.folder_id) : null;
    let heading = null, block = null, index = null;
    const blocks = blocksFor(doc.id);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (/^heading[123]$/.test(b.kind)) heading = b.text.slice(Render.hiddenMarkerLength(b.text, b.kind)).trim() || null;
      if (b.id === note.id) { block = b; index = i; break; }
      const row = (b.rows || []).find(r => r.id === note.id);
      if (row) { block = row; break; }
    }
    if (!block) return null;
    const ordinal = card.cloze_ordinal;
    const reverse = ordinal === Store.REVERSE_ORDINAL;
    // D-191: a LINE card (`ListReview.lineOrdinal`) asks its list's prompt
    // with its own line hidden.
    if (ordinal === Store.LINE_ORDINAL) {
      const line = index != null ? Cards.lineContextOf(blocks, index) : null;
      return { card, note, doc, folder, block, heading,
               entry: { id: card.id, kind: "line", block, ordinal, reverse: false, heading, context: null, line } };
    }
    let kind = "basic";
    if (block.isCloze) kind = "cloze";
    else if (block.hasDiagram && ordinal != null && !reverse) kind = "occlusion";
    // D-191: a list prompt's answer lines and a descriptor's concept.
    const context = kind === "basic" && index != null ? Cards.contextOf(blocks, index) : null;
    return { card, note, doc, folder, block, heading,
             entry: { id: card.id, kind, block, ordinal, reverse, heading, context } };
  }

  // ------------------------------------------------------------ the session

  // Study a scope: `{ kind: "library" }`, `{ kind: "doc", id }`,
  // `{ kind: "folder", id }` or `{ kind: "cards", ids }`.
  function start(scope, opts = {}) {
    const L = Backend.library();
    const now = Date.now();
    const s = L.settings;
    const cap = Sched.knobs(L, scope, s.retention, s.newPerDay).newPerDay;
    const allowance = Math.max(0, cap - Sched.countIntroducedToday(L, now, true));
    const queue = (opts.cram ? Sched.cramQueue(L, now, scope) : Sched.buildQueue(L, now, s.newPerDay, scope, allowance))
      .map(c => c.id);
    if (!queue.length) return false;
    hooks = opts;
    // `marks`: a list card's lines marked forgotten (a set's ✕, an ordered
    // list's revealed lines); `shown`: an ordered list's lines turned over.
    session = { queue, index: 0, showing: false, undo: [], reappear: new Map(), tally: [0, 0, 0, 0],
                startedAt: now, scope, dealt: -1, notice: null, marks: new Map(), shown: new Map() };
    mount();
    draw();
    return true;
  }

  function isOpen() { return !!session; }

  function current() {
    return session && session.index < session.queue.length ? session.queue[session.index] : null;
  }

  // D-191: the face a list card is reviewed through, or null.
  function listFaceOf(id) {
    const info = id ? describe(id) : null;
    if (!info) return null;
    const f = Cards.faces(info.entry, Pictures.context(Render.docStyle(info.doc.style)));
    return f.list ? f : null;
  }

  // An ordered list is face down until its last line is shown
  // (`orderedLinesLeft`); null for any other card.
  function linesLeft(id) {
    const f = listFaceOf(id);
    if (!f || f.line || !f.ordered) return null;
    return Math.max(0, f.total - (session.shown.get(id) || 0));
  }

  // "Show line N" on an ordered list turns one more line over, and the last
  // turns the card (`showNextLine`); anything else shows its answer.
  function reveal() {
    const id = current();
    if (!session || session.showing || !id) return;
    const left = linesLeft(id);
    if (left) {
      session.shown.set(id, (session.shown.get(id) || 0) + 1);
      if (left === 1) session.showing = true;
      draw();
      return;
    }
    session.showing = true;
    draw();
  }

  // A set's ✕ (and an ordered list's, on a line already shown).
  function toggleMiss(id, lineId) {
    const marks = new Set(session.marks.get(id) || []);
    if (marks.has(lineId)) marks.delete(lineId); else marks.add(lineId);
    session.marks.set(id, marks);
    draw();
  }

  function noteOf(cardId) {
    const c = Backend.get("card", cardId);
    return c ? c.note_id : null;
  }

  // Sibling burial: a note's other cards move eight places back; the SAME
  // FACT asked twice (a diagram's regions, a two-way pair) leaves the session.
  function bury(noteId, pairedFact) {
    const later = [];
    for (let i = session.index + 1; i < session.queue.length; i++) {
      if (noteOf(session.queue[i]) === noteId) later.push(i);
    }
    if (!later.length) return;
    const moved = [];
    for (const i of later.reverse()) moved.unshift(session.queue.splice(i, 1)[0]);
    if (pairedFact) return;
    const at = Math.min(session.index + BURY_DISTANCE, session.queue.length);
    session.queue.splice(at, 0, ...moved);
  }

  function grade(rating) {
    const id = current();
    if (!session || !id || !session.showing) return;
    const before = Backend.get("card", id);
    const info = describe(id);
    let step = null;
    try {
      step = Store.gradeCard(id, rating);
    } catch (error) {
      notice(error.message);
      return;
    }
    if (step) {
      step.inserted = false;
      // D-191: a line card that held retires; a list card's forgotten lines
      // each take a step towards their own card, in the list's order.
      step.lineSteps = { made: [], unpaused: [], retired: null };
      try {
        if (Store.isLineCard(before)) {
          if (rating >= 3 && Store.retireLineCard(id)) step.lineSteps.retired = id;
        } else {
          const marks = session.marks.get(id);
          const f = marks && marks.size ? listFaceOf(id) : null;
          if (f && !f.line) step.lineSteps = Store.recordListMisses(f.lines.map(l => l.id).filter(x => marks.has(x)));
        }
      } catch (error) { notice(error.message); }
      session.undo.push(step);
      if (session.undo.length > MAX_UNDO) session.undo.shift();
      session.tally[rating - 1] += 1;
      maybeLeech(id, before, rating);
    } else {
      notice("Card no longer exists");
    }
    if (info) {
      // D-191: a line asked both ways (`<>`, `::`, or a turned concept) is
      // one fact in two directions, and a stored `rev` reads as `<>`.
      const paired = info.note.occ_mode != null || info.entry.reverse || Model.cardAsks(info.note.attrs) === "b";
      bury(info.note.id, paired);
    }
    if (rating === 1 && step) {
      const fresh = Backend.get("card", id);
      if (fresh && fresh.deleted_at == null) {
        const n = (session.reappear.get(id) || 0) + 1;
        session.reappear.set(id, n);
        if (n <= REAPPEAR_BUDGET) {
          session.queue.splice(Math.min(session.index + 2, session.queue.length), 0, id);
          step.inserted = true;
        }
      }
    }
    session.marks.delete(id);
    session.shown.delete(id);
    session.index += 1;
    session.showing = false;
    draw();
  }

  // Leech policy (off by default): only the Again that CROSSES the line
  // suspends (C-20), and the session says so.
  function maybeLeech(id, before, rating) {
    const s = Backend.library().settings;
    if (!s.leechAutoSuspend || rating !== 1 || before.lapses >= s.leechThreshold) return;
    const fresh = Backend.get("card", id);
    if (!fresh || fresh.suspended || fresh.lapses < s.leechThreshold) return;
    Store.setSuspended(id, true);
    for (let i = session.queue.length - 1; i > session.index; i--) if (session.queue[i] === id) session.queue.splice(i, 1);
    notice("Suspended as a leech");
  }

  function undo() {
    if (!session || !session.undo.length) return;
    const step = session.undo[session.undo.length - 1];
    // A line card the grade retired comes back first: the grade's own undo
    // refuses a card that is gone (`undoGrade`), and `undoLineSteps` says a
    // retired one returns.
    const retired = step.lineSteps && step.lineSteps.retired;
    if (retired) Store.undoLineSteps({ made: [], unpaused: [], retired });
    if (!Store.undoGrade(step)) {
      if (retired) Store.retireLineCard(retired);
      return;
    }
    session.undo.pop();
    try { Store.undoLineSteps({ ...step.lineSteps, retired: null }); } catch (error) { notice(error.message); }
    session.tally[step.rating - 1] = Math.max(0, session.tally[step.rating - 1] - 1);
    session.index = Math.max(0, session.index - 1);
    if (step.rating === 1) {
      if (step.inserted) {
        for (let i = session.index + 1; i < session.queue.length; i++) {
          if (session.queue[i] === step.cardId) { session.queue.splice(i, 1); break; }
        }
      }
      const n = (session.reappear.get(step.cardId) || 1) - 1;
      if (n <= 0) session.reappear.delete(step.cardId); else session.reappear.set(step.cardId, n);
    }
    session.showing = false;
    session.dealt = -1;
    draw();
  }

  function close() {
    if (!session) return;
    session = null;
    document.removeEventListener("keydown", onKey, true);
    if (root) root.remove();
    root = null;
    if (hooks.onClose) hooks.onClose();
  }

  function openInDoc() {
    const id = current();
    const info = id ? describe(id) : null;
    const docId = info ? info.doc.id : null;
    close();
    if (docId && hooks.openDoc) hooks.openDoc(docId);
  }

  function notice(text) {
    if (!session) return;
    session.notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { if (session) { session.notice = null; draw(); } }, 2500);
    draw();
  }

  // ---------------------------------------------------------------- drawing

  function mount() {
    if (root) root.remove();
    root = h("div.review", { role: "dialog", "aria-label": "Study" });
    document.body.appendChild(root);
    document.addEventListener("keydown", onKey, true);
  }

  function remaining() {
    const left = session.queue.length - session.index;
    let fresh = 0;
    for (let i = session.index; i < session.queue.length; i++) {
      const c = Backend.get("card", session.queue[i]);
      if (c && c.state === "new") fresh++;
    }
    return { left, fresh };
  }

  // `ReviewScheduleLine.text`.
  function scheduleLine(card) {
    const words = { learning: "Learning", review: "Review", relearning: "Relearning" };
    const parts = [words[card.state] || "New", ordinal(card.reps + 1) + " review"];
    if (card.stability > 0) parts.push("stability " + Sched.formatInterval(card.stability * 86400));
    const events = Backend.library().events.filter(e => e.card_id === card.id)
      .sort((a, b) => Date.parse(b.reviewed_at) - Date.parse(a.reviewed_at));
    if (events.length) {
      const e = events[0];
      const name = ["Again", "Hard", "Good", "Easy"][e.rating - 1] || "Good";
      parts.push(`last ${name}, ${agoWords(Date.parse(e.reviewed_at))}`);
    }
    return parts.join(" · ");
  }

  function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return n + "th";
    return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  }

  function agoWords(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} m ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }

  function wide() { return window.matchMedia("(min-width: 700px)").matches; }

  function draw() {
    if (!session || !root) return;
    clear(root);
    const column = h("div.review-column");
    root.appendChild(column);
    const id = current();
    const info = id ? describe(id) : null;
    if (id && !info) {
      // The card went while the session was open (deleted on the Mac).
      session.queue.splice(session.index, 1);
      return draw();
    }
    const mac = wide();

    const top = h("div.review-top",
      chip("Done", { onclick: close, key: mac ? "esc" : null }),
      h("span.spacer"),
      id ? h("button.text-action", { type: "button", onclick: openInDoc }, "Open in doc", mac ? h("span.keycap", { text: "O" }) : null) : null,
      h("button.text-action", { type: "button", onclick: undo, disabled: !session.undo.length },
        "Undo", mac ? h("span.keycap", { text: "Z" }) : null));
    column.appendChild(top);

    const { left, fresh } = remaining();
    const done = session.index;
    const total = done + left;
    column.appendChild(h("div.review-progress",
      h("div.progress", h("div.progress-fill", { style: `width:${total ? Math.round(done / total * 100) : 100}%` })),
      h("span.tabular", { text: left ? `${left} left${fresh ? ` · ${fresh} new` : ""}` : "0 left" })));

    const slot = h("div.review-slot");
    column.appendChild(slot);

    if (!id) {
      drawEnd(slot);
      column.appendChild(h("div.dock-row", h("button.dock.primary", { type: "button", onclick: close },
        h("span.dock-label", { text: "Done" }), mac ? h("span.keycap", { text: "esc" }) : null)));
      return;
    }

    const crumb = [info.folder && info.folder.deleted_at == null ? info.folder.name : null, info.doc.name]
      .filter(Boolean).join(" · ");
    slot.appendChild(h("div.review-crumb.eyebrow", { text: crumb }));

    const ctx = Pictures.context(Render.docStyle(info.doc.style));
    const f = Cards.faces(info.entry, ctx);
    const card = h("article.review-card", { onclick: () => { if (!session.showing) reveal(); } });
    Render.applyDocStyle(card, Render.docStyle(info.doc.style));
    if (session.dealt !== session.index) { card.classList.add("deal-in"); session.dealt = session.index; }
    let suggested = null;
    if (f.list) {
      // D-191: A LIST ANSWER. An ordered list shows its rule and its lines
      // from the start, one more per "Show line N"; a set shows every line,
      // each with its ✕, once the card is up; a line card its list with its
      // own line in a gap.
      const marks = session.marks.get(id) || new Set();
      card.appendChild(f.question);
      const rows = f.rows({ showing: session.showing, shown: session.shown.get(id) || 0, marks,
                            toggle: f.line ? null : lineId => toggleMiss(id, lineId) });
      if (rows) {
        card.appendChild(h("div.face-rule" + (session.showing ? "" : ".quiet")));
        card.appendChild(session.showing && !f.ordered && !f.line ? h("div.reveal-in", rows) : rows);
      }
      if (!f.line) suggested = Store.suggestedRating(marks.size, f.total);
    } else if (!session.showing) {
      card.appendChild(f.question);
    } else if (f.together) {
      card.appendChild(f.question);
      card.appendChild(h("div.face-rule"));
      card.appendChild(h("div.reveal-in", f.answer));
    } else {
      card.appendChild(h("div.reveal-in", f.answer));
    }
    slot.appendChild(card);
    ctx.resolve();

    if (session.showing) {
      const after = h("div.after-card.reveal-in");
      const L = Backend.library();
      if (L.settings.fromYourNotes) {
        const b = info.block;
        const hidden = Render.hiddenMarkerLength(b.text, b.kind);
        after.appendChild(h("div.notes-block",
          h("div.eyebrow", { text: ["From your notes", info.heading].filter(Boolean).join(" · ") }),
          h("div.notes-text", Render.inlineDOM(b.text.slice(hidden), Spans.slice(b.runs, hidden, b.text.length), ctx))));
      }
      after.appendChild(h("div.schedule-line", { text: scheduleLine(info.card) }));
      slot.appendChild(after);
    }

    if (session.notice) slot.appendChild(h("div.review-notice", { text: session.notice }));

    const dock = h("div.dock-row");
    if (!session.showing) {
      const left = linesLeft(id);
      dock.appendChild(h("button.dock", { type: "button", onclick: reveal },
        h("span.dock-label", { text: left ? `Show line ${(session.shown.get(id) || 0) + 1}` : "Show answer" }),
        mac ? h("span.keycap", { text: "Space" }) : h("span.dock-sub", { text: "tap the card" })));
    } else {
      const grades = h("div.grades");
      for (const [k, label, rating] of GRADES) {
        // The capsule a list's marks suggest carries a ring; the person
        // still picks.
        const b = h("button.grade.grade-" + k, { type: "button", onclick: () => grade(rating) },
          h("span.dock-label", { text: label }),
          h("span.grade-interval", { text: Store.preview(id, rating) + (mac ? ` · ${rating}` : "") }));
        if (suggested === rating) b.classList.add("suggested");
        grades.appendChild(b);
      }
      dock.appendChild(grades);
    }
    column.appendChild(dock);
  }

  function drawEnd(slot) {
    const L = Backend.library();
    const graded = session.tally.reduce((a, b) => a + b, 0);
    const seconds = (Date.now() - session.startedAt) / 1000;
    const tomorrow = FSRS.startOfDay(Date.now()) + 2 * 86400000 - 1;
    const dueTomorrow = Sched.dueCounts(L, tomorrow, L.settings.newPerDay).total;
    const end = h("article.review-card.end-card.deal-in",
      h("div.end-ring", h("span", { text: "✓" })),
      h("div.end-title", { text: "All caught up" }),
      h("div.end-line", { text: `${UI.plural(graded, "card")} · ${seconds < 60 ? "under a minute" : Math.round(seconds / 60) + " min"}` }),
      Cards.tallyStripe(session.tally),
      h("div.end-next", { text: `${dueTomorrow} due tomorrow` }));
    slot.appendChild(end);
  }

  function onKey(event) {
    if (!session) return;
    if (UI.sheetOpen()) return;
    if (event.metaKey && (event.key === "z" || event.key === "Z")) { event.preventDefault(); undo(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const k = event.key;
    if (k === "Escape") { event.preventDefault(); close(); return; }
    if (!current()) {
      if (k === "Enter" || k === " ") { event.preventDefault(); close(); }
      return;
    }
    if (k === " " || k === "Enter") {
      event.preventDefault();
      if (!session.showing) reveal();
      return;
    }
    if (session.showing && /^[1-4]$/.test(k)) { event.preventDefault(); grade(Number(k)); return; }
    if (k === "z" || k === "Z") { event.preventDefault(); undo(); return; }
    if (k === "o" || k === "O") { event.preventDefault(); openInDoc(); }
  }

  return { start, isOpen, close, describe, blocksFor, reveal, grade, undo, toggleMiss,
           get session() { return session; } };
})();
