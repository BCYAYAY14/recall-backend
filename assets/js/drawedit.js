// The drawing editor (PLAN-BETA-0.12 section 26, W-7; Ink 17 section 6, the
// Mac's 640 sheet): one title bar (Cancel, Drawing, Done), the tool rail on
// the left, the page dotted on the paper rung, the colours, the width and
// the hint at the foot. It edits the app's own `DrawingDocument`
// (Sources/Core/Drawing.swift): shapes with ids, kinds, points, a stroke
// with a NAMED colour (so a drawing follows the theme), text with a size.
// Done hands back the document; the caller stores its JSON by sha as the app
// does (`MediaStore.saveDrawing`, `replaceMediaBytes`).

const DrawEdit = (() => {

  const TOOLS = [
    ["select", "Select", "V"], ["pen", "Pen", "P"], ["line", "Line", "L"], ["arrow", "Arrow", "A"],
    ["rectangle", "Rectangle", "R"], ["ellipse", "Ellipse", "O"], ["text", "Text", "T"],
  ];
  const COLOURS = ["ink", "accent", "red", "green", "blue", "yellow"];
  const WIDTHS = [2, 3, 5, 8];
  const HINTS = {
    select: "Click a shape to select it · drag to move it · drag its corner to resize · Delete removes it",
    pen: "Drag to draw",
    line: "Drag from one end to the other",
    arrow: "Drag from the tail to the head",
    rectangle: "Drag a box",
    ellipse: "Drag a box",
    text: "Click where the text goes, then type it",
  };

  const uuid = () => crypto.randomUUID().toUpperCase();

  // THE DOCUMENT IS KEPT WHOLE (owner, 2026-09-30, "fix"). This editor draws
  // and edits shapes only, but the app's drawing carries more: `groups` with
  // their names, each shape's `groupIds`, `locked`, `hidden`, `name`,
  // `attachedTo`, `startBinding` and `endBinding`, a picture's `imageData`,
  // the grapher's `graph`, and whatever a later build adds. So the editor
  // works on a deep copy of the parsed document and edits it IN PLACE: a
  // shape it moves keeps every key it does not read, and Done hands back the
  // same object (`version` included), never a rebuilt one.
  const key = id => String(id).toLowerCase();

  // A delete as the app's (`DrawingDocument.remove(ids:)`): the shapes, any
  // text typed inside a removed box, every binding that pointed at them, and
  // a group left with no member.
  function removeShapes(doc, ids) {
    const gone = new Set(ids.map(key));
    for (const s of doc.shapes) {
      const b = s.attachedTo;
      if (b && b.anchor === "inside" && gone.has(key(b.shape))) gone.add(key(s.id));
    }
    doc.shapes = doc.shapes.filter(s => !gone.has(key(s.id)));
    for (const s of doc.shapes) {
      for (const k of ["attachedTo", "startBinding", "endBinding"]) {
        if (s[k] && gone.has(key(s[k].shape))) delete s[k];
      }
    }
    if (Array.isArray(doc.groups)) {
      const live = new Set(doc.shapes.flatMap(s => (Array.isArray(s.groupIds) ? s.groupIds : []).map(key)));
      doc.groups = doc.groups.filter(g => g && live.has(key(g.id)));
      if (!doc.groups.length) delete doc.groups;
    }
    return doc;
  }

  // What the editor lets a pointer take: never a shape the app hides or
  // locks (its layers list decides those).
  const pickable = s => s.hidden !== true && s.locked !== true;

  // The working copy of a stored document, or a new one.
  function workingCopy(doc) {
    const out = doc ? JSON.parse(JSON.stringify(doc)) : { version: 1, width: 680, height: 360, shapes: [] };
    out.shapes = Array.isArray(out.shapes) ? out.shapes : [];
    return out;
  }

  // What an undo step holds: the two keys an edit here can change.
  const step = doc => JSON.stringify({ shapes: doc.shapes, groups: doc.groups });
  function restore(doc, text) {
    const s = JSON.parse(text);
    doc.shapes = s.shapes;
    if (s.groups === undefined) delete doc.groups; else doc.groups = s.groups;
  }

  function open({ doc = null, title = "Drawing", onSave }) {
    const { h, svg: svgNode, chip } = UI;
    const dark = document.documentElement.dataset.appearance === "dark";
    const working = workingCopy(doc);
    let tool = "pen";
    let colour = "ink";
    let width = 3;
    let selected = null;
    const history = [];

    const canvas = svgNode("svg", { viewBox: `0 0 ${working.width} ${working.height}`, class: "draw-canvas",
                                    role: "img", "aria-label": "Drawing" });
    const hint = h("p.help.draw-hint");
    const rail = h("div.draw-rail");
    const foot = h("div.draw-foot");

    function snapshot() {
      history.push(step(working));
      if (history.length > 50) history.shift();
    }

    function undo() {
      const last = history.pop();
      if (last) { restore(working, last); selected = null; draw(); }
    }

    function toolButton([id, label, key]) {
      const b = h("button.draw-tool", { type: "button", title: `${label} (${key})`, "aria-label": label, text: label });
      b.addEventListener("click", () => { tool = id; if (id !== "select") selected = null; draw(); });
      return b;
    }

    function drawRail() {
      rail.textContent = "";
      for (const t of TOOLS) {
        const b = toolButton(t);
        if (t[0] === tool) b.classList.add("on");
        rail.appendChild(b);
      }
    }

    function drawFoot() {
      foot.textContent = "";
      const swatches = h("div.draw-swatches");
      for (const c of COLOURS) {
        const rgb = Draw.PALETTE[c][dark ? "dark" : "light"].map(v => Math.round(v * 255)).join(",");
        const s = h("button.draw-swatch", { type: "button", title: c, "aria-label": `Colour ${c}` });
        s.style.backgroundColor = `rgb(${rgb})`;
        if (c === colour) s.classList.add("on");
        s.addEventListener("click", () => {
          colour = c;
          const shape = working.shapes.find(x => x.id === selected);
          if (shape) { snapshot(); shape.stroke = { ...(shape.stroke || {}), colour: c }; delete shape.stroke.hex; }
          draw();
        });
        swatches.appendChild(s);
      }
      const widths = h("div.draw-widths", WIDTHS.map(w => chip(`${w}`, { on: w === width, title: `Width ${w}`, onclick: () => {
        width = w;
        const shape = working.shapes.find(x => x.id === selected);
        if (shape) { snapshot(); shape.stroke = { ...(shape.stroke || {}), width: w }; }
        draw();
      } })));
      foot.append(swatches, h("span.bar-note", { text: "Width" }), widths, h("span.spacer"),
        chip("Undo", { disabled: !history.length, onclick: undo }),
        chip("Delete", { className: "danger", disabled: !selected, onclick: removeSelected }));
    }

    function removeSelected() {
      if (!selected) return;
      snapshot();
      removeShapes(working, [selected]);
      selected = null;
      draw();
    }

    function draw() {
      canvas.textContent = "";
      const paper = svgNode("rect", { x: 0, y: 0, width: working.width, height: working.height, class: "draw-paper" });
      canvas.appendChild(paper);
      for (const shape of working.shapes) {
        // A shape hidden in the app's layers list is kept, not drawn.
        if (shape.hidden === true) continue;
        const g = svgNode("g", { "data-id": shape.id });
        for (const node of Draw.drawShape(shape, dark)) g.appendChild(node);
        canvas.appendChild(g);
      }
      const shape = working.shapes.find(s => s.id === selected);
      if (shape) {
        const b = Draw.bounds(shape);
        if (b) {
          canvas.appendChild(svgNode("rect", { x: b.x - 4, y: b.y - 4, width: b.w + 8, height: b.h + 8, class: "draw-selection" }));
          canvas.appendChild(svgNode("rect", { x: b.x + b.w - 2, y: b.y + b.h - 2, width: 10, height: 10, class: "draw-handle", "data-handle": "resize" }));
        }
      }
      drawRail();
      drawFoot();
      hint.textContent = HINTS[tool];
    }

    function toDoc(event) {
      const r = canvas.getBoundingClientRect();
      return { x: Math.round((event.clientX - r.left) / r.width * working.width * 10) / 10,
               y: Math.round((event.clientY - r.top) / r.height * working.height * 10) / 10 };
    }

    function hit(p) {
      for (let i = working.shapes.length - 1; i >= 0; i--) {
        if (!pickable(working.shapes[i])) continue;
        const b = Draw.bounds(working.shapes[i]);
        if (!b) continue;
        const pad = 6;
        if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return working.shapes[i];
      }
      return null;
    }

    function newShape(kind, p) {
      return { id: uuid(), kind, points: [p, p], stroke: { colour, width, dashed: false, dotted: false } };
    }

    let gesture = null;
    canvas.addEventListener("pointerdown", event => {
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      const p = toDoc(event);
      if (tool === "select") {
        const handle = event.target && event.target.getAttribute && event.target.getAttribute("data-handle");
        const shape = handle ? working.shapes.find(s => s.id === selected) : hit(p);
        selected = shape ? shape.id : null;
        if (shape) {
          snapshot();
          gesture = { kind: handle ? "resize" : "move", shape, start: p, points: shape.points.map(q => ({ ...q })),
                      bounds: Draw.bounds(shape), size: shape.fontSize || 16 };
        }
        draw();
        return;
      }
      if (tool === "text") {
        placeText(p);
        return;
      }
      snapshot();
      const shape = newShape(tool, p);
      if (tool === "pen") shape.points = [p];
      working.shapes.push(shape);
      gesture = { kind: "create", shape };
      draw();
    });
    canvas.addEventListener("pointermove", event => {
      if (!gesture) return;
      const p = toDoc(event);
      const s = gesture.shape;
      if (gesture.kind === "create") {
        if (s.kind === "pen") s.points.push(p);
        else s.points[1] = p;
      } else if (gesture.kind === "move") {
        const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
        s.points = gesture.points.map(q => ({ x: q.x + dx, y: q.y + dy }));
      } else if (gesture.kind === "resize") {
        const b = gesture.bounds;
        const sx = b.w > 0 ? Math.max(0.05, (p.x - b.x) / b.w) : 1;
        const sy = b.h > 0 ? Math.max(0.05, (p.y - b.y) / b.h) : 1;
        if (s.kind === "text") {
          s.fontSize = Math.min(400, Math.max(6, Math.round(gesture.size * sy)));
        } else {
          s.points = gesture.points.map(q => ({ x: b.x + (q.x - b.x) * sx, y: b.y + (q.y - b.y) * sy }));
        }
      }
      draw();
    });
    const end = () => {
      if (gesture && gesture.kind === "create") {
        const s = gesture.shape;
        const b = Draw.bounds(s);
        // A click with no drag makes nothing but a pen dot.
        if (s.kind !== "pen" && b && b.w < 4 && b.h < 4) working.shapes = working.shapes.filter(x => x !== s);
        else selected = s.id;
      }
      gesture = null;
      draw();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    function placeText(p) {
      const field = h("input.field.draw-text", { type: "text", placeholder: "Text", "aria-label": "Text" });
      const r = canvas.getBoundingClientRect();
      const host = canvas.parentElement;
      const hr = host.getBoundingClientRect();
      field.style.left = (r.left - hr.left + p.x / working.width * r.width) + "px";
      field.style.top = (r.top - hr.top + p.y / working.height * r.height) + "px";
      host.appendChild(field);
      setTimeout(() => field.focus(), 0);
      const done = keep => {
        const text = field.value.trim();
        field.remove();
        if (!keep || !text) return;
        snapshot();
        const shape = { id: uuid(), kind: "text", points: [p], stroke: { colour, width: 0, dashed: false, dotted: false },
                        text, fontSize: 16 };
        working.shapes.push(shape);
        selected = shape.id;
        tool = "select";
        draw();
      };
      field.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); done(true); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      });
      field.addEventListener("blur", () => done(true));
    }

    const onKey = event => {
      if (event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
      if ((event.key === "Backspace" || event.key === "Delete") && selected) { event.preventDefault(); removeSelected(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo();
        return;
      }
      const t = TOOLS.find(x => x[2].toLowerCase() === event.key.toLowerCase());
      if (t && !event.metaKey && !event.ctrlKey) { tool = t[0]; draw(); }
    };
    document.addEventListener("keydown", onKey);

    const stage = h("div.draw-stage", canvas);
    const body = h("div.draw-editor", h("div.draw-main", rail, stage), foot, hint);
    draw();
    UI.sheet({
      title, left: "Cancel", right: "Done", width: 820, body: [body],
      onRight: async () => {
        document.removeEventListener("keydown", onKey);
        // The document it was handed, edited in place: every key this
        // editor does not read goes back as it came (owner, 2026-09-30).
        const out = working;
        try { await onSave(out); } catch (error) { hint.textContent = String(error.message || error); document.addEventListener("keydown", onKey); return false; }
        return true;
      },
      onClose: () => document.removeEventListener("keydown", onKey),
    });
  }

  // The bytes the app stores: the document as JSON with its keys sorted
  // (`DrawingDocument.encoded`).
  function encode(doc) {
    return new Blob([Wire.canonical(doc)], { type: Store.DRAWING_MIME });
  }

  return { open, encode, workingCopy, removeShapes, pickable, step, restore };
})();
