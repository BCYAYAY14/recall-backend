// D-191's list review on the web (assets/js/store.js, cards.js, study.js)
// against the app's `ListReview` (Sources/Core/ListReview.swift) and its
// FlashcardModelTests: the suggested grade, a line forgotten twice becoming
// its own card until it holds (paused on the first miss, unpaused on the
// second, retired on Good or Easy, every step undone with its grade), a line
// card's face (the prompt with the list, its own line in a gap), and the
// session: a set shows every line with its ✕ once the card is up, an ordered
// list turns one line over per "Show line N" and grades once at the end.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FNode, find, installFakeDom } from "../support/fake-dom.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = path.join(import.meta.dirname, "..", "..", "assets", "js");
const T0 = Date.parse("2026-09-28T00:00:00.000Z");

const doc = installFakeDom() as any;
const g = globalThis as any;
g.Node = FNode;
doc.body = new FNode("body");
doc.addEventListener = () => {};
doc.removeEventListener = () => {};
g.matchMedia = () => ({ matches: true });
g.getComputedStyle = () => ({ getPropertyValue: () => "" });

// The page's own scripts over a Backend that holds flat rows, stamps every
// write past the row's own stamp, and keeps what a tombstone replaced.
function stubbed() {
  const prelude = `
    const rowsMap = new Map();
    const lastContent = new Map();
    let clock = ${T0};
    let version = 0;
    const Backend = {
      rowsMap,
      get version() { return version; },
      library() {
        const notes = new Map(), docs = new Map(), folders = new Map(), media = new Map();
        const cards = [], occlusion = [], events = [];
        for (const [k, r] of rowsMap) {
          const lane = k.split("|")[0];
          if (lane === "note") notes.set(r.id, r);
          else if (lane === "notebook") docs.set(r.id, r);
          else if (lane === "folder") folders.set(r.id, r);
          else if (lane === "media") media.set(r.id, r);
          else if (lane === "card") cards.push(r);
          else if (lane === "occlusion") occlusion.push(r);
          else if (lane === "grade_event") events.push(r);
        }
        return { notes, docs, folders, media, cards, occlusion, events, fonts: [],
                 settings: { retention: 90, newPerDay: 50, leechAutoSuspend: false, leechThreshold: 8, fromYourNotes: false } };
      },
      doc(id) {
        const L = this.library();
        const notes = [...L.notes.values()].filter(n => n.notebook_id === id);
        const ids = new Set(notes.map(n => n.id));
        return { notes, cards: L.cards.filter(c => ids.has(c.note_id) && c.deleted_at == null) };
      },
      get(lane, id) { const r = rowsMap.get(lane + "|" + id); return r && r.deleted_at == null ? r : r || null; },
      write(lane, id, patch = {}, opts = {}) {
        version += 1;
        const k = lane + "|" + id;
        const prior = rowsMap.get(k);
        const t = Math.max(opts.now ?? clock, prior && prior.updated_at ? Date.parse(prior.updated_at) + 1 : 0);
        clock = t + 1;
        const stamp = new Date(t).toISOString();
        if (opts.tombstone) {
          if (prior && prior.deleted_at == null) {
            const { id: _i, updated_at: _u, ...rest } = prior;
            lastContent.set(k, { env: { ...rest, deleted_at: null }, content: {} });
          }
          rowsMap.set(k, { ...(prior || { id }), deleted_at: stamp, updated_at: stamp });
        } else {
          const next = { ...(prior || { id }), ...(patch.env || {}), ...(patch.content || {}), updated_at: stamp };
          if (!(patch.env && "deleted_at" in patch.env)) next.deleted_at = prior ? prior.deleted_at ?? null : null;
          rowsMap.set(k, next);
        }
        return { ...rowsMap.get(k) };
      },
      contentBefore(lane, id) { return lastContent.get(lane + "|" + id) || null; },
      discard() { return true; },
      deviceId() { return "dev"; },
      styleDefaults() { return {}; },
      media() { throw new Error("no media here"); },
    };`;
  const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "cardline.js", "spans.js", "model.js", "sched.js", "store.js",
               "ui.js", "media.js", "render.js", "pictures.js", "cards.js", "study.js"]
    .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${prelude}\n${src}\nMedia.reset([], []);\nreturn { Backend, Store, Model, Cards, Study };`)() as any;
}

function library() {
  const S = stubbed();
  const docId = S.Store.createDoc("D", null, T0);
  const first = [...S.Backend.library().notes.values()][0].id;
  return { S, docId, first };
}

function line(S: any, docId: string, after: string | null, text: string, kind = "paragraph", depth = 0, t = T0 + 10) {
  const id = S.Store.insertLine(docId, after, "", kind, t);
  if (depth) S.Store.setListDepth(id, depth, t);
  S.Store.saveLine(id, text, t);
  return id;
}

const liveCards = (S: any, noteId: string) =>
  S.Backend.library().cards.filter((c: any) => c.note_id === noteId && c.deleted_at == null);

// "Organelles of energy >>" with two bullets under it (the app's fixture).
function organelles() {
  const L = library();
  const prompt = line(L.S, L.docId, L.first, "Organelles of energy >>");
  const a = line(L.S, L.docId, prompt, "mitochondria", "bullet");
  const b = line(L.S, L.docId, a, "chloroplasts", "bullet");
  return { ...L, prompt, a, b };
}

describe("ListReview (FlashcardModelTests)", () => {
  it("the suggested grade counts what was forgotten (testTheSuggestedGradeCountsWhatWasForgotten)", () => {
    const { S } = library();
    expect(S.Store.suggestedRating(0, 4)).toBe(3);
    expect(S.Store.suggestedRating(1, 4)).toBe(2);
    expect(S.Store.suggestedRating(2, 4), "half or more").toBe(1);
    expect(S.Store.suggestedRating(1, 1)).toBe(1);
    expect(S.Store.suggestedRating(0, 0)).toBeNull();
  });

  it("a line forgotten twice becomes its own card until it holds (testALineForgottenTwiceBecomesItsOwnCardUntilItHolds)", () => {
    const { S, prompt, b } = organelles();
    expect(liveCards(S, prompt).length, "the prompt's card is its list").toBe(1);
    expect(liveCards(S, prompt)[0].a_snapshot).toBe("mitochondria\nchloroplasts");

    // The first miss makes a PAUSED line card on the answer line's note.
    const first = S.Store.recordListMisses([b], T0 + 100);
    expect(first.made.length).toBe(1);
    let card = liveCards(S, b)[0];
    expect(card.cloze_ordinal).toBe(S.Store.LINE_ORDINAL);
    expect(card.cloze_ordinal).toBe(-2);
    expect(card.suspended).toBe(true);
    // An edit to the line keeps it (the reconciles never touch -2).
    S.Store.saveLine(b, "chloroplast", T0 + 110);
    expect(liveCards(S, b).length).toBe(1);

    // The second miss unpauses it; a third leaves a live one alone.
    expect(S.Store.recordListMisses([b], T0 + 120).unpaused).toEqual([card.id]);
    card = liveCards(S, b)[0];
    expect(card.suspended).toBe(false);
    const third = S.Store.recordListMisses([b], T0 + 130);
    expect(third.made.length + third.unpaused.length).toBe(0);

    // Its face asks the prompt with the list, this line hidden.
    const context = S.Store.lineCardContext(S.Backend.get("note", b));
    expect(context.prompt).toBe("Organelles of energy");
    expect(context.lines).toEqual(["mitochondria", "chloroplast"]);
    expect(context.index).toBe(1);
    expect(context.ordered).toBe(false);

    // Holding retires it; the undo of that grade brings it back.
    expect(S.Store.retireLineCard(card.id, T0 + 140)).toBe(true);
    expect(liveCards(S, b).length).toBe(0);
    S.Store.undoLineSteps({ made: [], unpaused: [], retired: card.id }, T0 + 150);
    expect(liveCards(S, b).length).toBe(1);
    expect(liveCards(S, b)[0].cloze_ordinal).toBe(-2);
    // And the undo of the first miss takes the card it made away.
    S.Store.undoLineSteps({ made: [card.id], unpaused: [], retired: null }, T0 + 160);
    expect(liveCards(S, b).length).toBe(0);
    expect(S.Store.retireLineCard(liveCards(S, prompt)[0].id), "only a line card retires").toBe(false);
  });

  it("an unpause is undone by pausing again, and a line that left its list has no context", () => {
    const { S, docId, a, b } = organelles();
    S.Store.recordListMisses([a], T0 + 100);
    const steps = S.Store.recordListMisses([a], T0 + 110);
    expect(steps.unpaused.length).toBe(1);
    S.Store.undoLineSteps(steps, T0 + 120);
    expect(liveCards(S, a)[0].suspended, "paused again").toBe(true);
    // A paragraph between them ends the list: `b` answers nothing now.
    const p = line(S, docId, a, "an aside");
    expect(S.Store.listPromptOf(S.Backend.get("note", p))).toBeNull();
    expect(S.Store.lineCardContext(S.Backend.get("note", b))).toBeNull();
  });

  it("an ordered list's context numbers nothing itself and names its concept", () => {
    const { S, docId, first } = library();
    const concept = line(S, docId, first, "Mitosis :: cell division");
    const prompt = line(S, docId, concept, "stages ;;");
    const one = line(S, docId, prompt, "1. prophase", "numbered");
    const two = line(S, docId, one, "2. metaphase", "numbered");
    const context = S.Store.lineCardContext(S.Backend.get("note", two));
    expect(context).toMatchObject({ prompt: "stages", concept: "Mitosis", lines: ["prophase", "metaphase"], index: 1, ordered: true });
    // The block walk the faces read says the same.
    const blocks = S.Study.blocksFor(docId);
    const at = blocks.findIndex((x: any) => x.id === two);
    const byBlocks = S.Cards.lineContextOf(blocks, at);
    expect(byBlocks.prompt.id).toBe(prompt);
    expect(byBlocks.concept).toBe("Mitosis");
    expect(byBlocks.index).toBe(1);
    expect(byBlocks.ordered).toBe(true);
  });
});

describe("the faces (ListAnswerRows)", () => {
  const ctx = { picture: () => new FNode("img"), diagramsFor: () => [], resolve: () => Promise.resolve() };

  it("a set shows its rows only once the card is up, each with its ✕", () => {
    const { S, docId, prompt, a, b } = organelles();
    const blocks = S.Study.blocksFor(docId);
    const card = S.Cards.deck(blocks, S.Backend.library().cards).find((c: any) => c.block.id === prompt);
    const f = S.Cards.faces(card, ctx);
    expect(f.list).toBe(true);
    expect(f.ordered).toBe(false);
    expect(f.rows({ showing: false, shown: 0, marks: new Set(), toggle: () => {} }), "face down: the question alone").toBeNull();
    const toggled: string[] = [];
    const rows = f.rows({ showing: true, shown: 0, marks: new Set([b]), toggle: (id: string) => toggled.push(id) });
    expect(find(rows, "face-line").map((r) => r.textContent.replace("✕", ""))).toEqual(["mitochondria", "chloroplasts"]);
    expect(find(rows, "list-x")).toHaveLength(2);
    expect(find(rows, "forgot")).toHaveLength(1);
    expect(find(rows, "list-x")[1]!.getAttribute("aria-label")).toBe("Forgotten: chloroplasts");
    find(rows, "list-x")[0]!.click();
    expect(toggled).toEqual([a]);
  });

  it("an ordered list shows its lines one at a time, the rest as dots, each shown line with its ✕", () => {
    const { S, docId, first } = library();
    const prompt = line(S, docId, first, "Stages of mitosis >>");
    const one = line(S, docId, prompt, "1. prophase", "numbered");
    line(S, docId, one, "2. metaphase", "numbered");
    const blocks = S.Study.blocksFor(docId);
    const card = S.Cards.deck(blocks, S.Backend.library().cards).find((c: any) => c.block.id === prompt);
    const f = S.Cards.faces(card, ctx);
    expect(f.ordered).toBe(true);
    const rows = f.rows({ showing: false, shown: 1, marks: new Set(), toggle: () => {} });
    expect(find(rows, "list-num").map((n) => n.textContent)).toEqual(["1.", "2."]);
    expect(find(rows, "list-text").map((n) => n.textContent)).toEqual(["prophase"]);
    expect(find(rows, "list-more").map((n) => n.textContent)).toEqual(["· · ·"]);
    expect(find(rows, "list-x"), "only a shown line can be marked").toHaveLength(1);
  });

  it("a line card asks its prompt with the list and its own line in a gap, filled on reveal", () => {
    const { S, docId, b } = organelles();
    S.Store.recordListMisses([b], T0 + 100);
    S.Store.recordListMisses([b], T0 + 110);
    const blocks = S.Study.blocksFor(docId);
    const deck = S.Cards.deck(blocks, S.Backend.library().cards);
    const lineCard = deck.find((c: any) => c.kind === "line");
    expect(lineCard.block.id).toBe(b);
    const f = S.Cards.faces(lineCard, ctx);
    expect(f.line).toBe(true);
    expect(f.question.textContent).toBe("Organelles of energy");
    const down = f.rows({ showing: false });
    expect(find(down, "face-gap")).toHaveLength(1);
    expect(find(down, "face-gap-hint")[0]!.textContent).toBe("· · ·");
    expect(find(down, "list-x"), "nothing to mark on a line card").toHaveLength(0);
    const up = f.rows({ showing: true });
    expect(find(up, "face-gap")[0]!.classList.contains("revealed")).toBe(true);
    expect(find(up, "face-gap-answer")[0]!.textContent).toBe("chloroplasts");
    // A paused line card is not practised.
    S.Store.undoLineSteps({ made: [], unpaused: [lineCard.id], retired: null }, T0 + 120);
    expect(S.Cards.deck(S.Study.blocksFor(docId), S.Backend.library().cards).some((c: any) => c.kind === "line")).toBe(false);
  });
});

describe("the session (ReviewEngine)", () => {
  const docCards = (S: any, docId: string) => ({ kind: "cards", ids: new Set(S.Backend.library().cards
    .filter((c: any) => c.deleted_at == null && !c.suspended && S.Backend.get("note", c.note_id).notebook_id === docId).map((c: any) => c.id)) });
  const dockLabel = () => (doc.body.children[0] ? find(doc.body.children[0], "dock-label").map((n: FNode) => n.textContent) : []);

  it("a set: ✕ marks suggest the grade, and an Again with a mark makes the paused line card, undone with the grade", () => {
    const { S, docId, prompt, b } = organelles();
    // The session deals notes older than a minute (the young window).
    for (const n of S.Backend.library().notes.values()) n.created_at = new Date(T0 - 3600000).toISOString();
    expect(S.Study.start(docCards(S, docId))).toBe(true);
    const id = S.Study.session.queue[0];
    expect(S.Backend.get("card", id).note_id).toBe(prompt);
    expect(dockLabel()).toEqual(["Show answer"]);
    S.Study.reveal();
    S.Study.toggleMiss(id, b);
    const suggested = find(doc.body.children[0], "suggested");
    expect(suggested.map((n: FNode) => n.classList.contains("grade-again")), "one of two forgotten: Again").toEqual([true]);
    S.Study.grade(1);
    expect(liveCards(S, b).map((c: any) => [c.cloze_ordinal, c.suspended])).toEqual([[-2, true]]);
    S.Study.undo();
    expect(liveCards(S, b).length, "the undo takes the line card back").toBe(0);
    S.Study.close();
  });

  it("in order: \"Show line N\" turns one line over, the last turns the card", () => {
    const { S, docId, first } = library();
    const prompt = line(S, docId, first, "Stages of mitosis >>");
    const one = line(S, docId, prompt, "1. prophase", "numbered");
    const two = line(S, docId, one, "2. metaphase", "numbered");
    line(S, docId, two, "3. anaphase", "numbered");
    for (const n of S.Backend.library().notes.values()) n.created_at = new Date(T0 - 3600000).toISOString();
    expect(S.Study.start(docCards(S, docId))).toBe(true);
    expect(dockLabel()).toEqual(["Show line 1"]);
    S.Study.reveal();
    expect(dockLabel()).toEqual(["Show line 2"]);
    S.Study.reveal();
    expect(dockLabel()).toEqual(["Show line 3"]);
    expect(S.Study.session.showing).toBe(false);
    S.Study.reveal();
    expect(S.Study.session.showing, "the last line turns the card").toBe(true);
    expect(dockLabel()).toEqual(["Again", "Hard", "Good", "Easy"]);
    expect(find(doc.body.children[0], "suggested")[0]!.classList.contains("grade-good"), "nothing forgotten: Good").toBe(true);
    S.Study.close();
  });

  it("a line card that holds retires on Good, and comes back with the undo", () => {
    const { S, docId, b } = organelles();
    S.Store.recordListMisses([b], T0 + 100);
    S.Store.recordListMisses([b], T0 + 110);
    for (const n of S.Backend.library().notes.values()) n.created_at = new Date(T0 - 3600000).toISOString();
    const lineCard = liveCards(S, b)[0];
    expect(S.Study.start({ kind: "cards", ids: new Set([lineCard.id]) })).toBe(true);
    const face = find(doc.body.children[0]!, "face-q")[0]!;
    expect(face.textContent).toBe("Organelles of energy");
    S.Study.reveal();
    S.Study.grade(3);
    expect(liveCards(S, b).length, "it held: dissolved").toBe(0);
    S.Study.undo();
    expect(liveCards(S, b).map((c: any) => c.id)).toEqual([lineCard.id]);
    S.Study.close();
  });
});
