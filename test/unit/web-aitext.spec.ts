// What the web sends a model and keeps of its answer (assets/js/aitext.js)
// against Recall's AIWritingTests, QuizBuilderTests and the fixtures they
// use, so Make Cards and the quiz on the web ask in the app's own words
// (PLAN-BETA-0.12 section 26, W-7).

import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

interface Line { text: string; level: number | null; id?: string; tableRow?: boolean }
interface Section { title: string; path: string[]; text: string[]; cards: string[]; lastId: string | null }
interface Piece { text: string; sections: number[] }
interface QuizPiece { text: string; headings: string[]; facts: number; ask: number }
interface Question { prompt: string; options: string[]; correct: number; explanation: string | null; crumb: string }
/* eslint-disable @typescript-eslint/no-explicit-any */
const { AIText } = loadAssets<{ AIText: any }>(["gate.js", "aitext.js"], ["AIText"]);

const h = (level: number, text: string, id = text): Line => ({ text, level, id });
const p = (text: string, id = text): Line => ({ text, level: null, id });
const t = (text: string): Line => ({ text, level: null, tableRow: true });

const markets: Line[] = [h(1, "Markets"), h(2, "Demand"),
  p("Demand is defined as :: the quantity consumers are willing and able to buy at each price"),
  p("Individual demand refers to the demand of each consumer"),
  h(3, "The law of Demand"),
  p("The law of demand states that :: there is an inverse relationship between price and quantity"),
  t("Price $ | Quantity Demanded"), t("20 | 200"),
  h(3, "Shifts of the Demand Curve"),
  p("An increase in demand moves the demand curve to the :: right"),
  p("A decrease in demand moves the demand curve to the :: left"),
  h(2, "Supply"),
  p("Market supply is :: the sum of the supply of ALL firms in an industry")];

describe("the quiz reads the whole doc in its order", () => {
  it("one request, twice its facts at most, the lines as the app writes them", () => {
    const pieces: QuizPiece[] = AIText.quizPieces(markets, 20);
    expect(pieces.length).toBe(1);
    expect(pieces[0]!.facts).toBe(8);
    expect(pieces[0]!.ask).toBe(16);
    expect(pieces[0]!.text).toBe([
      "# Markets", "## Demand",
      "Demand is defined as → the quantity consumers are willing and able to buy at each price",
      "Individual demand refers to the demand of each consumer",
      "### The law of Demand",
      "The law of demand states that → there is an inverse relationship between price and quantity",
      "Price $ | Quantity Demanded", "20 | 200",
      "### Shifts of the Demand Curve",
      "An increase in demand moves the demand curve to the → right",
      "A decrease in demand moves the demand curve to the → left",
      "## Supply",
      "Market supply is → the sum of the supply of ALL firms in an industry"].join("\n"));
    const request: string = AIText.quizRequest("Topic 3: Markets", pieces[0]);
    expect(request.startsWith("Topic: Topic 3: Markets\n")).toBe(true);
    expect(request).toContain("Write 16 questions");
    expect(request).toContain("<<<NOTES\n# Markets");
    expect(AIText.quizPieces(markets, 5).map((x: QuizPiece) => x.ask)).toEqual([5]);
  });

  it("cuts only where a piece is full, and every piece opens under its headings", () => {
    const pieces: QuizPiece[] = AIText.quizPieces(markets, 8, 180, 5);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.reduce((a, x) => a + x.ask, 0)).toBe(8);
    expect(pieces[pieces.length - 1]!.text).toContain("Market supply is → the sum");
    for (const piece of pieces.slice(1)) expect(piece.text.startsWith("# Markets\n")).toBe(true);
  });

  it("shares the questions by what each piece holds", () => {
    const pieces = [{ text: "a", headings: [], facts: 10, ask: 0 }, { text: "b", headings: [], facts: 2, ask: 0 }, { text: "c", headings: [], facts: 1, ask: 0 }];
    expect(AIText.share(10, pieces, 20).map((x: QuizPiece) => x.ask)).toEqual([9, 1]);
    expect(AIText.share(10, pieces, 5).map((x: QuizPiece) => x.ask)).toEqual([5, 4, 1]);
    expect(AIText.share(30, pieces, 5).map((x: QuizPiece) => x.ask)).toEqual([5, 4, 2]);
  });

  it("names the heading a model named, or none", () => {
    const piece = { text: "", headings: ["Markets", "Demand", "Shifts of the Demand Curve"], facts: 1, ask: 1 };
    expect(AIText.crumb(piece, "shifts of the demand curve")).toBe("Shifts of the Demand Curve");
    expect(AIText.crumb(piece, "Markets › Demand")).toBe("Demand");
    expect(AIText.crumb(piece, "Elasticity")).toBe("");
  });

  it("gives the model each card with its answer and a cloze filled, never a to do or a fragment", () => {
    const blocks = [
      { kind: "heading1", text: "Cells", rows: [] }, { kind: "heading2", text: "Organelles", rows: [] },
      { kind: "paragraph", text: "read chapter 3", front: "read chapter 3", back: "", rows: [] },
      { kind: "paragraph", text: "mitocondria", front: "mitocondria", back: "", rows: [] },
      { kind: "paragraph", text: "What builds proteins? :: Ribosomes", front: "What builds proteins?", back: "Ribosomes", hasCard: true, rows: [] },
      { kind: "paragraph", text: "The {{c1::nucleus}} holds the cell's DNA", isCloze: true, clozeText: "The {{c1::nucleus}} holds the cell's DNA", rows: [] },
      { kind: "paragraph", text: "Mitochondria make ATP for the cell.", front: "Mitochondria make ATP for the cell.", back: "", rows: [] },
    ];
    const facts: string = AIText.quizPieces(AIText.factLines(blocks), 5)[0].text;
    expect(facts).toContain("What builds proteins? → Ribosomes");
    expect(facts).toContain("The nucleus holds the cell's DNA");
    expect(facts).toContain("Mitochondria make ATP for the cell.");
    expect(facts).not.toContain("read chapter 3");
    expect(facts.split("\n")).not.toContain("mitocondria");
    expect(AIText.filledCloze("The {{c1::nucleus::organelle}} holds {{c2::DNA}}")).toBe("The nucleus holds DNA");
  });
});

describe("Make Cards sends every section numbered, in one request", () => {
  const lines = ["# Cells", "## Organelles", "Ribosomes build proteins from RNA.", "What builds proteins? :: Ribosomes",
                 "## Empty", "mitocondria", "# Tissues", "Tissues are groups of similar cells working together."]
    .map((l, i) => { const m = /^(#{1,3}) (.*)$/.exec(l); return m ? h(m[1]!.length, m[2]!, "n" + i) : p(l, "n" + i); });

  it("carries the headings above each section, and the cards already made", () => {
    const secs: Section[] = AIText.sections(lines);
    expect(secs.map(s => s.path)).toEqual([["Cells"], ["Cells", "Organelles"], ["Cells", "Empty"], ["Tissues"]]);
    expect(secs[1]!.text).toEqual(["Ribosomes build proteins from RNA."]);
    expect(secs[1]!.cards).toEqual(["What builds proteins? → Ribosomes"]);
    expect(secs[1]!.lastId).toBe("n3");
    const pieces: Piece[] = AIText.cardsPieces(secs);
    expect(pieces.length).toBe(1);
    expect(pieces[0]!.sections).toEqual([2, 4]);
    expect(pieces[0]!.text).toContain("[Section 2] Cells › Organelles\nNotes:\n- Ribosomes build proteins from RNA.");
    expect(pieces[0]!.text).toContain("Existing flashcards (do not repeat these):\n- What builds proteins? → Ribosomes");
    expect(pieces[0]!.text).toContain("[Section 4] Tissues");
    expect(AIText.cardsRequest("Biology", pieces[0])).toContain("Write up to 12 flashcards, at most 6 a section");
    expect(AIText.cardFronts(lines).has("what builds proteins")).toBe(true);
  });

  it("keeps a card only under a section it sent, and never a vague one", () => {
    const secs = AIText.sections(lines);
    const piece = AIText.cardsPieces(secs)[0];
    const made = AIText.sectionCards(`{"cards":[{"section":2,"question":"What do ribosomes build?","answer":"Proteins"},
      {"section":"4","question":"What is a tissue?","answer":"A group of similar cells"},
      {"section":99,"question":"What is DNA?","answer":"Genetic material"},
      {"section":4,"question":"What does the text say about tissues?","answer":"Cells"}]}`);
    expect(made.length).toBe(4);
    const by = AIText.cardsBySection(made, piece);
    expect(by.get(2).map((c: { answer: string }) => c.answer)).toEqual(["Proteins"]);
    expect(by.get(4).map((c: { answer: string }) => c.answer)).toEqual(["A group of similar cells"]);
    expect(by.has(99)).toBe(false);
  });

  it("cuts a whole doc request only where it is full", () => {
    const secs = [1, 2, 3, 4, 5].map(n => ({ title: `S${n}`, path: [`S${n}`], text: [`Section ${n} states a fact about something important.`], cards: [], lastId: null }));
    expect(AIText.cardsPieces(secs).map((x: Piece) => x.sections)).toEqual([[1, 2, 3, 4, 5]]);
    const cut = AIText.cardsPieces(secs, 160);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.flatMap((x: Piece) => x.sections)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("what is kept of an answer", () => {
  it("drops fragments and to dos", () => {
    expect(AIText.facts(["mitocondria", "read chapter 3", "TODO: flashcards", "ATP: energy", "Mitochondria make ATP."]))
      .toEqual(["ATP: energy", "Mitochondria make ATP."]);
  });

  it("drops a card that points at the notes or gives its answer away", () => {
    expect(AIText.keepCard("What do mitochondria make?", "ATP")).toBe(true);
    expect(AIText.keepCard("What does the text say about ATP?", "Energy")).toBe(false);
    expect(AIText.keepCard("According to the notes, what makes ATP?", "Mitochondria")).toBe(false);
    expect(AIText.keepCard("What do mitochondria make, ATP or DNA?", "ATP")).toBe(false);
    expect(AIText.keepCard("What is it?", " ")).toBe(false);
  });

  it("drops a wrong option that is the right one again", () => {
    const prompt = "Which organelle builds proteins?";
    expect(AIText.keepQuestion(prompt, "Ribosomes", ["Nucleus", "Golgi apparatus", "Lysosome"])).toBe(true);
    expect(AIText.keepQuestion(prompt, "Ribosomes", ["The ribosome", "Nucleus", "Lysosome"])).toBe(false);
    expect(AIText.keepQuestion(prompt, "Ribosomes", ["All of the above", "Nucleus", "Lysosome"])).toBe(false);
    expect(AIText.keepQuestion(prompt, "Ribosomes", ["Nucleus", "Lysosome"])).toBe(false);
    expect(AIText.keepQuestion("What is the basic unit of life?", "Cell", ["Cell wall", "Tissue", "Organ"])).toBe(true);
  });

  it("reads JSON through code fences and prose, and keeps what a cut off answer finished", () => {
    expect(AIText.object("Here you go:\n```json\n{\"cards\":[{\"question\":\"Q\",\"answer\":\"ATP\"}]}\n```").cards[0].answer).toBe("ATP");
    expect(AIText.object("no json here")).toBeNull();
    expect(AIText.object("{\"a\":\"}\"} and then {\"b\":1}")).toEqual({ a: "}" });
    const cut = "{\"cards\":[{\"section\":1,\"question\":\"A?\",\"answer\":\"a\"},{\"section\":1,\"question\":\"B?\",\"ans";
    expect(AIText.sectionCards(cut)).toEqual([{ section: 1, question: "A?", answer: "a" }]);
    const quiz = "{\"questions\":[{\"question\":\"Q?\",\"correctAnswer\":\"A\",\"wrongAnswers\":[\"B\",\"C\",\"D\"],\"explanation\":\"E\"}]}";
    expect(AIText.questions(quiz)[0]).toEqual({ question: "Q?", correct: "A", wrong: ["B", "C", "D"], explanation: "E", section: "" });
    expect(AIText.QUIZ_SCHEMA.properties.questions.items.required).toContain("section");
  });

  it("bounds the answer by what it asks for", () => {
    expect(AIText.outputTokensForCards(12)).toBe(1080);
    expect(AIText.outputTokensForCards(1)).toBe(1000);
    expect(AIText.outputTokensForQuestions(200)).toBe(16000);
  });
});

describe("the quiz a doc's own cards make (QuizBuilder)", () => {
  const cards = [
    { front: "Capital of France", back: "Paris", section: "Europe" },
    { front: "Capital of Italy", back: "Rome", section: "Europe" },
    { front: "Capital of Spain", back: "Madrid", section: "Europe" },
    { front: "Capital of Japan", back: "Tokyo", section: "Asia" },
    { front: "Year of the moon landing", back: "1969", section: "History" },
  ];

  it("asks each card its own answer among three others", () => {
    const qs: Question[] = AIText.fromCards(cards, 20);
    expect(qs.length).toBe(5);
    for (const q of qs) {
      const card = cards.find(c => c.front === q.prompt)!;
      expect(q.options.length).toBe(4);
      expect(q.options[q.correct]).toBe(card.back);
      expect(new Set(q.options).size).toBe(4);
      expect(q.explanation).toBeNull();
      expect(q.crumb).toBe(card.section);
    }
    expect(AIText.fromCards(cards, 2).length).toBe(2);
    expect(AIText.fromCards(cards.slice(0, 3), 20)).toEqual([]);
  });

  it("offers the most alike answers first", () => {
    const wrong: string[] = AIText.distractors(cards[0], cards);
    expect(wrong.slice(0, 2).sort()).toEqual(["Madrid", "Rome"]);
    expect(wrong[wrong.length - 1]).toBe("1969");
    expect(AIText.answerShape("1969")).toBe("number");
    expect(AIText.answerShape("Paris")).toBe("word");
    expect(AIText.answerShape("the sum of all firms")).toBe("sentence");
  });

  it("says the answer once in the caption, and clamps the length", () => {
    expect(AIText.caption("Paris", "Paris has been the capital since 987.")).toBe("Paris has been the capital since 987.");
    expect(AIText.caption("Paris", "The capital since 987.")).toBe("Paris. The capital since 987.");
    expect(AIText.clampedLength(0)).toBe(1);
    expect(AIText.clampedLength(undefined)).toBe(20);
    expect(AIText.clampedLength(99)).toBe(50);
    expect(AIText.clampedLength("7")).toBe(7);
  });
});
