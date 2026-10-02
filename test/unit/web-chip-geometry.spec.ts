// The trigger chip on the web against the app (owner, 2026-09-29: "make web
// site icons match as well"): every arrow's strokes and the chip's box are
// read out of Recall's own Sources/Core/TriggerChipGeometry.swift and compared
// with render.js's numbers, so the two cannot drift; which arrow a line draws
// (`CardChipGlyph.glyph(for:asks:hasAnswerLines:)`); and the three typing
// rules of the same day, held to FlashcardModelTests' own cases
// (`triggerAwaitingSpace`, `rechippingOnSpace`, `backspaceInEscapedTrigger`).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const assets = path.join(import.meta.dirname, "..", "..", "assets");
const swiftFile = path.join(process.env.HOME || "", "Recall", "Sources", "Core", "TriggerChipGeometry.swift");
const { Render, CardLine } = loadAssets<{ Render: any; CardLine: any }>(
  ["gate.js", "spans.js", "render.js", "cardline.js"], ["Render", "CardLine"]);

type Pt = [number, number];
interface Icon { width: number; height: number; strokes: Pt[][]; dash: number[] }

// `TriggerChipGeometry`, parsed: the box constants and each case's `Icon(...)`.
function swiftGeometry(src: string) {
  const constant = (name: string) => {
    const m = new RegExp(`static let ${name}: Double = ([0-9.]+)`).exec(src);
    if (!m) throw new Error(`no ${name} in TriggerChipGeometry.swift`);
    return Number(m[1]);
  };
  const box = {
    height: constant("height"), minWidth: constant("minWidth"), padding: constant("padding"),
    margin: constant("margin"), radius: constant("radius"), strokeWidth: constant("strokeWidth"),
    offOpacity: constant("offOpacity"),
  };
  const icons: Record<string, Icon> = {};
  for (const m of src.matchAll(/case \.(\w+):[\s\S]*?return Icon\(width: ([0-9.]+), height: ([0-9.]+),\s*strokes: \[([\s\S]*?)\],\s*dash: \[([^\]]*)\]\)/g)) {
    const strokes = [...m[4]!.matchAll(/\[((?:\s*Point\([^)]*\),?)+)\s*\]/g)].map(s =>
      [...s[1]!.matchAll(/Point\(([0-9.]+), ([0-9.]+)\)/g)].map(p => [Number(p[1]), Number(p[2])] as Pt));
    icons[m[1]!] = { width: Number(m[2]), height: Number(m[3]), strokes,
                     dash: m[5]!.trim() ? m[5]!.split(",").map(Number) : [] };
  }
  const dashed = /case \.descriptor:[\s\S]*?var dashed = icon\(\.(\w+)\)[\s\S]*?dashed\.dash = \[([^\]]*)\]/.exec(src);
  if (dashed) icons.descriptor = { ...icons[dashed[1]!]!, dash: dashed[2]!.split(",").map(Number) };
  return { box, icons };
}

describe("the chip's geometry is TriggerChipGeometry's", () => {
  it.skipIf(!existsSync(swiftFile))("every arrow's strokes, size and dash, and the box, number for number", () => {
    const swift = swiftGeometry(readFileSync(swiftFile, "utf8"));
    expect(Object.keys(swift.icons).sort()).toEqual(["both", "descriptor", "forward", "list", "reverse"]);
    for (const [name, icon] of Object.entries(swift.icons)) {
      expect(Render.CHIP_ICONS[name], name).toEqual(icon);
    }
    expect(Render.CHIP).toEqual(swift.box);
  });

  it("draws the list arrow as one elbow and its head (owner, 2026-09-29)", () => {
    expect(Render.chipPath("list")).toBe("M1.5 3L9.5 3L11.5 5L11.5 10.5M8.5 7.5L11.5 10.5L14.5 7.5");
    expect(Render.chipPath("forward")).toBe("M1 5L13 5M9 1L13 5L9 9");
    expect(["forward", "reverse", "both", "list", "descriptor"].map(n => Render.chipWidth(n))).toEqual([26, 26, 26, 26, 26]); // ONE BOX, 26 by 20 for every arrow (app, 2026-10-01)
    // The editor's mask is built from the same strokes, dashed where the arrow is.
    const mask = decodeURIComponent(Render.chipMask("descriptor"));
    expect(mask).toContain("d='M1 5L13 5M9 1L13 5L9 9'");
    expect(mask).toContain("stroke-dasharray='2.2 2'");
    expect(mask).toContain("stroke-width='1.6'");
  });

  it("the stylesheet holds no second copy of an arrow, and its box is the app's", () => {
    const css = readFileSync(path.join(assets, "styles.css"), "utf8");
    expect(css).not.toMatch(/\[data-icon=/);
    expect(css).not.toMatch(/viewBox='0 0 1[68] 1[02]'/);
    const trig = /\.trig \{([^}]*)\}/.exec(css)![1]!;
    const { height, minWidth, padding, margin, radius, offOpacity } = Render.CHIP;
    expect(trig).toContain(`height: ${height}px`);
    expect(trig).toContain(`min-width: ${minWidth}px`);
    expect(trig).toContain(`padding: 0 ${padding}px`);
    expect(trig).toContain(`margin: 0 ${margin}px`);
    expect(trig).toContain(`border-radius: ${radius}px`);
    const edit = /\.edit-line \.trig-text \{([^}]*)\}/.exec(css)![1]!;
    expect(edit).toContain(`height: ${height}px`);
    expect(edit).toContain(`min-width: var(--chip-w, ${minWidth}px)`);
    expect(edit).toContain(`padding: 0 ${padding}px`);
    expect(edit).toContain(`border-radius: ${radius}px`);
    expect(css).toContain(`.trig.off, .trig-text.off { opacity: ${String(offOpacity).replace(/^0/, "")}; }`);
  });

  it("key hints are in the system font, as the app's", () => {
    const css = readFileSync(path.join(assets, "styles.css"), "utf8");
    for (const rule of [/^\.keycap \{([^}]*)\}/m, /^\.pop-key \{([^}]*)\}/m]) {
      const body = rule.exec(css)![1]!;
      expect(body).toContain("var(--font)");
      expect(body).not.toContain("--mono");
    }
  });
});

describe("which arrow a line draws (CardChipGlyph.glyph)", () => {
  it("a trigger that ends its line keeps its own arrow until answer lines sit under it", () => {
    expect(Render.chipGlyph("<>", true, "b")).toBe("both");
    expect(Render.chipGlyph(">>", true, "f")).toBe("forward");
    expect(Render.chipGlyph("<<", true, "r")).toBe("reverse");
    expect(Render.chipGlyph(";;", true, "f")).toBe("descriptor");
    expect(Render.chipGlyph("::", true, "b")).toBe("both");
    for (const sep of ["<>", ">>", "<<", ";;", "::"]) expect(Render.chipGlyph(sep, true, "f", true)).toBe("list");
    expect(Render.chipGlyph(">>>", true, "f")).toBe("list");
    expect(Render.chipGlyph(">>>", false, "f")).toBe("list");
    // A one-line card never draws the list arrow, whatever sits under it.
    expect(Render.chipGlyph(">>", false, "f", true)).toBe("forward");
  });
});

describe("the space after a trigger (FlashcardModelTests, 2026-09-29)", () => {
  it("a trigger at the caret waits for its space (testATriggerAtTheCaretWaitsForItsSpace)", () => {
    expect(CardLine.triggerAwaitingSpace("Q >>", 4)).not.toBeNull();
    expect(CardLine.triggerAwaitingSpace("Q >>>", 5)).not.toBeNull();
    expect(CardLine.triggerAwaitingSpace("Q >>-", 5)).not.toBeNull();
    expect(CardLine.triggerAwaitingSpace("Q >> ", 4), "a space after it: the chip").toBeNull();
    expect(CardLine.triggerAwaitingSpace("Q >> A", 6), "the caret is past it").toBeNull();
    expect(CardLine.triggerAwaitingSpace("Q \\>>", 5), "an escaped trigger is text already").toBeNull();
  });

  it("a space after an escaped trigger makes it a chip again (testASpaceAfterAnEscapedTriggerMakesItAChipAgain)", () => {
    const out = CardLine.rechippingOnSpace("Km \\>> the rest", 7, "paragraph");
    expect(out.text).toBe("Km >> the rest");
    expect(out.caret).toBe(6);
    // Code lines are gone (owner 2026-09-29): no kind keeps an escaped trigger from its chip.
    expect(CardLine.rechippingOnSpace("x \\>> y", 6, "paragraph").text).toBe("x >> y");
    // The space the chip kept is still there: the typed one is absorbed.
    const kept = CardLine.rechippingOnSpace("Km \\>>  the", 7, "paragraph");
    expect(kept.text).toBe("Km >> the");
    expect(kept.caret).toBe(6);
    expect(CardLine.rechippingOnSpace("Km >> the", 6, "paragraph"), "no escape, nothing to do").toBeNull();
  });

  it("Backspace inside an escaped trigger takes its backslash when nothing is left to escape", () => {
    // `Km \>>`: the second `>` goes and the backslash with it.
    expect(CardLine.backspaceInEscapedTrigger("Km \\>> A", 6)).toEqual([{ start: 5, length: 1 }, { start: 3, length: 1 }]);
    // `\>>>` still escapes `>>` once a `>` goes.
    expect(CardLine.backspaceInEscapedTrigger("Q \\>>> A", 6)).toEqual([{ start: 5, length: 1 }]);
    expect(CardLine.backspaceInEscapedTrigger("Q >> A", 4)).toBeNull();
  });
});
