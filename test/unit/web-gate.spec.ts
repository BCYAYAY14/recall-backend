// The web's card gate (assets/js/gate.js) against the cases Recall's own
// suite pins (FlashcardModelTests, CardGateTests, ReverseCardTests,
// OwnerRound20260909Tests, ClozeRenderTests), so a line typed in the browser
// makes exactly the card it makes on the Mac (PLAN-BETA-0.12 section 26, W-B;
// D-191, SPEC's 2026-09-28 flashcard model).

import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

interface Mark { separator: string; off: boolean; text: string }
interface Split { front: string; back: string; mark: Mark; separator: string; off: boolean; listShaped: boolean; isOneLineCard: boolean }
interface Hit { start: number; end: number; separator: string; off: boolean; mark: Mark }
interface GateModule {
  splitCard(line: string): Split | null;
  splitOutlineCard(line: string): { front: string; back: string } | null;
  separatorMask(line: string): string;
  separatorHits(line: string): Hit[];
  hasSecondSeparator(line: string): boolean;
  mayCarrySeparator(line: string): boolean;
  columnSeparator(line: string): Hit | null;
  cardCells(text: string): string[];
  flattenTriggers(s: string): string;
  blankingTriggers(s: string): string;
  draftLine(q: string, a: string): string | null;
  markFromText(t: string): Mark | null;
  marksAsks(m: Mark, override: string | null): string;
  clozeOrdinals(text: string): number[];
  declaredKind(line: string): { kind: string; marker: number; checked?: boolean } | null;
}

const { Gate } = loadAssets<{ Gate: GateModule }>(["gate.js"], ["Gate"]);
const split = (s: string) => Gate.splitCard(s);
const card = (s: string) => Gate.splitOutlineCard(s);

describe("the six triggers (FlashcardModelTests)", () => {
  it("reads every trigger, and the longest wins", () => {
    const expect_: [string, string][] = [
      ["France >> Paris", ">>"], ["cat << gato", "<<"], ["gato <> cat", "<>"],
      ["Mitosis :: division", "::"], ["happens in ;; somatic cells", ";;"], ["Stages >>> first", ">>>"],
    ];
    for (const [line, sep] of expect_) expect(split(line)?.separator, line).toBe(sep);
    expect(split("Stages >>>")?.front).toBe("Stages");
    expect(split("Stages >>>")?.listShaped).toBe(true);
  });

  it("a dash turns the card off and keeps its shape", () => {
    const s = split("A note >>- kept for reading");
    expect(s?.mark).toEqual({ separator: ">>", off: true, text: ">>-" });
    expect(s?.back).toBe("kept for reading");
    expect(card("A note >>- kept for reading"), "an off line is not a card").toBeNull();
  });

  it("an escaped trigger is text", () => {
    expect(split("shift \\>> right")).toBeNull();
    expect(split("a \\<< b >> c")?.front, "the escaped one is text and the next one is the trigger").toBe("a \\<< b");
  });

  it("the old reverse spelling is no trigger", () => {
    expect(split("perro <-> dog")).toBeNull();
    expect(Gate.separatorHits("perro <-> dog")).toEqual([]);
  });

  it("the cheap gate sees every trigger and nothing else", () => {
    for (const line of ["a >> b", "a << b", "a <> b", "a :: b", "a ;; b", "a >>> "]) expect(Gate.mayCarrySeparator(line), line).toBe(true);
    for (const line of ["a > b", "a <- b", "a -> b", "10:30", "a; b", "a <b>"]) expect(Gate.mayCarrySeparator(line), line).toBe(false);
  });

  it("flattened sides cannot split a line", () => {
    const side = Gate.flattenTriggers("std::move x >> y <> z");
    expect(Gate.separatorHits(side)).toEqual([]);
    expect(Gate.flattenTriggers("a::b")).toBe("a:b");
    expect(Gate.draftLine("What is 2::3?", "a ratio")).toBe("What is 2:3? >> a ratio");
    expect(Gate.draftLine("# Heading", "x")).toBe("Heading >> x");
    expect(Gate.draftLine("", "x")).toBeNull();
  });

  it("a mark reads its stored text, and a basic card's direction is its trigger", () => {
    expect(Gate.markFromText("::-")).toEqual({ separator: "::", off: true, text: "::-" });
    expect(Gate.markFromText("<->")).toBeNull();
    expect(Gate.markFromText("g")).toBeNull();
    expect(Gate.marksAsks(Gate.markFromText("::")!, "f")).toBe("f");
    expect(Gate.marksAsks(Gate.markFromText(";;")!, "r")).toBe("r");
    expect(Gate.marksAsks(Gate.markFromText("<<")!, "f"), "a Basic trigger ignores the menu").toBe("r");
    expect(Gate.marksAsks(Gate.markFromText("::")!, null)).toBe("b");
  });
});

describe("one masked finder (CardGateTests, D-191 spellings)", () => {
  it("is ONE non-space character before the trigger; the back may be empty (a list-shaped line)", () => {
    for (const ok of ["a >> b", "H >> hydrogen", "5 >> 5", "a>>b"]) expect(card(ok), ok).not.toBeNull();
    for (const no of ["no separator here", " >> cd", ">> answer only", "   ", ">>"]) expect(split(no), no).toBeNull();
    expect(card("ab >> "), "an empty answer is not a one-line card").toBeNull();
    expect(split("ab >> ")?.listShaped).toBe(true);
    expect(card("What is torque >> the rotational force")).toEqual({ front: "What is torque", back: "the rotational force" });
  });

  it("a formula owns its triggers", () => {
    expect(Gate.separatorHits("$a::b$")).toEqual([]);
    expect(card("$a::b$")).toBeNull();
    expect(card("$x >> y$")).toBeNull();
    expect(card("$x >> y$ >> the ratio")).toEqual({ front: "$x >> y$", back: "the ratio" });
    expect(card("Force >> $F = ma$")).toEqual({ front: "Force", back: "$F = ma$" });
    expect(card("$a*b$ >> c *d*")).toEqual({ front: "$a*b$", back: "c *d*" });
  });

  it("a styled run owns its triggers, and an unclosed marker masks nothing", () => {
    expect(card("**x >> y**")).toBeNull();
    expect(card("**bold >> half** rest")).toBeNull();
    expect(card("**Term** >> definition")).toEqual({ front: "**Term**", back: "definition" });
    expect(card("**unfinished >> still a card")).toEqual({ front: "**unfinished", back: "still a card" });
  });

  it("a cloze line is not a basic card", () => {
    expect(card("The {{c1::powerhouse}} of the cell")).toBeNull();
    expect(split("The {{c1::a <> b}} of it")).toBeNull();
  });

  it("finds and names a second trigger; later ones ride in the answer", () => {
    expect(Gate.separatorHits("a >> b >> c").length).toBe(2);
    expect(Gate.hasSecondSeparator("a >> b >> c")).toBe(true);
    expect(Gate.hasSecondSeparator("a >> b")).toBe(false);
    expect(card("a >> b >> c")).toEqual({ front: "a", back: "b >> c" });
    expect(Gate.hasSecondSeparator("front >> $a >> b$")).toBe(false);
  });

  it("the mask preserves length and leaves a plain line alone", () => {
    for (const line of ["$a::b$", "**x >> y**", "The {{c1::powerhouse}} of it", "plain >> card", "a >> b >> c", "no separator here"]) {
      expect(Gate.separatorMask(line).length, line).toBe(line.length);
    }
    expect(Gate.separatorMask("plain >> card")).toBe("plain >> card");
    expect(Gate.separatorHits("plain >> card")[0]?.start).toBe(6);
    expect(Gate.separatorHits("**x >> y**")).toEqual([]);
    expect(Gate.separatorHits("$a >> b$")).toEqual([]);
  });

  it("every trigger reads through the one scan, and the NEAREST wins", () => {
    expect(Gate.separatorHits("perro <> dog").length).toBe(1);
    expect(Gate.separatorHits("perro <> dog")[0]?.separator).toBe("<>");
    expect(Gate.separatorHits("$a <> b$")).toEqual([]);
    expect(Gate.separatorHits("a >> b <> c")[0]?.separator).toBe(">>");
    expect(Gate.separatorHits("a <> b >> c")[0]?.separator).toBe("<>");
  });
});

describe("the reverse and both-ways spellings (ReverseCardTests)", () => {
  it("`<>` is masked exactly as `>>` is", () => {
    expect(split("$a <> b$"), "math owns its own arrows").toBeNull();
    expect(split("**x <> y**"), "a styled run is not split").toBeNull();
    expect(card("perro <> "), "an empty side is not a one-line card").toBeNull();
    expect(split("perro <> ")?.listShaped, "it is a list-shaped line (D-191)").toBe(true);
    expect(split(" <> dog")).toBeNull();
  });

  it("a line with two triggers splits at the first and is reported as two", () => {
    expect(split("a <> b <> c")).toMatchObject({ front: "a", back: "b <> c" });
    expect(Gate.hasSecondSeparator("a <> b <> c")).toBe(true);
    expect(split("a :: b <> c")).toMatchObject({ front: "a", separator: "::" });
    expect(Gate.hasSecondSeparator("a :: b <> c")).toBe(true);
    expect(split("a <> b >> c")?.separator).toBe("<>");
  });

  it("a table's column gate is `::` and nothing else; an arrow in a cell is cell text", () => {
    expect(Gate.cardCells("perro <> dog::the pair")).toEqual(["perro <> dog", "the pair"]);
    expect(Gate.columnSeparator("a >> b")).toBeNull();
    expect(Gate.columnSeparator("a ::- b"), "an off `::` is no column").toBeNull();
    expect(Gate.cardCells("$a::b$ front::back")).toEqual(["$a::b$ front", "back"]);
  });
});

describe("cloze ordinals, typed markers and the word count's blanking", () => {
  it("one ordinal naming two blanks is one card; ordinals sort", () => {
    expect(Gate.clozeOrdinals("{{c1::Paris}} is the capital of {{c1::France}}")).toEqual([1]);
    expect(Gate.clozeOrdinals("{{c2::b}} and {{c1::a}} and {{c3::c::hint}}")).toEqual([1, 2, 3]);
    expect(Gate.clozeOrdinals("no cloze here")).toEqual([]);
  });

  it("a `# ` with no title is not a heading (landmine 33); markers come off", () => {
    expect(Gate.declaredKind("# Title")).toEqual({ kind: "heading1", marker: 2 });
    expect(Gate.declaredKind("### Deep")).toEqual({ kind: "heading3", marker: 4 });
    expect(Gate.declaredKind("# ")).toBeNull();
    expect(Gate.declaredKind("- item")).toEqual({ kind: "dash", marker: 2 });
    expect(Gate.declaredKind("3. third")?.marker).toBe(0);
    expect(Gate.declaredKind("[x] done")).toMatchObject({ kind: "checkbox", checked: true });
    expect(Gate.declaredKind("plain")).toBeNull();
  });

  it("code is gone (owner 2026-09-29): a backtick masks nothing, escapes nothing and declares nothing", () => {
    expect(Gate.declaredKind("``` npm install")).toBeNull();
    // A trigger between backticks is a trigger: no inline code span holds it.
    expect(Gate.splitCard("`a >> b`")?.front).toBe("`a");
    expect(Gate.separatorHits("x `<<` y").map((h) => h.separator)).toEqual(["<<"]);
    // `\`` is no escape: the backslash stays in the scratch.
    expect((Gate as any).spanScratch("a \\` b")).toBe("a \\` b");
    expect((Gate as any).inlineSpans("run `ls` now")).toEqual([]);
  });

  it("blanking keeps the length and removes every trigger", () => {
    expect(Gate.blankingTriggers("Mitosis :: two nuclei")).toBe("Mitosis    two nuclei");
    expect(Gate.blankingTriggers("a >>- b")).toBe("a     b");
    expect(Gate.blankingTriggers("no trigger")).toBe("no trigger");
  });
});
