// D-191's editing rules on the web (assets/js/cardline.js, gate.js, store.js)
// against the app: a cloze blank's menu as `ClozeBlanks` and its three
// FlashcardModelTests cases (the same inputs, the same answers), the arrow's
// menu as `chipState` and `applyChipChange` state it, Backspace after a chip
// (`canvasUnchipAtCaret`), Return after a trigger (`canvasReturnAfterTrigger`),
// Preview card (`cardPeek`), and what a menu change stores, byte for byte.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = path.join(import.meta.dirname, "..", "..", "assets", "js");
const T0 = Date.parse("2026-09-28T00:00:00.000Z");

function pure() {
  const src = ["gate.js", "cardline.js"].map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${src}\nreturn { Gate, CardLine, ClozeBlanks };`)() as any;
}
const { Gate, CardLine, ClozeBlanks } = pure();

// Store over a stub Backend that holds flat rows (web-flashcards.spec.ts's).
function stubbed() {
  const prelude = `
    const rowsMap = new Map();
    const Backend = {
      rowsMap,
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
        rowsMap.set(k, next);
        return next;
      },
      contentBefore() { return null; },
      deviceId() { return "dev"; },
    };`;
  const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "cardline.js", "spans.js", "model.js", "sched.js", "store.js"]
    .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${prelude}\n${src}\nreturn { Backend, Store, Model, Spans };`)() as any;
}

function doc() {
  const S = stubbed();
  const id = S.Store.createDoc("D", null, T0);
  const first = [...S.Backend.library().notes.values()][0].id;
  return { S, id, first };
}
function line(S: any, docId: string, after: string | null, text: string, kind = "paragraph", depth = 0, t = T0 + 10) {
  const id = S.Store.insertLine(docId, after, "", kind, t);
  if (depth) S.Store.setListDepth(id, depth, t);
  S.Store.saveLine(id, text, t);
  return id;
}
const note = (S: any, id: string) => S.Backend.get("note", id);
const ordinals = (S: any, noteId: string) =>
  S.Backend.library().cards.filter((c: any) => c.note_id === noteId && c.deleted_at == null)
    .map((c: any) => c.cloze_ordinal).sort((a: any, b: any) => (a ?? 0) - (b ?? 0));

// `ClozeBlanks.Edit` applied, as the app's tests apply it.
const apply = (e: any, text: string) => (e ? text.slice(0, e.start) + e.text + text.slice(e.end) : text);

describe("a blank's menu (FlashcardModelTests, SPEC 2026-09-28 \"Cloze\")", () => {
  it("testABlankIsItsOwnCardUntilItSharesAnOrdinal", () => {
    const text = "{{c1::Paris}} is the capital of {{c2::France::country}}";
    expect(ClozeBlanks.isOwnCard(text, 0)).toBe(true);
    const joined = apply(ClozeBlanks.settingOwnCard(text, 1, false), text);
    expect(joined).toBe("{{c1::Paris}} is the capital of {{c1::France::country}}");
    expect(ClozeBlanks.isOwnCard(joined, 0)).toBe(false);
    const parted = apply(ClozeBlanks.settingOwnCard(joined, 0, true), joined);
    expect(parted).toBe("{{c2::Paris}} is the capital of {{c1::France::country}}");
    expect(ClozeBlanks.settingOwnCard("only {{c1::one}}", 0, false), "with the others needs another blank").toBeNull();
    expect(ClozeBlanks.settingOwnCard(text, 0, true), "already its own").toBeNull();
  });

  it("testAHintIsWrittenAndClearedInItsSpan", () => {
    const text = "The capital of {{c1::France}} is Paris";
    const hinted = apply(ClozeBlanks.settingHint(text, 0, " country} "), text);
    expect(hinted).toBe("The capital of {{c1::France::country}} is Paris");
    expect(ClozeBlanks.hint(hinted, 0)).toBe("country");
    expect(apply(ClozeBlanks.settingHint(hinted, 0, ""), hinted)).toBe(text);
    expect(apply(ClozeBlanks.removing(hinted, 0), hinted)).toBe("The capital of France is Paris");
  });

  it("testTypingABareBlankMakesAnOwnCard", () => {
    const r = ClozeBlanks.expandingTyped("hide this and {{that}}", 22, "hide {{c1::this}} and ", ["paragraph"]);
    expect(r.display).toBe("hide this and {{c2::that}}");
    expect(r.caret).toBe(26);
    // On a later line, measured from that line (the ordinal from its own
    // source line).
    const two = ClozeBlanks.expandingTyped("first line\nsee {{it}}", 21, "first line\nsee ", ["paragraph", "paragraph"]);
    expect(two.display).toBe("first line\nsee {{c1::it}}");
    expect(two.caret).toBe(25);
    expect(ClozeBlanks.expandingTyped("{{img:x}}", 9, "", ["paragraph"])).toBeNull();
    // No kind refuses a blank since code left Recall (owner 2026-09-29).
    expect(ClozeBlanks.expandingTyped("a {{b}}", 7, "a ", ["code"]).display).toBe("a {{c1::b}}");
    expect(ClozeBlanks.expandingTyped("a >> {{b}}", 10, "a >> ", ["paragraph"])).toBeNull();
  });

  it("with the others joins the lowest ordinal two blanks share, else the lowest other", () => {
    const text = "{{c3::a}} {{c2::b}} {{c2::c}} {{c5::d}}";
    expect(apply(ClozeBlanks.settingOwnCard(text, 3, false), text)).toBe("{{c3::a}} {{c2::b}} {{c2::c}} {{c2::d}}");
    const plain = "{{c3::a}} {{c4::b}} {{c1::c}}";
    expect(apply(ClozeBlanks.settingOwnCard(plain, 0, false), plain)).toBe("{{c1::a}} {{c4::b}} {{c1::c}}");
    expect(apply(ClozeBlanks.settingOwnCard("{{c1::a}} {{c1::b}}", 1, true), "{{c1::a}} {{c1::b}}"),
      "own card: one past the highest, the hint kept").toBe("{{c1::a}} {{c2::b}}");
    const hinted = "{{c1::a::x}} {{c1::b}}";
    expect(apply(ClozeBlanks.settingOwnCard(hinted, 0, true), hinted)).toBe("{{c2::a::x}} {{c1::b}}");
  });

  it("a hint carries no brace and no newline, and an unchanged hint writes nothing", () => {
    const text = "{{c1::Paris::capital}}";
    expect(ClozeBlanks.settingHint(text, 0, "capital")).toBeNull();
    expect(apply(ClozeBlanks.settingHint(text, 0, "a {b}\ncity"), text)).toBe("{{c1::Paris::a bcity}}");
    expect(ClozeBlanks.settingHint(text, 3, "x"), "no such blank").toBeNull();
  });

  it("the pieces the document hides, in the line's own offsets", () => {
    const [s] = Gate.clozeSpans("The {{c12::capital::city}} is");
    expect(s.ordinal).toBe(12);
    expect(s.open).toEqual({ start: 4, end: 11 });
    expect(s.inner).toEqual({ start: 11, end: 18 });
    expect(s.hintMark).toEqual({ start: 18, end: 20 });
    expect(s.hint).toEqual({ start: 20, end: 24 });
    expect(s.close).toEqual({ start: 24, end: 26 });
    expect(Gate.clozeSpans("{{c1::a::}}")[0]).toMatchObject({ hintMark: { start: 7, end: 9 }, hint: null });
    expect(Gate.clozeSpans("no {{blank}} here")).toEqual([]);
  });
});

describe("an escaped trigger (`\\>>`) and Backspace after a chip (canvasUnchipAtCaret)", () => {
  it("the backslash of every escaped trigger, never one inside a cloze or a formula", () => {
    expect(Gate.escapedTriggerBackslashes("France \\>> Paris")).toEqual([7]);
    expect(Gate.escapedTriggerBackslashes("a \\>>> b \\:: c")).toEqual([2, 9]);
    expect(Gate.escapedTriggerBackslashes("{{c1::a \\>> b}} $x \\<< y$")).toEqual([]);
    expect(Gate.escapedTriggerBackslashes("a \\> b")).toEqual([]);
    expect(Gate.separatorHits("France \\>> Paris")).toEqual([]);
  });

  it("right after the chip, or after the one space after it, the backslash goes before the trigger", () => {
    expect(CardLine.unchipAt("France >> Paris", 9)).toBe(7);
    expect(CardLine.unchipAt("France >> Paris", 10)).toBe(7);
    expect(CardLine.unchipAt("France >> Paris", 11)).toBeNull();
    expect(CardLine.unchipAt("France >>- Paris", 10), "the dash is the chip's").toBe(7);
    expect(CardLine.unchipAt("Stages >>", 9), "a list-shaped line").toBe(7);
    expect(CardLine.unchipAt(">> Paris", 2), "no question: no card, no chip").toBeNull();
    const unchipped = "France \\>> Paris";
    expect(Gate.splitCard(unchipped), "the line stops being a card").toBeNull();
    expect(CardLine.unchipAt(unchipped, 10), "the next Backspace takes a `>`").toBeNull();
  });
});

describe("Return after a trigger (canvasReturnAfterTrigger)", () => {
  it("a line whose trigger ends it starts its answer one level deeper", () => {
    expect(CardLine.returnAfterTrigger("Stages of mitosis >>", 20, "paragraph", 0)).toBe(0);
    expect(CardLine.returnAfterTrigger("Stages >>>", 10, "heading2", 0)).toBe(0);
    expect(CardLine.returnAfterTrigger("phases ;;", 9, "bullet", 1)).toBe(2);
    expect(CardLine.returnAfterTrigger("phases ;;", 9, "numbered", 5), "six levels at most").toBe(5);
  });

  it("anything else keeps its own Return", () => {
    expect(CardLine.returnAfterTrigger("France >> Paris", 15, "paragraph", 0), "an answer on the line").toBeNull();
    expect(CardLine.returnAfterTrigger("Stages >>-", 10, "paragraph", 0), "turned off").toBeNull();
    expect(CardLine.returnAfterTrigger("Stages >>", 6, "paragraph", 0), "not at the end").toBeNull();
    expect(CardLine.returnAfterTrigger("{{c1::a}} b >>", 14, "paragraph", 0), "a cloze").toBeNull();
    expect(CardLine.returnAfterTrigger("Stages \\>>", 10, "paragraph", 0), "escaped").toBeNull();
  });
});

describe("the arrow's menu (chipState, applyChipChange)", () => {
  it("states Type, Asks, Answer and Card on as the line and its answer lines say", () => {
    expect(CardLine.state("France >> Paris", null, [])).toMatchObject({ kind: "basic", asks: "f", answer: "oneLine", hasAnswerLines: false, on: true });
    expect(CardLine.state("gato <> cat", "r", [])).toMatchObject({ kind: "basic", asks: "b" });
    expect(CardLine.state("Mitosis :: division", null, [])).toMatchObject({ kind: "concept", asks: "b" });
    expect(CardLine.state("Mitosis :: division", "r", [])).toMatchObject({ kind: "concept", asks: "r" });
    expect(CardLine.state("phases ;;", null, ["numbered", "numbered"])).toMatchObject({ kind: "descriptor", asks: "f", answer: "ordered", hasAnswerLines: true });
    expect(CardLine.state("Organelles >>", null, ["bullet"])).toMatchObject({ answer: "set", hasAnswerLines: true });
    expect(CardLine.state("France >> Paris", null, ["bullet"]), "a one-line card has no answer lines").toMatchObject({ answer: "oneLine", hasAnswerLines: false });
    expect(CardLine.state("A note >>- kept", null, [])).toMatchObject({ on: false });
    expect(CardLine.state("no trigger here", null, [])).toBeNull();
  });

  const edit = (text: string, ask: string | null, change: any) => {
    const e = CardLine.chipEdit(text, ask, change);
    return e && { text: e.text == null ? text : text.slice(0, e.start) + e.text + text.slice(e.end), ask: e.ask };
  };

  it("a Basic card's direction is its trigger", () => {
    expect(edit("France >> Paris", null, { asks: "r" })).toEqual({ text: "France << Paris", ask: null });
    expect(edit("France >> Paris", null, { asks: "b" })).toEqual({ text: "France <> Paris", ask: null });
    expect(CardLine.chipEdit("Stages >>>", null, { asks: "f" }).text, "`>>>` stays `>>>` while it asks forward").toBeNull();
    expect(edit("Stages >>>", null, { asks: "r" })).toEqual({ text: "Stages <<", ask: null });
  });

  it("a concept or a descriptor stores `ask` only when it differs from its own", () => {
    expect(edit("Mitosis :: division", null, { asks: "f" })).toEqual({ text: "Mitosis :: division", ask: "f" });
    expect(edit("Mitosis :: division", "f", { asks: "b" })).toEqual({ text: "Mitosis :: division", ask: null });
    expect(edit("happens in ;; somatic cells", null, { asks: "b" })).toEqual({ text: "happens in ;; somatic cells", ask: "b" });
    expect(edit("happens in ;; somatic cells", "r", { asks: "f" })).toEqual({ text: "happens in ;; somatic cells", ask: null });
  });

  it("a change of Type starts at the type's own direction, Basic keeping the one it asked", () => {
    expect(edit("France >> Paris", null, { kind: "concept" })).toEqual({ text: "France :: Paris", ask: null });
    expect(edit("France << Paris", null, { kind: "descriptor" })).toEqual({ text: "France ;; Paris", ask: null });
    expect(edit("Mitosis :: division", null, { kind: "basic" })).toEqual({ text: "Mitosis <> division", ask: null });
    expect(edit("Mitosis :: division", "r", { kind: "basic" })).toEqual({ text: "Mitosis << division", ask: null });
    expect(edit("Stages >>>", null, { kind: "basic" }), "unchanged").toEqual({ text: "Stages >>>", ask: null });
    expect(edit("A note >>- kept", null, { kind: "concept" }), "off stays off").toEqual({ text: "A note ::- kept", ask: null });
  });

  it("Card on moves only the `-`", () => {
    expect(edit("France >> Paris", null, { on: false })).toEqual({ text: "France >>- Paris", ask: null });
    expect(edit("France >>- Paris", null, { on: true })).toEqual({ text: "France >> Paris", ask: null });
    expect(edit("Mitosis :: division", "f", { on: false })).toEqual({ text: "Mitosis ::- division", ask: "f" });
  });

  it("Set takes each `N. ` off; In order writes `N. ` per depth, restarting under a shallower line", () => {
    const lines = [{ text: "prophase", depth: 1 }, { text: "3. metaphase", depth: 1 }, { text: "a", depth: 2 },
                   { text: "b", depth: 2 }, { text: "anaphase", depth: 1 }, { text: "c", depth: 2 }];
    expect(CardLine.answerEdits(lines, "ordered").map((e: any) => e.add)).toEqual(["1. ", "2. ", "1. ", "2. ", "3. ", "1. "]);
    expect(CardLine.answerEdits(lines, "ordered").map((e: any) => e.cut)).toEqual([0, 3, 0, 0, 0, 0]);
    expect(CardLine.answerEdits([{ text: "12) x", depth: 1 }, { text: "4.", depth: 1 }, { text: "4.x", depth: 1 }], "set"))
      .toEqual([{ cut: 4, add: "", kind: "bullet" }, { cut: 2, add: "", kind: "bullet" }, { cut: 0, add: "", kind: "bullet" }]);
    expect(CardLine.answerEdits(lines, "oneLine")).toBeNull();
    expect(CardLine.answerEdits([], "set")).toBeNull();
  });

  it("Preview card: the two sides, a list's lines without their numbers, pictures out", () => {
    expect(CardLine.peek("France >> Paris")).toEqual({ front: "France", back: "Paris" });
    expect(CardLine.peek("phases ;;", ["1. prophase", "2. metaphase"])).toEqual({ front: "phases", back: "prophase\nmetaphase" });
    expect(CardLine.peek("Stages >>", [])).toEqual({ front: "Stages", back: null });
    expect(CardLine.peek("{{c1::Paris}} is a capital")).toEqual({ front: "{{c1::Paris}} is a capital", back: null });
    expect(CardLine.peek("{{img:9F0E1D2C-3B4A-5968-7766-554433221100}} Heart >> pump")).toEqual({ front: "Heart", back: "pump" });
  });
});

describe("what a menu change stores (Store.saveLine's ask, setCardAsk, setAnswerShape)", () => {
  it("Asks on a concept writes `attrs.ask` and the cards follow; Both takes it off again", () => {
    const { S, id, first } = doc();
    const a = line(S, id, first, "Mitosis :: division");
    expect(ordinals(S, a)).toEqual([-1, null]);
    expect(S.Store.setCardAsk(a, "f", T0 + 20)).toBe(true);
    expect(note(S, a).attrs).toBe('{"ask":"f","tg":"::","v":1}');
    expect(ordinals(S, a), "forward only").toEqual([null]);
    expect(S.Store.setCardAsk(a, "f", T0 + 21), "unchanged writes nothing").toBe(false);
    S.Store.setCardAsk(a, null, T0 + 30);
    expect(note(S, a).attrs).toBe('{"tg":"::","v":1}');
    expect(ordinals(S, a)).toEqual([-1, null]);
    const b = line(S, id, a, "France >> Paris");
    expect(S.Store.setCardAsk(b, "r", T0 + 40), "a Basic direction is its trigger").toBe(false);
  });

  it("a Type change writes the trigger and the ask in one write", () => {
    const { S, id, first } = doc();
    const a = line(S, id, first, "Mitosis :: division");
    S.Store.setCardAsk(a, "r", T0 + 20);
    S.Store.saveLine(a, "Mitosis ;; division", T0 + 30, undefined, { ask: null });
    expect(note(S, a).attrs).toBe('{"tg":";;","v":1}');
    expect(ordinals(S, a)).toEqual([null]);
    S.Store.saveLine(a, "Mitosis >> division", T0 + 40, undefined, { ask: null });
    expect(note(S, a).attrs).toBeNull();
    expect(S.Model.rawText(note(S, a))).toBe("Mitosis >> division");
  });

  it("In order numbers the answer lines per depth and Set takes the numbers off, depth and card kept", () => {
    const { S, id, first } = doc();
    const p = line(S, id, first, "Stages >>");
    const x = line(S, id, p, "prophase", "bullet", 1);
    const y = line(S, id, x, "metaphase", "bullet", 1);
    const z = line(S, id, y, "early", "bullet", 2);
    const after = line(S, id, z, "Not an answer");
    expect(S.Store.setAnswerShape(p, "ordered", T0 + 20)).toBe(true);
    expect([x, y, z].map((n) => [note(S, n).kind, note(S, n).front, S.Model.listDepth(note(S, n))]))
      .toEqual([["numbered", "1. prophase", 1], ["numbered", "2. metaphase", 1], ["numbered", "1. early", 2]]);
    expect(note(S, after).kind).toBe("paragraph");
    expect(S.Store.cardContext(note(S, p)).ordered).toBe(true);
    expect(ordinals(S, p)).toEqual([null]);
    expect(S.Store.setAnswerShape(p, "set", T0 + 30)).toBe(true);
    expect([x, y, z].map((n) => [note(S, n).kind, note(S, n).front, S.Model.listDepth(note(S, n))]))
      .toEqual([["bullet", "prophase", 1], ["bullet", "metaphase", 1], ["bullet", "early", 2]]);
    expect(S.Store.setAnswerShape(p, "set", T0 + 40), "already a set").toBe(false);
    const one = line(S, id, after, "France >> Paris");
    expect(S.Store.setAnswerShape(one, "set", T0 + 50), "a one-line card has no answer lines").toBe(false);
  });

  it("a numbered answer line keeps its style through In order", () => {
    const { S, id, first } = doc();
    const p = line(S, id, first, "Stages >>");
    const x = S.Store.insertLine(id, p, "", "bullet", T0 + 10);
    S.Store.setListDepth(x, 1, T0 + 10);
    S.Store.saveLine(x, "prophase first", T0 + 11, [{ start: 0, end: 8, kind: "b", value: null }]);
    S.Store.setAnswerShape(p, "ordered", T0 + 20);
    const n = note(S, x);
    expect(n.front).toBe("1. prophase first");
    expect(S.Spans.decode(n.spans, S.Model.rawText(n))).toEqual([{ start: 3, end: 11, kind: "b", value: null }]);
  });
});
