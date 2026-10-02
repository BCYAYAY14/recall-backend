// Import, export and the word count on the web (assets/js/io.js and
// words.js) against Recall's CSVImporterTests, NoteFileReaderTests,
// CanvasWordCountTests and the JSON export's shape (`Snapshots.exportJSON`),
// so a file moves between the web and the app unchanged (PLAN-BETA-0.12
// section 26, W-7 and W-8).

import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { IO, Words } = loadAssets<{ IO: any; Words: any }>(["wire.js", "spans.js", "gate.js", "model.js", "io.js", "words.js"], ["IO", "Words"]);

describe("CSV in and out, as CSVImporter and Snapshots.exportCSV", () => {
  it("sniffs the delimiter", () => {
    expect(IO.sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(IO.sniffDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(IO.sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  it("reads quoted commas and escaped quotes, and round trips its own escaping", () => {
    const rows = IO.parseCSV("\"hello, world\",\"say \"\"hi\"\"\"\nplain,x");
    expect(rows).toEqual([["hello, world", "say \"hi\""], ["plain", "x"]]);
    expect(IO.csvEscape("plain")).toBe("plain");
    expect(IO.csvEscape("a,b")).toBe("\"a,b\"");
    expect(IO.csvEscape("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
    expect(IO.csvEscape("line\nbreak")).toBe("\"line\nbreak\"");
    const fields = ["Q, with comma", "A: \"quoted\"", "", "t1 t2", "⚛️ Physics"];
    expect(IO.parseCSV(fields.map(IO.csvEscape).join(","))[0]).toEqual(fields);
  });

  it("handles CRLF, a BOM, and trims only unquoted cells", () => {
    expect(IO.parseCSV("a,b\r\nc,d\r\n")).toEqual([["a", "b"], ["c", "d"]]);
    expect(IO.parseCSV("﻿front,back\nx,y")[0]).toEqual(["front", "back"]);
    expect(IO.parseCSV("\"  padded  \",b\nplain,  trimmed  ")).toEqual([["  padded  ", "b"], ["plain", "trimmed"]]);
  });

  it("maps columns, skips an empty front, and skips duplicates in the doc and in the file", () => {
    const rows = IO.parseCSV("front,back\nhola,hello\n,orphan\nadios,goodbye\nHola,hi again");
    const { entries, invalid } = IO.csvEntries(rows, { skipHeader: true, front: 0, back: 1 });
    expect(invalid).toBe(1);
    expect(entries.length).toBe(3);
    const { unique, duplicates } = IO.withoutDuplicates(entries, ["adios"]);
    expect(unique.map((e: any) => e.front)).toEqual(["hola"]);
    expect(duplicates.length).toBe(2);
    expect(IO.entryLine({ front: "hola", back: "hello" })).toBe("hola >> hello");
    // D-191: a trigger inside a cell is flattened (`importSide`), so a cell
    // cannot split the line or make a concept.
    expect(IO.entryLine({ front: "std::move", back: "a >> b" })).toBe("std:move >> a \u00BB b");
    expect(IO.entryLine({ front: "just a note", back: "" })).toBe("just a note");
  });

  it("exports front, back, cloze, tags, deck with the kind's marker, a BOM and CRLF", () => {
    const L = {
      docs: new Map([["d1", { id: "d1", name: "Spanish", deleted_at: null }], ["d0", { id: "d0", name: "Gone", deleted_at: "2026-09-01T00:00:00.000Z" }]]),
      notes: new Map([
        ["a", { id: "a", notebook_id: "d1", parent_id: null, position: 0, kind: "heading1", front: "Verbs", back: null, cloze_text: null, tags: "", created_at: "x", deleted_at: null }],
        ["b", { id: "b", notebook_id: "d1", parent_id: null, position: 1, kind: "paragraph", front: "hablar", back: "to speak, talk", cloze_text: null, tags: "imported", created_at: "x", deleted_at: null }],
        ["c", { id: "c", notebook_id: "d0", parent_id: null, position: 0, kind: "paragraph", front: "x", back: null, cloze_text: null, tags: "", created_at: "x", deleted_at: null }],
      ]),
    };
    expect(IO.exportCSV(L)).toBe("﻿front,back,cloze,tags,deck\r\n# Verbs,,,,Spanish\r\nhablar,\"to speak, talk\",,imported,Spanish\r\n");
  });
});

describe("Markdown and text in, as NoteFileReader", () => {
  it("keeps a Markdown file's lines in the doc's own markers", () => {
    const text = ["---", "title: Notes", "---", "#### Deep heading ##", "# Top", "+ plus item", "* star item", "- dash item",
      "- [x] done task", "2) second", "Read [the paper](https://example.com) and ![fig](fig.png) **now**", "2 * 3 * 4", "***",
      "```", "code :: kept", "```"].join("\n");
    expect(IO.markdownLines(text)).toEqual(["### Deep heading", "# Top", "* plus item", "* star item", "- dash item",
      "- done task", "2. second", "Read the paper and now", "2 * 3 * 4", "code :: kept"]);
  });

  it("joins only what plain text hard wrapped", () => {
    const text = ["Cells", "Mitochondria are the part of the cell that makes most of the energy", "it uses.",
      "hablar :: to speak", "• a bullet", "", "Short line", "next line"].join("\n");
    expect(IO.textLines(text)).toEqual(["Cells", "Mitochondria are the part of the cell that makes most of the energy it uses.",
      "hablar :: to speak", "* a bullet", "Short line", "next line"]);
    expect(IO.textLines("Line one\r\nLine two")).toEqual(["Line one", "Line two"]);
  });

  it("names the doc from the file and reads a BOM as nothing", () => {
    expect(IO.docName("Physics notes.md")).toBe("Physics notes");
    expect(IO.docName(".md")).toBe("Notes");
    expect(IO.decodeText(new Uint8Array([0xEF, 0xBB, 0xBF, 0x23, 0x20, 0x54]))).toBe("# T");
    expect(IO.decodeText(new Uint8Array([0xE9]))).toBe("é");
  });
});

describe("the snapshot is the app's JSON export", () => {
  it("writes Swift's shapes: dates as seconds since 2001, ids upper case, nil left out, live rows only", () => {
    const bundle = IO.exportBundle({
      notebook: [{ id: "10000000-0000-4000-8000-00000000000a", folder_id: null, name: "Bio", emoji: "x", position: 0, created_at: "2001-01-01T00:00:10.000Z",
                   updated_at: "2026-09-23T00:00:00.000Z", deleted_at: null, exam_at: null, style: null, retention_pct: null, new_per_day: null }],
      note: [{ id: "20000000-0000-4000-8000-00000000000b", notebook_id: "10000000-0000-4000-8000-00000000000a", parent_id: null, position: 0,
               front: "a", back: "b", cloze_text: null, tags: "", unreviewed: false, occ_mode: null, typed_answer: false, spans: null, kind: "paragraph",
               attrs: null, created_at: "2001-01-01T00:00:00.000Z", updated_at: "2001-01-01T00:00:01.500Z", deleted_at: null },
             { id: "30000000-0000-4000-8000-00000000000c", notebook_id: "x", deleted_at: "2026-09-01T00:00:00.000Z" }],
      grade_event: [{ id: "40000000-0000-4000-8000-00000000000d", card_id: "50000000-0000-4000-8000-00000000000e", rating: 3,
                      reviewed_at: "2001-01-02T00:00:00.000Z", device_id: "web-device" }],
    }, { retention_pct: "90" }, [{ relPath: "abc.png", dataBase64: "AA==" }]);
    expect(Object.keys(bundle)).toEqual(["folders", "notebooks", "notes", "cards", "events", "media", "mediaFiles", "occlusions", "settings", "dictionary", "fonts"]);
    expect(bundle.notebooks[0]).toEqual({ id: "10000000-0000-4000-8000-00000000000A", name: "Bio", emoji: "x", position: 0, created_at: 10, updated_at: bundle.notebooks[0].updated_at });
    expect(bundle.notes.length).toBe(1);
    expect(bundle.notes[0].notebook_id).toBe("10000000-0000-4000-8000-00000000000A");
    expect(bundle.notes[0].updated_at).toBe(1.5);
    expect("parent_id" in bundle.notes[0]).toBe(false);
    expect(bundle.events[0]).toEqual({ id: "40000000-0000-4000-8000-00000000000D", card_id: "50000000-0000-4000-8000-00000000000E", rating: 3, reviewed_at: 86400, device_id: "web-device" });
    expect(bundle.mediaFiles).toEqual([{ relPath: "abc.png", dataBase64: "AA==" }]);
    expect(bundle.settings).toEqual({ retention_pct: "90" });
    expect(IO.base64(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(IO.swiftRow("card", { id: "a", due: "2026-09-23T01:02:03.374Z" }).due).toBe(811818123.374);
  });
});

describe("the word count, as CanvasWordCount", () => {
  const para = (text: string, extra: any = {}) => ({ kind: "paragraph", text, front: text, rows: [], attrs: {}, ...extra });

  it("counts runs of non whitespace, characters with and without spaces", () => {
    expect(Words.count([para("the quick  brown\tfox")]).words).toBe(4);
    const c = Words.count([para("ab cd")]);
    expect([c.characters, c.charactersNoSpaces]).toEqual([5, 4]);
  });

  it("a table per cell, a picture nothing, a diagram its prompt, a card both sides", () => {
    const table = { kind: "table", text: "", rows: [{ text: "alpha\tbeta", front: "alpha\tbeta" }, { text: "gamma\t", front: "gamma\t" }], attrs: { cardTable: false } };
    expect(Words.count([table]).words).toBe(3);
    expect(Words.count([{ kind: "image", text: "", rows: [], attrs: {} }]).characters).toBe(0);
    expect(Words.count([para("Name the parts", { hasDiagram: true })]).words).toBe(3);
    expect(Words.count([para("capital of France :: Paris")]).words).toBe(4);
    expect(Words.count([para("the identity $x^2 + y^2$ holds")]).words).toBe(6);
    expect(Words.count([para("the identity {{img:50B690BD-0A45-444A-A85A-8979EE9D4EEC}} holds")]).words).toBe(3);
  });

  it("matches the hand count of a whole document", () => {
    const blocks = [
      { kind: "heading1", text: "Photosynthesis", rows: [], attrs: {} },
      para("light energy :: chemical energy", { hasCard: true }),
      { kind: "table", text: "", attrs: { cardTable: false }, rows: [{ text: "stage\twhere" }, { text: "light dependent\tthylakoid" }] },
      para("the rate is $k times I$"),
      para("the rate is {{img:50B690BD-0A45-444A-A85A-8979EE9D4EEC}}"),
    ];
    const c = Words.count(blocks);
    expect([c.words, c.characters, c.blocks, c.cards]).toEqual([19, 110, 5, 1]);
  });

  it("reads a duration as a person does, and walks the statistics", () => {
    expect(Words.duration(0)).toBe("0 min");
    expect(Words.duration(30)).toBe("under a minute");
    expect(Words.duration(250)).toBe("4 min");
    expect(Words.duration(3900)).toBe("1 h 5 min");
    expect(Words.readout("readingTime", { words: 200 })).toBe("1 min to read");
    expect(Words.next("speakingTime")).toBe("words");
    expect(Words.valid("nonsense")).toBe("words");
  });
});
