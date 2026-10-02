// Find and replace, and cut then paste keeping ids and cards, on the web
// (assets/js/find.js, clip.js, store.js) against the app: CanvasFindTests
// (the block list searched, a table's rows and not its parent, markers and
// picture tokens never prose, runs carried, a replaced block keeping its id,
// a line break refused whole, a TAB or `::` refused in a cell by count), and
// P2d's ClipboardRoundTripTests and BlockKindTests (the markdown a row
// copies as, the payload usable beside its text, a cut line pasted back as
// ITSELF with its graded card, only the cards the cut killed, every region
// card of an occlusion note, a live id pasted as a fresh copy, a table with
// its rows, a picture as its own copy).

import { describe, expect, it } from "vitest";
import { blocksOf, storeStub } from "../support/web-store.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const T0 = Date.parse("2026-09-29T00:00:00.000Z");
let n = 0;
const b = (text: string, kind = "paragraph", runs: any[] = [], rows: any[] = []) =>
  ({ id: `b${++n}`, kind, text, runs, rows });
const bold = (start: number, end: number) => ({ start, end, kind: "b", value: null });
const italic = (start: number, end: number) => ({ start, end, kind: "i", value: null });

const { Find, Clip, Spans } = storeStub(T0);

describe("find over the block list (CanvasFindTests)", () => {
  it("finds every occurrence in document order; an empty query finds nothing", () => {
    const a = b("the cat sat on the mat"), c = b("another cat");
    const hits = Find.matches([a, c], "cat");
    expect(hits.map((h: any) => [h.block, h.start, h.end])).toEqual([[a.id, 4, 7], [c.id, 8, 11]]);
    expect(Find.matches([b("anything")], "")).toEqual([]);
  });

  it("case insensitive by default, sensitive on request; whole word refuses a match inside a word", () => {
    const a = b("Cat cat CAT");
    expect(Find.matches([a], "cat")).toHaveLength(3);
    expect(Find.matches([a], "cat", { caseSensitive: true })).toHaveLength(1);
    const w = b("category cat cathode");
    expect(Find.matches([w], "cat")).toHaveLength(3);
    const whole = Find.matches([w], "cat", { wholeWord: true });
    expect(whole.map((h: any) => [h.start, h.end])).toEqual([[9, 12]]);
  });

  it("matches do not overlap", () => {
    expect(Find.matches([b("aaa")], "aa")).toHaveLength(1);
    const a = b("aaaa");
    expect(Find.replaceAll([a], "aa", "b").get(a.id).text).toBe("bb");
  });

  it("a table row is searched and its parent is not; a pre-migration row is", () => {
    const row = b("alpha\tbeta\tgamma", "tablerow");
    const parent = b("alpha beta gamma", "table", [], [row]);
    const list = Find.flattened([parent]);
    const hits = Find.matches(list, "beta");
    expect(hits.map((h: any) => h.block)).toEqual([row.id]);
    const out = Find.replaceAll(list, "beta", "DELTA");
    expect([...out.keys()]).toEqual([row.id]);
    expect(out.get(row.id).text).toBe("alpha\tDELTA\tgamma");
    expect(Find.matches([b("alpha\tbeta\tgamma", "table")], "beta")).toHaveLength(1);
  });

  it("replace all returns only the blocks that changed, from the back, lengths moving later matches", () => {
    const a = b("one two"), c = b("nothing here");
    const out = Find.replaceAll([a, c], "two", "2");
    expect([...out.keys()]).toEqual([a.id]);
    expect(out.get(a.id).text).toBe("one 2");
    const x = b("x cat y cat z cat");
    expect(Find.replaceAll([x], "cat", "dog").get(x.id).text).toBe("x dog y dog z dog");
    const y = b("aa bb aa");
    expect(Find.replaceAll([y], "aa", "wxyz").get(y.id).text).toBe("wxyz bb wxyz");
    expect(Find.replaceAll([b("nothing to see")], "zebra", "x").size).toBe(0);
  });

  it("style runs travel with the replacement; a run inside it is dropped (landmine 88)", () => {
    const a = b("bold cat tail", "paragraph", [bold(0, 4), italic(5, 8)]);
    const out = Find.replaceAll([a], "cat", "elephant").get(a.id);
    expect(out.text).toBe("bold elephant tail");
    expect(out.runs.find((r: any) => r.kind === "b")).toMatchObject({ start: 0, end: 4 });
    expect(out.runs.find((r: any) => r.kind === "i")).toMatchObject({ start: 5, end: 13 });
    const c = b("say cat now", "paragraph", [bold(5, 6)]);
    const dropped = Find.replaceAll([c], "cat", "dog").get(c.id);
    expect(dropped.text).toBe("say dog now");
    expect(dropped.runs).toEqual([]);
  });

  it("a search never reaches a list marker or a pre-migration row marker; a style kind's text has none", () => {
    const item = b("1. Tare the balance", "numbered");
    expect(Find.matches([item], "1.")).toHaveLength(0);
    expect(Find.matches([item], "1. Tare")).toHaveLength(0);
    expect(Find.matches([item], "Tare")[0].start).toBe(3);
    expect(Find.replaceAll([item], "1.", "9.").size).toBe(0);
    expect(Find.replaceAll([item], "balance", "scale").get(item.id).text).toBe("1. Tare the scale");
    const row = b("| alpha\tbeta", "table");
    expect(Find.matches([row], "| ")).toHaveLength(0);
    expect(Find.matches([row], "alpha")).toHaveLength(1);
    expect(Find.matches([b("Sodium hydroxide", "dash")], "Sodium")[0].start).toBe(0);
    // A heading's text holds no marker either: a `1.` in it is prose (landmine 259).
    expect(Find.matches([b("1. Membranes", "heading2")], "1.")).toHaveLength(1);
  });

  it("a media token is never a match", () => {
    const a = b("see {{img:AA2BD11E-9FCB-4B10-B8A5-53C8382D29EF}} and img");
    const hits = Find.matches([a], "img");
    expect(hits.map((h: any) => [h.start, h.end - h.start])).toEqual([[53, 3]]);
    expect(Find.replaceAll([a], "img", "gone").get(a.id).text).toBe("see {{img:AA2BD11E-9FCB-4B10-B8A5-53C8382D29EF}} and gone");
  });
});

describe("replace over a document (CanvasDocument.replaceAll, M9)", () => {
  function tableDoc(withProse = false) {
    const S = storeStub(T0);
    const doc = S.Store.createDoc("D", null, T0);
    const first = blocksOf(S, doc)[0].id;
    if (withProse) S.Store.saveLine(first, "Column heading", T0 + 1);
    S.Store.insertTable(doc, first, { rows: 2, columns: 2 }, T0 + 2);
    return { S, doc };
  }

  it("a cell is found once, naming the ROW, and replace all writes the cells", () => {
    const { S, doc } = tableDoc();
    const blocks = blocksOf(S, doc);
    const table = blocks.find((x: any) => x.kind === "table");
    const hits = Find.matches(Find.flattened(blocks), "Column");
    expect(hits).toHaveLength(2);
    for (const hit of hits) expect(table.rows.some((r: any) => r.id === hit.block)).toBe(true);
    const report = Find.replaceInDocument(blocks, "Column", "Field");
    expect(report.replacements).toBe(2);
    expect(report.refusedInCells).toBe(0);
    expect(report.rows.get(table.rows[0].id).text).toBe("Field 1\tField 2");
    expect(Find.notice(report)).toBe("Replaced 2 matches.");
  });

  it("a replacement that would restructure a table is refused in its cells by count, and prose still takes it", () => {
    const { S, doc } = tableDoc(true);
    const blocks = blocksOf(S, doc);
    const report = Find.replaceInDocument(blocks, "Column", "a\tb");
    expect(report.replacements).toBe(1);
    expect(report.refusedInCells).toBe(2);
    expect(report.rows.size).toBe(0);
    expect([...report.lines.values()][0].text).toBe("a\tb heading");
    expect(Find.replaceInDocument(blocks, "Column", "a::b").refusedInCells).toBe(2);
    expect(Find.notice(report)).toBe("Replaced 1 match. Table cells were left alone: a replacement cannot add a column or a card.");
  });

  it("a replacement carrying a line break is refused whole", () => {
    const report = Find.replaceInDocument([b("alpha beta")], "beta", "two\nlines");
    expect(report.refusedLineBreak).toBe(true);
    expect(report.replacements).toBe(0);
    expect(report.lines.size).toBe(0);
    expect(Find.notice(report)).toBe("A replacement cannot contain a line break. Nothing was changed.");
    expect(Find.replaceInDocument([b("alpha")], "zebra", "x").replacements).toBe(0);
  });

  it("one Replace writes the match it names and no other", () => {
    const a = b("cat and cat");
    const second = Find.matches([a], "cat")[1];
    const report = Find.replaceInDocument([a], "cat", "dog", {}, second);
    expect(report.lines.get(a.id).text).toBe("cat and dog");
    expect(report.replacements).toBe(1);
  });

  it("a replaced block keeps its identity: the same note, its card and schedule", () => {
    const S = storeStub(T0);
    const doc = S.Store.createDoc("D", null, T0);
    const id = blocksOf(S, doc)[0].id;
    S.Store.saveLine(id, "hola >> mundo", T0 + 1);
    const card = S.Backend.library().cards.find((c: any) => c.note_id === id && c.deleted_at == null);
    S.Store.gradeCard(card.id, 3, T0 + 2);
    const report = Find.replaceInDocument(blocksOf(S, doc), "mundo", "world");
    const [[noteId, change]] = [...report.lines.entries()];
    expect(noteId).toBe(id);
    expect(S.Store.replaceLineText(noteId, change.text, change.runs, T0 + 3)).toBe(true);
    const after = blocksOf(S, doc);
    expect(after[0].id).toBe(id);
    expect(after[0].text).toBe("hola >> world");
    const live = S.Backend.library().cards.filter((c: any) => c.note_id === id && c.deleted_at == null);
    expect(live.map((c: any) => c.id)).toEqual([card.id]);
    expect(live[0].reps).toBe(1);
    expect(live[0].a_snapshot).toBe("world");
  });
});

describe("the clipboard's markdown and payload (ClipboardRoundTripTests)", () => {
  it("a prefix-free row copies as markdown; one that declares its kind, a numbered and a legacy table row travel as they stand", () => {
    expect(Clip.markdownLine("heading1", "Ions")).toBe("# Ions");
    expect(Clip.markdownLine("bullet", "alpha")).toBe("* alpha");
    expect(Clip.markdownLine("dash", "beta")).toBe("- beta");
    expect(Clip.markdownLine("quote", "said so")).toBe("> said so");
    expect(Clip.markdownLine("heading1", "# Ions")).toBe("# Ions");
    expect(Clip.markdownLine("bullet", "* alpha")).toBe("* alpha");
    expect(Clip.markdownLine("numbered", "1. step")).toBe("1. step");
    expect(Clip.markdownLine("table", "| a\tb")).toBe("| a\tb");
  });

  it("the payload agrees with the text, a whole line's terminator allowed", () => {
    const blocks = [b("Reagents", "heading1"), b("alpha", "bullet"), b("beta", "bullet"), b("1. first", "numbered")];
    const items = blocks.map((x) => Clip.blockOf(x));
    const text = items.map((i: any) => i.text).join("\n");
    expect(text).toBe("# Reagents\n* alpha\n* beta\n1. first");
    const back = Clip.usable(Clip.encode(items), text);
    expect(back.map((i: any) => i.kind)).toEqual(["heading1", "bullet", "bullet", "numbered"]);
    expect(back.map((i: any) => i.id)).toEqual(blocks.map((x) => x.id));
    expect(Clip.usable(Clip.encode(items.slice(0, 1)), "# Reagents\n")).not.toBeNull();
    expect(Clip.usable(Clip.encode(items.slice(0, 1)), "something else")).toBeNull();
    expect(Clip.usable("not json", "# Reagents")).toBeNull();
  });

  it("style rides the marker shift", () => {
    const item = Clip.blockOf(b("alpha", "bullet", [bold(0, 5)]));
    expect(item.text).toBe("* alpha");
    expect(Spans.decode(item.spans, "* alpha").map((r: any) => [r.start, r.end])).toEqual([[2, 7]]);
  });

  it("a copied table carries its rows and pastes as TSV", () => {
    const rows = [b("Term::Meaning", "tablerow"), b("aa::bb", "tablerow")];
    const item = Clip.blockOf(b("", "table", [], rows), { rows, cardTable: true });
    expect(item.text).toBe("Term\tMeaning\naa\tbb");
    expect(item.rows.map((r: any) => r.id)).toEqual(rows.map((r) => r.id));
    expect(Clip.carriesTable([item])).toBe(true);
    expect(Clip.decode(Clip.encode([item]))).toEqual([item]);
  });

  it("where a paste's lines land: a pure insert at a line's start goes above; anything else anchors at the caret's line", () => {
    const items = [{ id: "x", kind: "heading1" }, { id: "y", kind: "bullet" }];
    const atStart = Clip.plan({ text: "tail", start: 0, end: 0 }, "# One\n* two", items);
    expect(atStart.above).toEqual([{ text: "# One", block: items[0] }]);
    expect(atStart.line).toMatchObject({ text: "* twotail", kind: "bullet", block: items[1] });
    const mid = Clip.plan({ text: "headtail", start: 4, end: 4 }, "# One\n* two", items);
    expect(mid.line).toMatchObject({ text: "head# One", kind: "heading1" });
    expect(mid.below).toEqual([{ text: "* twotail", block: items[1] }]);
    const over = Clip.plan({ text: "a XX b", start: 2, end: 4 }, "one", [{ id: "z", kind: "paragraph" }]);
    expect(over.line.text).toBe("a one b");
  });
});

describe("cut then paste keeps ids and cards (P2d, BlockKindTests)", () => {
  function setUp() {
    const S = storeStub(T0);
    const doc = S.Store.createDoc("D", null, T0);
    const keep = blocksOf(S, doc)[0].id;
    S.Store.saveLine(keep, "keep", T0 + 1);
    const victim = S.Store.insertLine(doc, keep, "", "paragraph", T0 + 2);
    S.Store.saveLine(victim, "aa >> bb", T0 + 3);
    return { S, doc, keep, victim };
  }
  const liveCards = (S: any, id: string) => S.Backend.library().cards.filter((c: any) => c.note_id === id && c.deleted_at == null);

  it("restores the graded card (testCutThenPasteRestoresTheGradedCard)", () => {
    const { S, doc, keep, victim } = setUp();
    const card = liveCards(S, victim)[0];
    S.Store.gradeCard(card.id, 3, T0 + 4);
    const item = Clip.blockOf(blocksOf(S, doc).find((x: any) => x.id === victim));
    expect(S.Store.deleteLine(victim, T0 + 5)).toBe(true);
    expect(liveCards(S, victim), "the cut tombstones the card").toEqual([]);
    S.Store.pasteBlocks(doc, keep, "below", Clip.usable(Clip.encode([item]), item.text + "\n"), T0 + 6);
    const after = blocksOf(S, doc);
    expect(after.map((x: any) => x.text)).toEqual(["keep", "aa >> bb"]);
    expect(after[1].id, "the paste RESTORED the cut row").toBe(victim);
    const restored = liveCards(S, victim);
    expect(restored.map((c: any) => c.id)).toEqual([card.id]);
    expect(restored[0].reps, "the schedule survived the move").toBe(1);
  });

  it("revives only the card the cut killed (testCutThenPasteRevivesOnlyTheCardTheCutKilled)", () => {
    const { S, doc, keep, victim } = setUp();
    const firstCard = liveCards(S, victim)[0].id;
    S.Store.saveLine(victim, "aa bb", T0 + 4);
    expect(liveCards(S, victim), "the dissolve tombstoned it").toEqual([]);
    S.Store.saveLine(victim, "aa >> bb", T0 + 5);
    const secondCard = liveCards(S, victim)[0].id;
    expect(secondCard).not.toBe(firstCard);
    const item = Clip.blockOf(blocksOf(S, doc).find((x: any) => x.id === victim));
    S.Store.deleteLine(victim, T0 + 6);
    S.Store.pasteBlocks(doc, keep, "below", [item], T0 + 7);
    expect(liveCards(S, victim).map((c: any) => c.id)).toEqual([secondCard]);
  });

  it("revives every region card, region and picture of an occlusion note", () => {
    const { S, doc, keep } = setUp();
    const { noteId, mediaId } = S.Store.insertPicture(doc, keep, "c".repeat(64), "image/png", T0 + 4);
    for (const ordinal of [1, 2, 3]) {
      S.Backend.write("occlusion", `r${ordinal}`, { env: { note_id: noteId, media_id: mediaId, ordinal, x: 0.1 * ordinal, y: 0.1, w: 0.05, h: 0.05,
        rotation: 0, z: 0, created_at: "2026-09-29T00:00:00.000Z", deleted_at: null }, content: { label: `L${ordinal}`, points_json: null } }, { now: T0 + 5 });
      S.Backend.write("card", `c${ordinal}`, { env: { note_id: noteId, cloze_ordinal: ordinal, flag: 0, suspended: false, stability: 0, difficulty: 0,
        due: "2026-09-29T00:00:00.000Z", state: "new", last_review_at: null, introduced_on: null, reps: 0, lapses: 0, detached: false, deleted_at: null },
        content: { q_snapshot: `region ${ordinal}`, a_snapshot: "" } }, { now: T0 + 5 });
    }
    const ordinals = () => liveCards(S, noteId).map((c: any) => c.cloze_ordinal).sort();
    expect(ordinals()).toEqual([1, 2, 3]);
    const item = Clip.blockOf(blocksOf(S, doc).find((x: any) => x.id === noteId));
    S.Store.deleteLine(noteId, T0 + 6);
    expect(ordinals(), "the cut took every region card").toEqual([]);
    S.Store.pasteBlocks(doc, keep, "below", [item], T0 + 7);
    expect(ordinals(), "every region card came back").toEqual([1, 2, 3]);
    const L = S.Backend.library();
    expect(L.media.get(mediaId).deleted_at, "the picture itself").toBeNull();
    expect(L.occlusion.filter((o: any) => o.note_id === noteId && o.deleted_at == null)).toHaveLength(3);
  });

  it("a live id pastes a fresh copy, keeping the original's card (testPasteWithALiveIdCreatesAFreshNote)", () => {
    const { S, doc, victim } = setUp();
    const card = liveCards(S, victim)[0];
    S.Store.gradeCard(card.id, 3, T0 + 4);
    const item = Clip.blockOf(blocksOf(S, doc).find((x: any) => x.id === victim));
    S.Store.pasteBlocks(doc, victim, "below", [item], T0 + 5);
    const after = blocksOf(S, doc);
    expect(after.map((x: any) => x.text)).toEqual(["keep", "aa >> bb", "aa >> bb"]);
    expect(after[1].id).toBe(victim);
    expect(after[2].id, "the pasted COPY is a fresh note").not.toBe(victim);
    expect(liveCards(S, victim).map((c: any) => c.id)).toEqual([card.id]);
    const copy = liveCards(S, after[2].id);
    expect(copy).toHaveLength(1);
    expect(copy[0].reps, "a copy is a new card, not a second schedule").toBe(0);
  });

  it("a copied heading keeps its kind and its style", () => {
    const { S, doc, keep } = setUp();
    const h = S.Store.insertLine(doc, keep, "", "heading2", T0 + 4);
    S.Store.saveLine(h, "Membranes", T0 + 5, [bold(0, 4)]);
    const item = Clip.blockOf(blocksOf(S, doc).find((x: any) => x.id === h));
    expect(item.text).toBe("## Membranes");
    const [copy] = S.Store.pasteBlocks(doc, keep, "above", [item], T0 + 6);
    const block = blocksOf(S, doc).find((x: any) => x.id === copy);
    expect(block.kind).toBe("heading2");
    expect(block.text).toBe("Membranes");
    expect(block.runs.map((r: any) => [r.start, r.end, r.kind])).toEqual([[0, 4, "b"]]);
  });

  it("a cut table comes back with its own rows and their cards", () => {
    const { S, doc, keep } = setUp();
    const t = S.Store.insertTable(doc, keep, { rows: 2, columns: 2, cardTable: true }, T0 + 4);
    let table = blocksOf(S, doc).find((x: any) => x.id === t);
    S.Store.saveTableRow(table.rows[1].id, ["Carbonate", "CO3 2-"], T0 + 5);
    table = blocksOf(S, doc).find((x: any) => x.id === t);
    const rowIds = table.rows.map((r: any) => r.id);
    const rowCard = liveCards(S, rowIds[1])[0].id;
    const item = Clip.blockOf(table, { rows: table.rows, cardTable: true });
    expect(item.text).toBe("Term\tMeaning\nCarbonate\tCO3 2-");
    S.Store.deleteTable(t, T0 + 6);
    expect(blocksOf(S, doc).some((x: any) => x.id === t)).toBe(false);
    S.Store.pasteBlocks(doc, keep, "below", [item], T0 + 7);
    const back = blocksOf(S, doc).find((x: any) => x.id === t);
    expect(back.rows.map((r: any) => r.id)).toEqual(rowIds);
    expect(liveCards(S, rowIds[1]).map((c: any) => c.id)).toEqual([rowCard]);
  });

  it("a copied picture is its own copy: a fresh note and media row on the same bytes, width and crop", () => {
    const { S, doc, keep } = setUp();
    const { noteId, mediaId } = S.Store.insertPicture(doc, keep, "d".repeat(64), "image/png", T0 + 4);
    S.Store.setPictureWidth(noteId, mediaId, 300, T0 + 5);
    S.Store.setMediaCrop(mediaId, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, T0 + 6);
    const item = Clip.blockOf(blocksOf(S, doc).find((x: any) => x.id === noteId));
    const [copy] = S.Store.pasteBlocks(doc, noteId, "below", [item], T0 + 7);
    expect(copy).not.toBe(noteId);
    const L = S.Backend.library();
    const media = [...L.media.values()].filter((m: any) => m.note_id === copy);
    expect(media).toHaveLength(1);
    expect(media[0].id).not.toBe(mediaId);
    expect(media[0].bytes_sha).toBe("d".repeat(64));
    expect(media[0].display_width).toBe(300);
    expect(media[0].crop).toBe("0.1000,0.1000,0.5000,0.5000");
    expect(L.media.get(mediaId).note_id, "the original keeps its row").toBe(noteId);
  });
});
