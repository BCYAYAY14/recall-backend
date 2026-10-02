// The canvas's geometry on the web (assets/js/geometry.js, store.js,
// render.js) against the app: a table's column widths (`TableBlock.fit`,
// `hasStoredWidths`, the 44pt floor, the drag's one column, the 7pt edge,
// Fit to Page, a column's width added and removed with it) and its own text
// size (`ts`); a picture's resize (`CanvasImageResize`: 96pt to the
// measure, any corner, anchored) and crop (`MediaCrop` and
// PictureEditTests, `CanvasImageCrop.adjusted`, `CropCopy` and C-26's
// refusal, stored "x,y,w,h" on the media row); and A4 pages
// (CanvasPageLayoutTests), drawn over a laid-out canvas.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FNode, installFakeDom } from "../support/fake-dom.ts";
import { loadAssets } from "../support/web-assets.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = path.join(import.meta.dirname, "..", "..", "assets", "js");
const T0 = Date.parse("2026-09-29T00:00:00.000Z");
const { Geometry } = loadAssets<{ Geometry: any }>(["geometry.js"], ["Geometry"]);
const close = (a: number, b: number, d = 0.0001) => expect(Math.abs(a - b)).toBeLessThanOrEqual(d);

function stubbed() {
  const prelude = `
    const rowsMap = new Map();
    const Backend = {
      rowsMap, writes: [],
      library() {
        const notes = new Map(), docs = new Map(), folders = new Map(), media = new Map();
        const cards = [], occlusion = [], events = [];
        for (const [k, r] of rowsMap) {
          const lane = k.split("|")[0];
          if (lane === "note") notes.set(r.id, r);
          else if (lane === "notebook") docs.set(r.id, r);
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
        next.deleted_at = opts.tombstone ? "2026-09-29T00:00:01.000Z" : next.deleted_at ?? null;
        rowsMap.set(k, next);
        this.writes.push({ lane, id, patch });
        return next;
      },
      contentBefore() { return null; },
      deviceId() { return "dev"; },
    };`;
  const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "cardline.js", "spans.js", "model.js", "geometry.js", "clip.js", "sched.js", "store.js"]
    .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${prelude}\n${src}\nreturn { Backend, Store, Model };`)() as any;
}

describe("a table's column widths (TableBlock, CanvasTableLayout)", () => {
  it("stored widths count only while they describe the table", () => {
    expect(Geometry.hasStoredWidths([120, 200], 2)).toBe(true);
    expect(Geometry.hasStoredWidths([120, 200], 3), "a column was added since").toBe(false);
    expect(Geometry.hasStoredWidths([120, 0], 2)).toBe(false);
    expect(Geometry.hasStoredWidths([], 1)).toBe(false);
  });

  it("fit keeps widths that fit, and scales a wider table above the 44pt floor", () => {
    expect(Geometry.fit([100, 200], 624)).toEqual([100, 200]);
    const f = Geometry.fit([300, 500, 100], 600);
    close(f.reduce((a: number, b: number) => a + b, 0), 600);
    // (available - floors) / (total - floors) = (600 - 132) / (900 - 132)
    const k = (600 - 132) / (900 - 132);
    close(f[0], 44 + 256 * k);
    close(f[2], 44 + 56 * k);
    // No room even for the floors: equal shares.
    expect(Geometry.fit([300, 300, 300], 90)).toEqual([30, 30, 30]);
  });

  it("a drag moves the column left of the edge alone, never under 44pt; edges are caught within 7pt", () => {
    expect(Geometry.resizeColumn([120, 200, 100], 1, 40)).toEqual([120, 240, 100]);
    expect(Geometry.resizeColumn([120, 200], 0, -500)).toEqual([44, 200]);
    expect(Geometry.edgeAt(126, [120, 200])).toBe(0);
    expect(Geometry.edgeAt(313, [120, 200]), "the table's right edge is an edge too").toBe(1);
    expect(Geometry.edgeAt(200, [120, 200])).toBe(-1);
    expect(Geometry.edgeAt(120, [120]), "one column has no edge to drag").toBe(-1);
  });

  it("the store writes the widths once, Fit to Page forgets them, and a column carries its width", () => {
    const S = stubbed();
    const doc = S.Store.createDoc("D", null, T0);
    const t = S.Store.insertTable(doc, null, { rows: 2, columns: 2 }, T0);
    expect(S.Store.setTableWidths(t, [150.123, 220], T0 + 1)).toBe(true);
    expect(S.Backend.get("note", t).attrs).toBe('{"v":1,"w":[150.12,220]}');
    expect(S.Store.setTableWidths(t, [150.12, 220], T0 + 2), "unchanged: no write").toBe(false);
    expect(S.Model.decodeAttrs(S.Backend.get("note", t).attrs).widths).toEqual([150.12, 220]);
    S.Store.addTableColumn(t, T0 + 3);
    expect(S.Model.decodeAttrs(S.Backend.get("note", t).attrs).widths, "the new column at 110pt").toEqual([150.12, 220, 110]);
    S.Store.deleteTableColumn(t, 0, T0 + 4);
    expect(S.Model.decodeAttrs(S.Backend.get("note", t).attrs).widths).toEqual([220, 110]);
    expect(S.Store.setTableWidths(t, [], T0 + 5)).toBe(true);
    expect(S.Backend.get("note", t).attrs, "content sized again").toBeNull();
  });

  it("a table's text size is its own (`ts`), the document's when cleared", () => {
    const S = stubbed();
    const doc = S.Store.createDoc("D", null, T0);
    const t = S.Store.insertTable(doc, null, { rows: 2, columns: 2, cardTable: true }, T0);
    expect(S.Store.setTableFontSize(t, 14, T0 + 1)).toBe(true);
    expect(S.Backend.get("note", t).attrs).toBe('{"card":true,"ts":14,"v":1}');
    expect(S.Model.decodeAttrs(S.Backend.get("note", t).attrs).tableFontSize).toBe(14);
    expect(S.Store.setTableFontSize(t, 14, T0 + 2)).toBe(false);
    S.Store.setTableFontSize(t, null, T0 + 3);
    expect(S.Backend.get("note", t).attrs).toBe('{"card":true,"v":1}');
  });
});

describe("a picture's resize (CanvasImageResize)", () => {
  it("clamps between 96pt and the measure, from any corner, anchored where the column puts it", () => {
    expect(Geometry.clampWidth(40, 624)).toBe(96);
    expect(Geometry.clampWidth(900, 624)).toBe(624);
    expect(Geometry.clampWidth(300, 624)).toBe(300);
    expect(Geometry.resizedWidth(300, 40, "bottomRight")).toBe(340);
    expect(Geometry.resizedWidth(300, -40, "topLeft"), "a left corner dragged outward widens it").toBe(340);
    const rect = { x: 0, y: 0, w: 300, h: 200 };
    expect(Geometry.resizeCorner({ x: 295, y: 195 }, rect)).toBe("bottomRight");
    expect(Geometry.resizeCorner({ x: -4, y: 3 }, rect), "within the slop").toBe("topLeft");
    expect(Geometry.resizeCorner({ x: 150, y: 100 }, rect)).toBeNull();
  });

  it("the store writes the width on the media row only (`setMediaDisplayWidth`)", () => {
    const S = stubbed();
    const doc = S.Store.createDoc("D", null, T0);
    const { noteId, mediaId } = S.Store.insertPicture(doc, null, "a".repeat(64), "image/png", T0);
    const before = S.Backend.get("note", noteId).attrs;
    expect(S.Store.setPictureWidth(noteId, mediaId, 333.4, T0 + 1)).toBe(true);
    expect(S.Backend.get("media", mediaId).display_width).toBe(333);
    expect(S.Backend.get("note", noteId).attrs, "`mw` is read by nothing and not written").toBe(before);
    expect(S.Store.setPictureWidth(noteId, mediaId, 333, T0 + 2)).toBe(false);
  });
});

describe("a picture's crop (MediaCrop, PictureEditTests)", () => {
  it("parse rejects malformed and whole values (testCropParseRejectsMalformedAndWholeValues)", () => {
    expect(Geometry.parseCrop(null)).toBeNull();
    expect(Geometry.parseCrop("")).toBeNull();
    expect(Geometry.parseCrop("0.1,0.2"), "three numbers short of a crop").toBeNull();
    expect(Geometry.parseCrop("a,b,c,d")).toBeNull();
    expect(Geometry.parseCrop("0,0,1,1"), "the whole picture reads as no crop").toBeNull();
    expect(Geometry.parseCrop("0.25,0.25,0.5,0.5")).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(Geometry.parseCrop("[0.1,0.1,0.5,0.5]"), "JSON is not the stored form").toBeNull();
  });

  it("the text round trips to four places and a crop clamps into the picture, never collapsing", () => {
    const crop = { x: 0.125, y: 0.25, w: 0.5, h: 0.375 };
    expect(Geometry.cropText(crop)).toBe("0.1250,0.2500,0.5000,0.3750");
    expect(Geometry.parseCrop(Geometry.cropText(crop))).toEqual(crop);
    const out = Geometry.clampCrop({ x: -0.5, y: 0.9, w: 5, h: 0.0001 });
    close(out.x, 0);
    expect(out.x + out.w).toBeLessThanOrEqual(1.0001);
    expect(out.h).toBeGreaterThanOrEqual(Geometry.CROP_MIN_SIDE);
  });

  it("regions are re-expressed against the crop (landmine 103), and place and unplace are inverses", () => {
    const crop = { x: 0.5, y: 0, w: 0.5, h: 1 };
    const placed = Geometry.place({ x: 0.75, y: 0.25, w: 0.25, h: 0.5 }, crop);
    close(placed.x, 0.5); close(placed.w, 0.5); close(placed.y, 0.25); close(placed.h, 0.5);
    const c2 = { x: 0.2, y: 0.1, w: 0.6, h: 0.7 };
    const back = Geometry.unplace(Geometry.place({ x: 0.35, y: 0.4, w: 0.2, h: 0.15 }, c2), c2);
    close(back.x, 0.35); close(back.y, 0.4); close(back.w, 0.2); close(back.h, 0.15);
    const whole = Geometry.place({ x: 0.3, y: 0.4, w: 0.1, h: 0.2 }, Geometry.WHOLE);
    close(whole.x, 0.3); close(whole.w, 0.1);
  });

  it("a corner drags the crop, flipping past its opposite; the nearest corner wins", () => {
    const pic = { x: 0, y: 0, w: 400, h: 200 };
    const moved = Geometry.adjustCrop(Geometry.WHOLE, "bottomRight", { x: 200, y: 100 }, pic);
    expect(moved).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    const flipped = Geometry.adjustCrop({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, "topLeft", { x: 380, y: 190 }, pic);
    close(flipped.x, 0.75); close(flipped.w, 0.2); close(flipped.y, 0.75); close(flipped.h, 0.2);
    const tiny = Geometry.adjustCrop(Geometry.WHOLE, "bottomRight", { x: 1, y: 1 }, pic);
    expect(tiny.w).toBe(Geometry.CROP_MIN_SIDE);
    const r = Geometry.cropRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, pic);
    expect(r).toEqual({ x: 100, y: 50, w: 200, h: 100 });
    expect(Geometry.cropCorner({ x: 105, y: 52 }, r)).toBe("topLeft");
    expect(Geometry.cropCorner({ x: 200, y: 100 }, r)).toBeNull();
  });

  it("a crop that would hide a mask is refused by ordinal (CropCopy, C-26); a whole crop is stored as none", () => {
    expect(Geometry.wouldHide([2])).toBe("That crop would hide masked region 2, so it was not applied.");
    expect(Geometry.wouldHide([3, 2])).toBe("That crop would hide masked regions 2 and 3, so it was not applied.");
    expect(Geometry.wouldHide([4, 2, 3])).toBe("That crop would hide masked regions 2, 3 and 4, so it was not applied.");
    expect(Geometry.keepsWhole({ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBe(true);
    expect(Geometry.keepsWhole({ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.4, y: 0.1, w: 0.2, h: 0.2 }), "clipped").toBe(false);

    const S = stubbed();
    const doc = S.Store.createDoc("D", null, T0);
    const { noteId, mediaId } = S.Store.insertPicture(doc, null, "b".repeat(64), "image/png", T0);
    S.Backend.write("occlusion", "r1", { env: { note_id: noteId, ordinal: 2, x: 0.6, y: 0.1, w: 0.2, h: 0.2, media_id: mediaId,
                                                rotation: 0, z: 0, created_at: "x", deleted_at: null }, content: { label: "Nucleus", points_json: null } });
    const notice = S.Store.commitCrop(mediaId, { x: 0, y: 0, w: 0.5, h: 1 }, T0 + 1);
    expect(notice).toBe("That crop would hide masked region 2, so it was not applied.");
    expect(notice).not.toContain("Nucleus");
    expect(S.Backend.get("media", mediaId).crop ?? null, "nothing written").toBeNull();
    expect(S.Store.commitCrop(mediaId, { x: 0.5, y: 0, w: 0.5, h: 1 }, T0 + 2)).toBeNull();
    expect(S.Backend.get("media", mediaId).crop).toBe("0.5000,0.0000,0.5000,1.0000");
    expect(S.Store.setMediaCrop(mediaId, null, T0 + 3), "Show whole picture").toBe(true);
    expect(S.Backend.get("media", mediaId).crop).toBeNull();
    S.Store.setMediaCrop(mediaId, Geometry.WHOLE, T0 + 4);
    expect(S.Backend.get("media", mediaId).crop, "a whole crop is no crop").toBeNull();
  });
});

describe("A4 pages (CanvasPageLayoutTests)", () => {
  const page = { contentHeight: 100, gap: 20 };

  it("a page holds its content and then a gutter", () => {
    expect(Geometry.pageTop(page, 0)).toBe(0);
    expect(Geometry.pageBottom(page, 0)).toBe(100);
    expect(Geometry.pageTop(page, 1)).toBe(120);
  });

  it("a fragment that fits stays; one that would straddle, or starts in the gutter, goes to the next page; one taller than a page stays", () => {
    expect(Geometry.push(page, 0, 20)).toBeNull();
    expect(Geometry.push(page, 80, 20)).toBeNull();
    expect(Geometry.push(page, 90, 20)).toBe(120);
    expect(Geometry.push(page, 105, 20)).toBe(120);
    expect(Geometry.push(page, 10, 400)).toBeNull();
  });

  it("the gutters inside a band, and a scrolled band's own", () => {
    expect(Geometry.gutters(page, 0, 300)).toEqual([100, 220]);
    expect(Geometry.gutters(page, 500, 200)).toEqual([580, 700]);
  });

  it("A4 at the frozen 680pt measure is 1024pt of canvas and a 28pt gutter", () => {
    const a4 = Geometry.a4();
    expect(a4.contentHeight).toBe(1024);
    expect(a4.gap).toBe(28);
    close(a4.contentHeight / 680, 733.89 / 487.28, 0.01);
  });

  it("the canvas moves a straddling block to the next page and draws each page's foot", () => {
    installFakeDom();
    // A canvas that lays its children out top to bottom whenever one is
    // measured (a page gap is its own height, a rule takes none).
    const heights = new Map<FNode, number>();
    const canvas = new FNode("div");
    const heightOf = (c: FNode) => (c.classList.contains("page-gap") ? parseFloat(c.style.height ?? "") || 0
      : c.classList.contains("page-rule") ? 0 : heights.get(c) ?? 0);
    const topOf = (c: FNode) => {
      let y = 0;
      for (const k of canvas.children) { if (k === c) return y; y += heightOf(k); }
      return y;
    };
    const measured = (c: FNode) => Object.assign(c, { getBoundingClientRect: () => ({ top: topOf(c), height: heightOf(c) }) });
    (canvas as any).getBoundingClientRect = () => ({ top: 0, height: canvas.children.reduce((a, c) => a + heightOf(c), 0) });
    (canvas as any).insertBefore = (c: FNode, ref: FNode) => {
      c.parent = canvas;
      canvas.children.splice(canvas.children.indexOf(ref), 0, measured(c));
      return c;
    };
    (canvas as any).querySelectorAll = () => canvas.children.filter((c) => c.classList.contains("page-gap") || c.classList.contains("page-rule"));
    for (let i = 0; i < 30; i++) { const b = measured(new FNode("div")); heights.set(b, i === 12 ? 60 : 40); canvas.appendChild(b); }
    const { Render } = loadAssets<{ Render: any }>(["gate.js", "spans.js", "model.js", "geometry.js", "render.js"], ["Render"]);
    Render.paginate(canvas, true);
    // Blocks of 40 fill 1000 at the 25th; the 26th would end at 1060 > 1024
    // (the 60pt block sits at 12), so it starts page two at 1052.
    const gaps = canvas.children.filter((c) => c.classList.contains("page-gap"));
    expect(gaps).toHaveLength(1);
    const pushed = canvas.children[canvas.children.indexOf(gaps[0]!) + 1] as any;
    expect(pushed.getBoundingClientRect().top).toBe(1052);
    const rules = canvas.children.filter((c) => c.classList.contains("page-rule"));
    expect(rules.map((r) => r.style.top)).toEqual(["1024px"]);
    expect(canvas.classList.contains("paged")).toBe(true);
    // Off again: nothing drawn, nothing moved.
    Render.paginate(canvas, false);
    expect(canvas.children.filter((c) => c.classList.contains("page-gap") || c.classList.contains("page-rule"))).toHaveLength(0);
  });
});

describe("a table drawn at its stored widths (Render.tableWidths)", () => {
  const { Render } = loadAssets<{ Render: any }>(["gate.js", "spans.js", "model.js", "geometry.js", "render.js"], ["Render"]);
  it("stored widths that describe the table are fitted to the room; anything else is content sized", () => {
    expect(Render.tableWidths({ attrs: { widths: [100, 200] } }, 2, 624)).toEqual([100, 200]);
    expect(Render.tableWidths({ attrs: { widths: [100, 200] } }, 3, 624)).toBeNull();
    expect(Render.tableWidths({ attrs: {} }, 2, 624)).toBeNull();
    const fitted = Render.tableWidths({ attrs: { widths: [400, 400] } }, 2, 624);
    expect(fitted[0] + fitted[1]).toBeCloseTo(624, 6);
    expect(Render.MEASURE).toBe(624);
  });
});
