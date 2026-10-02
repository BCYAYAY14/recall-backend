// D-191 on the web: what a line the browser saves stores, byte for byte, as
// the app's FlashcardModelTests and ReverseCardTests pin it (SPEC's
// 2026-09-28 flashcard model): a card row per direction, the trigger in
// `attrs.tg` (absent for the default `>>` with an answer), `attrs.ask` for a
// concept or descriptor, a legacy code row read as the paragraph it now is,
// list answers read from the lines under a line, and a descriptor's concept.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = path.join(import.meta.dirname, "..", "..", "assets", "js");
const T0 = Date.parse("2026-09-28T00:00:00.000Z");

// Store over a stub Backend that holds flat rows and records every write.
function stubbed() {
  const prelude = `
    const writes = [];
    const rowsMap = new Map();
    const Backend = {
      writes, rowsMap,
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
        }
        return { notes, docs, folders, media, cards, occlusion, events, settings: { retention: 90, newPerDay: 10 } };
      },
      get(lane, id) { return rowsMap.get(lane + "|" + id) || null; },
      write(lane, id, patch = {}, opts = {}) {
        const k = lane + "|" + id;
        const next = { ...(rowsMap.get(k) || { id }), ...(patch.env || {}), ...(patch.content || {}) };
        next.deleted_at = opts.tombstone ? "2026-09-28T00:00:01.000Z" : next.deleted_at ?? null;
        if (!opts.tombstone && patch.env && "deleted_at" in patch.env) next.deleted_at = patch.env.deleted_at;
        rowsMap.set(k, next);
        writes.push({ lane, id, patch, opts });
        return next;
      },
      contentBefore() { return null; },
      deviceId() { return "dev"; },
    };`;
  const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "spans.js", "model.js", "sched.js", "store.js", "render.js", "cards.js"]
    .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${prelude}\n${src}\nreturn { Backend, Store, Model, Cards, Gate };`)() as any;
}

function doc() {
  const S = stubbed();
  const id = S.Store.createDoc("D", null, T0);
  // The doc's trailing blank line (R4) is its first line; type into it.
  const first = [...S.Backend.library().notes.values()][0].id;
  return { S, id, first };
}

const cardsOf = (S: any, noteId: string) =>
  S.Backend.library().cards.filter((c: any) => c.note_id === noteId && c.deleted_at == null)
    .sort((a: any, b: any) => (a.cloze_ordinal ?? 0) - (b.cloze_ordinal ?? 0));
const ordinals = (S: any, noteId: string) => cardsOf(S, noteId).map((c: any) => c.cloze_ordinal);
const note = (S: any, id: string) => S.Backend.get("note", id);

// A line placed after `after` with a stated kind and list depth, then typed.
function line(S: any, docId: string, after: string | null, text: string, kind = "paragraph", depth = 0, t = T0 + 10) {
  const id = S.Store.insertLine(docId, after, "", kind, t);
  if (depth) S.Store.setListDepth(id, depth, t);
  S.Store.saveLine(id, text, t);
  return id;
}

describe("the triggers store their directions (FlashcardModelTests)", () => {
  it("each trigger stores its directions and the line reads back as written", () => {
    const { S, id, first } = doc();
    const expected: [string, (number | null)[]][] = [
      ["France >> Paris", [null]],
      ["cat << gato", [-1]],
      ["gato <> cat", [-1, null]],
      ["Mitosis :: division", [-1, null]],
      ["happens in ;; somatic cells", [null]],
      ["A note >>- kept", []],
    ];
    let after = first;
    for (const [text, want] of expected) {
      after = line(S, id, after, text);
      expect(ordinals(S, after), text).toEqual(want);
      expect(S.Model.rawText(note(S, after)), text).toBe(text);
    }
  });

  it("the default trigger stores nothing; any other stores exactly the app's attrs", () => {
    const { S, id, first } = doc();
    const a = line(S, id, first, "France >> Paris");
    expect(note(S, a).attrs, "an ordinary card keeps NULL attrs").toBeNull();
    const b = line(S, id, a, "Mitosis :: division");
    expect(note(S, b).attrs).toBe('{"tg":"::","v":1}');
    const c = line(S, id, b, "A note >>- kept");
    expect(note(S, c).attrs).toBe('{"tg":">>-","v":1}');
    const d = line(S, id, c, "Stages >>");
    expect(note(S, d).attrs, "a list-shaped `>>` keeps its trigger").toBe('{"tg":">>","v":1}');
    expect(note(S, d).back).toBeNull();
    const e = line(S, id, d, "phases ;;", "bullet", 2);
    expect(note(S, e).attrs).toBe('{"d":2,"tg":";;","v":1}');
    // A line that stops being a card line drops the trigger.
    S.Store.saveLine(b, "Mitosis, plainly", T0 + 20);
    expect(note(S, b).attrs).toBeNull();
  });

  it("an imported two column note is a forward card", () => {
    const { S, id, first } = doc();
    const a = line(S, id, first, "front >> back");
    S.Backend.write("note", a, { content: { attrs: null } });
    expect(S.Model.rawText(note(S, a))).toBe("front >> back");
    expect(S.Model.cardAsks(note(S, a).attrs)).toBe("f");
  });

  it("turning a card off detaches its graded card and on again relinks it", () => {
    const { S, id, first } = doc();
    const a = line(S, id, first, "France >> Paris");
    const [c] = cardsOf(S, a);
    S.Backend.write("card", c.id, { env: { reps: 1, state: "review" } });
    S.Store.saveLine(a, "France >>- Paris", T0 + 20);
    expect(S.Backend.get("card", c.id).detached, "off pauses, history kept").toBe(true);
    S.Store.saveLine(a, "France >> Paris", T0 + 30);
    expect(S.Backend.get("card", c.id).detached).toBe(false);
    expect(S.Backend.get("card", c.id).reps, "the same card, its schedule intact").toBe(1);
  });

  it("the menu's direction overrides a concept but never a basic card", () => {
    const { S, id, first } = doc();
    const a = line(S, id, first, "Mitosis :: division");
    expect(cardsOf(S, a).length).toBe(2);
    S.Backend.write("note", a, { content: { attrs: '{"ask":"f","tg":"::","v":1}' } });
    S.Store.saveLine(a, "Mitosis :: division, again", T0 + 20);
    expect(ordinals(S, a), "the concept now asks forward only").toEqual([null]);
    expect(note(S, a).attrs, "the override is kept").toBe('{"ask":"f","tg":"::","v":1}');
    S.Store.saveLine(a, "Mitosis >> division", T0 + 30);
    expect(note(S, a).attrs, "a Basic trigger drops the override").toBeNull();
  });

  it("code is gone (owner 2026-09-29): no line becomes code, and a legacy code row is a paragraph", () => {
    const { S, id, first } = doc();
    const b = line(S, id, first, "France >> Paris");
    expect(cardsOf(S, b).length).toBe(1);
    expect(S.Store.setKind(b, "code", T0 + 40), "code is no kind a line can take").toBe(false);
    expect(note(S, b).kind).toBe("paragraph");
    expect(cardsOf(S, b).length).toBe(1);
    // Typed "``` " declares nothing: it is text.
    const t = line(S, id, b, "``` npm install");
    expect(note(S, t)).toMatchObject({ kind: "paragraph", front: "``` npm install" });
    // A row another device stored as `code` before the removal (it never
    // gated) is read, drawn and edited as a paragraph; its next save stores
    // `paragraph` and its trigger makes the card.
    S.Backend.rowsMap.set("note|legacy", { ...note(S, t), id: "legacy", kind: "code", front: "cout << x", position: 99999 });
    const block = S.Model.build([note(S, "legacy")], new Map(), new Set())[0];
    expect(block.kind).toBe("paragraph");
    expect(block.text).toBe("cout << x");
    S.Store.saveLine("legacy", "cout << x", T0 + 60);
    expect(note(S, "legacy")).toMatchObject({ kind: "paragraph", front: "cout", back: "x" });
    expect(ordinals(S, "legacy"), "`<<` asks the reverse card").toEqual([-1]);
  });

  it("an unchanged card is not stamped by an edit", () => {
    const { S, id, first } = doc();
    const a = line(S, id, first, "France >> Paris");
    const writes = S.Backend.writes.length;
    S.Store.saveLine(a, "France >> Paris", T0 + 20);
    expect(S.Backend.writes.length).toBe(writes);
    S.Store.saveLine(a, "France  >>  Paris ", T0 + 30);
    expect(S.Backend.writes.filter((w: any) => w.lane === "card").length, "the spacing is normalised, no card write").toBe(1);
  });
});

describe("a stored `rev` reads as `<>` (ReverseCardTests on the web)", () => {
  it("a legacy reverse note rejoins with `<>`, keeps its bytes, and loses `rev` when the trigger moves", () => {
    const { S, id, first } = doc();
    const a = line(S, id, first, "perro <> dog");
    S.Backend.write("note", a, { content: { attrs: '{"rev":true,"v":1}' } });
    expect(S.Model.rawText(note(S, a))).toBe("perro <> dog");
    expect(S.Model.cardAsks(note(S, a).attrs)).toBe("b");
    S.Store.saveLine(a, "perro <> dogs", T0 + 20);
    expect(note(S, a).attrs, "nothing changed in the trigger, so the app's bytes stay").toBe('{"rev":true,"v":1}');
    S.Store.saveLine(a, "perro >> dogs", T0 + 30);
    expect(note(S, a).attrs).toBeNull();
    expect(ordinals(S, a)).toEqual([null]);
  });

  it("the codec is CanvasAttrs's: dead keys drop on a write, unknown keys and the version stay", () => {
    const { S } = doc();
    const enc = (json: string | null, tg: string | null) => { const a = S.Store.decodeCanvasAttrs(json); a.tg = tg; return S.Store.encodeCanvasAttrs(a); };
    expect(enc('{"c":true,"g":"x","r":2,"tf":"Arial","v":1}', null)).toBe('{"card":true,"v":1}');
    expect(enc('{"zz":{"b":1,"a":2},"d":1}', "::")).toBe('{"d":1,"tg":"::","v":0,"zz":{"a":2,"b":1}}');
    expect(enc(null, null)).toBeNull();
    expect(enc('{"m":"abcdef01-2345-4789-8abc-def012345678","v":1}', null)).toBe('{"m":"ABCDEF01-2345-4789-8ABC-DEF012345678","v":1}');
    expect(enc('{"u":"a/b","v":1}', null), "a slash is escaped as JSONSerialization escapes it").toBe('{"u":"a\\/b","v":1}');
  });
});

describe("list answers (D-191)", () => {
  it("a list-shaped line makes its card when its first answer line arrives", () => {
    const { S, id, first } = doc();
    const prompt = line(S, id, first, "Organelles of energy >>");
    expect(cardsOf(S, prompt).length, "no lines, no card").toBe(0);
    expect(S.Model.rawText(note(S, prompt))).toBe("Organelles of energy >>");
    line(S, id, prompt, "mitochondria", "bullet");
    const [made] = cardsOf(S, prompt);
    expect(made.a_snapshot).toBe("mitochondria");
    const context = S.Store.cardContext(note(S, prompt));
    expect(context.answerLines).toEqual(["mitochondria"]);
    expect(context.ordered, "bullets are a set").toBe(false);
  });

  it("a numbered list is asked in order, and deleting the only answer line takes the ungraded card", () => {
    const { S, id, first } = doc();
    const prompt = line(S, id, first, "Stages of mitosis >>>");
    const one = line(S, id, prompt, "1. prophase", "numbered", 1);
    expect(cardsOf(S, prompt).length).toBe(1);
    expect(S.Store.cardContext(note(S, prompt)).ordered).toBe(true);
    S.Store.deleteLine(one, T0 + 50);
    expect(cardsOf(S, prompt).length).toBe(0);
  });

  it("an answer run stops at the first line that is not a deeper list item", () => {
    const { S, id, first } = doc();
    const prompt = line(S, id, first, "phases ;;", "bullet", 0);
    const a = line(S, id, prompt, "1. prophase", "numbered", 1);
    const b = line(S, id, a, "2. metaphase", "numbered", 1);
    const same = line(S, id, b, "a sibling", "bullet", 0);
    line(S, id, same, "3. not mine", "numbered", 1);
    expect(S.Store.cardContext(note(S, prompt)).answerLines.length).toBe(2);
    expect(cardsOf(S, prompt)[0].a_snapshot).toBe("1. prophase\n2. metaphase");
  });

  it("a line becoming a list item joins the answer; indenting past the prompt is what counts", () => {
    const { S, id, first } = doc();
    const prompt = line(S, id, first, "Parts >>", "bullet", 0);
    const sub = line(S, id, prompt, "stem", "bullet", 0);
    expect(cardsOf(S, prompt).length, "a sibling at the prompt's depth is not an answer").toBe(0);
    S.Store.setListDepth(sub, 1, T0 + 60);
    expect(cardsOf(S, prompt).length).toBe(1);
    S.Store.setKind(sub, "paragraph", T0 + 70);
    expect(cardsOf(S, prompt).length, "a paragraph ends the run").toBe(0);
  });
});

describe("descriptors (D-191)", () => {
  it("a descriptor belongs to the concept above it; a heading stops the walk", () => {
    const { S, id, first } = doc();
    const concept = line(S, id, first, "Mitosis :: division into two nuclei");
    const one = line(S, id, concept, "happens in ;; somatic cells", "bullet", 1);
    const two = line(S, id, one, "takes ;; about an hour", "bullet", 1);
    expect(S.Store.cardContext(note(S, two)).concept, "a sibling descriptor is skipped on the way up").toBe("Mitosis");
    const heading = line(S, id, two, "# Meiosis");
    expect(note(S, heading).kind).toBe("heading1");
    const orphan = line(S, id, heading, "happens in ;; germ cells");
    expect(S.Store.cardContext(note(S, orphan)).concept, "a heading stops the walk").toBeNull();
  });

  it("the practice deck reads the same context from the block list", () => {
    const { S, id, first } = doc();
    const concept = line(S, id, first, "Mitosis :: division");
    const desc = line(S, id, concept, "happens in ;; somatic cells", "bullet", 1);
    const prompt = line(S, id, desc, "Organelles >>");
    line(S, id, prompt, "mitochondria", "bullet", 0);
    const L = S.Backend.library();
    const rows = [...L.notes.values()].filter((n: any) => n.deleted_at == null);
    const flags = new Map(L.cards.filter((c: any) => c.deleted_at == null).map((c: any) => [c.note_id, { detached: false }]));
    const blocks = S.Model.build(rows, flags, new Set());
    const deck = S.Cards.deck(blocks, L.cards);
    const byNote = (nid: string) => deck.filter((c: any) => c.block.id === nid);
    expect(byNote(concept).map((c: any) => c.reverse)).toEqual([false, true]);
    expect(byNote(desc)[0].context.concept).toBe("Mitosis");
    expect(byNote(prompt)[0].context.answerLines.map((b: any) => b.text)).toEqual(["mitochondria"]);
    expect(blocks.find((b: any) => b.id === prompt).listWithLines, "the list arrow").toBe(true);
    expect(blocks.find((b: any) => b.id === concept).listWithLines).toBe(false);
  });
});

describe("writers from outside write `>>`", () => {
  it("Make Cards writes a forward card per draft, a trigger inside a side flattened", () => {
    const { S, id, first } = doc();
    const ids = S.Store.insertCards(id, first, [{ question: "What is std::move?", answer: "a cast" }, { question: "", answer: "x" }], T0 + 5);
    expect(ids.length).toBe(1);
    expect(note(S, ids[0])).toMatchObject({ front: "What is std:move?", back: "a cast", attrs: null, unreviewed: true });
    expect(ordinals(S, ids[0])).toEqual([null]);
  });
});
