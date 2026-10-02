// Make Cards and the quiz on the web (PLAN-BETA-0.12 section 26, W-7; Ink 17
// sections 5 and 6). The prompt is written here from the doc (AIText, the
// app's own words) and sent to the Worker's `/v1/ai`, which holds the
// OpenRouter key as a secret: the key never reaches this page. A backend with
// no key answers one sentence, which Make Cards shows as it is and the quiz
// answers by building its questions from the doc's own cards
// (`QuizBuilder.fromCards`), as the app does without a model.
//
// NOTHING HERE GRADES (owner, 2026-09-14): a quiz is practice; Make Cards
// writes `question >> answer` lines through the same save as a typed line,
// each unreviewed like any capture.

const AI = (() => {

  let unconfigured = null;   // the Worker's sentence once it said it has no key

  function modelName() {
    const v = Backend.library().settingsValues || {};
    return String(v.openrouter_model || "").trim() || "google/gemini-2.5-flash";
  }

  const shortModel = m => m.split("/").pop();

  // One request through the Worker, the schema in words once more when a
  // model refused structured output (`OpenRouterClient.json`).
  async function ask({ system, user, schemaName, schema, maxTokens, parse }) {
    const body = { system, user, schema_name: schemaName, schema, max_tokens: maxTokens, model: modelName() };
    let reply;
    try {
      reply = await Backend.ai(body);
      const value = parse(reply.content);
      if (value) return value;
      if (reply.truncated) throw new Error("The model's answer could not be read.");
    } catch (error) {
      if (error.code === "ai_unconfigured") unconfigured = error.message;
      if (error.code !== "ai_refused") throw error;
    }
    reply = await Backend.ai({ ...body, structured: false });
    const value = parse(reply.content);
    if (!value) throw new Error("The model's answer could not be read.");
    return value;
  }

  // ------------------------------------------------------------ Make Cards

  // Proposals by section, each ticked unless its question is already a
  // card's front here; "Add N" writes the ticked ones after the section's
  // last line.
  function makeCards(docId, { onAdded, onError } = {}) {
    const { h, clear, chip } = UI;
    const doc = Backend.get("notebook", docId);
    const blocks = Study.blocksFor(docId);
    const lines = AIText.sourceLines(blocks);
    const secs = AIText.sections(lines);
    const fronts = AIText.cardFronts(lines);
    const pieces = AIText.cardsPieces(secs);
    const body = h("div.make-cards");
    const proposals = [];     // { section, question, answer, already, on }
    let phase = "writing";
    let message = null;

    const handle = UI.sheet({
      title: "Make Cards", left: "Cancel", right: "Add", rightDisabled: true, width: 560, body: [body],
      onRight: () => {
        const chosen = proposals.filter(p => p.on && !p.already);
        if (!chosen.length) return false;
        try {
          const bySection = new Map();
          for (const p of chosen) {
            const list = bySection.get(p.section) || [];
            list.push(p);
            bySection.set(p.section, list);
          }
          let n = 0;
          for (const [index, list] of bySection) {
            const section = secs[index - 1];
            Store.insertCards(docId, section.lastId || null, list);
            n += list.length;
          }
          if (onAdded) onAdded(n);
        } catch (error) {
          if (onError) onError(error);
          return false;
        }
        return true;
      },
    });

    function draw() {
      clear(body);
      if (phase === "writing") {
        body.appendChild(h("p.sheet-text", { text: pieces.length
          ? `Writing cards from ${UI.plural(pieces.reduce((a, p) => a + p.sections.length, 0), "section")} of ${doc ? doc.name || "Untitled" : "this doc"}.`
          : "" }));
      }
      if (message) body.appendChild(h("p.sheet-text", { text: message }));
      const bySection = new Map();
      for (const p of proposals) {
        if (!bySection.has(p.section)) bySection.set(p.section, []);
        bySection.get(p.section).push(p);
      }
      for (const [index, list] of bySection) {
        const section = secs[index - 1];
        const title = section.path.length ? section.path[section.path.length - 1] : (doc && doc.name) || "Opening notes";
        const tickable = list.filter(p => !p.already);
        const allOn = tickable.length && tickable.every(p => p.on);
        const head = h("div.section-head", h("span.eyebrow", { text: title }),
          tickable.length ? chip(allOn ? "Untick all" : "Tick all", { onclick: () => { for (const p of tickable) p.on = !allOn; draw(); } }) : null);
        const rows = list.map(p => {
          const tick = h("span.tick", { "aria-hidden": "true", text: p.on && !p.already ? "✓" : "" });
          if (p.on && !p.already) tick.classList.add("on");
          const row = h(p.already ? "div.value-row.proposal" : "button.value-row.proposal", { type: p.already ? null : "button",
            "aria-pressed": p.already ? null : (p.on ? "true" : "false"),
            onclick: p.already ? null : () => { p.on = !p.on; draw(); } },
            tick, h("span.value-stack", h("span.value-label", { text: p.question }),
                                        h("span.value-sub", { text: p.already ? `${p.answer} · Already a card` : p.answer })));
          if (p.already) row.classList.add("already");
          return row;
        });
        body.append(head, UI.block(rows));
      }
      if (phase === "done" && proposals.length) {
        body.appendChild(h("p.help", { text: `Written by ${shortModel(modelName())} through OpenRouter. Pairs arrive under the section they came from.` }));
      }
      const count = proposals.filter(p => p.on && !p.already).length;
      handle.rightBtn.textContent = count ? `Add ${count}` : "Add";
      handle.rightBtn.disabled = !count;
    }

    async function run() {
      if (!pieces.length) {
        phase = "done";
        message = "This doc has no notes that state a fact yet, so there is nothing to make cards from.";
        draw();
        return;
      }
      for (const piece of pieces) {
        try {
          const made = await ask({ system: AIText.CARDS_INSTRUCTIONS, user: AIText.cardsRequest(doc ? doc.name : "", piece),
                                   schemaName: "flashcards", schema: AIText.SECTION_CARDS_SCHEMA,
                                   maxTokens: AIText.outputTokensForCards(piece.sections.length * AIText.CARDS_LIMIT),
                                   parse: AIText.sectionCards });
          for (const [section, list] of AIText.cardsBySection(made, piece)) {
            for (const c of list) {
              const already = fronts.has(AIText.normalize(c.question));
              proposals.push({ section, question: c.question, answer: c.answer, already, on: !already });
            }
          }
        } catch (error) {
          message = String(error.message || error);
          break;
        }
        if (!document.body.contains(body)) return;
        draw();
      }
      phase = "done";
      if (!proposals.length && !message) message = "No cards were proposed. The notes may already be cards, or state no facts.";
      draw();
    }

    draw();
    run();
  }

  // ----------------------------------------------------------------- quiz

  let quiz = null;

  function isOpen() { return !!quiz; }

  // The start card is the review card in the review slot: "How many
  // questions?", the stepper, the plan line; Start is the one primary.
  function startQuiz(docId, { onClose } = {}) {
    const { h } = UI;
    if (quiz) return;
    const doc = Backend.get("notebook", docId);
    const settings = Backend.library().settingsValues || {};
    quiz = { docId, docName: doc ? doc.name || "Untitled" : "Untitled", length: AIText.clampedLength(settings.quiz_length || AIText.QUIZ_LENGTH),
             phase: "start", questions: [], index: 0, picked: null, right: 0, missed: [], source: null, note: null, onClose };
    const layer = h("div.review.quiz", { role: "dialog", "aria-label": "Quiz" });
    quiz.layer = layer;
    document.body.appendChild(layer);
    quiz.onKey = event => onKey(event);
    document.addEventListener("keydown", quiz.onKey);
    draw();
  }

  function closeQuiz() {
    if (!quiz) return;
    const q = quiz;
    quiz = null;
    document.removeEventListener("keydown", q.onKey);
    q.layer.remove();
    if (q.onClose) q.onClose();
  }

  function onKey(event) {
    if (!quiz || UI.sheetOpen()) return;
    if (event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
    if (event.key === "Escape") { event.preventDefault(); closeQuiz(); return; }
    if (quiz.phase === "question" && quiz.picked === null && /^[1-4]$/.test(event.key)) {
      event.preventDefault();
      pick(Number(event.key) - 1);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !event.metaKey && !event.ctrlKey) {
      if (quiz.phase === "start") { event.preventDefault(); begin(); }
      else if (quiz.phase === "question" && quiz.picked !== null) { event.preventDefault(); next(); }
    }
  }

  async function begin() {
    if (!quiz || quiz.phase !== "start") return;
    const settings = Backend.library().settingsValues || {};
    if (String(quiz.length) !== String(settings.quiz_length || "")) {
      try { Backend.setSetting({ quiz_length: quiz.length }); } catch (_) { /* paused writes keep the old length */ }
    }
    quiz.phase = "writing";
    draw();
    const blocks = Study.blocksFor(quiz.docId);
    const owned = quiz;
    let questions = [];
    let note = null;
    if (!unconfigured) {
      try {
        const pieces = AIText.quizPieces(AIText.factLines(blocks), quiz.length);
        for (const piece of pieces) {
          const made = await ask({ system: AIText.QUIZ_INSTRUCTIONS, user: AIText.quizRequest(quiz.docName, piece),
                                   schemaName: "quiz", schema: AIText.QUIZ_SCHEMA,
                                   maxTokens: AIText.outputTokensForQuestions(piece.ask), parse: AIText.questions });
          for (const m of made) {
            if (!AIText.keepQuestion(m.question, m.correct, m.wrong)) continue;
            const q = AIText.question(m.question, m.correct, m.wrong, m.explanation, AIText.crumb(piece, m.section));
            if (q) questions.push(q);
            if (questions.length >= owned.length) break;
          }
          if (questions.length >= owned.length) break;
        }
        if (questions.length) owned.source = `Written by ${shortModel(modelName())} from ${owned.docName}`;
      } catch (error) {
        note = String(error.message || error);
      }
    }
    if (quiz !== owned) return;
    if (!questions.length) {
      const cards = AIText.quizCards(blocks);
      questions = AIText.fromCards(cards, owned.length);
      if (questions.length) {
        owned.source = `Built from the cards of ${owned.docName}`;
        if (unconfigured) note = "This backend has no OpenRouter key, so these questions are built from the doc's cards.";
      } else if (!note) {
        note = unconfigured
          || (AIText.canBuild(cards) ? "No questions could be written from this doc." : "A quiz needs a model, or at least four cards with different answers in this doc.");
      } else if (unconfigured) {
        note = unconfigured;
      }
    }
    owned.questions = questions;
    owned.note = note;
    owned.phase = questions.length ? "question" : "failed";
    owned.index = 0;
    draw();
  }

  function pick(i) {
    if (!quiz || quiz.picked !== null) return;
    const q = quiz.questions[quiz.index];
    quiz.picked = i;
    if (i === q.correct) quiz.right += 1;
    else quiz.missed.push({ prompt: q.prompt, answer: q.options[q.correct], said: q.options[i] });
    draw();
  }

  function next() {
    if (!quiz) return;
    quiz.index += 1;
    quiz.picked = null;
    if (quiz.index >= quiz.questions.length) quiz.phase = "end";
    draw();
  }

  function again() {
    if (!quiz) return;
    Object.assign(quiz, { phase: "start", questions: [], index: 0, picked: null, right: 0, missed: [], source: null, note: null, dealt: -1 });
    draw();
  }

  function draw() {
    const { h, clear, chip } = UI;
    if (!quiz) return;
    const layer = clear(quiz.layer);
    const column = h("div.review-column");
    const total = quiz.questions.length;
    const readout = quiz.phase === "question" ? `${quiz.index + 1} of ${total}`
      : quiz.phase === "end" ? `${total} of ${total}` : `Quiz · ${quiz.docName}`;
    column.appendChild(h("div.review-top", chip("Done", { onclick: closeQuiz }), h("span.spacer"),
      h("span.practice-count", { text: readout })));
    const fill = h("div.progress-fill.quiet");
    fill.style.width = total ? `${Math.round(((quiz.phase === "end" ? total : quiz.index + (quiz.picked !== null ? 1 : 0)) / total) * 100)}%` : "0%";
    column.appendChild(h("div.review-progress", h("div.progress", fill)));
    const slot = h("div.review-slot");
    const dock = h("div.dock-row");
    const style = Render.docStyle((Backend.get("notebook", quiz.docId) || {}).style);

    if (quiz.phase === "start" || quiz.phase === "writing") {
      const card = h("div.review-card.deal-in");
      Render.applyDocStyle(card, style);
      const value = h("b.quiz-count", { text: String(quiz.length) });
      const set = n => { quiz.length = AIText.clampedLength(n); value.textContent = String(quiz.length); };
      card.append(h("div.eyebrow", { text: `Quiz · ${quiz.docName}` }),
        h("div.face.face-q.quiz-ask", { text: "How many questions?" }),
        h("div.quiz-stepper",
          h("button.chip.quiz-step", { type: "button", text: "−", "aria-label": "Fewer", disabled: quiz.phase === "writing", onclick: () => set(quiz.length - 1) }),
          value,
          h("button.chip.quiz-step", { type: "button", text: "+", "aria-label": "More", disabled: quiz.phase === "writing", onclick: () => set(quiz.length + 1) }),
          h("span.quiz-unit", { text: "questions" })),
        h("p.quiz-plan", { text: unconfigured
          ? "Built from this doc's cards, because this backend has no OpenRouter key. Nothing is graded."
          : "Written from every section of this doc through OpenRouter, with the key this backend holds. Nothing is graded." }));
      slot.appendChild(card);
      dock.appendChild(h("button.dock.primary", { type: "button", disabled: quiz.phase === "writing", onclick: begin },
        quiz.phase === "writing" ? "Writing questions" : "Start"));
    } else if (quiz.phase === "failed") {
      const card = h("div.review-card");
      card.append(h("div.eyebrow", { text: `Quiz · ${quiz.docName}` }), h("p.quiz-plan", { text: quiz.note || "No questions could be written." }));
      slot.appendChild(card);
      dock.appendChild(h("button.dock.primary", { type: "button", onclick: closeQuiz }, "Done"));
    } else if (quiz.phase === "question") {
      const q = quiz.questions[quiz.index];
      // A question is DEALT once; answering it redraws it in place.
      const card = h("div.review-card");
      if (quiz.dealt !== quiz.index) { card.classList.add("deal-in"); quiz.dealt = quiz.index; }
      Render.applyDocStyle(card, style);
      card.append(h("div.eyebrow", { text: q.crumb ? `Quiz · ${quiz.docName} › ${q.crumb}` : `Quiz · ${quiz.docName}` }),
        h("div.face.face-q.quiz-ask", { text: q.prompt }));
      slot.appendChild(card);
      if (quiz.index === 0 && quiz.note) slot.appendChild(h("p.quiz-note", { text: quiz.note }));
      const rows = q.options.map((option, i) => {
        const answered = quiz.picked !== null;
        const right = answered && i === q.correct;
        const wrong = answered && i === quiz.picked && i !== q.correct;
        const letter = h("span.quiz-letter", { text: right ? "✓" : wrong ? "✕" : "ABCD"[i] });
        const row = h("button.value-row.quiz-option", { type: "button", disabled: answered, onclick: () => pick(i),
          "aria-label": `${"ABCD"[i]}: ${option}${right ? ", right" : wrong ? ", your pick" : ""}` },
          letter, h("span.value-label", { text: option }));
        if (right) row.classList.add("right");
        if (wrong) row.classList.add("wrong");
        return row;
      });
      slot.appendChild(h("div.block.quiz-options", rows));
      if (quiz.picked !== null) {
        const line = AIText.caption(q.options[q.correct], q.explanation || "");
        if (line) slot.appendChild(h("p.quiz-caption.reveal-in", h("b", { text: q.options[q.correct] + ". " }),
          line.startsWith(q.options[q.correct] + ". ") ? line.slice(q.options[q.correct].length + 2) : (line === q.options[q.correct] ? "" : line)));
        dock.appendChild(h("button.dock", { type: "button", onclick: next }, quiz.index + 1 >= total ? "See the score" : "Next"));
      } else {
        slot.appendChild(h("p.help.quiz-keys", { text: "Keys 1 to 4 pick an answer." }));
      }
    } else if (quiz.phase === "end") {
      const card = h("div.review-card.end-card.deal-in");
      UI.append(card, [h("div.quiz-score", h("span", { text: String(quiz.right) }), h("small", { text: ` of ${total}` })),
        h("div.end-line", { text: "Practice only. No card was graded." }),
        quiz.source ? h("div.quiz-source", { text: quiz.source }) : null]);
      slot.appendChild(card);
      if (quiz.missed.length) {
        slot.appendChild(UI.eyebrow("Missed", String(quiz.missed.length)));
        slot.appendChild(UI.block(quiz.missed.map(m => UI.valueRow(m.prompt, null, { sub: m.said ? `${m.answer} · you said ${m.said}` : m.answer }))));
      }
      dock.appendChild(h("div.dock-pair",
        h("button.dock", { type: "button", onclick: again }, "Quiz Again"),
        h("button.dock.primary", { type: "button", onclick: closeQuiz }, "Done")));
    }
    column.append(slot, dock);
    layer.appendChild(column);
  }

  return { makeCards, startQuiz, isOpen, closeQuiz, get unconfigured() { return unconfigured; } };
})();
