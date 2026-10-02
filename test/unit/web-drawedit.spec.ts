// The web drawing editor keeps what it does not draw (owner, 2026-09-30,
// "fix"): assets/js/drawedit.js edits the app's `DrawingDocument` in place,
// so groups, names, locks, hidden shapes, bindings, a picture's bytes, the
// grapher's `graph` and any key a later build adds all survive a save, and
// a delete does what the app's `DrawingDocument.remove(ids:)` does.

import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { DrawEdit, Wire } = loadAssets<{ DrawEdit: any; Wire: any }>(["wire.js", "drawedit.js"], ["DrawEdit", "Wire"]);

const BOX = "A0000000-0000-4000-8000-000000000001";
const LABEL = "A0000000-0000-4000-8000-000000000002";
const ARROW = "A0000000-0000-4000-8000-000000000003";
const OTHER = "A0000000-0000-4000-8000-000000000004";
const GROUP = "B0000000-0000-4000-8000-000000000001";

function stored(): any {
  return {
    version: 1, width: 680, height: 360,
    groups: [{ id: GROUP, name: "Market" }],
    graph: { rows: [{ text: "y=x^2" }], viewport: { xMin: -5, xMax: 5 } },
    futureDocKey: { kept: true },
    shapes: [
      { id: BOX, kind: "rectangle", points: [{ x: 10, y: 10 }, { x: 110, y: 60 }], stroke: { colour: "ink", width: 2 },
        groupIds: [GROUP], name: "Supply box", locked: true, futureShapeKey: 7 },
      { id: LABEL, kind: "text", points: [{ x: 60, y: 35 }], stroke: { colour: "ink", width: 1 }, text: "S",
        attachedTo: { shape: BOX, anchor: "inside" }, groupIds: [GROUP] },
      { id: ARROW, kind: "arrow", points: [{ x: 200, y: 40 }, { x: 110, y: 40 }], stroke: { colour: "ink", width: 2 },
        endBinding: { shape: BOX, anchor: "right" }, hidden: true },
      { id: OTHER, kind: "ellipse", points: [{ x: 300, y: 10 }, { x: 340, y: 50 }], stroke: { colour: "red", width: 3 },
        imageData: "iVBORw0KGgo=" },
    ],
  };
}

describe("the web drawing editor keeps what it does not draw", () => {
  it("hands back every key it was given, a moved shape's included", () => {
    const original = stored();
    const doc = DrawEdit.workingCopy(original);
    expect(doc).not.toBe(original);
    // An edit here is a move: the points change and nothing else does.
    doc.shapes[3].points = doc.shapes[3].points.map((p: any) => ({ x: p.x + 5, y: p.y }));
    const back = JSON.parse(Wire.canonical(doc));
    expect(back.groups).toEqual([{ id: GROUP, name: "Market" }]);
    expect(back.graph).toEqual(original.graph);
    expect(back.futureDocKey).toEqual({ kept: true });
    expect(back.version).toBe(1);
    expect(back.shapes[0]).toEqual(original.shapes[0]);
    expect(back.shapes[1].attachedTo).toEqual({ shape: BOX, anchor: "inside" });
    expect(back.shapes[2].endBinding).toEqual({ shape: BOX, anchor: "right" });
    expect(back.shapes[2].hidden).toBe(true);
    expect(back.shapes[3].imageData).toBe("iVBORw0KGgo=");
    expect(back.shapes[3].points[0].x).toBe(305);
  });

  it("starts a new drawing as the app does", () => {
    expect(DrawEdit.workingCopy(null)).toEqual({ version: 1, width: 680, height: 360, shapes: [] });
  });

  it("deletes as the app does: the text inside, the bindings to it, an empty group", () => {
    const doc = DrawEdit.workingCopy(stored());
    DrawEdit.removeShapes(doc, [BOX.toLowerCase()]);
    expect(doc.shapes.map((s: any) => s.id)).toEqual([ARROW, OTHER]);
    expect("endBinding" in doc.shapes[0]).toBe(false);
    expect("groups" in doc).toBe(false);
    expect(doc.graph).toBeTruthy();
  });

  it("keeps a group that still has a member", () => {
    const doc = DrawEdit.workingCopy(stored());
    DrawEdit.removeShapes(doc, [OTHER]);
    expect(doc.groups).toEqual([{ id: GROUP, name: "Market" }]);
  });

  it("never lets a pointer take a hidden or locked shape", () => {
    const doc = stored();
    expect(doc.shapes.map(DrawEdit.pickable)).toEqual([false, true, false, true]);
  });

  it("undoes a delete with its groups", () => {
    const doc = DrawEdit.workingCopy(stored());
    const before = DrawEdit.step(doc);
    DrawEdit.removeShapes(doc, [BOX]);
    DrawEdit.restore(doc, before);
    expect(doc.shapes.length).toBe(4);
    expect(doc.groups).toEqual([{ id: GROUP, name: "Market" }]);
    expect(doc.futureDocKey).toEqual({ kept: true });
  });
});
