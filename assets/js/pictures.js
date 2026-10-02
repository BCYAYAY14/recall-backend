// Pictures, drawings, rendered formulas and occlusion diagrams, drawn into a
// document or onto a card face. A picture is drawn as a placeholder first and
// filled in when its bytes arrive, so one slow object never holds the whole
// document back. Moved out of app.js unchanged so the review takeover can
// draw a diagram card with the same code the page uses.

const Pictures = (() => {

  function context(style) {
    const jobs = [];
    const diagrams = Media.diagramsByNote();
    const dark = document.documentElement.dataset.appearance === "dark";

    function picture(mediaId, opts = {}) {
      const row = Media.row(mediaId);
      // A PICTURE IS A BLOCK, even mid sentence: the canvas pads the
      // attachment out to the MEASURE, so nothing fits beside it. A RENDERED
      // FORMULA is the exception and is deliberately NOT padded, because
      // `$x^2$` sat in its sentence before it was rendered and has to sit
      // there after (landmine 97's trap 1, and P7).
      const inline = !!(row && row.latex);
      const wrap = document.createElement(inline ? "span" : "div");
      wrap.className = "figure" + (inline ? " inline" : "");
      if (!row) {
        // A good id whose row or bytes are missing says so, rather than
        // silently drawing nothing.
        wrap.appendChild(Render.missing("Image not available"));
        return wrap;
      }
      // A formula is re-rendered from the LaTeX it was made from rather than
      // downloaded: it is the same expression, it takes the reader's ink in
      // both appearances, and it costs no round trip. `latex` is stored AS
      // TYPED, delimiters included (`Media.latex`), so they come off first
      // (`MathText.delimited`); an older row's bare latex draws inline. A
      // formula KaTeX refuses falls back to the rendered picture's bytes.
      if (row.latex && window.katex) {
        const d = Render.delimited(row.latex) || { latex: row.latex, display: false };
        const drawn = Render.formulaNode(d.latex, d.display, null);
        if (drawn.classList.contains("formula")) {
          wrap.appendChild(drawn);
          return wrap;
        }
      }
      wrap.appendChild(Render.missing("Loading picture"));
      jobs.push((async () => {
        try {
          const loaded = await Media.load(row.id);
          wrap.textContent = "";
          if (loaded.drawing) {
            wrap.appendChild(Draw.svg(loaded.drawing, {
              dark,
              maxWidth: 420,
              width: opts.width || loaded.row.display_width || null,
            }));
            return;
          }
          const regions = Media.regionsFor(row.id, opts.noteId || row.note_id);
          wrap.appendChild(await pictureNode(loaded, regions, opts, dark));
        } catch (error) {
          wrap.textContent = "";
          wrap.appendChild(Render.missing("Image not available"));
        }
      })());
      return wrap;
    }

    return {
      picture,
      style,
      diagramsFor: noteId => diagrams.get(noteId) || [],
      resolve: () => Promise.all(jobs),
    };
  }

  // The picture, at the width the canvas would draw it, with its regions on
  // top when it has any.
  function pictureNode(loaded, regions, opts, dark) {
    return new Promise(resolve => {
      const img = new Image();
      img.src = loaded.url;
      img.alt = "";
      img.addEventListener("error", () => resolve(Render.missing("Image not available")));
      img.addEventListener("load", () => {
        // The crop is the MEDIA ROW's (`media.crop`, "x,y,w,h", `MediaCrop`),
        // as the canvas draws it; `opts.crop` is a crop being chosen (the
        // editor's crop mode shows the whole picture).
        const crop = normalisedCrop(opts.crop !== undefined ? opts.crop : Geometry.parseCrop(loaded.row.crop));
        const nativeW = img.naturalWidth * crop.w;
        const nativeH = img.naturalHeight * crop.h;
        const stored = opts.width || loaded.row.display_width;
        // An unsized picture is fitted inside both caps and never enlarged;
        // a sized one is drawn at exactly the width it was given. A card
        // face fits the card's column instead.
        const capW = opts.face ? 560 : 420;
        const capH = opts.face ? 420 : 320;
        const scale = stored && !opts.face
          ? stored / nativeW
          : Math.min(capW / nativeW, capH / nativeH, 1);
        const width = Math.max(1, Math.round(nativeW * scale));
        const height = Math.max(1, Math.round(nativeH * scale));

        let node = img;
        if (crop.w !== 1 || crop.h !== 1 || crop.x !== 0 || crop.y !== 0) {
          // The crop is applied to the PIXELS first, so everything after it
          // is about the picture the reader actually sees.
          const frame = document.createElement("span");
          frame.style.display = "inline-block";
          frame.style.overflow = "hidden";
          frame.style.width = width + "px";
          frame.style.height = height + "px";
          frame.style.position = "relative";
          img.style.position = "absolute";
          img.style.width = Math.round(img.naturalWidth * scale) + "px";
          img.style.height = Math.round(img.naturalHeight * scale) + "px";
          img.style.left = -Math.round(img.naturalWidth * crop.x * scale) + "px";
          img.style.top = -Math.round(img.naturalHeight * crop.y * scale) + "px";
          img.style.maxWidth = "none";
          frame.appendChild(img);
          node = frame;
        } else {
          img.style.width = width + "px";
          img.style.height = height + "px";
        }

        if (!regions.length) return resolve(node);

        const holder = document.createElement("span");
        holder.className = "occlusion";
        holder.style.width = width + "px";
        holder.style.height = height + "px";
        holder.appendChild(node);
        holder.appendChild(regionOverlay(regions, width, height, crop, dark, opts.face));
        resolve(holder);
      });
    });
  }

  // A crop as the drawing uses it: `{ x, y, w, h }`, the whole picture for
  // none. (The stored form was read as JSON here, which never matched the
  // app's "x,y,w,h", so a crop made on the Mac drew uncropped.)
  function normalisedCrop(c) {
    if (!c || ![c.x, c.y, c.w, c.h].every(n => Number.isFinite(n)) || c.w <= 0 || c.h <= 0) {
      return { x: 0, y: 0, w: 1, h: 1 };
    }
    return { x: c.x, y: c.y, w: c.w, h: c.h };
  }

  // A REGION IS NORMALISED TO THE WHOLE IMAGE, so a crop moves every box
  // unless it is re-expressed (landmine 103). This is `MediaCrop.place`.
  function place(region, crop) {
    return {
      x: (region.x - crop.x) / crop.w,
      y: (region.y - crop.y) / crop.h,
      w: region.w / crop.w,
      h: region.h / crop.h,
    };
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Two drawings of one set of regions. In the DOCUMENT a labelled diagram
  // is the thing the note is about: a wash, the outline and the label (or
  // the number when the box is too small). On a CARD (`face`) the target is
  // masked with the accent's outline, hide-all masks every region, and a
  // label shows only where the question may show it (OcclusionFaceView).
  function regionOverlay(regions, width, height, crop, dark, face) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    // Chrome scales against the 420pt reference so a small picture is the
    // same picture, smaller (landmine 101), and it never exceeds 1.
    const chrome = Math.min(1, Math.max(0.55, width / 420));
    const ink = dark ? "#ffffff" : "#000000";
    const wash = dark ? "rgba(0,0,0,.28)" : "rgba(255,255,255,.30)";
    const edge = dark ? "rgba(255,255,255,.75)" : "rgba(0,0,0,.62)";
    const mask = dark ? "#35353c" : "#d6d6d6";
    const accent = cssVar("--accent") || "#6e62e5";
    const strong = cssVar("--hairline-strong") || edge;

    for (const region of regions) {
      const n = place(region, crop);
      const rw = Math.max(2, n.w * width);
      const rh = Math.max(2, n.h * height);
      const rx = n.x * width;
      const ry = n.y * height;      // stored y is from the TOP, as SVG's is
      if (rx > width || ry > height || rx + rw < 0 || ry + rh < 0) continue;

      const group = document.createElementNS(NS, "g");
      if (region.rotation) {
        group.setAttribute("transform",
          `rotate(${region.rotation * 180 / Math.PI} ${rx + rw / 2} ${ry + rh / 2})`);
      }

      const isTarget = face && region.ordinal === face.target;
      const filled = face && !face.revealed && (isTarget || face.mode === "all");

      const shape = polygonFor(region, crop, width, height);
      const node = shape
        ? document.createElementNS(NS, "polygon")
        : document.createElementNS(NS, "rect");
      if (shape) {
        node.setAttribute("points", shape);
      } else {
        node.setAttribute("x", rx + 0.5);
        node.setAttribute("y", ry + 0.5);
        node.setAttribute("width", Math.max(1, rw - 1));
        node.setAttribute("height", Math.max(1, rh - 1));
        node.setAttribute("rx", 3 * chrome);
      }
      if (face) {
        node.setAttribute("fill", filled ? mask : "none");
        node.setAttribute("stroke", isTarget ? accent : strong);
        node.setAttribute("stroke-width", (isTarget ? 2.5 : filled ? 1 : 1.5) * chrome);
      } else {
        node.setAttribute("fill", wash);
        node.setAttribute("stroke", edge);
        node.setAttribute("stroke-width", 1.5 * chrome);
      }
      group.appendChild(node);

      const label = String(region.label || "").trim();
      const carries = rw >= 26 * chrome && rh >= 16 * chrome;
      // On a card the TARGET's word is the answer chip under the picture,
      // never printed in the box as well: a diagram with its own printed
      // label under the box read the answer twice.
      const showLabel = face
        ? !isTarget && (face.revealed || face.mode === "one") && label && carries
        : label && carries;
      if (showLabel) {
        const text = document.createElementNS(NS, "text");
        text.setAttribute("x", rx + rw / 2);
        text.setAttribute("y", ry + rh / 2);
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "central");
        text.setAttribute("fill", ink);
        text.setAttribute("font-size", 11 * chrome);
        text.setAttribute("font-family", "-apple-system, system-ui, sans-serif");
        text.textContent = label;
        group.appendChild(text);
      }
      // A card always numbers its regions; a document numbers a box only
      // when it cannot carry its word.
      if (face || !showLabel) {
        const badge = document.createElementNS(NS, "text");
        badge.setAttribute("x", rx + 3 * chrome + 5 * chrome);
        badge.setAttribute("y", ry + 3 * chrome + 6 * chrome);
        badge.setAttribute("fill", ink);
        badge.setAttribute("font-size", 10 * chrome);
        badge.setAttribute("font-weight", "600");
        badge.setAttribute("dominant-baseline", "central");
        badge.textContent = String((region.ordinal || 0) + 1);
        group.appendChild(badge);
      }
      svg.appendChild(group);
    }
    return svg;
  }

  function polygonFor(region, crop, width, height) {
    if (!region.points_json) return null;
    let pts;
    try { pts = JSON.parse(region.points_json); } catch (_) { return null; }
    if (!Array.isArray(pts) || pts.length < 3) return null;
    const out = [];
    for (const raw of pts) {
      const px = Array.isArray(raw) ? raw[0] : raw && raw.x;
      const py = Array.isArray(raw) ? raw[1] : raw && raw.y;
      if (typeof px !== "number" || typeof py !== "number") return null;
      // Points are whole image normalised too, so they take the same trip
      // through the crop the bounding rect took.
      out.push(`${((px - crop.x) / crop.w) * width},${((py - crop.y) / crop.h) * height}`);
    }
    return out.join(" ");
  }

  return { context };
})();
