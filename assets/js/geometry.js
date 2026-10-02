// The canvas's own geometry, restated so the web draws and stores what the
// app does, as pure arithmetic (no DOM here; editor.js measures and asks):
//  - a table's stored column widths and their fit into the measure
//    (`TableBlock.fit`, `CanvasTableLayout.hasStoredWidths`,
//    `TableBlock.minimumColumnWidth`, `CanvasTable.insertedColumnWidth`),
//    and the column edge a drag takes hold of (`tableResizeHit`);
//  - a picture's resize by a corner (`CanvasImageResize`) and its crop
//    (`MediaCrop`, `CanvasImageCrop`, `CropCopy`): a crop is x, y, w, h
//    normalised to the WHOLE image, and so is every occlusion region, so a
//    region is re-expressed through the crop wherever it is drawn
//    (landmine 103);
//  - A4 pages drawn into the canvas (`CanvasPageLayout`, PLAN-BETA-0.6 K1).

const Geometry = (() => {

  // ---------------------------------------------------------------- tables

  const MIN_COLUMN = 44;        // `TableBlock.minimumColumnWidth`
  const INSERTED_COLUMN = 110;  // `CanvasTable.insertedColumnWidth`
  const EDGE_SLOP = 7;          // a column edge is caught within 7pt

  // Is the table drawn at widths a person stored (a column drag), rather
  // than content sized? Stored widths count only while they still describe
  // the table: one per column, every one positive.
  function hasStoredWidths(widths, columns) {
    const w = Array.isArray(widths) ? widths : [];
    return w.length === Math.max(1, columns) && w.every(x => typeof x === "number" && x > 0);
  }

  // `TableBlock.fit`: widths wider than the measure are scaled down together
  // above the floor, so the table's SHAPE survives; with no room even for
  // the floors every column takes an equal share.
  function fit(widths, available, minWidth = MIN_COLUMN) {
    const columns = widths.length;
    if (!columns) return widths.slice();
    const total = widths.reduce((a, b) => a + b, 0);
    if (!(total > available) || !(available > 0)) return widths.slice();
    const floorTotal = columns * minWidth;
    if (!(available > floorTotal)) return widths.map(() => Math.max(1, available / columns));
    const slack = total - floorTotal;
    if (!(slack > 0)) return widths.slice();
    const k = (available - floorTotal) / slack;
    return widths.map(w => minWidth + (w - minWidth) * k);
  }

  // `tableResizeMoved`: the column LEFT of the dragged edge takes the drag,
  // never narrower than the floor; the others keep theirs.
  function resizeColumn(widths, column, delta) {
    const w = widths.slice();
    if (column >= 0 && column < w.length) w[column] = Math.max(MIN_COLUMN, w[column] + delta);
    return w;
  }

  // The column whose RIGHT edge `x` is within 7pt of (the table's right edge
  // included, owner 2026-09-08), given each column's width from the table's
  // left, or -1. A table of one column has no edge to drag.
  function edgeAt(x, widths) {
    if (widths.length < 2) return -1;
    let right = 0;
    for (let c = 0; c < widths.length; c++) {
      right += widths[c];
      if (Math.abs(x - right) <= EDGE_SLOP) return c;
    }
    return -1;
  }

  // ------------------------------------------------------ picture resize

  const RESIZE = { handle: 12, slop: 6, minWidth: 96 };
  const CORNERS = ["topLeft", "topRight", "bottomLeft", "bottomRight"];
  const growsRight = corner => corner === "topRight" || corner === "bottomRight";

  // `CanvasImageResize.clamp`: never narrower than a diagram's labels read,
  // never wider than the measure.
  function clampWidth(width, measure) {
    return Math.min(Math.max(width, RESIZE.minWidth), Math.max(RESIZE.minWidth, measure));
  }

  // A handle's square, hung INSIDE the picture's corner.
  function resizeHandle(corner, rect) {
    const x = growsRight(corner) ? rect.x + rect.w - RESIZE.handle : rect.x;
    const y = corner === "topLeft" || corner === "topRight" ? rect.y : rect.y + rect.h - RESIZE.handle;
    return { x, y, w: RESIZE.handle, h: RESIZE.handle };
  }

  // The corner a point is close enough to start a drag from, or null.
  function resizeCorner(point, rect) {
    return CORNERS.find(c => inside(point, grow(resizeHandle(c, rect), RESIZE.slop))) || null;
  }

  // The width a drag of `dx` from `corner` asks for, before clamping: the
  // picture stays anchored where the column puts it, so a LEFT corner
  // dragged outward (leftward) widens it by the distance dragged.
  function resizedWidth(start, dx, corner) {
    return growsRight(corner) ? start + dx : start - dx;
  }

  // ------------------------------------------------------------ the crop

  const CROP_MIN_SIDE = 0.05;   // `MediaCrop.minSide`
  const CROP = { handle: 14, slop: 8 };
  const WHOLE = { x: 0, y: 0, w: 1, h: 1 };

  // `MediaCrop.clamped`: inside the picture and never a strip nothing can be
  // seen in. A crop arriving from the wire is not trusted to be either.
  function clampCrop(c) {
    const cx = Math.min(Math.max(c.x, 0), 1);
    const cy = Math.min(Math.max(c.y, 0), 1);
    const cw = Math.min(Math.max(c.w, CROP_MIN_SIDE), 1 - cx);
    const ch = Math.min(Math.max(c.h, CROP_MIN_SIDE), 1 - cy);
    return { x: cx, y: cy, w: Math.max(cw, CROP_MIN_SIDE), h: Math.max(ch, CROP_MIN_SIDE) };
  }

  const isWhole = c => c.x <= 0.0005 && c.y <= 0.0005 && c.w >= 0.9995 && c.h >= 0.9995;

  // `MediaCrop.parse`: the stored `media.crop` is "x,y,w,h". Absent, a
  // malformed string and a crop of the whole picture all mean the same
  // thing to a caller: draw everything (null).
  function parseCrop(raw) {
    if (typeof raw !== "string") return null;
    const parts = raw.split(",").map(p => p.trim());
    if (parts.length !== 4) return null;
    const nums = parts.map(p => (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(p) ? Number(p) : NaN));
    if (!nums.every(Number.isFinite)) return null;
    const crop = clampCrop({ x: nums[0], y: nums[1], w: nums[2], h: nums[3] });
    return isWhole(crop) ? null : crop;
  }

  // The stored form, four places (`MediaCrop.text`).
  const cropText = c => [c.x, c.y, c.w, c.h].map(v => v.toFixed(4)).join(",");

  // Whole-image normalised coordinates into CROP-relative ones, the one
  // conversion the feature turns on, and back (`place`, `unplace`).
  function place(r, crop) {
    if (!(crop.w > 0.0001 && crop.h > 0.0001)) return { x: r.x, y: r.y, w: r.w, h: r.h };
    return { x: (r.x - crop.x) / crop.w, y: (r.y - crop.y) / crop.h, w: r.w / crop.w, h: r.h / crop.h };
  }
  function unplace(r, crop) {
    return { x: crop.x + r.x * crop.w, y: crop.y + r.y * crop.h, w: r.w * crop.w, h: r.h * crop.h };
  }

  // `keepsWhole` (C-26): a region survives a crop only whole; a mask the crop
  // would clip or leave outside is the same defect (the answer on screen).
  function keepsWhole(crop, r, slack = 0.0005) {
    return r.x >= crop.x - slack && r.y >= crop.y - slack
      && r.x + r.w <= crop.x + crop.w + slack && r.y + r.h <= crop.y + crop.h + slack;
  }

  // `CropCopy.wouldHide`: named by ordinal, never by label (a label IS the
  // hidden answer).
  function wouldHide(ordinals) {
    const names = ordinals.slice().sort((a, b) => a - b).map(String);
    if (!names.length) return "";
    const list = names.length === 1 ? `region ${names[0]}`
      : names.length === 2 ? `regions ${names[0]} and ${names[1]}`
      : "regions " + names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    return `That crop would hide masked ${list}, so it was not applied.`;
  }

  // The crop's rectangle inside the picture as drawn (both y-down).
  function cropRect(crop, pic) {
    return { x: pic.x + crop.x * pic.w, y: pic.y + crop.y * pic.h, w: crop.w * pic.w, h: crop.h * pic.h };
  }

  function cornerPoint(corner, r) {
    return { x: corner === "topLeft" || corner === "bottomLeft" ? r.x : r.x + r.w,
             y: corner === "topLeft" || corner === "topRight" ? r.y : r.y + r.h };
  }

  function cropHandle(corner, r) {
    const p = cornerPoint(corner, r);
    return { x: p.x - CROP.handle / 2, y: p.y - CROP.handle / 2, w: CROP.handle, h: CROP.handle };
  }

  // The corner a press grabbed; nearest wins where two overlap (a crop
  // dragged down to its minimum side).
  function cropCorner(point, r) {
    let best = null;
    for (const c of CORNERS) {
      if (!inside(point, grow(cropHandle(c, r), CROP.slop))) continue;
      const p = cornerPoint(c, r);
      const d = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
      if (!best || d < best.d) best = { c, d };
    }
    return best ? best.c : null;
  }

  // `CanvasImageCrop.adjusted`: one corner moved to a point in the picture's
  // own coordinates; a corner dragged past its opposite flips the edge
  // rather than making a negative width.
  function adjustCrop(crop, corner, point, pic) {
    if (!(pic.w > 0 && pic.h > 0)) return crop;
    const nx = Math.min(Math.max((point.x - pic.x) / pic.w, 0), 1);
    const ny = Math.min(Math.max((point.y - pic.y) / pic.h, 0), 1);
    let left = crop.x, top = crop.y, right = crop.x + crop.w, bottom = crop.y + crop.h;
    if (corner === "topLeft") { left = nx; top = ny; }
    else if (corner === "topRight") { right = nx; top = ny; }
    else if (corner === "bottomLeft") { left = nx; bottom = ny; }
    else { right = nx; bottom = ny; }
    const x0 = Math.min(left, right), x1 = Math.max(left, right);
    const y0 = Math.min(top, bottom), y1 = Math.max(top, bottom);
    return clampCrop({ x: x0, y: y0, w: Math.max(x1 - x0, CROP_MIN_SIDE), h: Math.max(y1 - y0, CROP_MIN_SIDE) });
  }

  // ---------------------------------------------------------------- pages

  // `CanvasPageLayout.a4`: 680pt of canvas stands for A4's printable width
  // (0.75 inch margins), so a page holds the same proportion of its
  // printable height, 1024pt, with a 28pt gutter. The canvas passes the
  // default measure, and so does this.
  function a4(measure = 680) {
    const printableWidth = 595.28 - 108;
    const printableHeight = 841.89 - 108;
    return { contentHeight: Math.round(printableHeight * measure / printableWidth), gap: 28 };
  }

  const cycle = p => p.contentHeight + p.gap;
  const pageAtY = (p, y) => (cycle(p) > 0 ? Math.max(0, Math.floor(Math.max(0, y) / cycle(p))) : 0);
  const pageTop = (p, n) => n * cycle(p);
  const pageBottom = (p, n) => pageTop(p, n) + p.contentHeight;

  // Where a fragment should sit so it does not straddle a break, or null
  // when it fits. One that STARTS in the gutter belongs to the next page
  // too; one taller than a page is left where it is (it would be pushed for
  // ever).
  function push(p, top, height) {
    if (!(cycle(p) > 0 && p.contentHeight > 0 && height > 0 && height <= p.contentHeight)) return null;
    const page = pageAtY(p, top);
    if (!(top + height > pageBottom(p, page))) return null;
    return pageTop(p, page + 1);
  }

  // The gutters a band [top, top + height) meets: each one's top.
  function gutters(p, top, height) {
    if (!(cycle(p) > 0 && p.gap > 0 && height > 0)) return [];
    const out = [];
    for (let page = pageAtY(p, top); out.length <= 512; page++) {
      const y = pageBottom(p, page);
      if (y > top + height) break;
      if (y + p.gap >= top) out.push(y);
    }
    return out;
  }

  // -------------------------------------------------------------- helpers

  const inside = (pt, r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h;
  const grow = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

  return { MIN_COLUMN, INSERTED_COLUMN, EDGE_SLOP, hasStoredWidths, fit, resizeColumn, edgeAt,
           RESIZE, clampWidth, resizeHandle, resizeCorner, resizedWidth,
           CROP_MIN_SIDE, CROP, WHOLE, clampCrop, isWhole, parseCrop, cropText, place, unplace, keepsWhole, wouldHide,
           cropRect, cropHandle, cropCorner, adjustCrop,
           a4, pageAtY, pageTop, pageBottom, push, gutters };
})();
