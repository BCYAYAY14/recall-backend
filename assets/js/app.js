// The shell: sign in, the library in the sidebar, one document in the page,
// its cards beside it, and a share link for it.
//
// Two ways in. PAIRED is a browser holding a read-only device credential and
// the whole library. A SHARE LINK (`#share=<token>`) is one doc for a visitor
// with no account: no sidebar, no pairing, the same page and cards. The
// backend is this page's own origin (js/backend.js).
//
// It writes nothing but share links, and only on the owner's say so (Create
// link, Stop sharing). No note, card or schedule is written from here, and
// card practice grades nothing.

(() => {

  const $ = id => document.getElementById(id);

  const state = {
    folders: [],
    docs: [],
    selected: null,
    filter: "",
    tab: "notes",
    current: null,     // { doc, blocks, cards, style }
    practice: null,    // the mounted card column's handle
    share: null,       // the live share row for the open doc, when known
  };

  // ------------------------------------------------------------- appearance

  function appearance() {
    const stored = localStorage.getItem("recall.viewer.appearance");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  // A drawing's ink is a named palette entry, so a switch redraws the page
  // rather than recolouring it.
  function applyAppearance(mode) {
    document.documentElement.dataset.appearance = mode;
    localStorage.setItem("recall.viewer.appearance", mode);
    $("appearance").textContent = mode === "dark" ? "☾" : "☀";
    if (state.current) drawTab({ keepScroll: true });
  }

  // ----------------------------------------------------------------- errors

  function showError(node, error, context) {
    if (!error) { node.classList.add("hidden"); return; }
    node.classList.remove("hidden");
    node.textContent = String(error.message || error);
    if (context) {
      const eyebrow = document.createElement("span");
      eyebrow.className = "eyebrow";
      eyebrow.textContent = context;
      node.appendChild(eyebrow);
    }
  }

  // ---------------------------------------------------------------- sign in

  function showSignIn() {
    $("signin").classList.remove("hidden");
    $("shell").classList.add("hidden");
  }

  async function signIn(event) {
    event.preventDefault();
    const button = $("signin-button");
    button.disabled = true;
    showError($("signin-error"), null);
    try {
      await Backend.pair($("pair-code").value, $("pair-label").value.trim());
      $("pair-code").value = "";
      await start();
    } catch (error) {
      showError($("signin-error"), error, "sign in");
      button.disabled = false;
      return;
    }
    button.disabled = false;
  }

  // ---------------------------------------------------------------- library

  async function loadLibrary() {
    state.folders = await Backend.folders();
    state.docs = await Backend.notebooks();
    // The doc row's meta is a fact, never an action: how many notes it holds.
    state.counts = Backend.noteCounts();
    drawTree();
  }

  function matches(doc) {
    if (!state.filter) return true;
    return String(doc.name || "").toLowerCase().includes(state.filter);
  }

  function drawTree() {
    const tree = $("tree");
    tree.textContent = "";

    const byFolder = new Map();
    const loose = [];
    for (const doc of state.docs) {
      if (!matches(doc)) continue;
      // NotebookTree.groups: a doc naming a folder that is not in the list
      // reads as unfiled rather than vanishing (landmine 151).
      if (doc.folder_id && state.folders.some(f => f.id === doc.folder_id)) {
        if (!byFolder.has(doc.folder_id)) byFolder.set(doc.folder_id, []);
        byFolder.get(doc.folder_id).push(doc);
      } else {
        loose.push(doc);
      }
    }

    const sorted = list => list.sort((a, b) =>
      (a.position || 0) - (b.position || 0)
      || String(a.name || "").localeCompare(String(b.name || "")));

    for (const folder of sorted([...state.folders])) {
      const docs = sorted(byFolder.get(folder.id) || []);
      if (state.filter && !docs.length) continue;
      tree.appendChild(groupHead(folder.name, docs.length, true));
      const kids = document.createElement("div");
      kids.className = "folder-kids";
      for (const doc of docs) kids.appendChild(docRow(doc));
      tree.appendChild(kids);
    }

    if (loose.length) {
      tree.appendChild(groupHead(state.folders.length ? "Docs" : "Library", loose.length, false));
      for (const doc of sorted(loose)) tree.appendChild(docRow(doc));
    }

    if (!tree.children.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = state.filter ? "No doc matches that." : "This library is empty.";
      tree.appendChild(empty);
    }
  }

  function groupHead(name, count, isFolder) {
    const head = document.createElement("div");
    head.className = "group-head";
    if (isFolder) head.appendChild(folderGlyph());
    head.appendChild(document.createTextNode(name || "Folder"));
    const badge = document.createElement("span");
    badge.className = "count";
    badge.textContent = count;
    head.appendChild(badge);
    return head;
  }

  // FolderGlyph: a folder outline, the one mark a folder draws (review
  // 2026-09-13, finding 9).
  function folderGlyph() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("class", "folder-glyph");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.5h5.4a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3.25a1.5 1.5 0 0 1-1.5-1.5z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.4");
    svg.appendChild(path);
    return svg;
  }

  // THE EMOJI PATH IS RETIRED (ruling I10). Every doc draws the monochrome
  // dot-and-bar mark, so a library reads as one list rather than as a colour
  // chart whose hues mean nothing. `none` draws nothing and keeps the row
  // aligned.
  function glyph(value) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    if (String(value || "") === "none") return svg;
    // DotAndBarMark at scale 0.9: three rows of a 2.7 dot and a 9 by 2.25
    // capsule, 1.8 apart, the rows 2.7 apart, at 100 / 66 / 38 per cent.
    const rowH = 2.7, gap = 2.7, dot = 2.7, bar = 9, barH = 2.25, space = 1.8;
    const totalH = 3 * rowH + 2 * gap;
    const totalW = dot + space + bar;
    const x0 = (20 - totalW) / 2;
    let y = (20 - totalH) / 2;
    for (const opacity of [1, 0.66, 0.38]) {
      const circle = document.createElementNS(NS, "circle");
      circle.setAttribute("cx", x0 + dot / 2);
      circle.setAttribute("cy", y + rowH / 2);
      circle.setAttribute("r", dot / 2);
      circle.setAttribute("fill", "currentColor");
      circle.setAttribute("opacity", opacity);
      const capsule = document.createElementNS(NS, "rect");
      capsule.setAttribute("x", x0 + dot + space);
      capsule.setAttribute("y", y + (rowH - barH) / 2);
      capsule.setAttribute("width", bar);
      capsule.setAttribute("height", barH);
      capsule.setAttribute("rx", barH / 2);
      capsule.setAttribute("fill", "currentColor");
      capsule.setAttribute("opacity", opacity);
      svg.append(circle, capsule);
      y += rowH + gap;
    }
    return svg;
  }

  // Row grammar: 26pt icon tile, name at 14 medium, a right aligned fact.
  function docRow(doc) {
    const row = document.createElement("button");
    row.className = "row";
    row.dataset.docId = doc.id;
    if (state.selected === doc.id) row.classList.add("selected");

    const tile = document.createElement("span");
    tile.className = "row-tile";
    tile.appendChild(glyph(doc.emoji));

    const body = document.createElement("span");
    body.className = "row-body";
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = doc.name || "Untitled";
    body.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "row-meta";
    const count = state.counts ? state.counts.get(doc.id) : null;
    meta.textContent = count == null ? "" : `${count} note${count === 1 ? "" : "s"}`;

    row.append(tile, body, meta);
    row.addEventListener("click", () => openDoc(doc.id));
    return row;
  }

  // --------------------------------------------------------------- the page

  async function openDoc(docId) {
    const doc = state.docs.find(d => d.id === docId);
    if (!doc) return;
    state.selected = docId;
    location.hash = docId;
    closeSharePanel();
    state.share = null;
    for (const row of document.querySelectorAll(".row")) {
      row.classList.toggle("selected", row.dataset.docId === docId);
    }
    beginLoading(doc.name);
    document.getElementById("shell").classList.remove("browsing");

    try {
      present(doc, await loadDoc(docId));
    } catch (error) {
      $("doc-meta").textContent = "";
      showError($("doc-error"), error, "load");
    }
  }

  function beginLoading(name) {
    $("doc-title").textContent = name || "Untitled";
    $("doc-meta").textContent = "Loading";
    $("page").textContent = "";
    if (state.practice) { state.practice.destroy(); state.practice = null; }
    $("practice").textContent = "";
    showError($("doc-error"), null);
  }

  // The rows of one doc, the same five lists a share link is answered with.
  // Regions are asked for by NOTE, not by media row: a legacy region carries
  // a null `media_id` and binds to the note's first image.
  async function loadDoc(docId) {
    return Backend.doc(docId);
  }

  function present(doc, rows) {
    Media.reset(rows.media || [], rows.occlusion || []);
    const cardFlags = new Map();
    for (const c of rows.cards || []) {
      const existing = cardFlags.get(c.note_id);
      cardFlags.set(c.note_id, { detached: (existing && existing.detached) || !!c.detached });
    }
    const diagrams = Media.diagramsByNote();
    const blocks = Model.build(rows.notes || [], cardFlags, new Set(diagrams.keys()));
    state.current = {
      doc,
      blocks,
      cards: Cards.deck(blocks, rows.cards || []),
      style: Render.docStyle(doc.style),
    };
    ensureDocFont(state.current.style.family);
    const n = state.current.cards.length;
    $("doc-meta").textContent = n ? `${n} card${n === 1 ? "" : "s"}` : "No cards";
    $("tab-cards").textContent = n ? `Cards ${n}` : "Cards";
    drawTab();
  }

  // CUSTOM FONTS (owner 2026-09-13). An added font is a row in `font` and a
  // file in the owner's media folder, so a signed in page loads the doc's
  // family from them and the page redraws once the face arrives. A share link
  // can read neither and draws the fallback, as for a family a machine lacks.
  const loadedFonts = new Map();
  function ensureDocFont(family) {
    if (!family || Backend.isShared() || loadedFonts.has(family)) return;
    loadedFonts.set(family, (async () => {
      try {
        for (const row of Backend.fontRows(family)) {
          const bytes = await (await Backend.media(row)).arrayBuffer();
          const face = new FontFace(family, bytes, fontDescriptors(bytes));
          await face.load();
          document.fonts.add(face);
        }
      } catch (_) {
        // No font table on the project yet, or no such family.
      }
    })());
  }

  // Weight and slant from the file's OS/2 table, so a bold file is the
  // family's bold rather than a second regular.
  function fontDescriptors(bytes) {
    try {
      const v = new DataView(bytes);
      const tables = v.getUint16(4);
      for (let i = 0; i < tables; i++) {
        const at = 12 + i * 16;
        const tag = String.fromCharCode(v.getUint8(at), v.getUint8(at + 1),
                                        v.getUint8(at + 2), v.getUint8(at + 3));
        if (tag !== "OS/2") continue;
        const os2 = v.getUint32(at + 8);
        return {
          weight: String(v.getUint16(os2 + 4) || 400),
          style: (v.getUint16(os2 + 62) & 1) ? "italic" : "normal",
        };
      }
    } catch (_) { /* a collection or a damaged file: the defaults */ }
    return {};
  }

  function setTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    drawTab();
  }

  // Notes | Cards, one chip each, the chosen one in the selection tint.
  function drawTab({ keepScroll = false } = {}) {
    const scroll = keepScroll ? $("main").scrollTop : 0;
    $("tab-notes").classList.toggle("on", state.tab === "notes");
    $("tab-cards").classList.toggle("on", state.tab === "cards");
    $("tab-notes").setAttribute("aria-pressed", state.tab === "notes");
    $("tab-cards").setAttribute("aria-pressed", state.tab === "cards");
    if (state.practice) { state.practice.destroy(); state.practice = null; }
    $("page").textContent = "";
    $("practice").textContent = "";
    const current = state.current;
    if (!current) return;
    const ctx = renderContext(current.style);
    if (state.tab === "notes") {
      $("page").classList.remove("hidden");
      $("practice").classList.add("hidden");
      const paper = document.createElement("div");
      paper.className = "paper";
      paper.appendChild(Render.document(current.blocks, ctx));
      $("page").appendChild(paper);
      ctx.resolve();
    } else {
      $("page").classList.add("hidden");
      $("practice").classList.remove("hidden");
      // The faces take the doc's font and heading styles as the page does.
      Render.applyDocStyle($("practice"), current.style);
      state.practice = Cards.mount($("practice"), current.cards, ctx,
                                   { docName: current.doc.name || "" });
    }
    $("main").scrollTop = scroll;
  }

  // A picture is drawn as a placeholder first and filled in when its bytes
  // arrive, so one slow object never holds the whole document back.
  function renderContext(style) {
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
      // both appearances, and it costs no round trip.
      if (row.latex && window.katex) {
        try {
          window.katex.render(row.latex, wrap, { displayMode: false, throwOnError: false });
          return wrap;
        } catch (_) { wrap.textContent = ""; }
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
              width: opts.width || null,
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
        const crop = normalisedCrop(opts.crop || parseCrop(loaded.row.crop));
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

  function parseCrop(text) {
    if (!text) return null;
    try {
      const d = JSON.parse(text);
      if (Array.isArray(d) && d.length >= 4) return d;
      if (d && typeof d === "object") return [d.x, d.y, d.w, d.h];
    } catch (_) {}
    return null;
  }

  function normalisedCrop(values) {
    if (!Array.isArray(values) || values.length < 4) return { x: 0, y: 0, w: 1, h: 1 };
    const [x, y, w, h] = values.map(Number);
    if (![x, y, w, h].every(n => Number.isFinite(n)) || w <= 0 || h <= 0) {
      return { x: 0, y: 0, w: 1, h: 1 };
    }
    return { x, y, w, h };
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

  // ------------------------------------------------------------------ share
  //
  // One doc, one link, revocable (owner 2026-09-13). The link is
  // `<this origin>/#share=<token>` and carries nothing else. The backend keeps
  // only a hash of the token, so a link can be copied when it is made; a
  // later visit can see that a link is live and stop it, or make a new one.

  function closeSharePanel() {
    $("share-panel").classList.add("hidden");
    $("share-button").classList.remove("on");
  }

  async function toggleSharePanel() {
    if (!$("share-panel").classList.contains("hidden")) { closeSharePanel(); return; }
    if (!state.current) return;
    $("share-panel").classList.remove("hidden");
    $("share-button").classList.add("on");
    showError($("share-error"), null);
    drawSharePanel("loading");
    try {
      const live = await Backend.shares(state.current.doc.id);
      state.share = live[0] ? { id: live[0].id, url: null } : null;
      drawSharePanel();
    } catch (error) {
      state.share = null;
      drawSharePanel();
      showError($("share-error"), error, "share");
    }
  }

  function drawSharePanel(phase) {
    const live = !!state.share;
    const hasURL = live && !!state.share.url;
    $("share-doc").textContent = state.current ? state.current.doc.name || "Untitled" : "";
    $("share-state").textContent = phase === "loading" ? "Checking"
      : hasURL ? "Anyone with the link can read it"
      : live ? "A link is live. Make a new one to copy it again" : "Not shared";
    $("share-link-row").classList.toggle("hidden", !hasURL);
    $("share-create").classList.toggle("hidden", hasURL || phase === "loading");
    $("share-create").textContent = live ? "New link" : "Create link";
    $("share-stop").classList.toggle("hidden", !live);
    if (hasURL) $("share-url").value = state.share.url;
    $("share-copy").textContent = "Copy";
  }

  async function createShare() {
    if (!state.current) return;
    $("share-create").disabled = true;
    showError($("share-error"), null);
    try {
      const made = await Backend.createShare(state.current.doc.id);
      state.share = { id: made.id, url: made.url };
      drawSharePanel();
      copyShare();
    } catch (error) {
      showError($("share-error"), error, "share");
    }
    $("share-create").disabled = false;
  }

  async function stopShare() {
    if (!state.share) return;
    $("share-stop").disabled = true;
    showError($("share-error"), null);
    try {
      await Backend.revokeShare(state.share.id);
      state.share = null;
      drawSharePanel();
    } catch (error) {
      showError($("share-error"), error, "share");
    }
    $("share-stop").disabled = false;
  }

  async function copyShare() {
    const url = $("share-url").value;
    try {
      await navigator.clipboard.writeText(url);
      $("share-copy").textContent = "Copied";
    } catch (_) {
      $("share-url").select();
      $("share-copy").textContent = "Select and copy";
    }
  }

  function shareParams() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash.startsWith("share=")) return null;
    const token = new URLSearchParams(hash).get("share");
    return token ? { token } : null;
  }

  // A VISITOR: one doc, no account, nothing written.
  async function startShared(params) {
    $("signin").classList.add("hidden");
    $("shell").classList.remove("hidden");
    $("shell").classList.add("shared");
    beginLoading("Shared doc");
    try {
      await Backend.checkVersion();
      const data = await Backend.sharedDoc(params.token);
      if (!data || data.stopped || !data.notebook) {
        $("doc-title").textContent = "Not shared";
        $("doc-meta").textContent = "";
        showError($("doc-error"), new Error((data && data.stopped) || "This link has been stopped, or it never existed."), "share");
        return;
      }
      document.title = `${data.notebook.name || "Untitled"} · Recall`;
      $("doc-title").textContent = data.notebook.name || "Untitled";
      present(data.notebook, data);
    } catch (error) {
      $("doc-meta").textContent = "";
      showError($("doc-error"), error, "share");
    }
  }

  // ------------------------------------------------------------------ start

  async function start() {
    $("signin").classList.add("hidden");
    $("shell").classList.remove("hidden");
    $("shell").classList.remove("shared");
    showError($("doc-error"), null);
    try {
      await Backend.checkVersion();
      await loadLibrary();
    } catch (error) {
      // A dead credential is a pairing, not a banner over an empty library.
      if (error.authFailed) {
        Backend.signOut();
        showSignIn();
        showError($("signin-error"), error, "session");
        return;
      }
      showError($("doc-error"), error, "library");
      return;
    }
    const wanted = location.hash.replace(/^#/, "");
    if (wanted && state.docs.some(d => d.id === wanted)) openDoc(wanted);
    else if (state.docs.length === 1) openDoc(state.docs[0].id);
  }

  function boot() {
    applyAppearance(appearance());
    $("signin-form").addEventListener("submit", signIn);
    const flip = () => applyAppearance(document.documentElement.dataset.appearance === "dark" ? "light" : "dark");
    $("appearance").addEventListener("click", flip);
    $("appearance-shared").addEventListener("click", flip);
    $("signout").addEventListener("click", () => {
      Backend.signOut();
      state.selected = null;
      state.current = null;
      location.hash = "";
      showSignIn();
    });
    $("search").addEventListener("input", event => {
      state.filter = event.target.value.trim().toLowerCase();
      drawTree();
    });
    $("tab-notes").addEventListener("click", () => setTab("notes"));
    $("tab-cards").addEventListener("click", () => setTab("cards"));
    $("share-button").addEventListener("click", toggleSharePanel);
    $("share-create").addEventListener("click", createShare);
    $("share-stop").addEventListener("click", stopShare);
    $("share-copy").addEventListener("click", copyShare);
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeSharePanel();
    });

    const shared = shareParams();
    if (shared) {
      startShared(shared);
      return;
    }

    if (Backend.isSignedIn()) {
      start().catch(error => {
        showError($("signin-error"), error, "session");
        showSignIn();
      });
    } else {
      showSignIn();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
