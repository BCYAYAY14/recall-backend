// What the web writes, as the app writes it: a grade (card row plus grade
// event, `AppDatabase.grade`), its undo (`undoGrade`), a line of a doc
// (`outlineUpdateText` with its card reconcile), a new line, a deleted line,
// a doc made, renamed, deleted and restored, a study deadline
// (`setExamDeadline` with `clampScheduledToExam`) and a doc's own scheduler
// knobs. Every write goes out as whole rows through Backend.write, stamped
// past the row's own stamp, and last write wins with the tie to the server.

const Store = (() => {

  const now = () => Date.now();
  const iso = t => Wire.wireTime(t);
  const ms = t => (t == null ? null : Date.parse(t));
  const REVERSE_ORDINAL = -1;   // `ReverseCard.ordinal`

  const lib = () => Backend.library();

  function liveCardsOf(noteId) {
    return lib().cards.filter(c => c.note_id === noteId && c.deleted_at == null);
  }

  function cardEnv(c) {
    return {
      note_id: c.note_id, cloze_ordinal: c.cloze_ordinal, flag: c.flag, suspended: c.suspended,
      stability: c.stability, difficulty: c.difficulty, due: c.due, state: c.state,
      last_review_at: c.last_review_at, introduced_on: c.introduced_on, reps: c.reps, lapses: c.lapses,
      detached: c.detached, deleted_at: c.deleted_at ?? null,
    };
  }

  // `Card.fresh`: new, due at its creation, no memory.
  function freshCard(noteId, ordinal, q, a, t) {
    return Backend.write("card", crypto.randomUUID(), {
      env: { note_id: noteId, cloze_ordinal: ordinal, flag: 0, suspended: false, stability: 0, difficulty: 0,
             due: iso(t), state: "new", last_review_at: null, introduced_on: null, reps: 0, lapses: 0,
             detached: false, deleted_at: null },
      content: { q_snapshot: q, a_snapshot: a },
    }, { now: t });
  }

  // ------------------------------------------------------------------ grade

  // `AppDatabase.grade`: the scope's retention, FSRS-6, the deadline clamp,
  // the lapse count, `introduced_on` on the first grade, and an append-only
  // grade event carrying THIS device's id. Returns the undo step, or null
  // when the card may not be graded (gone, suspended, detached).
  function gradeCard(cardId, rating, t = now()) {
    const L = lib();
    const card = Backend.get("card", cardId);
    if (!card || card.deleted_at != null || card.suspended || card.detached) return null;
    const note = L.notes.get(card.note_id);
    if (!note || note.deleted_at != null) return null;
    const before = { ...card };
    const elapsed = card.last_review_at ? (t - ms(card.last_review_at)) / 86400000 : 0;
    const mem = card.reps === 0 ? null : { stability: card.stability, difficulty: card.difficulty };
    const retention = Sched.retentionFor(L, note.notebook_id, L.settings.retention);
    const p = FSRS.params(retention / 100, L.settings.weights);
    const out = FSRS.grade(mem, card.state, rating, elapsed, t, p, Sched.spreadFor(L, card, elapsed, t));
    const due = Sched.clampToExam(out.due, Sched.rawExam(L, L.docs.get(note.notebook_id)), t);
    const lapse = rating === 1 && out.newState === "relearning" && card.state === "review";
    Backend.write("card", cardId, {
      env: {
        stability: out.state.stability, difficulty: out.state.difficulty, due: iso(due), state: out.newState,
        last_review_at: iso(t), introduced_on: card.reps === 0 ? iso(t) : card.introduced_on,
        reps: card.reps + 1, lapses: card.lapses + (lapse ? 1 : 0),
      },
    }, { now: t });
    const eventId = crypto.randomUUID();
    Backend.write("grade_event", eventId, {
      env: { card_id: cardId, rating, reviewed_at: iso(t), device_id: Backend.deviceId() }, content: {},
    }, { now: t });
    if (note.unreviewed) Backend.write("note", note.id, { env: { unreviewed: false } }, { now: t });
    return { cardId, before, eventId, rating, reviewedAt: t };
  }

  // What a grade WOULD schedule, deadline included (C-23): the capsule
  // states the number the press acts on.
  function preview(cardId, rating, t = now()) {
    const L = lib();
    const card = Backend.get("card", cardId);
    if (!card) return "";
    const note = L.notes.get(card.note_id);
    if (!note) return "";
    const elapsed = card.last_review_at ? (t - ms(card.last_review_at)) / 86400000 : 0;
    const mem = card.reps === 0 ? null : { stability: card.stability, difficulty: card.difficulty };
    const p = FSRS.params(Sched.retentionFor(L, note.notebook_id, L.settings.retention) / 100,
                         L.settings.weights);
    const out = FSRS.grade(mem, card.state, rating, elapsed, t, p, Sched.spreadFor(L, card, elapsed, t));
    const due = Sched.clampToExam(out.due, Sched.rawExam(L, L.docs.get(note.notebook_id)), t);
    return Sched.gradeRowInterval(due, t);
  }

  // `undoGrade`: restores the columns a grade writes and nothing else
  // (C-22), stamped past the LIVE row; drops the event if it never left.
  function undoGrade(step) {
    const live = Backend.get("card", step.cardId);
    if (!live || live.deleted_at != null) return false;
    const note = lib().notes.get(live.note_id);
    if (!note || note.deleted_at != null) return false;
    const b = step.before;
    Backend.write("card", step.cardId, {
      env: { stability: b.stability, difficulty: b.difficulty, due: b.due, state: b.state,
             last_review_at: b.last_review_at, introduced_on: b.introduced_on, reps: b.reps, lapses: b.lapses },
    });
    Backend.discard("grade_event", step.eventId);
    return true;
  }

  function setSuspended(cardId, suspended) {
    const card = Backend.get("card", cardId);
    if (!card || card.deleted_at != null) return;
    Backend.write("card", cardId, { env: { suspended } });
  }

  // ----------------------------------------------------------------- attrs

  function attrsObject(json) {
    if (!json) return {};
    try { const d = JSON.parse(json); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; }
    catch (_) { return {}; }
  }

  // `CanvasAttrs.encoded`: nil when nothing but the version is left, else
  // sorted keys with `v`.
  function encodeAttrs(obj) {
    const out = { ...obj };
    delete out.v;
    if (!Object.keys(out).length) return null;
    out.v = 1;
    const sorted = {};
    for (const k of Object.keys(out).sort()) sorted[k] = out[k];
    return JSON.stringify(sorted);
  }

  // `CanvasAttrs`, byte for byte, for the writes that must leave exactly the
  // attrs the app would (D-191's `attrs.tg` and `attrs.ask`). Known keys are
  // read the way `CanvasAttrs.decode` reads them (a dead `rev`, `c`, `tf`,
  // `g` or `r` is dropped on the next write, a stored version kept) and
  // written the way `encoded` writes them (NULL when nothing is left, keys
  // sorted, `v` last in the dictionary and sorted with the rest, a slash
  // escaped as JSONSerialization escapes it).
  const KNOWN_ATTRS = new Set(["v", "d", "w", "hdr", "card", "c", "m", "mw", "crop", "tf", "ts", "chk",
                               "rev", "tg", "ask", "g", "r"]);
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function decodeCanvasAttrs(json) {
    const a = { version: 1, d: 0, w: [], hdr: true, card: false, m: null, mw: null, crop: null, ts: null,
                chk: false, tg: null, ask: null, unknown: {} };
    if (!json) return a;
    let d;
    try { d = JSON.parse(json); } catch (_) { return a; }
    if (!d || typeof d !== "object" || Array.isArray(d)) return a;
    a.version = Number.isInteger(d.v) ? d.v : 0;
    a.d = Number.isInteger(d.d) ? d.d : 0;
    a.w = Array.isArray(d.w) ? d.w.filter(n => typeof n === "number") : [];
    a.hdr = typeof d.hdr === "boolean" ? d.hdr : true;
    a.card = typeof d.card === "boolean" ? d.card : typeof d.c === "boolean" ? d.c : false;
    a.m = typeof d.m === "string" && UUID_SHAPE.test(d.m) ? d.m.toUpperCase() : null;
    a.mw = typeof d.mw === "number" ? d.mw : null;
    a.crop = Array.isArray(d.crop) ? d.crop.filter(n => typeof n === "number") : null;
    a.ts = typeof d.ts === "number" ? d.ts : null;
    a.chk = d.chk === true;
    a.tg = typeof d.tg === "string" ? d.tg : (d.rev === true ? "<>" : null);
    a.ask = typeof d.ask === "string" ? d.ask : null;
    for (const k of Object.keys(d)) if (!KNOWN_ATTRS.has(k)) a.unknown[k] = d[k];
    return a;
  }

  function sortedJSON(v) {
    if (Array.isArray(v)) return "[" + v.map(sortedJSON).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + sortedJSON(v[k])).join(",") + "}";
    }
    return JSON.stringify(v);
  }

  function encodeCanvasAttrs(a) {
    const isDefault = !Object.keys(a.unknown).length && a.d === 0 && !a.w.length && a.hdr && !a.card
      && a.m == null && a.mw == null && !(a.crop && a.crop.length) && a.ts == null && !a.chk
      && a.tg == null && a.ask == null;
    if (isDefault) return null;
    const out = { ...a.unknown };
    if (a.d !== 0) out.d = a.d;
    if (a.w.length) out.w = a.w;
    if (!a.hdr) out.hdr = false;
    if (a.card) out.card = true;
    if (a.m != null) out.m = a.m;
    if (a.mw != null) out.mw = a.mw;
    if (a.crop && a.crop.length) out.crop = a.crop;
    if (a.ts != null) out.ts = a.ts;
    if (a.chk) out.chk = true;
    if (a.tg != null) out.tg = a.tg;
    if (a.ask != null) out.ask = a.ask;
    if (!Object.keys(out).length) return null;
    out.v = a.version;
    return sortedJSON(out).replace(/\//g, "\\/");
  }

  // `Note.storeCardMark`: the trigger a split carries, the default (`>>`
  // with an answer on its line) left unstored; a Basic trigger drops `ask`.
  // The attrs are rewritten ONLY when something changed, as the app does.
  function storeCardMark(json, split) {
    const a = decodeCanvasAttrs(json);
    const wanted = split.mark.text === ">>" && split.back !== "" ? null : split.mark.text;
    let changed = false;
    if (a.tg !== wanted) { a.tg = wanted; changed = true; }
    if (!Gate.takesAskOverride(split.separator) && a.ask != null) { a.ask = null; changed = true; }
    return changed ? encodeCanvasAttrs(a) : (json ?? null);
  }

  // `Note.clearCardMark`: a line that stopped being a card line drops its
  // stored trigger and direction.
  function clearCardMark(json) {
    if (!json || (json.indexOf('"tg"') < 0 && json.indexOf('"rev"') < 0 && json.indexOf('"ask"') < 0)) return json ?? null;
    const a = decodeCanvasAttrs(json);
    if (a.tg == null && a.ask == null) return json;
    a.tg = null;
    a.ask = null;
    return encodeCanvasAttrs(a);
  }

  // `attrs.ask` set to `ask` ("f", "r", "b" or null), the attrs rewritten
  // only when it changed.
  function withAsk(json, ask) {
    const a = decodeCanvasAttrs(json);
    const wanted = ask === "f" || ask === "r" || ask === "b" ? ask : null;
    if (a.ask === wanted) return json ?? null;
    a.ask = wanted;
    return encodeCanvasAttrs(a);
  }

  // THE ARROW'S MENU, ASKS ALONE (D-191): a concept's or a descriptor's
  // direction changed while its trigger stays, so only `attrs.ask` moves and
  // the line's cards follow it (a card per direction asked). A Basic line
  // has no `ask` of its own: its direction is its trigger.
  function setCardAsk(noteId, ask, t = now()) {
    const note = Backend.get("note", noteId);
    if (!note || note.deleted_at != null || note.cloze_text != null) return false;
    const split = Gate.splitCard(Model.rawText(note));
    if (!split || !Gate.takesAskOverride(split.separator)) return false;
    const attrs = withAsk(note.attrs ?? null, ask);
    if (attrs === (note.attrs ?? null)) return false;
    Backend.write("note", noteId, { content: { attrs } }, { now: t });
    reconcileBasic(noteId, split.isOneLineCard, t);
    return true;
  }

  // THE ARROW'S MENU, ANSWER (D-191, `applyChipChange`'s `.answer`): the
  // answer lines under a list-shaped line become a SET (each `N. ` taken off,
  // a bullet) or IN ORDER (`N. ` written, counted per depth and restarting
  // under a shallower line, numbered), each keeping its depth and its style.
  // One write per line that changed; the prompt's card follows.
  function setAnswerShape(promptId, answer, t = now()) {
    const prompt = Backend.get("note", promptId);
    if (!prompt || prompt.deleted_at != null) return false;
    const split = Gate.splitCard(Model.rawText(prompt));
    if (!split || !split.listShaped) return false;
    const { lines } = listAnswerLines(prompt);
    const blocks = lines.map(n => Model.build([n], new Map(), new Set())[0]);
    const edits = CardLine.answerEdits(blocks.map((b, i) => ({ text: b.text, depth: Model.listDepth(lines[i]) })), answer);
    if (!edits) return false;
    let wrote = false;
    lines.forEach((line, i) => {
      const { cut, add, kind } = edits[i];
      const b = blocks[i];
      const text = add + b.text.slice(cut);
      const runs = Spans.mapped(b.runs, 0, cut, add.length);
      const live = Backend.get("note", line.id);
      if (storeLine(live, text, kind, live.attrs ?? null, text, runs, t)) wrote = true;
    });
    return wrote;
  }

  // ------------------------------------------------------------ the cards

  // `retireBasicCard`: the plain card and its reverse sibling go; an
  // ungraded card dissolves, a graded one DETACHES (P0.7c).
  function retire(card, t) {
    if (card.reps === 0) Backend.write("card", card.id, {}, { tombstone: true, now: t });
    else if (!card.detached) Backend.write("card", card.id, { env: { detached: true } }, { now: t });
  }

  // One direction's card row (`reconcileDirection`): created when wanted and
  // missing, written ONLY when its content changed (a card write carries
  // this page's copy of its schedule, which may be older than a grade made
  // elsewhere; review 2026-09-26, web-5), and when no longer wanted it
  // dissolves ungraded and DETACHES graded (P0.7c).
  function reconcileDirection(noteId, ordinal, wanted, q, a, t) {
    const live = liveCardsOf(noteId).find(c => (ordinal == null ? c.cloze_ordinal == null : c.cloze_ordinal === ordinal));
    if (wanted) {
      if (!live) { freshCard(noteId, ordinal, q, a, t); return; }
      if (live.detached || (live.q_snapshot ?? null) !== q || (live.a_snapshot ?? null) !== a) {
        Backend.write("card", live.id, { env: { detached: false }, content: { q_snapshot: q, a_snapshot: a } }, { now: t });
      }
    } else if (live) {
      retire(live, t);
    }
  }

  // `reconcileOutlineCard` for a basic line (D-191): a card row PER
  // DIRECTION the line asks (`>>` forward, `<<` reverse only, `<>` and `::`
  // both, `;;` forward, a concept or descriptor turned round by `attrs.ask`),
  // each kept, created or retired alone. A list-shaped line's gate is the
  // lines under it.
  function reconcileBasic(noteId, gated, t) {
    const note = Backend.get("note", noteId);
    if (!note || note.deleted_at != null) return;
    let g = gated;
    if (isListPrompt(note)) g = listAnswerLines(note).lines.length > 0;
    const asks = Model.cardAsks(note.attrs);
    const answer = cardAnswerSnapshot(note);
    const front = note.front ?? null;
    reconcileDirection(noteId, null, g && asks !== "r", front, answer, t);
    reconcileDirection(noteId, REVERSE_ORDINAL, g && asks !== "f", answer, front, t);
    // A line that stopped being cloze drops its ordinal cards (an occlusion
    // note never reaches here: its prompt is saved as text alone).
    for (const c of liveCardsOf(noteId)) if (c.cloze_ordinal != null && c.cloze_ordinal > 0) retire(c, t);
  }

  // ------------------------------------------------ list answers (D-191)

  // `isListPrompt`: a line whose trigger ENDS it and is ON; its answer is
  // the lines under it.
  function isListPrompt(note) {
    if (!note || note.cloze_text != null || (note.back ?? "") !== "" || !(note.front ?? "")) return false;
    const m = Model.storedMark(note.attrs);
    if (!m || m.off) return false;
    return note.kind !== "tablerow" && note.kind !== "table";
  }

  // `listAnswerLines`: the lines right after it in its sibling group that
  // are list items deeper than it, up to the first that is not; `ordered`
  // when the first is numbered.
  function listAnswerLines(note) {
    const depth = Model.listDepth(note);
    const sibs = siblingsOf(note.notebook_id, note.parent_id ?? null);
    const at = sibs.findIndex(s => s.id === note.id);
    const lines = [];
    const after = at < 0 ? sibs.filter(s => Order.compare(s, note) > 0) : sibs.slice(at + 1);
    for (const row of after.slice(0, 400)) {
      if (!Model.isListKind(row.kind) || Model.listDepth(row) <= depth) break;
      lines.push(row);
    }
    return { lines, ordered: lines.length > 0 && lines[0].kind === "numbered" };
  }

  // `cardAnswerSnapshot`: the back, or a list-shaped line's answer lines,
  // one to a line.
  function cardAnswerSnapshot(note) {
    if (note.back) return note.back;
    if (!isListPrompt(note)) return note.back ?? null;
    const { lines } = listAnswerLines(note);
    return lines.length ? lines.map(n => Model.rawText(n)).join("\n") : null;
  }

  // `reconcileListPrompts(near:)`: after a write that can change a list,
  // the list-shaped lines whose answer the touched notes may have joined or
  // left, found by walking BACK through each one's sibling group over the
  // list items above it (a bounded walk, never the whole doc).
  function reconcileListPrompts(noteIds, t = now()) {
    const seen = new Set();
    for (const id of noteIds) {
      const touched = Backend.get("note", id);
      if (!touched) continue;
      // A group with no list prompt in it has nothing to reconcile, and
      // asking costs one pass instead of a sort (a doc of plain lines).
      const group = [...lib().notes.values()].filter(n => n.deleted_at == null && n.notebook_id === touched.notebook_id
        && (n.parent_id ?? null) === (touched.parent_id ?? null));
      if (!group.some(isListPrompt)) continue;
      const candidates = [];
      if (touched.deleted_at == null) candidates.push(touched);
      const above = group.sort(Order.compare)
        .filter(s => s.id !== touched.id && Order.compare(s, touched) < 0).reverse().slice(0, 400);
      for (const row of above) {
        candidates.push(row);
        if (!Model.isListKind(row.kind)) break;
      }
      for (const c of candidates) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        if (isListPrompt(c)) reconcileBasic(c.id, false, t);
      }
    }
  }

  // `descriptorOwner`: walking up from a `;;` line through its sibling
  // group, skipping lines deeper than it and other descriptors at its depth,
  // the first line reached is its CONCEPT when it is a `::` line. A heading
  // stops the walk.
  function descriptorOwner(note) {
    const m = Model.storedMark(note && note.attrs);
    if (!m || m.separator !== ";;") return null;
    const depth = Model.listDepth(note);
    const above = siblingsOf(note.notebook_id, note.parent_id ?? null)
      .filter(s => s.id !== note.id && Order.compare(s, note) < 0).reverse().slice(0, 400);
    for (const row of above) {
      if (/^heading[123]$/.test(row.kind || "")) return null;
      const d = Model.listDepth(row);
      if (d > depth) continue;
      const rm = Model.storedMark(row.attrs);
      if (d === depth && rm && rm.separator === ";;") continue;
      return rm && rm.separator === "::" && (row.front ?? "") ? row : null;
    }
    return null;
  }

  // `cardContext`: what a card's face needs beyond its note.
  function cardContext(note) {
    const out = { answerLines: [], ordered: false, concept: null };
    if (isListPrompt(note)) {
      const found = listAnswerLines(note);
      out.answerLines = found.lines.map(n => Model.rawText(n));
      out.ordered = found.ordered;
    }
    const owner = descriptorOwner(note);
    out.concept = owner ? owner.front : null;
    return out;
  }

  // ------------------------------------------- list review (D-191, ListReview)
  //
  // A set shows every answer line with a ✕ to mark what was forgotten and
  // SUGGESTS a grade; an ordered list reveals one line at a time and grades
  // once at the end. A line forgotten twice becomes its own card until it
  // holds: the first miss makes a PAUSED line card (ordinal -2 on the ANSWER
  // line's own note, suspended), the second miss unpauses it, and a Good or
  // Easy on it retires it (it dissolves; its grades stay in the log). The
  // reconciles touch null, -1 and positive ordinals only, so an edit to the
  // line never dissolves it.
  const LINE_ORDINAL = -2;   // `ListReview.lineOrdinal`
  const isLineCard = card => !!card && card.cloze_ordinal === LINE_ORDINAL;

  // `ListReview.suggestedRating`: none forgotten Good (3), fewer than half
  // Hard (2), half or more Again (1); null with no lines.
  function suggestedRating(forgotten, total) {
    if (!(total > 0)) return null;
    if (forgotten <= 0) return 3;
    return forgotten * 2 < total ? 2 : 1;
  }

  // `RichText.numberedMarker`'s rest: an answer line as a face prints it,
  // without a numbered item's `N. ` (the face numbers the lines itself).
  function listLineText(note) {
    const t = Model.rawText(note);
    const m = /^(\d+)[.)]( |$)/.exec(t);
    return m ? t.slice(m[0].length) : t;
  }

  // `AppDatabase.listPrompt(of:)`: the list-shaped line whose answer `line`
  // is, walking back through its sibling group over the list items above it
  // (at most 400 rows), or null.
  function listPromptOf(line) {
    if (!line || !Model.isListKind(line.kind)) return null;
    const above = siblingsOf(line.notebook_id, line.parent_id ?? null)
      .filter(s => s.id !== line.id && Order.compare(s, line) < 0).reverse().slice(0, 400);
    for (const row of above) {
      if (isListPrompt(row) && listAnswerLines(row).lines.some(n => n.id === line.id)) return row;
      if (!Model.isListKind(row.kind)) break;
    }
    return null;
  }

  // `lineCardContext(for:)`: a line card's face, the prompt it belongs to
  // (with a descriptor's concept), the whole list, and which line is hidden.
  function lineCardContext(note) {
    const prompt = listPromptOf(note);
    if (!prompt) return null;
    const found = listAnswerLines(prompt);
    const index = found.lines.findIndex(n => n.id === note.id);
    if (index < 0) return null;
    const owner = descriptorOwner(prompt);
    return { prompt: prompt.front ?? "", concept: owner ? owner.front : null,
             lines: found.lines.map(listLineText), index, ordered: found.ordered };
  }

  // `recordListMisses`: after a list card's grade each forgotten line takes
  // one step towards its own card. No line card yet makes a paused one; a
  // paused one is unpaused; a live one is left to its own schedule. Answers
  // what it did, for the grade's undo.
  function recordListMisses(lineIds, t = now()) {
    const steps = { made: [], unpaused: [], retired: null };
    for (const id of lineIds) {
      const note = Backend.get("note", id);
      if (!note || note.deleted_at != null) continue;
      const card = liveCardsOf(id).find(isLineCard);
      if (card) {
        if (!card.suspended) continue;
        Backend.write("card", card.id, { env: { suspended: false } }, { now: t });
        steps.unpaused.push(card.id);
      } else {
        const made = Backend.write("card", crypto.randomUUID(), {
          env: { note_id: id, cloze_ordinal: LINE_ORDINAL, flag: 0, suspended: true, stability: 0, difficulty: 0,
                 due: iso(t), state: "new", last_review_at: null, introduced_on: null, reps: 0, lapses: 0,
                 detached: false, deleted_at: null },
          content: { q_snapshot: null, a_snapshot: null },
        }, { now: t });
        steps.made.push(made.id);
      }
    }
    return steps;
  }

  // `retireLineCard`: a line card that held dissolves; its grades stay.
  function retireLineCard(cardId, t = now()) {
    const card = Backend.get("card", cardId);
    if (!isLineCard(card) || card.deleted_at != null) return false;
    Backend.write("card", cardId, {}, { tombstone: true, now: t });
    return true;
  }

  // `undoLineSteps`: a grade's undo takes its line card steps back: a card
  // it made goes, one it unpaused is paused again, one it retired returns.
  function undoLineSteps(steps, t = now()) {
    if (!steps) return;
    for (const id of steps.made || []) {
      const c = Backend.get("card", id);
      if (c && c.deleted_at == null) Backend.write("card", id, {}, { tombstone: true, now: t });
    }
    for (const id of steps.unpaused || []) {
      const c = Backend.get("card", id);
      if (c && c.deleted_at == null) Backend.write("card", id, { env: { suspended: true } }, { now: t });
    }
    if (steps.retired) {
      const before = Backend.contentBefore("card", steps.retired);
      if (before) Backend.write("card", steps.retired, { env: { ...before.env, deleted_at: null }, content: before.content }, { now: t });
    }
  }

  function reconcileCloze(noteId, text, t) {
    const wanted = new Set(Gate.clozeOrdinals(text));
    const seen = new Set();
    for (const c of liveCardsOf(noteId)) {
      if (c.cloze_ordinal == null || c.cloze_ordinal === REVERSE_ORDINAL) { retire(c, t); continue; }
      if (c.cloze_ordinal <= 0) continue;
      seen.add(c.cloze_ordinal);
      if (wanted.has(c.cloze_ordinal)) {
        if (c.detached || c.q_snapshot !== text || c.a_snapshot !== text) {
          Backend.write("card", c.id, { env: { detached: false }, content: { q_snapshot: text, a_snapshot: text } }, { now: t });
        }
      } else {
        retire(c, t);
      }
    }
    for (const o of [...wanted].sort((a, b) => a - b)) if (!seen.has(o)) freshCard(noteId, o, text, text, t);
  }

  // ------------------------------------------------------------ the lines

  // One line of a doc, as `outlineUpdateText` stores it: a typed marker
  // declares the kind and comes off (prefix free, v2.9); a cloze span makes
  // a cloze note; a trigger (D-191's six) makes a card per direction it
  // asks; anything else is text. With `runs` (the editor's styled line) the style is written as the
  // store will hold it: mapped through what the store did to the text
  // (`CanvasBlock.storedRuns`) and fingerprinted against the stored anchor
  // (landmines 67, 68). Without them `spans` is left as it was, so a changed
  // text drops its style on read (R3) exactly as the app's plain paths do.
  //
  // A marker declares a kind only when it was TYPED: text the store already
  // holds is prefix free, so a heading titled `1. Intro` or a quote
  // `# install` carries what reads as a marker and keeps its kind and its
  // words (review 2026-09-26, web-2; Ink 18 R7 on the app). A marker is typed
  // when the stored line did not already open with the same one; likewise a
  // numbered line becomes body only when its number was deleted.
  //
  // `ask` (D-191, the arrow's menu) is the direction the block stores in the
  // same write, for a concept or a descriptor (`applyChipChange`); left
  // undefined, the stored one stays.
  function saveLine(noteId, text, t = now(), runs = undefined, { base = null, ask = undefined } = {}) {
    const note = Backend.get("note", noteId);
    if (!note || note.deleted_at != null) return false;
    // A legacy `code` row is a paragraph now (`Model.kindOf`), stored so.
    let kind = Model.kindOf(note);
    let body = text.replace(/\n/g, " ");
    let attrsJson = note.attrs ?? null;
    const stored = Model.rawText(note);
    const was = Gate.declaredKind(stored);
    const declared = Gate.declaredKind(body);
    const typed = declared && !(was && was.kind === declared.kind);
    if (typed) {
      kind = declared.kind;
      if (declared.marker) body = body.slice(declared.marker);
      if (declared.kind === "checkbox") {
        const a = decodeCanvasAttrs(attrsJson);
        if (a.chk !== !!declared.checked) { a.chk = !!declared.checked; attrsJson = encodeCanvasAttrs(a); }
      }
    } else if (kind === "numbered" && was && was.kind === "numbered" && !/^\d+[.)]( |$)/.test(body.trim())) {
      kind = "paragraph";
    }
    return storeLine(note, body, kind, attrsJson, text, runs, t, base, ask);
  }

  // A block's WHOLE text replaced (find and replace, `CanvasDocument
  // .replaceAll`): the same note, its kind kept (a replacement never
  // declares one), stored as the canvas's commit stores it, its card
  // reconciled, its runs carried. False when nothing changed.
  function replaceLineText(noteId, text, runs, t = now()) {
    const note = Backend.get("note", noteId);
    if (!note || note.deleted_at != null) return false;
    return storeLine(note, text.replace(/\n/g, " "), Model.kindOf(note), note.attrs ?? null, text, runs, t);
  }

  // `applyOutlineText` and `reconcileOutlineCard` over one note: a cloze
  // span makes a cloze note (its attrs untouched); an occlusion note's
  // prompt is text alone; a trigger splits the
  // line into its two sides and `attrs.tg` remembers which trigger it was
  // (`storeCardMark`), and anything else is text with no trigger stored.
  // `shown` is the text the runs are measured against.
  function storeLine(note, body, kind, attrsJson, shown, runs, t, base = null, ask = undefined) {
    const noteId = note.id;
    const trimmed = Gate.storedTrim(body);
    const regions = lib().occlusion.some(o => o.note_id === noteId && o.deleted_at == null);
    let front = trimmed, back = null, cloze = null, gated = false;
    let attrs = attrsJson ?? null;
    if (regions) {
      front = body.replace(/^\s+|\s+$/g, "");
    } else if (Gate.clozeOrdinals(trimmed).length) {
      cloze = trimmed; front = null;
    } else {
      const split = Gate.splitCard(body);
      if (split) {
        front = split.front;
        back = split.back || null;
        gated = split.isOneLineCard;
        attrs = storeCardMark(attrs, split);
        if (ask !== undefined && Gate.takesAskOverride(split.separator)) attrs = withAsk(attrs, ask);
      } else {
        front = trimmed;
        attrs = clearCardMark(attrs);
      }
    }
    let spans = note.spans ?? null;
    if (runs !== undefined) {
      const anchor = Model.rawText({ kind, front, back, cloze_text: cloze, attrs });
      spans = Spans.encode(Spans.mappedThroughDiff(runs || [], shown, anchor), anchor);
    }
    // A legacy `code` row read as the paragraph it is now is the same kind:
    // an untouched line is never written (web-5); an edit stores `paragraph`.
    const sameKind = note.kind === kind || (note.kind === "code" && kind === "paragraph");
    const same = sameKind && (note.front ?? null) === front && (note.back ?? null) === back
      && (note.cloze_text ?? null) === cloze && (note.attrs ?? null) === attrs
      && (note.spans ?? null) === spans;
    if (same) return false;
    Backend.write("note", noteId, {
      env: { kind, unreviewed: false },
      content: { front, back, cloze_text: cloze, attrs, spans },
    }, { now: t, base });
    if (!regions) {
      if (cloze != null) reconcileCloze(noteId, cloze, t);
      else reconcileBasic(noteId, gated, t);
    }
    reconcileListPrompts([noteId], t);
    return true;
  }

  // A sibling group in the app's read order (`Order.compare`).
  function siblingsOf(docId, parentId) {
    return [...lib().notes.values()]
      .filter(n => n.deleted_at == null && n.notebook_id === docId && (n.parent_id ?? null) === (parentId ?? null))
      .sort(Order.compare);
  }

  // `count` slots at `index` of a group (`OrderSlots.allocate`): between the
  // neighbours, or the lines nearby respaced, each row that moved written
  // (so stamped) and nothing else.
  function slotsAt(lane, group, index, count, t) {
    return Order.allocate(group, index, count, (row, position) =>
      Backend.write(lane, row.id, { env: { position } }, { now: t }));
  }

  // A new line after `afterId` (or at the end): a slot between its
  // neighbours, as the app places it (landmine 256).
  // `afterId` "" (not null) places the line FIRST in the doc's top level.
  function insertLine(docId, afterId, text = "", kind = "paragraph", t = now()) {
    const after = afterId ? Backend.get("note", afterId) : null;
    const parentId = after ? (after.parent_id ?? null) : null;
    const sibs = siblingsOf(docId, parentId);
    const index = afterId === "" ? 0 : after ? sibs.findIndex(s => s.id === after.id) + 1 || sibs.length : sibs.length;
    const [position] = slotsAt("note", sibs, index, 1, t);
    const id = blankLine(docId, parentId, position, kind, t);
    if (text) saveLine(id, text, t);
    else reconcileListPrompts([id], t);
    return id;
  }

  // MOVE BLOCK (⌥⌘[ and ⌥⌘], R7's keyboard door, `CanvasDocument.moveBlocks`):
  // the top-level blocks `ids` (a line, a table with its rows, a heading with
  // anything filed under it) move over ONE neighbouring block, up or down, and
  // only the moved rows (and any the slot needed respaced) are written. The
  // doc's trailing blank line stays last (R4). False when nothing can move.
  function moveBlocks(docId, ids, up, t = now()) {
    const sibs = siblingsOf(docId, null);
    const wanted = new Set(ids);
    const moving = sibs.filter(n => wanted.has(n.id));
    if (!moving.length || moving.length !== wanted.size) return false;
    const first = sibs.indexOf(moving[0]), last = sibs.indexOf(moving[moving.length - 1]);
    if (last - first + 1 !== moving.length) return false;
    const rest = sibs.filter(n => !wanted.has(n.id));
    let at;
    if (up) {
      if (first === 0) return false;
      at = rest.indexOf(sibs[first - 1]);
    } else {
      const tail = sibs[sibs.length - 1];
      const tailBlank = tail && tail.kind === "paragraph" && !tail.front && !tail.back && tail.cloze_text == null;
      const limit = sibs.length - (tailBlank ? 1 : 0);
      if (last + 1 >= limit) return false;
      at = rest.indexOf(sibs[last + 1]) + 1;
    }
    const positions = Order.allocate(rest, at, moving.length, (row, position) =>
      Backend.write("note", row.id, { env: { position } }, { now: t }));
    moving.forEach((row, i) => Backend.write("note", row.id, { env: { position: positions[i] } }, { now: t }));
    reconcileListPrompts(moving.map(n => n.id).concat(rest.slice(Math.max(0, at - 1), at + 1).map(n => n.id)), t);
    return true;
  }

  function blankLine(docId, parentId, position, kind, t, tags = "") {
    const id = crypto.randomUUID();
    Backend.write("note", id, {
      env: { notebook_id: docId, parent_id: parentId, position, kind, unreviewed: false, occ_mode: null,
             typed_answer: false, created_at: iso(t), deleted_at: null },
      content: { front: "", back: null, cloze_text: null, tags, spans: null, attrs: null },
    }, { now: t });
    return id;
  }

  // `deleteNotePromotingChildren`, for a line with no children: the note and
  // its cards, pictures and regions go together, at ONE instant
  // (`tombstoneNote`), past the newest of their stamps, so "the rows this
  // cut killed" is exactly the rows whose `deleted_at` is the note's (P2d's
  // paste revives those and no others).
  function deleteLine(noteId, t = now()) {
    const note = Backend.get("note", noteId);
    if (!note || note.deleted_at != null) return false;
    const L = lib();
    if ([...L.notes.values()].some(n => n.parent_id === noteId && n.deleted_at == null)) return false;
    const going = [note, ...liveCardsOf(noteId), ...[...L.media.values()].filter(m => m.note_id === noteId && m.deleted_at == null),
                   ...L.occlusion.filter(o => o.note_id === noteId && o.deleted_at == null)];
    t = Math.max(t, ...going.map(r => (r.updated_at ? ms(r.updated_at) + 1 : 0)));
    Backend.write("note", noteId, {}, { tombstone: true, now: t });
    for (const c of liveCardsOf(noteId)) Backend.write("card", c.id, {}, { tombstone: true, now: t });
    for (const m of L.media.values()) if (m.note_id === noteId && m.deleted_at == null) Backend.write("media", m.id, {}, { tombstone: true, now: t });
    for (const o of L.occlusion) if (o.note_id === noteId && o.deleted_at == null) Backend.write("occlusion", o.id, {}, { tombstone: true, now: t });
    reconcileListPrompts([noteId], t);
    return true;
  }

  // ------------------------------------------------ paste keeps cards (P2d)
  //
  // `restorePastedNote`: a stated id whose row is TOMBSTONED comes back as
  // itself at the paste's slot, with the card, picture and region rows THIS
  // cut killed (the ones whose `deleted_at` is the note's, so a card the
  // note dissolved long before stays dead), then takes the pasted text and
  // kind through the ordinary save, which finds its card and keeps its
  // schedule. A live id (a copy) is a fresh row with the stated kind. A row
  // this page never held before its tombstone cannot be revived (a
  // tombstone carries no content) and is pasted fresh.

  // A payload item's kind and text as the store keeps them: markdown's
  // marker off a prefix-free kind, its runs shifted with it.
  function pastedLine(item) {
    const kind = TEXT_KINDS.includes(item.kind) ? item.kind : "paragraph";
    let text = item.text, runs = item.spans ? Spans.decode(item.spans, item.text) : [];
    const prefix = Clip.PREFIX[kind];
    if (prefix && text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      runs = Spans.mapped(runs, 0, prefix.length, 0);
    }
    return { kind, text, runs };
  }

  function revivable(lane, id) {
    const row = Backend.get(lane, id);
    return !!(row && row.deleted_at != null && Backend.contentBefore(lane, id));
  }

  // Un-tombstones a row from what this page held before its tombstone.
  function revive(lane, id, env, t) {
    const before = Backend.contentBefore(lane, id);
    Backend.write(lane, id, { env: { ...before.env, ...env, deleted_at: null }, content: before.content }, { now: t });
  }

  // `reviveCutDependants`: the card, media and occlusion rows whose
  // `deleted_at` is the note's.
  function reviveCutDependants(noteId, deletedAt, t) {
    const L = lib();
    const rows = [["card", L.cards], ["media", [...L.media.values()]], ["occlusion", L.occlusion]];
    for (const [lane, list] of rows) {
      for (const r of list) {
        if (r.note_id === noteId && r.deleted_at != null && r.deleted_at === deletedAt && Backend.contentBefore(lane, r.id)) revive(lane, r.id, {}, t);
      }
    }
  }

  // One payload item placed at `position` in the group `parentId`: revived
  // when its row is dead, else a fresh row. Answers its note id.
  function pasteItem(docId, parentId, position, item, t) {
    if (item.rows && item.rows.length) return pasteTable(docId, parentId, position, item, t);
    if (item.kind === "image") return pastePicture(docId, parentId, position, item, t);
    const line = pastedLine(item);
    let id;
    if (revivable("note", item.id)) {
      id = item.id;
      const deletedAt = Backend.get("note", id).deleted_at;
      reviveCutDependants(id, deletedAt, t);
      revive("note", id, { notebook_id: docId, parent_id: parentId, position }, t);
    } else {
      id = blankLine(docId, parentId, position, line.kind, t);
    }
    const note = Backend.get("note", id);
    storeLine(note, line.text, line.kind, note.attrs ?? null, line.text, line.runs, t);
    return id;
  }

  // A TABLE travels with its rows (REVIEW-2026-09-08-TEXT-ENGINE finding 1,
  // `performBlockPaste`): a dead table and its dead rows come back as
  // themselves, their cards and schedules aboard; a live one is a copy with
  // fresh ids, its attrs (widths, header, card flag) and every row's style.
  function pasteTable(docId, parentId, position, item, t) {
    let id;
    const dead = revivable("note", item.id);
    if (dead) {
      id = item.id;
      reviveCutDependants(id, Backend.get("note", id).deleted_at, t);
      revive("note", id, { notebook_id: docId, parent_id: parentId, position }, t);
    } else {
      id = crypto.randomUUID();
      Backend.write("note", id, {
        env: newNoteEnv(docId, parentId, position, "table", t),
        content: { front: "", back: null, cloze_text: null, tags: "", spans: null, attrs: item.attrs ?? null },
      }, { now: t });
    }
    const slots = Order.slots(item.rows.length, null, null);
    item.rows.forEach((r, i) => {
      const runs = r.spans ? Spans.decode(r.spans, r.text) : [];
      let rowId;
      if (dead && revivable("note", r.id)) {
        rowId = r.id;
        reviveCutDependants(rowId, Backend.get("note", rowId).deleted_at, t);
        revive("note", rowId, { notebook_id: docId, parent_id: id }, t);
      } else {
        rowId = crypto.randomUUID();
        Backend.write("note", rowId, {
          env: newNoteEnv(docId, id, slots[i], "tablerow", t),
          content: { front: r.text, back: null, cloze_text: null, tags: "", spans: null, attrs: null },
        }, { now: t });
      }
      const tb = tableOf(id);
      const row = Backend.get("note", rowId);
      const cells = tb.cardTable ? Gate.cardCells(r.text) : r.text.split("\t");
      writeRow(row, tb, cells, Spans.cellRuns(r.text, runs, tb.cardTable), t);
    });
    deriveTable(id, t);
    return id;
  }

  // A PASTED PICTURE IS ITS OWN COPY (owner, 2026-09-11): a cut picture comes
  // back as itself; a copied one gets a fresh note and a fresh media row on
  // the same bytes, width and crop.
  function pastePicture(docId, parentId, position, item, t) {
    if (revivable("note", item.id)) {
      reviveCutDependants(item.id, Backend.get("note", item.id).deleted_at, t);
      revive("note", item.id, { notebook_id: docId, parent_id: parentId, position }, t);
      return item.id;
    }
    const source = Model.decodeAttrs(item.attrs ?? null).mediaId;
    const m = source ? [...lib().media.values()].find(x => x.id.toLowerCase() === source.toLowerCase()) : null;
    if (!m) return null;
    const noteId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    Backend.write("note", noteId, {
      env: newNoteEnv(docId, parentId, position, "image", t),
      content: { front: "", back: null, cloze_text: null, tags: "", spans: null, attrs: encodeAttrs({ m: mediaId.toUpperCase() }) },
    }, { now: t });
    Backend.write("media", mediaId, {
      env: { note_id: noteId, rel_path: m.rel_path, mime: m.mime, bytes_sha: m.bytes_sha, display_width: m.display_width ?? null,
             created_at: iso(t), deleted_at: null },
      content: { crop: m.crop ?? null, latex: m.latex ?? null },
    }, { now: t });
    return noteId;
  }

  // Pasted rows ABOVE or BELOW `anchorId` (a line or a table) in its group,
  // in order, slots taken in one allocation. Answers their ids.
  function pasteBlocks(docId, anchorId, where, items, t = now()) {
    if (!items.length) return [];
    const anchor = anchorId ? Backend.get("note", anchorId) : null;
    const parentId = anchor ? (anchor.parent_id ?? null) : null;
    const sibs = siblingsOf(docId, parentId);
    const at = anchor ? sibs.findIndex(s => s.id === anchor.id) : -1;
    const index = at < 0 ? sibs.length : where === "above" ? at : at + 1;
    const positions = slotsAt("note", sibs, index, items.length, t);
    const ids = items.map((item, i) => pasteItem(docId, parentId, positions[i], item, t)).filter(Boolean);
    reconcileListPrompts(ids.concat(anchorId ? [anchorId] : []), t);
    return ids;
  }

  // The caret's line after a paste (`plan.line`): its text, its runs, and
  // the kind the pasted line states (markdown's marker off a prefix-free
  // kind), written as the canvas's commit writes a paired line.
  function pasteIntoLine(noteId, text, runs, kind, t = now()) {
    const note = Backend.get("note", noteId);
    if (!note || note.deleted_at != null) return false;
    const k = kind && TEXT_KINDS.includes(kind) ? kind : Model.kindOf(note);
    let body = text, r = runs;
    const prefix = kind ? Clip.PREFIX[k] : null;
    if (prefix && body.startsWith(prefix)) { body = body.slice(prefix.length); r = Spans.mapped(r, 0, prefix.length, 0); }
    return storeLine(note, body, k, note.attrs ?? null, body, r, t);
  }

  function setChecked(noteId, checked) {
    const note = Backend.get("note", noteId);
    if (!note) return;
    const attrs = attrsObject(note.attrs);
    if (checked) attrs.chk = true; else delete attrs.chk;
    Backend.write("note", noteId, { content: { attrs: encodeAttrs(attrs) } });
  }

  // ------------------------------------------------------------- the docs

  // A new doc takes the slot after the last doc of its folder (the unfiled
  // top level for null), as `addNotebook` does.
  function createDoc(name, folderId = null, t = now()) {
    const docs = [...lib().docs.values()]
      .filter(d => d.deleted_at == null && (d.folder_id ?? null) === (folderId ?? null))
      .sort(Order.compare);
    const [position] = slotsAt("notebook", docs, docs.length, 1, t);
    const id = crypto.randomUUID();
    Backend.write("notebook", id, {
      env: { folder_id: folderId, position, created_at: iso(t), deleted_at: null, exam_at: null,
             retention_pct: null, new_per_day: null },
      content: { name: name.trim() || "Untitled", emoji: "\u{1F4DA}", style: null },
    }, { now: t });
    // R4: a doc's trailing blank line is a stored paragraph.
    insertLine(id, null, "", "paragraph", t);
    return id;
  }

  function renameDoc(id, name) {
    const trimmed = name.trim();
    const doc = Backend.get("notebook", id);
    if (!doc || !trimmed || doc.name === trimmed) return false;
    Backend.write("notebook", id, { content: { name: trimmed } });
    return true;
  }

  // Everything a doc holds is tombstoned at one instant, which is how
  // Recently Deleted knows what goes back with it.
  function deleteDoc(id, t = now()) {
    const L = lib();
    const doc = L.docs.get(id);
    if (!doc || doc.deleted_at != null) return false;
    const notes = [...L.notes.values()].filter(n => n.notebook_id === id && n.deleted_at == null);
    const ids = new Set(notes.map(n => n.id));
    for (const c of L.cards) if (ids.has(c.note_id) && c.deleted_at == null) Backend.write("card", c.id, {}, { tombstone: true, now: t });
    for (const m of L.media.values()) if (ids.has(m.note_id) && m.deleted_at == null) Backend.write("media", m.id, {}, { tombstone: true, now: t });
    for (const o of L.occlusion) if (ids.has(o.note_id) && o.deleted_at == null) Backend.write("occlusion", o.id, {}, { tombstone: true, now: t });
    for (const n of notes) Backend.write("note", n.id, {}, { tombstone: true, now: t });
    Backend.write("notebook", id, {}, { tombstone: true, now: t });
    return true;
  }

  // What went with a deleted doc: rows tombstoned within two seconds of it.
  function deletedWith(id) {
    const L = lib();
    const doc = L.docs.get(id);
    if (!doc || doc.deleted_at == null) return null;
    const at = ms(doc.deleted_at);
    const near = r => r.deleted_at != null && Math.abs(ms(r.deleted_at) - at) < 2000;
    const notes = [...L.notes.values()].filter(n => n.notebook_id === id && near(n));
    const noteIds = new Set(notes.map(n => n.id));
    const cards = L.cards.filter(c => noteIds.has(c.note_id) && near(c));
    const media = [...L.media.values()].filter(m => noteIds.has(m.note_id) && near(m));
    const occlusion = L.occlusion.filter(o => noteIds.has(o.note_id) && near(o));
    return { doc, notes, cards, media, occlusion };
  }

  // Restorable only when this page holds what the rows said before the
  // tombstone reached them: a tombstone carries no content (PROTOCOL.md 3),
  // and an undelete must carry every column.
  function canRestore(id) {
    return !!Backend.contentBefore("notebook", id);
  }

  function restoreDoc(id, t = now()) {
    const w = deletedWith(id);
    if (!w) return false;
    const before = Backend.contentBefore("notebook", id);
    if (!before) return false;
    Backend.write("notebook", id, { env: { ...before.env, deleted_at: null }, content: before.content }, { now: t });
    for (const n of w.notes) {
      const b = Backend.contentBefore("note", n.id);
      if (b) Backend.write("note", n.id, { env: { ...b.env, deleted_at: null }, content: b.content }, { now: t });
    }
    // Pictures and diagram regions come back with their notes, as
    // `RecentlyDeleted` restores them (review 2026-09-26, web-10).
    for (const [lane, list] of [["card", w.cards], ["media", w.media], ["occlusion", w.occlusion]]) {
      for (const r of list) {
        const b = Backend.contentBefore(lane, r.id);
        if (b) Backend.write(lane, r.id, { env: { ...b.env, deleted_at: null }, content: b.content }, { now: t });
      }
    }
    return true;
  }

  // ------------------------------------------------------------- schedule

  // `setExamDeadline` then `clampScheduledToExam`: a learning or review card
  // due after the exam day is due ON it. New cards are the ramp's.
  function setDeadline(docId, dayMs, t = now()) {
    const own = dayMs == null ? null : FSRS.startOfDay(dayMs);
    Backend.write("notebook", docId, { env: { exam_at: own == null ? null : iso(own) } }, { now: t });
    // The clamp follows the deadline IN FORCE, the doc's or else its
    // folder's, and runs on a clear too (`clampScheduledToExam`, review
    // 2026-09-26, web-16).
    const L = lib();
    const inForce = Sched.rawExam(L, L.docs.get(docId));
    const day = inForce == null ? null : FSRS.startOfDay(inForce);
    if (day == null || !(day > t)) return 0;
    let moved = 0;
    for (const c of L.cards) {
      if (c.deleted_at != null || c.state === "new" || ms(c.due) <= day) continue;
      const note = L.notes.get(c.note_id);
      if (!note || note.notebook_id !== docId) continue;
      Backend.write("card", c.id, { env: { due: iso(day) } }, { now: t });
      moved++;
    }
    return moved;
  }

  // What a deadline not yet saved would pull forward (`examPullCount`).
  function deadlinePullCount(docId, dayMs, t = now()) {
    const day = FSRS.startOfDay(dayMs);
    if (!(day > t)) return 0;
    const L = lib();
    return L.cards.filter(c => {
      if (c.deleted_at != null || c.state === "new" || ms(c.due) <= day) return false;
      const note = L.notes.get(c.note_id);
      return note && note.notebook_id === docId;
    }).length;
  }

  // A doc's own knobs; null follows Settings (C-76).
  function setDocKnobs(docId, retention, newPerDay) {
    Backend.write("notebook", docId, { env: {
      retention_pct: retention == null ? null : Sched.clampedRetention(Math.round(retention)),
      new_per_day: newPerDay == null ? null : Math.max(0, Math.min(200, Math.round(newPerDay))),
    } });
  }

  // ------------------------------------------------------------- kinds

  const TEXT_KINDS = ["paragraph", "heading1", "heading2", "heading3", "quote", "bullet", "dash",
                      "numbered", "checkbox"];

  // `applyParagraphKind`: the kind is a column, never a marker in the text,
  // except the numbered marker, which rides the text (E24).
  function setKind(noteId, kind, t = now()) {
    const note = Backend.get("note", noteId);
    if (!note || note.deleted_at != null || !TEXT_KINDS.includes(kind)) return false;
    const block = Model.build([note], new Map(), new Set())[0];
    let text = block ? block.text : (note.front || "");
    let runs = block ? block.runs : [];
    const numbered = /^(\d+)([.)]) ?/.exec(text);
    if (note.kind === "numbered" && kind !== "numbered" && numbered) {
      runs = Spans.mapped(runs, 0, numbered[0].length, 0);
      text = text.slice(numbered[0].length);
    } else if (kind === "numbered" && !numbered) {
      runs = Spans.mapped(runs, 0, 0, 3);
      text = "1. " + text;
    }
    const wasCode = note.kind === "code";
    if (note.cloze_text != null || note.back || Model.storedMark(note.attrs)) {
      // A card or a cloze keeps its text; only the kind moves.
      Backend.write("note", noteId, { env: { kind } }, { now: t });
      reconcileListPrompts([noteId], t);
      return true;
    }
    const anchor = text;
    Backend.write("note", noteId, { env: { kind }, content: { front: text, spans: Spans.encode(runs, anchor) } }, { now: t });
    if (wasCode && Gate.mayCarrySeparator(text)) {
      // A LEGACY code row (stored before code was removed, 2026-09-29)
      // never gated; given a kind it is a line like any other, so a trigger
      // it holds makes its card now.
      const live = Backend.get("note", noteId);
      storeLine(live, text, kind, live.attrs ?? null, text, runs, t);
    }
    reconcileListPrompts([noteId], t);
    return true;
  }

  // A list item's indent (`attrs.d`, R8): structure is `parent_id`, a
  // bullet's depth is this integer and nothing else.
  function setListDepth(noteId, depth, t = now()) {
    const note = Backend.get("note", noteId);
    if (!note || !Model.LIST_KINDS.concat(["checkbox"]).includes(note.kind)) return false;
    const attrs = attrsObject(note.attrs);
    const d = Math.max(0, Math.min(8, depth));
    if ((attrs.d || 0) === d) return false;
    if (d) attrs.d = d; else delete attrs.d;
    Backend.write("note", noteId, { content: { attrs: encodeAttrs(attrs) } }, { now: t });
    reconcileListPrompts([noteId], t);
    return true;
  }

  function newNoteEnv(docId, parentId, position, kind, t) {
    return { notebook_id: docId, parent_id: parentId, position, kind, unreviewed: false, occ_mode: null,
             typed_answer: false, created_at: iso(t), deleted_at: null };
  }

  // A place after `afterId` among its siblings: a slot between the
  // neighbours (`slotsAt`).
  function makeRoom(docId, afterId, t) {
    const after = afterId ? Backend.get("note", afterId) : null;
    const parentId = after && after.kind !== "tablerow" ? (after.parent_id ?? null) : null;
    const anchor = after && after.kind === "tablerow" ? Backend.get("note", after.parent_id) : after;
    const sibs = siblingsOf(docId, parentId);
    const index = anchor ? sibs.findIndex(s => s.id === anchor.id) + 1 || sibs.length : sibs.length;
    const [position] = slotsAt("note", sibs, index, 1, t);
    return { parentId, position };
  }

  // ------------------------------------------------------------- tables

  // A table (R1): a `table` parent that owns its rows as `tablerow`
  // children, its width and card flag in `attrs`, its `front` the DERIVED
  // text (every row's cells, TAB separated) so search and exports see it.
  function tableOf(tableId) {
    const table = Backend.get("note", tableId);
    if (!table || table.kind !== "table") return null;
    const attrs = attrsObject(table.attrs);
    const rows = [...lib().notes.values()]
      .filter(n => n.parent_id === tableId && n.deleted_at == null && n.kind === "tablerow")
      .sort(Order.compare);
    return { table, attrs, rows, cardTable: attrs.card === true || attrs.c === true, header: attrs.hdr !== false };
  }

  // A card row's cells split its text at the column separator
  // (`CanvasBlock.cells(cardTable:)`): a header stored as one front
  // `Term::Meaning` is two cells, and a half row `H::` is `H` and nothing,
  // so saving the cells gives back the stored text instead of growing a `::`
  // on every visit (review 2026-09-26, web-1).
  // A normal row's cells are its whole stored text split at TABS, back
  // included: a row the gate stored as a card (`std::vector` in a cell,
  // `CanvasBlock.rowGates`) reads `front::back`, as `outlineRawText` does.
  function rowCells(row, cardTable) {
    const text = Model.rawText({ ...row, kind: "tablerow" });
    return cardTable ? Gate.cardCells(text) : text.split("\t");
  }

  function deriveTable(tableId, t) {
    const tb = tableOf(tableId);
    if (!tb) return;
    const text = tb.rows.map(r => rowCells(r, tb.cardTable).join("\t")).join("\n");
    if ((tb.table.front || "") !== text) Backend.write("note", tableId, { content: { front: text } }, { now: t });
  }

  // One row's cells, stored as `CanvasBlock.storedText` would: a card
  // table's rows (never its header) take the `::` gate and a card, and a
  // normal table's body row takes it only when `rowGates` says so (a cell's
  // `::` that splits the row cleanly, `Gate.tableRowGate`). Every row's card
  // is reconciled, so one that stops gating retires its card.
  //
  // D-189: with `cellRuns` (each cell's style, relative to the cell as the
  // editor holds it) the row's `spans` is written as the store will hold it:
  // each cell's runs placed in the row's text, carried through what the
  // store did to it (a card table trims each cell, a gated normal row the
  // spaces round its gate, `storedRuns`), split at every cell boundary
  // (`TableCellRuns`: a run never crosses a cell) and fingerprinted against
  // the stored text (landmines 67, 68). Without them `spans` is left as it
  // was, as `saveLine` leaves it.
  function saveTableRow(rowId, cells, t = now(), cellRuns = undefined) {
    const row = Backend.get("note", rowId);
    if (!row || row.deleted_at != null) return false;
    const tb = tableOf(row.parent_id);
    if (!tb) return false;
    if (!writeRow(row, tb, cells, cellRuns, t)) return false;
    deriveTable(row.parent_id, t);
    return true;
  }

  function writeRow(row, tb, cells, cellRuns, t) {
    const index = tb.rows.findIndex(r => r.id === row.id);
    const header = tb.header && index === 0;
    let front, back = null, gated = false;
    const clean = cells.map(c => String(c).replace(/[\t\n]/g, " "));
    let spans = row.spans ?? null;
    if (tb.cardTable) {
      const f = (clean[0] || "").trim(), b = (clean[1] || "").trim();
      if (!header && /\S/.test(f) && /\S/.test(b)) { front = f; back = b; gated = true; }
      else front = f + "::" + b;
      if (cellRuns !== undefined) {
        const anchor = Model.rawText({ kind: "tablerow", front, back, cloze_text: null });
        const shown = [clean[0] || "", clean[1] || ""];
        const mapped = [f, b].map((s, i) => trimmedRuns((cellRuns && cellRuns[i]) || [], shown[i], s));
        spans = Spans.encode(Spans.clipToCells(anchor, Spans.rowRuns(mapped, anchor, true), true), anchor);
      }
    } else {
      const text = clean.join("\t");
      const gate = header ? null : Gate.tableRowGate(text);
      if (gate) { front = gate.front; back = gate.back; gated = true; }
      else front = text;
      if (cellRuns !== undefined) {
        const anchor = gate ? gate.stored : text;
        const runs = Spans.rowRuns(clean.map((_, i) => (cellRuns && cellRuns[i]) || []), text, false);
        spans = Spans.encode(Spans.mappedThroughDiff(runs, text, anchor), anchor);
      }
    }
    const same = (row.front ?? "") === front && (row.back ?? null) === back && (row.spans ?? null) === spans;
    if (same) return false;
    Backend.write("note", row.id, { env: { unreviewed: false }, content: { front, back, cloze_text: null, spans } }, { now: t });
    reconcileBasic(row.id, gated, t);
    return true;
  }

  // A cell's runs carried through its trim: the space taken off each end is
  // two removals, so a styled word between them keeps its style (one
  // replaced middle would drop it); anything else maps as one change.
  function trimmedRuns(runs, shown, stored) {
    if (shown === stored || !runs.length) return runs;
    const lead = shown.length - shown.replace(/^\s+/, "").length;
    if (shown.slice(lead, lead + stored.length) !== stored) return Spans.mappedThroughDiff(runs, shown, stored);
    const kept = Spans.mapped(runs, 0, lead, 0);
    return Spans.mapped(kept, stored.length, shown.length - lead - stored.length, 0);
  }

  // A row's style runs against its stored text (`outlineRawText`).
  function rowRunsOf(row) {
    return Spans.decode(row.spans, Model.rawText({ ...row, kind: "tablerow" }));
  }

  function insertTable(docId, afterId, { rows = 3, columns = 2, cardTable = false } = {}, t = now()) {
    const { parentId, position } = makeRoom(docId, afterId, t);
    const id = crypto.randomUUID();
    const cols = cardTable ? 2 : Math.max(1, columns);
    const attrs = cardTable ? { card: true } : {};
    Backend.write("note", id, {
      env: newNoteEnv(docId, parentId, position, "table", t),
      content: { front: "", back: null, cloze_text: null, tags: "", spans: null, attrs: encodeAttrs(attrs) },
    }, { now: t });
    const header = cardTable ? ["Term", "Meaning"] : Array.from({ length: cols }, (_, i) => `Column ${i + 1}`);
    const rowSlots = Order.slots(Math.max(1, rows), null, null);
    for (let r = 0; r < Math.max(1, rows); r++) {
      const cells = r === 0 ? header : Array.from({ length: cols }, () => "");
      const rowId = crypto.randomUUID();
      const text = cardTable ? cells[0] + "::" + cells[1] : cells.join("\t");
      Backend.write("note", rowId, {
        env: newNoteEnv(docId, id, rowSlots[r], "tablerow", t),
        content: { front: text, back: null, cloze_text: null, tags: "", spans: null, attrs: null },
      }, { now: t });
    }
    deriveTable(id, t);
    return id;
  }

  function addTableRow(tableId, afterRowId, t = now()) {
    const tb = tableOf(tableId);
    if (!tb) return null;
    const cols = tb.cardTable ? 2 : Math.max(1, ...tb.rows.map(r => rowCells(r, false).length));
    const at = afterRowId ? tb.rows.findIndex(r => r.id === afterRowId) + 1 || tb.rows.length : tb.rows.length;
    const [position] = slotsAt("note", tb.rows, at, 1, t);
    const id = crypto.randomUUID();
    const cells = Array.from({ length: cols }, () => "");
    Backend.write("note", id, {
      env: newNoteEnv(tb.table.notebook_id, tableId, position, "tablerow", t),
      content: { front: tb.cardTable ? "::" : cells.join("\t"), back: null, cloze_text: null, tags: "", spans: null, attrs: null },
    }, { now: t });
    deriveTable(tableId, t);
    return id;
  }

  // E18: a card table's header is a label, never deletable. A normal table
  // may delete any row (the next row becomes the header), and deleting its
  // last row removes the table.
  function deleteTableRow(rowId, t = now()) {
    const row = Backend.get("note", rowId);
    if (!row) return false;
    const tb = tableOf(row.parent_id);
    if (!tb) return false;
    const index = tb.rows.findIndex(r => r.id === rowId);
    if (tb.cardTable && tb.header && index === 0) return false;
    if (tb.rows.length <= 1) return deleteTable(row.parent_id, t);
    deleteLine(rowId, t);
    // The row that becomes the header stops gating (`rowGates`).
    if (index === 0 && tb.header) saveTableRow(tb.rows[1].id, rowCells(tb.rows[1], tb.cardTable), t);
    deriveTable(row.parent_id, t);
    return true;
  }

  // A column added or removed keeps every other cell's style (D-189): the
  // row's runs are carried cell by cell onto the new text. A table drawn at
  // stored widths gains the new column at `CanvasTable.insertedColumnWidth`
  // (and a removed column's width goes), as `CanvasDocument` edits `w`.
  function addTableColumn(tableId, t = now()) {
    const tb = tableOf(tableId);
    if (!tb || tb.cardTable) return false;
    const cols = Math.max(1, ...tb.rows.map(r => rowCells(r, false).length));
    tb.rows.forEach((r, i) => {
      const cells = rowCells(r, false);
      const runs = Spans.cellRuns(Model.rawText({ ...r, kind: "tablerow" }), rowRunsOf(r), false);
      while (cells.length < cols) cells.push("");
      cells.push(i === 0 && tb.header ? `Column ${cols + 1}` : "");
      writeRow(r, tb, cells, runs, t);
    });
    const w = tableWidthsOf(tb);
    if (w.length) setTableWidths(tableId, [...w.slice(0, cols), Geometry.INSERTED_COLUMN, ...w.slice(cols)], t);
    deriveTable(tableId, t);
    return true;
  }

  function tableWidthsOf(tb) {
    return Array.isArray(tb.attrs.w) ? tb.attrs.w.filter(n => typeof n === "number") : [];
  }

  // A table's column widths (`CanvasTableEdit.setWidths`), the ones a drag
  // left drawn; none (`[]`) is Fit to Page (Ink 18 R26): content sized
  // again. One write, and nothing when they are what the table holds.
  function setTableWidths(tableId, widths, t = now()) {
    const tb = tableOf(tableId);
    if (!tb) return false;
    const clean = (widths || []).filter(n => typeof n === "number" && Number.isFinite(n)).map(n => Math.round(n * 100) / 100);
    const a = decodeCanvasAttrs(tb.table.attrs ?? null);
    if (JSON.stringify(a.w) === JSON.stringify(clean)) return false;
    a.w = clean;
    Backend.write("note", tableId, { content: { attrs: encodeCanvasAttrs(a) } }, { now: t });
    return true;
  }

  // A TABLE'S OWN TEXT SIZE (`ts`, owner 2026-09-12; `setTableFont`), in
  // Docs' points, or null for the document's own. A table is painted as one
  // block, so the size is the table's, never a cell's.
  function setTableFontSize(tableId, points, t = now()) {
    const tb = tableOf(tableId);
    if (!tb) return false;
    const v = points == null ? null : Number(points);
    const a = decodeCanvasAttrs(tb.table.attrs ?? null);
    const want = v != null && Number.isFinite(v) && v > 0 ? v : null;
    if (a.ts === want) return false;
    a.ts = want;
    Backend.write("note", tableId, { content: { attrs: encodeCanvasAttrs(a) } }, { now: t });
    return true;
  }

  function deleteTableColumn(tableId, index, t = now()) {
    const tb = tableOf(tableId);
    if (!tb || tb.cardTable) return false;
    const cols = Math.max(1, ...tb.rows.map(r => rowCells(r, false).length));
    if (cols <= 1) return false;
    for (const r of tb.rows) {
      const cells = rowCells(r, false);
      const runs = Spans.cellRuns(Model.rawText({ ...r, kind: "tablerow" }), rowRunsOf(r), false);
      while (cells.length < cols) cells.push("");
      cells.splice(index, 1);
      runs.splice(index, 1);
      writeRow(r, tb, cells, runs, t);
    }
    const w = tableWidthsOf(tb);
    if (index < w.length) setTableWidths(tableId, w.filter((_, i) => i !== index), t);
    deriveTable(tableId, t);
    return true;
  }

  function setTableHeader(tableId, header, t = now()) {
    const tb = tableOf(tableId);
    if (!tb) return false;
    const attrs = { ...tb.attrs };
    if (header) delete attrs.hdr; else attrs.hdr = false;
    Backend.write("note", tableId, { content: { attrs: encodeAttrs(attrs) } }, { now: t });
    // The first row's gate follows the header (`rowGates`), for both kinds.
    if (tb.rows[0]) saveTableRow(tb.rows[0].id, rowCells(tb.rows[0], tb.cardTable), t);
    return true;
  }

  function deleteTable(tableId, t = now()) {
    const tb = tableOf(tableId);
    if (!tb) return false;
    for (const r of tb.rows) deleteLine(r.id, t);
    return deleteLine(tableId, t);
  }

  // ------------------------------------------------------------ pictures

  const DRAWING_MIME = "application/vnd.recall.drawing+json";

  function relPathFor(sha, mime) {
    if (mime === DRAWING_MIME) return `${sha}.drawing.json`;
    const ext = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" }[mime] || "jpg";
    return `${sha}.${ext}`;
  }

  function mediaRow(id, noteId, sha, mime, t) {
    return Backend.write("media", id, {
      env: { note_id: noteId, rel_path: relPathFor(sha, mime), mime, bytes_sha: sha, display_width: null,
             created_at: iso(t), deleted_at: null },
      content: { crop: null, latex: null },
    }, { now: t });
  }

  // A block PICTURE (`BlockKind.image`): an empty note whose `attrs.m`
  // names its one media row, and the media row bound to the note.
  function insertPicture(docId, afterId, sha, mime, t = now()) {
    const { parentId, position } = makeRoom(docId, afterId, t);
    const noteId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    Backend.write("note", noteId, {
      env: newNoteEnv(docId, parentId, position, "image", t),
      content: { front: "", back: null, cloze_text: null, tags: "", spans: null,
                 attrs: encodeAttrs({ m: mediaId.toUpperCase() }) },
    }, { now: t });
    mediaRow(mediaId, noteId, sha, mime, t);
    return { noteId, mediaId };
  }

  // `setMediaDisplayWidth`: a picture's width is ONE number on its media row,
  // the one every canvas draws at (`attrs.mw` is read by nothing, so it is
  // no longer written). False when the row already holds it.
  function setPictureWidth(noteId, mediaId, width, t = now()) {
    const w = width == null ? null : Math.max(40, Math.min(1400, Math.round(width)));
    const m = Backend.get("media", mediaId);
    if (!m || m.deleted_at != null || m.display_width === w) return false;
    Backend.write("media", mediaId, { env: { display_width: w } }, { now: t });
    return true;
  }

  // `setMediaCrop`: "x,y,w,h" to four places, or null for the whole picture
  // (`resetCrop`, the menu's Show Whole Picture). A crop is an edit.
  function setMediaCrop(mediaId, crop, t = now()) {
    const m = Backend.get("media", mediaId);
    if (!m || m.deleted_at != null) return false;
    const value = crop && !Geometry.isWhole(crop) ? Geometry.cropText(Geometry.clampCrop(crop)) : null;
    if ((m.crop ?? null) === value) return false;
    Backend.write("media", mediaId, { content: { crop: value } }, { now: t });
    return true;
  }

  // `occlusionRegions(forMediaId:)`: the live regions a picture carries, a
  // legacy region (no media id) belonging to its note's picture, by ordinal.
  function regionsOnMedia(mediaId) {
    const L = lib();
    const m = L.media.get(mediaId);
    return L.occlusion.filter(o => {
      if (o.deleted_at != null) return false;
      const note = L.notes.get(o.note_id);
      if (!note || note.deleted_at != null) return false;
      return o.media_id === mediaId || (o.media_id == null && !!m && o.note_id === m.note_id);
    }).sort((a, b) => a.ordinal - b.ordinal);
  }

  // `commitCrop` (C-26): A CROP CANNOT HIDE A LIVE MASK. Answers the notice
  // naming the regions it would hide (by ordinal, never by label, which IS
  // the answer), in which case nothing is written, or null once written.
  function commitCrop(mediaId, crop, t = now()) {
    const hidden = !crop || Geometry.isWhole(crop) ? [] : regionsOnMedia(mediaId).filter(o => !Geometry.keepsWhole(crop, o));
    if (hidden.length) return Geometry.wouldHide(hidden.map(o => o.ordinal));
    setMediaCrop(mediaId, crop, t);
    return null;
  }

  // `replaceMediaBytes`: a drawing edited in place keeps its row (so the
  // block, the width and any regions survive) and takes new bytes.
  function replaceMediaBytes(mediaId, sha, mime, t = now()) {
    const m = Backend.get("media", mediaId);
    if (!m || m.deleted_at != null) return false;
    Backend.write("media", mediaId, { env: { rel_path: relPathFor(sha, mime), mime, bytes_sha: sha } }, { now: t });
    return true;
  }

  // ------------------------------------------------------------ occlusion

  const MIN_SIDE = 0.01;   // `OcclusionStore.minSide`

  function clampRect(x, y, w, h) {
    const cx = Math.min(Math.max(x, 0), 1), cy = Math.min(Math.max(y, 0), 1);
    return { x: cx, y: cy, w: Math.max(0, Math.min(w, 1 - cx)), h: Math.max(0, Math.min(h, 1 - cy)) };
  }

  // `saveNewOcclusionNote` / `applyOcclusionEdits` in one: the prompt on the
  // note, one media row, the regions as the DESIRED live set (a missing one
  // tombstoned, its card dissolved or, when graded, detached; a kept one
  // updated in place with its card's answer restamped; a new one given the
  // next ordinal and a fresh card).
  function saveOcclusion({ docId, afterId, noteId, prompt, mode, sha, mime, regions }, t = now()) {
    const text = String(prompt || "").trim();
    if (!text) throw new Error("A diagram needs a prompt, the question its regions answer.");
    if (!regions.length) throw new Error("Draw at least one region on the picture.");
    for (const r of regions) {
      const c = clampRect(r.x, r.y, r.w, r.h);
      if (c.w < MIN_SIDE || c.h < MIN_SIDE) throw new Error("A region is too small to see.");
    }
    const L = lib();
    let id = noteId;
    let mediaId = null;
    if (!id) {
      const { parentId, position } = makeRoom(docId, afterId, t);
      id = crypto.randomUUID();
      Backend.write("note", id, {
        env: { ...newNoteEnv(docId, parentId, position, "paragraph", t), occ_mode: mode === "all" ? "all" : "one" },
        content: { front: text, back: null, cloze_text: null, tags: "", spans: null, attrs: null },
      }, { now: t });
      mediaId = crypto.randomUUID();
      mediaRow(mediaId, id, sha, mime, t);
    } else {
      const note = Backend.get("note", id);
      if (!note || note.deleted_at != null) throw new Error("That diagram was deleted.");
      if (note.front !== text || note.occ_mode !== mode) {
        Backend.write("note", id, { env: { occ_mode: mode === "all" ? "all" : "one", unreviewed: false }, content: { front: text } }, { now: t });
      }
      const m = [...L.media.values()].find(x => x.note_id === id && x.deleted_at == null);
      mediaId = m ? m.id : null;
    }
    const existing = L.occlusion.filter(o => o.note_id === id && o.deleted_at == null);
    const keep = new Set(regions.map(r => r.id).filter(Boolean));
    const cards = liveCardsOf(id);
    for (const o of existing) {
      if (keep.has(o.id)) continue;
      Backend.write("occlusion", o.id, {}, { tombstone: true, now: t });
      for (const c of cards) if (c.cloze_ordinal === o.ordinal) retire(c, t);
    }
    let next = Math.max(-1, ...lib().occlusion.filter(o => o.note_id === id).map(o => o.ordinal)) + 1;
    for (const r of regions) {
      const c = clampRect(r.x, r.y, r.w, r.h);
      const label = String(r.label || "").trim();
      const old = r.id ? existing.find(o => o.id === r.id) : null;
      if (old) {
        Backend.write("occlusion", old.id, {
          env: { x: c.x, y: c.y, w: c.w, h: c.h, rotation: 0, z: r.z || 0, media_id: old.media_id ?? mediaId },
          content: { label, points_json: null },
        }, { now: t });
        const card = cards.find(k => k.cloze_ordinal === old.ordinal);
        if (card && card.a_snapshot !== label) Backend.write("card", card.id, { content: { a_snapshot: label, q_snapshot: text } }, { now: t });
      } else {
        const ordinal = next++;
        Backend.write("occlusion", crypto.randomUUID(), {
          env: { note_id: id, ordinal, x: c.x, y: c.y, w: c.w, h: c.h, media_id: mediaId, rotation: 0, z: r.z || 0,
                 created_at: iso(t), deleted_at: null },
          content: { label, points_json: null },
        }, { now: t });
        freshCard(id, ordinal, text, label, t);
      }
    }
    return id;
  }

  // ------------------------------------------------------------ doc style

  // `DocStyle.encoded`: h, ls, lang, f in that order, nil fields left out,
  // NULL when the doc changed nothing.
  function setDocStyle(docId, style, t = now()) {
    const doc = Backend.get("notebook", docId);
    if (!doc) return false;
    let wire = {};
    try { wire = doc.style ? JSON.parse(doc.style) || {} : {}; } catch (_) { wire = {}; }
    const next = { ...wire, ...style };
    const out = {};
    if (Array.isArray(next.h) && next.h.length === 3) out.h = next.h.map(l => ({ size: l.size, weight: l.weight }));
    if (typeof next.ls === "number") out.ls = next.ls;
    if (typeof next.lang === "string" && next.lang) out.lang = next.lang;
    if (typeof next.f === "string" && next.f) out.f = next.f;
    const encoded = Object.keys(out).length ? JSON.stringify(out) : null;
    if ((doc.style ?? null) === encoded) return false;
    Backend.write("notebook", docId, { content: { style: encoded } }, { now: t });
    return true;
  }

  // ------------------------------------------------------ cards and imports

  // Make Cards' accepted drafts: `question >> answer` lines (`CardDrafts.line`,
  // triggers inside a side flattened) after the section's last line, each
  // unreviewed like any capture (W5).
  function insertCards(docId, afterId, cards, t = now()) {
    let after = afterId;
    const ids = [];
    for (const c of cards) {
      const line = Gate.draftLine(c.question, c.answer);
      if (!line) continue;
      const id = insertLine(docId, after, line, "paragraph", t);
      Backend.write("note", id, { env: { unreviewed: true } }, { now: t });
      ids.push(id);
      after = id;
    }
    return ids;
  }

  // Lines typed by a file: each through the same save as a typed line, so a
  // `# ` is a heading and a `::` a card, every note carrying the tags.
  //
  // Every slot is taken in ONE allocation after the doc's last line, so an
  // import reads the doc's lines once, not once a line (review 2026-09-26,
  // web-12).
  function importLines(docId, lines, tags = "", t = now()) {
    const sibs = siblingsOf(docId, null);
    const last = sibs[sibs.length - 1];
    let n = 0;
    if (last && !last.front && !last.back && !last.cloze_text && last.kind === "paragraph" && lines.length) {
      // Fill the doc's trailing blank line first (R4).
      saveLine(last.id, lines[0], t);
      if (tags) Backend.write("note", last.id, { content: { tags } }, { now: t });
      lines = lines.slice(1);
      n = 1;
    }
    if (!lines.length) return n;
    const positions = slotsAt("note", sibs, sibs.length, lines.length, t);
    lines.forEach((line, i) => {
      const id = blankLine(docId, null, positions[i], "paragraph", t, tags);
      if (line) saveLine(id, line, t);
    });
    return n + lines.length;
  }

  return { gradeCard, preview, undoGrade, setSuspended, saveLine, insertLine, deleteLine, setChecked,
           createDoc, renameDoc, deleteDoc, deletedWith, canRestore, restoreDoc, setDeadline,
           deadlinePullCount, setDocKnobs, attrsObject, encodeAttrs, setKind, setListDepth,
           tableOf, rowCells, rowRunsOf, saveTableRow, insertTable, addTableRow, deleteTableRow, addTableColumn,
           deleteTableColumn, setTableHeader, deleteTable, insertPicture, setPictureWidth, replaceMediaBytes,
           setTableWidths, setTableFontSize, setMediaCrop, regionsOnMedia, commitCrop, replaceLineText,
           pasteBlocks, pasteIntoLine, pastedLine,
           saveOcclusion, setDocStyle, insertCards, importLines, relPathFor, TEXT_KINDS, DRAWING_MIME,
           REVERSE_ORDINAL, moveBlocks, isListPrompt, listAnswerLines, descriptorOwner, cardContext, reconcileListPrompts,
           decodeCanvasAttrs, encodeCanvasAttrs, storeCardMark, clearCardMark, setCardAsk, setAnswerShape,
           LINE_ORDINAL, isLineCard, suggestedRating, listLineText, listPromptOf, lineCardContext, recordListMisses,
           retireLineCard, undoLineSteps };
})();
