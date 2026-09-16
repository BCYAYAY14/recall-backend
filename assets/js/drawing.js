// A stored drawing rendered to SVG.
//
// A drawing's BYTES are a `DrawingDocument` (Sources/Core/Drawing.swift); the
// PNG every app surface shows is DERIVED beside it and is deliberately NOT
// synced, so a viewer has to draw the document itself. Every constant here is
// copied from that file, not re-picked.

const Draw = (() => {

  const NS = "http://www.w3.org/2000/svg";

  // A named palette entry, never an RGB triple, so a drawing follows the
  // theme and reads in both appearances.
  const PALETTE = {
    ink:    { dark: [0.93, 0.93, 0.94], light: [0.11, 0.11, 0.12] },
    accent: { dark: [0.43, 0.38, 0.90], light: [0.43, 0.38, 0.90] },
    red:    { dark: [0.86, 0.27, 0.27], light: [0.86, 0.27, 0.27] },
    green:  { dark: [0.20, 0.60, 0.35], light: [0.20, 0.60, 0.35] },
    blue:   { dark: [0.20, 0.45, 0.85], light: [0.20, 0.45, 0.85] },
    yellow: { dark: [0.92, 0.72, 0.15], light: [0.92, 0.72, 0.15] },
  };

  const BOXED = ["rectangle", "ellipse", "roundedRectangle", "triangle", "diamond"];

  function colour(name, hex, dark) {
    if (hex && /^#?[0-9a-fA-F]{6}$/.test(hex.trim())) {
      const h = hex.trim().replace(/^#/, "");
      return "#" + h.toLowerCase();
    }
    const entry = PALETTE[name] || PALETTE.ink;
    const c = dark ? entry.dark : entry.light;
    return `rgb(${c.map(v => Math.round(v * 255)).join(",")})`;
  }

  function parse(text) {
    let doc;
    try { doc = JSON.parse(text); } catch (_) { return null; }
    if (!doc || typeof doc !== "object") return null;
    if (typeof doc.width !== "number" || typeof doc.height !== "number") return null;
    if (!(doc.width > 0 && doc.height > 0)) return null;
    if ((doc.version || 1) > 1) return null;
    doc.shapes = Array.isArray(doc.shapes) ? doc.shapes : [];
    return doc;
  }

  function strokeOf(shape) {
    const s = shape.stroke || {};
    return {
      colour: s.colour || "ink",
      width: typeof s.width === "number" ? s.width : 3,
      hex: typeof s.hex === "string" ? s.hex : null,
      // A drawing saved before `dashed` existed has no such key; an absent
      // key takes its default (landmine 134).
      dashed: s.dashed === true,
    };
  }

  function points(shape) {
    return (shape.points || [])
      .filter(p => p && typeof p.x === "number" && typeof p.y === "number")
      .map(p => ({ x: p.x, y: p.y }));
  }

  function box(shape) {
    const p = points(shape);
    if (p.length < 2) return null;
    const [a, b] = p;
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
             w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  // The box a shape occupies, stroke width included.
  function bounds(shape) {
    const p = points(shape);
    if (!p.length) return null;
    let minX = p[0].x, minY = p[0].y, maxX = p[0].x, maxY = p[0].y;
    for (const q of p) {
      minX = Math.min(minX, q.x); minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y);
    }
    let w = maxX - minX, h = maxY - minY;
    if (shape.kind === "text") {
      const size = shape.fontSize || 16;
      // Helvetica's mean advance is close enough for a bounding box; the
      // app measures it with Core Text, which a browser cannot reach.
      w = (shape.text || " ").length * size * 0.52;
      h = size * 1.16;
    }
    const half = strokeOf(shape).width / 2;
    return { x: minX - half, y: minY - half, w: w + 2 * half, h: h + 2 * half };
  }

  // The picture a document shows: wherever the ink is, plus a margin for the
  // thickest stroke. An EMPTY drawing keeps the page.
  function pictureBounds(doc) {
    const page = { x: 0, y: 0, w: doc.width, h: doc.height };
    const boxes = doc.shapes.map(bounds).filter(Boolean);
    if (!boxes.length) return page;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    const thickest = Math.max(0, ...doc.shapes.map(s => strokeOf(s).width));
    const m = Math.ceil(thickest / 2 + 2);
    return { x: Math.floor(minX - m), y: Math.floor(minY - m),
             w: Math.ceil(maxX - minX + 2 * m), h: Math.ceil(maxY - minY + 2 * m) };
  }

  const fmt = n => (Math.round(n * 100) / 100).toString();

  // The pen's polyline as a quadratic curve through the midpoints, which is
  // what makes a mouse stroke look like a stroke.
  function smoothed(p) {
    if (!p.length) return "";
    let d = `M ${fmt(p[0].x)} ${fmt(p[0].y)}`;
    if (p.length === 1) return d;
    if (p.length === 2) return d + ` L ${fmt(p[1].x)} ${fmt(p[1].y)}`;
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i].x + p[i + 1].x) / 2, my = (p[i].y + p[i + 1].y) / 2;
      d += ` Q ${fmt(p[i].x)} ${fmt(p[i].y)} ${fmt(mx)} ${fmt(my)}`;
    }
    return d + ` L ${fmt(p[p.length - 1].x)} ${fmt(p[p.length - 1].y)}`;
  }

  // A smooth curve THROUGH every vertex (Catmull-Rom as cubic Beziers).
  function catmullRom(p) {
    if (!p.length) return "";
    let d = `M ${fmt(p[0].x)} ${fmt(p[0].y)}`;
    if (p.length === 1) return d;
    if (p.length === 2) return d + ` L ${fmt(p[1].x)} ${fmt(p[1].y)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = i === 0 ? p[0] : p[i - 1];
      const p1 = p[i], p2 = p[i + 1];
      const p3 = i + 2 < p.length ? p[i + 2] : p[i + 1];
      const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
      const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
      d += ` C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
    }
    return d;
  }

  function arrowHead(a, b, width) {
    const length = Math.max(10, width * 4);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const spread = Math.PI / 7;
    const p1 = { x: b.x - length * Math.cos(angle - spread),
                 y: b.y - length * Math.sin(angle - spread) };
    const p2 = { x: b.x - length * Math.cos(angle + spread),
                 y: b.y - length * Math.sin(angle + spread) };
    return `M ${fmt(b.x)} ${fmt(b.y)} L ${fmt(p1.x)} ${fmt(p1.y)} `
         + `L ${fmt(p2.x)} ${fmt(p2.y)} Z`;
  }

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) node.setAttribute(k, String(v));
    }
    return node;
  }

  function drawShape(shape, dark) {
    const stroke = strokeOf(shape);
    const ink = colour(stroke.colour, stroke.hex, dark);
    const p = points(shape);
    const common = {
      stroke: ink,
      "stroke-width": stroke.width,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      fill: "none",
      ...(stroke.dashed
        ? { "stroke-dasharray": `${Math.max(1, stroke.width) * 3},${Math.max(1, stroke.width) * 2.5}` }
        : {}),
    };
    const nodes = [];

    switch (shape.kind) {
      case "pen":
        if (!p.length) break;
        if (p.length === 1) {
          nodes.push(el("circle", { cx: p[0].x, cy: p[0].y, r: stroke.width / 2,
                                    fill: ink, stroke: "none" }));
        } else {
          nodes.push(el("path", { ...common, d: smoothed(p) }));
        }
        break;
      case "polyline":
        if (p.length < 2) break;
        nodes.push(el("path", { ...common,
          d: "M " + p.map(q => `${fmt(q.x)} ${fmt(q.y)}`).join(" L ") }));
        break;
      case "curve":
        if (p.length < 2) break;
        nodes.push(el("path", { ...common, d: catmullRom(p) }));
        break;
      case "line":
      case "arrow": {
        if (p.length < 2) break;
        const a = p[0], b = p[p.length - 1];
        nodes.push(el("path", { ...common, d: `M ${fmt(a.x)} ${fmt(a.y)} L ${fmt(b.x)} ${fmt(b.y)}` }));
        if (shape.kind === "arrow") {
          nodes.push(el("path", { d: arrowHead(a, b, stroke.width), fill: ink, stroke: "none" }));
        }
        break;
      }
      default: {
        if (!BOXED.includes(shape.kind)) break;
        const bx = box(shape);
        if (!bx) break;
        // A picture placed in the drawing: its bytes ride in the shape, and
        // the shape is a rectangle with no stroke (Drawing.swift, `imageData`).
        if (shape.kind === "rectangle" && typeof shape.imageData === "string"
            && /^[A-Za-z0-9+/]+={0,2}$/.test(shape.imageData)) {
          const mime = shape.imageData.startsWith("iVBOR") ? "image/png" : "image/jpeg";
          nodes.push(el("image", { x: bx.x, y: bx.y, width: bx.w, height: bx.h,
                                   href: `data:${mime};base64,${shape.imageData}`,
                                   preserveAspectRatio: "none" }));
          if (stroke.width > 0) {
            nodes.push(el("rect", { ...common, x: bx.x, y: bx.y, width: bx.w, height: bx.h }));
          }
          break;
        }
        const filled = shape.fill != null || shape.fillHex != null;
        const fill = filled
          ? colour(shape.fill || stroke.colour, shape.fillHex, dark) : "none";
        const attrs = { ...common, fill };
        if (shape.kind === "rectangle") {
          nodes.push(el("rect", { ...attrs, x: bx.x, y: bx.y, width: bx.w, height: bx.h }));
        } else if (shape.kind === "roundedRectangle") {
          const r = Math.min(12, bx.w / 4, bx.h / 4);
          nodes.push(el("rect", { ...attrs, x: bx.x, y: bx.y, width: bx.w, height: bx.h, rx: r, ry: r }));
        } else if (shape.kind === "ellipse") {
          nodes.push(el("ellipse", { ...attrs, cx: bx.x + bx.w / 2, cy: bx.y + bx.h / 2,
                                     rx: bx.w / 2, ry: bx.h / 2 }));
        } else if (shape.kind === "triangle") {
          nodes.push(el("polygon", { ...attrs, points:
            `${fmt(bx.x + bx.w / 2)},${fmt(bx.y)} ${fmt(bx.x + bx.w)},${fmt(bx.y + bx.h)} `
            + `${fmt(bx.x)},${fmt(bx.y + bx.h)}` }));
        } else if (shape.kind === "diamond") {
          nodes.push(el("polygon", { ...attrs, points:
            `${fmt(bx.x + bx.w / 2)},${fmt(bx.y)} ${fmt(bx.x + bx.w)},${fmt(bx.y + bx.h / 2)} `
            + `${fmt(bx.x + bx.w / 2)},${fmt(bx.y + bx.h)} ${fmt(bx.x)},${fmt(bx.y + bx.h / 2)}` }));
        }
        break;
      }
      case "text": {
        if (!p.length || !shape.text) break;
        const size = shape.fontSize || 16;
        // The app draws Helvetica with the origin at the text's TOP LEFT and
        // Core Text's ascent below it; SVG's y is the baseline.
        const node = el("text", { x: p[0].x, y: p[0].y + size * 0.92,
                                  fill: ink, stroke: "none",
                                  "font-family": "Helvetica, Arial, sans-serif",
                                  "font-size": size });
        node.textContent = shape.text;
        nodes.push(node);
        break;
      }
    }
    return nodes;
  }

  // The document as one <svg>, sized to the ink. `maxWidth` caps the drawn
  // width the way `CanvasImageRenderer.maxWidth` caps a picture's.
  function svg(doc, { dark = false, maxWidth = 420, width = null } = {}) {
    const b = pictureBounds(doc);
    const drawn = width || Math.min(b.w, maxWidth);
    const scale = b.w > 0 ? drawn / b.w : 1;
    const root = el("svg", {
      viewBox: `${fmt(b.x)} ${fmt(b.y)} ${fmt(b.w)} ${fmt(b.h)}`,
      width: Math.round(drawn),
      height: Math.round(b.h * scale),
      xmlns: NS,
    });
    for (const shape of doc.shapes) {
      for (const node of drawShape(shape, dark)) root.appendChild(node);
    }
    return root;
  }

  return { parse, svg, pictureBounds };
})();
