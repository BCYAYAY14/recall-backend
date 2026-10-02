// The shell: pairing, the sidebar (Library, then the places), the title bar,
// the pages, a doc (Notes | Cards, the editor, Share, its deadline and its
// own scheduling), the sheets and the bottom stack. Hash routes:
//
//   #today  #docs  #doc/<id>  #doc/<id>/cards  #doc/<id>/edit  #cards
//   #knowledge  #settings  #settings/<page>  #share=<token> (a visitor)
//
// A PAIRED browser is a device with full scope (ruling W-0): it studies with
// real FSRS grades and edits notes, and every write goes out as whole rows
// through Backend. A SHARE LINK is one doc for a visitor with no account:
// read only for ever, its Cards tab a practice that saves nothing.

(() => {

  const { h, clear, chip, control, icon, docMark, folderGlyph, tile, sheet, closeSheet, group, valueRow, stepper,
          toggle, plural, eyebrow } = UI;
  const $ = id => document.getElementById(id);
  const wide = () => window.matchMedia("(min-width: 700px)").matches;
  const MODE_KEY = "recall.viewer.appearance";

  const state = {
    route: null,
    filter: "",
    cardQuery: "",
    editor: null,       // the mounted editor's handle
    bar: null,          // the format strip over it
    revealNote: null,   // a note the palette opened, shown once the editor mounts
    practice: null,     // the mounted practice column's handle
    share: null,        // the live share row for the open doc, when known
    shared: null,       // a visitor's resolved document
    renderQueued: false,
    mediaVersion: -1,
  };

  // ------------------------------------------------------------- appearance

  function modeOverride() {
    const v = localStorage.getItem(MODE_KEY);
    return v === "light" || v === "dark" ? v : null;
  }

  // Light and dark: this browser's override, else the library's Mode from the
  // settings lane when paired, else the system's (prefers-color-scheme).
  function applyAppearance() {
    const paired = Backend.loaded && !Backend.isShared();
    const s = paired ? Backend.library().settings : null;
    let mode = modeOverride();
    if (!mode && s && s.appearance === 1) mode = "light";
    if (!mode && s && s.appearance === 2) mode = "dark";
    if (!mode) mode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    const root = document.documentElement;
    const theme = s ? s.theme : "recall";
    const changed = root.dataset.appearance !== mode || root.dataset.theme !== theme;
    root.dataset.appearance = mode;
    root.dataset.theme = theme;
    return changed;
  }

  function flipMode() {
    const now = document.documentElement.dataset.appearance === "dark" ? "light" : "dark";
    localStorage.setItem(MODE_KEY, now);
    applyAppearance();
    render();
  }

  function clearModeOverride() { localStorage.removeItem(MODE_KEY); }

  // ----------------------------------------------------------------- errors

  function showError(error, context) {
    if (!error) return;
    UI.banner($("banners"), { id: context || "error", source: context ? context[0].toUpperCase() + context.slice(1) : "Recall",
                              message: String(error.message || error) });
  }

  // ---------------------------------------------------------------- sign in

  function showSignIn(message) {
    $("signin").classList.remove("hidden");
    $("shell").classList.add("hidden");
    const err = $("signin-error");
    err.classList.toggle("hidden", !message);
    err.textContent = message || "";
  }

  async function signIn(event) {
    event.preventDefault();
    const button = $("signin-button");
    button.disabled = true;
    $("signin-error").classList.add("hidden");
    try {
      await Backend.pair($("pair-code").value, $("pair-label").value);
      $("pair-code").value = "";
      await start();
    } catch (error) {
      showSignIn(String(error.message || error));
    }
    button.disabled = false;
  }

  // Signing out erases this browser's copy with its credential, so changes
  // not yet sent are lost: the sheet says how many first.
  function signOut() {
    const pending = Backend.pendingCount();
    const leave = () => {
      if (state.editor) { state.editor.destroy(); state.editor = null; }
      Backend.signOut();
      location.hash = "";
      showSignIn(null);
    };
    sheet({ title: "Sign Out", left: "Cancel", right: "Sign Out",
      body: [h("p.sheet-text", { text: pending
        ? `${plural(pending, "change")} made here ${pending === 1 ? "has" : "have"} not reached the backend yet, and signing out now loses ${pending === 1 ? "it" : "them"}. This browser's copy of the library is erased.`
        : "This browser forgets its credential and erases its copy of the library. Pair it again from Recall to use it." })],
      onRight: () => { leave(); } });
    document.querySelector(".sheet .bar-right").classList.add("danger");
  }

  // ------------------------------------------------------------------ route

  function parseRoute() {
    const hash = location.hash.replace(/^#/, "");
    if (hash.startsWith("share=")) return { name: "share" };
    if (/^[0-9a-f-]{36}$/.test(hash)) return { name: "doc", id: hash, tab: "notes" };
    const [name, a, b] = hash.split("/");
    switch (name) {
      case "doc": return { name: "doc", id: a, tab: b === "cards" ? "cards" : b === "edit" ? "edit" : "notes" };
      case "docs": return { name: "docs" };
      case "cards": return { name: "cards" };
      case "knowledge": return { name: "knowledge" };
      case "settings": return { name: "settings", sub: a || null };
      default: return { name: "today" };
    }
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function openDoc(id, tab, noteId) {
    if (noteId) { state.revealNote = noteId; tab = "edit"; }
    go(`#doc/${id}${tab && tab !== "notes" ? "/" + tab : ""}`);
  }

  function docStyleOf(doc) {
    return Render.docStyle(doc ? doc.style : null, Backend.styleDefaults());
  }

  // --------------------------------------------------------------- titlebar

  function titlebar(title, sub, tools, back) {
    const bar = clear($("titlebar"));
    if (back) bar.appendChild(h("button.back", { type: "button", "aria-label": "Back", onclick: back }, icon("back", 16)));
    bar.appendChild(h("div.title-stack", h("h1.page-title", { text: title }), sub ? h("div.page-sub", { text: sub }) : null));
    bar.appendChild(h("div.title-tools", tools || []));
    // A doc's four tools take the phone's whole width: they drop to a row of
    // their own there rather than squeezing the title to three letters.
    bar.classList.toggle("crowded", (tools || []).filter(Boolean).length > 2);
    document.title = `${title} · Recall`;
  }

  // ---------------------------------------------------------------- sidebar

  function drawSidebar() {
    const L = Backend.library();
    const now = Date.now();
    const perDoc = Sched.docDue(L, now);
    const route = state.route || {};
    const tree = clear($("tree"));
    const docs = Pages.liveDocs(L).filter(d => !state.filter || String(d.name || "").toLowerCase().includes(state.filter));
    const folders = Pages.liveFolders(L);
    const row = (d, indent) => {
      const b = h("button.side-row", { type: "button", onclick: () => openDoc(d.id), dataset: { docId: d.id } },
        h("span.side-glyph", docMark(14)), h("span.side-name", { text: d.name || "Untitled" }),
        perDoc.get(d.id) ? h("span.side-count", { text: String(perDoc.get(d.id)) }) : null);
      if (indent) b.classList.add("indent");
      if (route.name === "doc" && route.id === d.id) b.classList.add("on");
      return b;
    };
    const filed = new Set();
    for (const f of folders) {
      const members = docs.filter(d => d.folder_id === f.id);
      if (state.filter && !members.length) continue;
      members.forEach(d => filed.add(d.id));
      tree.appendChild(h("div.side-folder", h("span.side-glyph", folderGlyph(13)), h("span.side-name", { text: f.name || "Folder" })));
      for (const d of members) tree.appendChild(row(d, true));
    }
    for (const d of docs) if (!filed.has(d.id)) tree.appendChild(row(d, false));
    if (!tree.children.length) tree.appendChild(h("div.side-empty", { text: state.filter ? "No doc matches that." : "This library is empty." }));

    const dc = Sched.dueCounts(L, now, L.settings.newPerDay);
    const places = clear($("places"));
    const place = (name, label, glyph, hash, count) => {
      const b = h("button.side-row", { type: "button", onclick: () => go(hash) },
        h("span.side-glyph", icon(glyph, 14)), h("span.side-name", { text: label }),
        count ? h("span.side-count", { text: String(count) }) : null);
      if (route.name === name) b.classList.add("on");
      return b;
    };
    places.append(place("today", "Today", "today", "#today", dc.total), place("cards", "Flashcards", "cards", "#cards"),
                  place("knowledge", "Statistics", "chart", "#knowledge"), place("settings", "Settings", "gear", "#settings"));
    drawSyncLine();
  }

  function drawSyncLine() {
    const st = Backend.status;
    const line = clear($("sync-line"));
    const words = st.phase === "syncing" ? "syncing"
      : st.phase === "offline" ? "offline"
      : st.phase === "error" ? "not synced"
      : st.live ? "live"
      : st.lastSync ? "synced " + UI.ago(st.lastSync) : "connecting";
    line.append(h("span.sync-dot", { className: st.live && st.phase === "idle" ? "live" : st.phase }), `Cloudflare · ${words}`);
    const pending = Backend.pendingCount();
    if (pending) line.append(` · ${pending} to send`);
  }

  function drawTabbar() {
    const r = state.route || {};
    for (const b of $("tabbar").querySelectorAll("button")) {
      const on = b.dataset.tab === "today" ? r.name === "today"
        : b.dataset.tab === "docs" ? ["docs", "doc", "cards", "knowledge"].includes(r.name)
        : r.name === "settings";
      b.classList.toggle("on", on);
    }
  }

  // ------------------------------------------------------------------ render

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => { state.renderQueued = false; render(); });
  }

  function syncMedia() {
    if (Backend.isShared() || state.mediaVersion === Backend.version) return;
    const L = Backend.library();
    Media.reset([...L.media.values()].filter(m => m.deleted_at == null), L.occlusion.filter(o => o.deleted_at == null));
    state.mediaVersion = Backend.version;
  }

  function render() {
    if (Backend.isShared()) { drawShared(); return; }
    if (!Backend.loaded) return;
    applyAppearance();
    syncMedia();
    const route = parseRoute();
    const sameDocEdit = state.route && state.route.name === "doc" && route.name === "doc"
      && state.route.id === route.id && route.tab === "edit" && state.route.tab === "edit" && state.editor
      && !state.layoutChanged;
    state.layoutChanged = false;
    state.route = route;
    drawSidebar();
    drawTabbar();
    drawSyncBanner();
    if (sameDocEdit) {
      state.editor.refresh();
      drawDocHeader(route);
      if (state.bar) state.bar.update(state.editor);
      drawCount(route.id);
      return;
    }
    if (state.editor) { state.editor.destroy(); state.editor = null; }
    state.bar = null;
    state.countNode = null;
    if (state.practice) { state.practice.destroy(); state.practice = null; }
    const view = $("view");
    const keep = view.scrollTop;
    clear(view);
    view.className = "view";
    let page;
    switch (route.name) {
      case "docs": page = Pages.library(app); break;
      case "cards": page = Pages.flashcards(app, state); break;
      case "knowledge": page = Pages.knowledge(app); break;
      case "settings": page = Pages.settings(app, route.sub); break;
      case "doc": page = drawDoc(route); break;
      default: page = Pages.today(app); break;
    }
    if (page) view.appendChild(page);
    const same = state.lastRouteKey === routeKey(route);
    if (same) view.scrollTop = keep;
    else view.classList.add("route-in");
    state.lastRouteKey = routeKey(route);
  }

  const routeKey = r => [r.name, r.id, r.tab, r.sub].join("/");

  // -------------------------------------------------------------- a doc

  function docCounts(docId) {
    const L = Backend.library();
    const facts = Pages.docFacts(L);
    return { notes: facts.notes.get(docId) || 0, cards: facts.cards.get(docId) || 0, edited: facts.edited.get(docId) };
  }

  // "Kinds · 12 notes · 3 cards · edited 6:40": the title, then the facts.
  function drawDocHeader(route) {
    const doc = Backend.get("notebook", route.id);
    if (!doc) return;
    const c = docCounts(doc.id);
    const L = Backend.library();
    const due = Sched.docDueCount(L, doc.id, Date.now(), L.settings.newPerDay);
    // The due count is stated in read mode too (owner's punch list,
    // 2026-09-30), as the app's doc header states it.
    const meta = [plural(c.notes, "note"), plural(c.cards, "card"), due ? `${due} due` : null, UI.edited(c.edited)]
      .filter(Boolean).join(" · ");
    const exam = Sched.examDeadline(L, doc.id, Date.now());
    const tools = [];
    const kept = Backend.versions(doc.id).length;
    if (kept) tools.push(chip(`Kept ${kept}`, { title: "Kept versions", onclick: () => keptVersionsSheet(doc.id) }));
    if (wide()) {
      tools.push(chip("Notes", { on: route.tab === "notes", onclick: () => openDoc(doc.id) }),
                 chip("Cards", { on: route.tab === "cards", onclick: () => openDoc(doc.id, "cards") }),
                 chip("Quiz", { onclick: () => quiz(doc.id) }));
    }
    tools.push(chip(route.tab === "edit" ? "Done" : "Edit", { on: route.tab === "edit", onclick: () => openDoc(doc.id, route.tab === "edit" ? "notes" : "edit") }),
               chip("Share", { onclick: () => shareSheet(doc) }),
               chip("⋯", { title: "More", onclick: event => docMenu(doc, event.currentTarget) }));
    // Study is one fixed slot (Ink 18 R9): disabled with nothing due, never gone.
    tools.push(control(due ? `Study ${due}` : "Study", { disabled: !due, onclick: () => study({ kind: "doc", id: doc.id }) }));
    const sub = exam ? `${meta} · deadline ${new Date(exam).toLocaleDateString([], { day: "numeric", month: "short" })}` : meta;
    titlebar(doc.name || "Untitled", sub, tools, wide() ? null : () => go("#docs"));
  }

  function drawDoc(route) {
    const doc = Backend.get("notebook", route.id);
    if (!doc || doc.deleted_at != null) {
      titlebar("Not found", null, []);
      return h("div.page", h("p.empty", { text: "This doc is not in the library. It may have been deleted." }));
    }
    drawDocHeader(route);
    const view = $("view");
    const wrap = h("div.doc-page");
    if (!wide()) {
      wrap.appendChild(h("div.segmented.doc-seg", { role: "group", "aria-label": "Notes or cards" },
        ["notes", "cards"].map(t => h("button", { type: "button", text: t === "notes" ? "Notes" : "Cards",
          className: (route.tab === t || (t === "notes" && route.tab === "edit")) ? "on" : null, onclick: () => openDoc(doc.id, t) }))));
    }
    if (route.tab === "cards") {
      view.classList.add("tinted");
      wrap.appendChild(docCards(doc));
      return wrap;
    }
    const paper = h("div.paper");
    if (route.tab === "edit") {
      const bar = formatBar(doc.id);
      state.bar = bar;
      wrap.append(bar.node, h("div.desk", paper), countFooter(doc.id));
      queueMicrotask(() => {
        state.editor = Editor.mount(paper, doc.id, {
          onError: e => showError(e, "edit"),
          onNotice: text => UI.banner($("banners"), { id: "edit", source: "Edit", message: text }),
          askLink: (prefill, apply) => linkSheet(prefill, apply),
          pastePicture: (file, afterId) => pastePicture(doc.id, file, afterId),
          syncMedia: () => syncMedia(),
          onFocusLine: api => bar.update(api),
          openDrawing: ({ noteId, mediaId }) => editDrawing(doc.id, noteId, mediaId),
          openOcclusion: source => openOcclusion(doc.id, source),
          showCardInfo: cardId => cardInfoSheet(cardId),
        });
        bar.update(state.editor);
        if (state.revealNote) { const id = state.revealNote; state.revealNote = null; state.editor.reveal(id); }
      });
      return wrap;
    }
    wrap.append(h("div.desk", paper), countFooter(doc.id));
    const rows = Backend.doc(doc.id);
    const flags = new Map();
    for (const c of rows.cards) {
      const e = flags.get(c.note_id);
      flags.set(c.note_id, { detached: (e && e.detached) || !!c.detached });
    }
    const diagrams = Media.diagramsByNote();
    const blocks = Model.build(rows.notes, flags, new Set(diagrams.keys()));
    const style = docStyleOf(doc);
    ensureDocFont(style.family);
    const ctx = Pictures.context(style);
    const canvas = Render.document(blocks, ctx);
    if (style.language) canvas.setAttribute("lang", style.language);
    canvas.addEventListener("dblclick", () => openDoc(doc.id, "edit"));
    paper.appendChild(canvas);
    if (!blocks.length) paper.appendChild(h("p.empty", { text: "Nothing here yet. Edit to write the first line." }));
    // A4 pages (K1) once the pictures have their sizes.
    const paged = (Backend.library().settingsValues || {}).page_layout === "1";
    ctx.resolve().then(() => { if (paged && canvas.isConnected) Render.paginate(canvas, true); });
    if (paged) requestAnimationFrame(() => { if (canvas.isConnected) Render.paginate(canvas, true); });
    return wrap;
  }

  // A doc's cards as a list: question, answer, when (`relativeDue`).
  function docCards(doc) {
    const L = Backend.library();
    const now = Date.now();
    const page = h("div.page.flashcards");
    const rowsIn = [];
    const visit = b => {
      for (const c of L.cards.filter(x => x.note_id === b.id && x.deleted_at == null)
        .sort((a, x) => (a.cloze_ordinal ?? -2) - (x.cloze_ordinal ?? -2))) {
        const faces = Pages.cardText(b, c);
        const when = c.suspended ? "suspended" : c.detached ? "detached" : c.state === "new" ? "new" : Sched.relativeDue(Date.parse(c.due), now);
        const row = h("div.cardlist-row", h("span.card-dot"), h("span.card-q", { text: faces.q }),
          h("span.card-a", { text: faces.a }), h("span.card-due", { text: when }));
        if (c.suspended) row.classList.add("suspended");
        if (c.detached) row.classList.add("detached");
        rowsIn.push(row);
      }
    };
    for (const b of Study.blocksFor(doc.id)) { visit(b); for (const r of b.rows || []) visit(r); }
    page.append(eyebrow("Cards", plural(rowsIn.length, "card")),
      rowsIn.length ? UI.block(rowsIn) : h("p.empty", { text: "No cards in this doc yet. A line with >> in it makes one." }));
    return page;
  }

  // CUSTOM FONTS: an added font is a `font` row and a file, so a paired page
  // loads the doc's family and redraws once the face arrives. Calibri is
  // never served (landmine 195): it is the app's own bundled face.
  const loadedFonts = new Map();
  function ensureDocFont(family) {
    if (!family || family === "Calibri" || Backend.isShared() || loadedFonts.has(family)) return;
    loadedFonts.set(family, (async () => {
      try {
        for (const row of Backend.fontRows(family)) {
          const bytes = await (await Backend.media(row)).arrayBuffer();
          const face = new FontFace(family, bytes, fontDescriptors(bytes));
          await face.load();
          document.fonts.add(face);
        }
      } catch (_) { /* no such family on this backend */ }
    })());
  }

  function fontDescriptors(bytes) {
    try {
      const v = new DataView(bytes);
      const tables = v.getUint16(4);
      for (let i = 0; i < tables; i++) {
        const at = 12 + i * 16;
        const tag = String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));
        if (tag !== "OS/2") continue;
        const os2 = v.getUint32(at + 8);
        return { weight: String(v.getUint16(os2 + 4) || 400), style: (v.getUint16(os2 + 62) & 1) ? "italic" : "normal" };
      }
    } catch (_) { /* a collection or a damaged file */ }
    return {};
  }

  // ---------------------------------------------------------------- study

  function study(scope) {
    if (Study.isOpen()) return;
    try {
      const started = Study.start(scope, { onClose: () => render(), openDoc: id => openDoc(id) });
      if (!started) showError(new Error("Nothing is due here right now."), "study");
    } catch (error) {
      showError(error, "study");
    }
  }

  // ---------------------------------------------------------------- sheets

  function docMenu(doc, anchor) {
    const L = Backend.library();
    const exam = Sched.examDeadline(L, doc.id, Date.now());
    const k = Sched.knobs(L, { kind: "doc", id: doc.id }, L.settings.retention, L.settings.newPerDay);
    const kept = Backend.versions(doc.id).length;
    const style = docStyleOf(doc);
    sheet({
      title: doc.name || "Untitled", right: "Done",
      body: [group(null, [
        valueRow("Rename", null, { onclick: () => renameSheet(doc) }),
        valueRow("Study deadline", exam ? new Date(exam).toLocaleDateString([], { day: "numeric", month: "short" }) : "None", { onclick: () => deadlineSheet(doc) }),
        valueRow("Scheduling", `${k.retention}% · ${k.newPerDay} a day`, { onclick: () => schedulingSheet(doc) }),
        valueRow("Study every card now", null, { onclick: () => { closeSheet(); cramDoc(doc); } }),
      ]), group("Write", [
        valueRow("Make Cards", null, { onclick: () => { closeSheet(); makeCards(doc.id); } }),
        valueRow("Quiz", null, { onclick: () => { closeSheet(); quiz(doc.id); } }),
        valueRow("Text styles", style.family || "San Francisco", { onclick: () => textStylesSheet(doc.id) }),
        valueRow("Word count", `${Words.count(Study.blocksFor(doc.id)).words} words`, { onclick: () => wordCountSheet(doc.id) }),
        kept ? valueRow("Kept versions", String(kept), { onclick: () => keptVersionsSheet(doc.id) }) : null,
      ].filter(Boolean)), group("Files", [
        valueRow("Import into this doc", "CSV, Markdown, text", { onclick: () => { closeSheet(); importNotes(doc.id); } }),
        valueRow("Print or save as PDF", null, { onclick: () => { closeSheet(); printDoc(doc.id); } }),
      ]), UI.block(valueRow("Delete doc", null, { danger: true, onclick: () => deleteSheet(doc) }))],
    });
  }

  // Cram: the doc's cards now, due or not; grades schedule for real.
  function cramDoc(doc) {
    try {
      if (!Study.start({ kind: "doc", id: doc.id }, { onClose: () => render(), openDoc: id => openDoc(id), cram: true })) {
        showError(new Error("This doc has no cards yet."), "study");
      }
    } catch (error) { showError(error, "study"); }
  }

  // D-011's question, as the canvas asks it: the address the selected words
  // open. The words stay selected behind it.
  function linkSheet(prefill, apply) {
    const field = h("input.field", { type: "url", value: prefill || "", placeholder: "https://", maxlength: 2048, "aria-label": "Address" });
    sheet({ title: "Link", left: "Cancel", right: "Link",
      body: [group("Address", [h("div.value-row", field)], "The address the selected words open.")],
      onRight: () => { apply(field.value); } });
    field.addEventListener("keydown", e => { if (e.key === "Enter") document.querySelector(".sheet .bar-right").click(); });
    // The words offered are selected, so typing an address replaces them.
    setTimeout(() => { if (field.isConnected) field.select(); }, 60);
  }

  function renameSheet(doc) {
    const field = h("input.field", { type: "text", value: doc.name || "", maxlength: 200, "aria-label": "Name" });
    sheet({ title: "Rename", left: "Cancel", right: "Save",
      body: [group("Name", [h("div.value-row", field)])],
      onRight: () => { try { Store.renameDoc(doc.id, field.value); render(); } catch (e) { showError(e, "rename"); } } });
    field.addEventListener("keydown", e => { if (e.key === "Enter") document.querySelector(".sheet .bar-right").click(); });
  }

  function newDoc() {
    const field = h("input.field", { type: "text", placeholder: "Doc name", maxlength: 200, "aria-label": "Name" });
    sheet({ title: "New Doc", left: "Cancel", right: "Create",
      body: [group("Name", [h("div.value-row", field)], "A doc holds notes. Every line with >> in it becomes a card.")],
      onRight: () => {
        try { const id = Store.createDoc(field.value || "Untitled"); openDoc(id, "edit"); }
        catch (e) { showError(e, "new doc"); }
      } });
    field.addEventListener("keydown", e => { if (e.key === "Enter") document.querySelector(".sheet .bar-right").click(); });
  }

  function deleteSheet(doc) {
    const c = docCounts(doc.id);
    sheet({ title: "Delete Doc", left: "Cancel", right: "Delete",
      body: [h("p.sheet-text", { text: `${doc.name || "Untitled"} and its ${plural(c.notes, "note")} and ${plural(c.cards, "card")} go to Recently deleted for 30 days, on every device.` })],
      onRight: () => {
        try { Store.deleteDoc(doc.id); go("#today"); }
        catch (e) { showError(e, "delete"); }
      } });
    document.querySelector(".sheet .bar-right").classList.add("danger");
  }

  function dateInputValue(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Study Deadline: every interval is clamped to the day, and new cards ramp
  // so all of them are seen before it (S12: "Choose a day" until one is).
  function deadlineSheet(doc) {
    const L = Backend.library();
    const current = Sched.rawExam(L, L.docs.get(doc.id));
    const input = h("input.field.date", { type: "date", min: dateInputValue(Date.now()), value: current && !doc.exam_at ? "" : (doc.exam_at ? dateInputValue(Date.parse(doc.exam_at)) : ""), "aria-label": "Exam day" });
    const daysLeft = h("span.value", { text: "Choose a day" });
    const pulled = h("span.value", { text: "Choose a day" });
    const chosen = () => {
      if (!input.value) return null;
      const [y, m, d] = input.value.split("-").map(Number);
      return new Date(y, m - 1, d).getTime();
    };
    const update = () => {
      const day = chosen();
      if (day == null) { daysLeft.textContent = "Choose a day"; pulled.textContent = "Choose a day"; return; }
      daysLeft.textContent = `${Math.max(1, Sched.daysBetween(Date.now(), day))} d`;
      pulled.textContent = `+${Store.deadlinePullCount(doc.id, day)} reviews`;
    };
    input.addEventListener("input", update);
    update();
    const rows = [group(doc.name || "Untitled", [h("div.value-row", h("span.value-label", { text: "Exam day" }), input)]),
      group("Before the exam", [h("div.value-row", h("span.value-label", { text: "Days left" }), daysLeft),
                                h("div.value-row", h("span.value-label", { text: "Reviews brought forward" }), pulled)],
            "Every interval is clamped to the day, and new cards ramp so all of them are seen before it.")];
    if (doc.exam_at) rows.push(UI.block(valueRow("Clear the deadline", null, { danger: true, onclick: () => {
      try { Store.setDeadline(doc.id, null); closeSheet(); render(); } catch (e) { showError(e, "deadline"); }
    } })));
    sheet({ title: "Study Deadline", left: "Cancel", right: "Set", body: rows,
      onRight: () => {
        const day = chosen();
        if (day == null) return false;
        try { Store.setDeadline(doc.id, day); render(); } catch (e) { showError(e, "deadline"); }
      } });
  }

  // Scheduling: a doc can keep its own numbers; off follows Settings (C-76).
  function schedulingSheet(doc) {
    const L = Backend.library();
    const s = L.settings;
    let ret = doc.retention_pct, cap = doc.new_per_day;
    const body = h("div");
    const draw = () => {
      clear(body);
      const retRows = [valueRow("Desired retention", toggle(ret != null, on => { ret = on ? s.retention : null; draw(); }, "Own retention"),
        { sub: ret == null ? `Follows Settings · ${s.retention}%` : "This doc's own" })];
      if (ret != null) retRows.push(valueRow("Retention", stepper(ret, { min: 70, max: 97, format: v => `${v}%`, onchange: v => { ret = v; } })));
      const capRows = [valueRow("New cards per day", toggle(cap != null, on => { cap = on ? s.newPerDay : null; draw(); }, "Own new cards per day"),
        { sub: cap == null ? `Follows Settings · ${s.newPerDay}` : "This doc's own" })];
      if (cap != null) capRows.push(valueRow("Cap", stepper(cap, { min: 0, max: 200, onchange: v => { cap = v; } })));
      body.append(group(doc.name || "Untitled", [...retRows, ...capRows], "A doc can keep its own numbers. Off follows Settings."));
    };
    draw();
    sheet({ title: "Scheduling", left: "Cancel", right: "Save", body: [body],
      onRight: () => { try { Store.setDocKnobs(doc.id, ret, cap); render(); } catch (e) { showError(e, "scheduling"); } } });
  }

  // Share: one doc, one link (owner 2026-09-13). The backend keeps only a
  // hash of the token, so a link can be copied when it is made; a later
  // visit can see that one is live and stop it, or make a new one.
  function shareSheet(doc) {
    const body = h("div");
    let live = null;
    let phase = "loading";
    let error = null;
    const draw = () => {
      clear(body);
      const rows = [valueRow("Anyone with the link can read", phase === "loading" ? "Checking" : live ? (live.url ? "Live" : "Live, copied once") : "Not shared")];
      if (live && live.url) {
        const url = h("span.mono-url", { text: live.url });
        const copy = chip("Copy", { onclick: async () => {
          try { await navigator.clipboard.writeText(live.url); copy.textContent = "Copied"; }
          catch (_) { const r = document.createRange(); r.selectNodeContents(url); getSelection().removeAllRanges(); getSelection().addRange(r); copy.textContent = "Select and copy"; }
        } });
        rows.push(h("div.value-row", url, copy));
      }
      body.appendChild(group("Link", rows, live && !live.url ? "Only a hash of a link is kept, so it cannot be copied again. Make a new one instead." : null));
      const foot = h("div.sheet-foot");
      if (live) foot.appendChild(chip("Stop sharing", { className: "danger", onclick: stop }));
      foot.appendChild(h("span.spacer"));
      if (phase !== "loading" && !(live && live.url)) foot.appendChild(control(live ? "New link" : "Create link", { onclick: create }));
      body.appendChild(foot);
      if (error) body.appendChild(h("p.help.error-line", { text: error }));
    };
    async function create() {
      error = null;
      try { const made = await Backend.createShare(doc.id); live = { id: made.id, url: made.url }; }
      catch (e) { error = e.message; }
      draw();
      if (live && live.url) { try { await navigator.clipboard.writeText(live.url); } catch (_) {} }
    }
    async function stop() {
      error = null;
      try { await Backend.revokeShare(live.id); live = null; } catch (e) { error = e.message; }
      draw();
    }
    sheet({ title: `Share ${doc.name || "Untitled"}`, right: "Done", body: [body] });
    draw();
    Backend.shares(doc.id).then(list => { live = list[0] ? { id: list[0].id, url: null } : null; phase = "ready"; draw(); })
      .catch(e => { phase = "ready"; error = e.message; draw(); });
  }

  function recentlyDeletedSheet() {
    const L = Backend.library();
    const items = Pages.recentlyDeletedDocs(L);
    const rows = items.map(d => {
      const w = Store.deletedWith(d.id);
      const before = Backend.contentBefore("notebook", d.id);
      const name = before ? before.content.name : "A doc deleted on another device";
      const when = Sched.daysBetween(Date.parse(d.deleted_at), Date.now());
      const meta = `doc · deleted ${when === 0 ? "today" : when === 1 ? "yesterday" : when + " d ago"} · ${plural(w ? w.notes.length : 0, "note")}`;
      return h("div.value-row", h("span.value-stack", h("span.value-label", { text: name }), h("span.value-sub", { text: meta })),
        Store.canRestore(d.id)
          ? control("Restore", { onclick: () => { try { Store.restoreDoc(d.id); closeSheet(); render(); } catch (e) { showError(e, "restore"); } } })
          : h("span.value", { text: "Restore in Recall" }));
    });
    sheet({ title: "Recently Deleted", right: "Done",
      body: [group("Waiting", rows.length ? rows : [valueRow("Nothing deleted in the last 30 days", null)],
        "A row goes for good 30 days after it was deleted, on every device. A tombstone carries no text, so a doc deleted elsewhere is restored from Recall.")] });
  }

  async function devicesSheet() {
    const body = h("div", h("p.help", { text: "Loading" }));
    sheet({ title: "Devices", right: "Done", body: [body] });
    try {
      const list = await Backend.devices();
      clear(body);
      const kind = p => ({ mac: "Mac", ios: "iPhone", web: "Browser" })[p] || "Device";
      body.appendChild(group("Paired", list.map(d => valueRow(d.label + (d.this_device ? " (this browser)" : ""),
        d.revoked_at ? "removed" : kind(d.platform), { sub: d.last_seen_at ? "seen " + UI.ago(Date.parse(d.last_seen_at)) : null })),
        "Remove a device from Recall's device list on the Mac or the phone; a removed browser is signed out and its copy erased."));
    } catch (e) {
      clear(body);
      body.appendChild(h("p.help", { text: e.message }));
    }
  }

  // ------------------------------------------------------- the format strip

  // The strip at the top of the doc (Ink 17 section 3, D22): style and list
  // menus, the doc's ONE font, the size, the inline styles, then the blocks
  // (make card, drawing, table, picture, diagram). Its lit states follow the
  // caret (landmine 98). A button takes no focus, so the line keeps its
  // selection; a menu takes it, and the editor acts on the selection it
  // remembered.
  const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48];
  const FAMILIES = ["San Francisco", "Arial", "Calibri", "Times New Roman"];
  const HIGHLIGHTS = [["Plain", undefined], ["Yellow", "#e8c34a"], ["Blue", "#7ec8f2"], ["Purple", "#b98be8"],
                      ["Pink", "#e88ab0"], ["Grey", "#9aa0a8"], ["None", null]];

  function formatBar(docId) {
    const ed = () => state.editor;
    const keep = el => { el.addEventListener("mousedown", e => e.preventDefault()); return el; };
    const select = (label, options, onchange, className) => {
      const s = h("select.fmt-select", { "aria-label": label, title: label, className });
      for (const [value, text] of options) s.appendChild(h("option", { value, text }));
      s.addEventListener("change", () => { onchange(s.value); });
      return s;
    };
    const kindSel = select("Paragraph style", [["paragraph", "Normal"], ["heading1", "Heading 1"], ["heading2", "Heading 2"],
      ["heading3", "Heading 3"], ["quote", "Quote"], ["", "List"]], v => { if (v && ed()) ed().setKind(v); });
    kindSel.lastElementChild.hidden = true;
    const listSel = select("List", [["", "No list"], ["bullet", "• Bullets"], ["dash", "– Dashes"], ["numbered", "1. Numbers"],
      ["checkbox", "☐ Tasks"]], v => { if (ed()) ed().setKind(v || "paragraph"); });
    const families = [...new Set([...FAMILIES, ...Backend.library().fonts.filter(f => f.deleted_at == null).map(f => f.family)])];
    const fontSel = select("Font", families.map(f => [f, f]), v => {
      try {
        const lib = Backend.styleDefaults().fontFamily;
        Store.setDocStyle(docId, { f: v === "San Francisco" && !lib ? null : v });
        if (ed()) ed().rerender();
      } catch (e) { showError(e, "font"); }
    });
    const sizeSel = select("Size", SIZES.map(n => [String(n), String(n)]), v => { if (ed()) ed().format("z", v === "11" ? null : Number(v)); });
    const toggles = {};
    const tbtn = (kind, label, title) => {
      const b = keep(h("button.fmt-btn", { type: "button", title, "aria-label": title, "aria-pressed": "false", text: label,
        dataset: { kind }, onclick: () => { if (ed()) { ed().format(kind); bar.update(ed()); } } }));
      toggles[kind] = b;
      return b;
    };
    const hlSel = select("Highlight", HIGHLIGHTS.map(([name]) => [name, name]), v => {
      const pick = HIGHLIGHTS.find(x => x[0] === v);
      if (pick && ed()) ed().format("h", pick[1]);
      hlSel.value = "";
    }, "fmt-highlight");
    hlSel.insertBefore(h("option", { value: "", text: "Highlight", hidden: true }), hlSel.firstChild);
    hlSel.value = "";
    const tableSel = select("Table", [["", "⊞"], ["table", "Table"], ["cards", "Card table"]], v => {
      tableSel.value = "";
      if (v) insertTable(docId, v === "cards");
    }, "fmt-icon");
    const act = (label, title, run) => keep(h("button.fmt-btn", { type: "button", title, "aria-label": title, text: label, onclick: run }));
    // Drawn icons, never a stand-in glyph (owner's punch list, 2026-09-30).
    const iact = (name, title, run) => keep(h("button.fmt-btn", { type: "button", title, "aria-label": title, onclick: run }, UI.icon(name, 16)));
    // The link (D-011, D-190): lit when the caret is in one.
    const linkBtn = keep(h("button.fmt-btn", { type: "button", title: "Link (⌘L)", "aria-label": "Link (⌘L)", "aria-pressed": "false", text: "↗",
      onclick: () => { if (ed()) { ed().link(); bar.update(ed()); } } }));
    toggles.l = linkBtn;
    const node = h("div.format-strip", { role: "toolbar", "aria-label": "Format" },
      h("div.fmt-group", kindSel, listSel, fontSel, sizeSel),
      h("span.fmt-rule"),
      h("div.fmt-group", tbtn("b", "B", "Bold (⌘B)"), tbtn("i", "I", "Italic (⌘I)"), tbtn("n", "U", "Underline (⌘U)"),
        tbtn("s", "S", "Strikethrough (⌘⇧X)"),
        tbtn("p", "x²", "Superscript (⌘.)"), tbtn("u", "x₂", "Subscript (⌘,)"), linkBtn, hlSel,
        act("ƒ(x)", "Formula: wraps the selection in $", () => { if (ed()) ed().wrap("$", "$"); }),
        iact("clearfmt", "Clear formatting", () => { if (ed()) { ed().clearFormat(); bar.update(ed()); } })),
      h("span.fmt-rule"),
      h("div.fmt-group", iact("card", "Make card (⇧⌘C): adds >> at the caret", () => { if (ed()) ed().makeCard(); }),
        iact("draw", "New drawing", () => newDrawing(docId)), tableSel,
        iact("picture", "Picture", () => addPicture(docId)),
        iact("diagram", "Diagram: label the parts of a picture", () => newDiagram(docId))));
    node.addEventListener("keydown", e => { if (e.key === "Escape" && ed()) e.target.blur(); });
    // A mouse wheel scrolls the strip sideways where it runs past the page.
    node.addEventListener("wheel", e => {
      if (node.scrollWidth <= node.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      node.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    const fade = () => node.classList.toggle("more", node.scrollLeft + node.clientWidth < node.scrollWidth - 2);
    node.addEventListener("scroll", fade);
    requestAnimationFrame(fade);
    const bar = {
      node,
      update(api) {
        const st = api && api.state ? api.state() : null;
        const doc = Backend.get("notebook", docId);
        const style = docStyleOf(doc);
        fontSel.value = families.includes(style.family) ? style.family : "San Francisco";
        const textOn = !!st;
        for (const el of [kindSel, listSel, sizeSel, hlSel, ...Object.values(toggles)]) el.disabled = !textOn;
        // A table cell (D-189) takes the inline styles and never a paragraph
        // style or a list; its size is the TABLE's (`setTableFont`).
        if (st && st.cell) for (const el of [kindSel, listSel]) el.disabled = true;
        if (!st) { kindSel.value = "paragraph"; listSel.value = ""; sizeSel.value = "11"; for (const b of Object.values(toggles)) { b.classList.remove("on"); b.setAttribute("aria-pressed", "false"); } return; }
        const list = ["bullet", "dash", "numbered", "checkbox"].includes(st.kind);
        kindSel.value = list ? "" : (["paragraph", "heading1", "heading2", "heading3", "quote"].includes(st.kind) ? st.kind : "paragraph");
        listSel.value = list ? st.kind : "";
        sizeSel.value = st.size && SIZES.includes(st.size) ? String(st.size) : "11";
        for (const [k, b] of Object.entries(toggles)) {
          b.classList.toggle("on", !!st.on[k]);
          b.setAttribute("aria-pressed", st.on[k] ? "true" : "false");
        }
      },
    };
    return bar;
  }

  // ------------------------------------------------------------ the blocks

  function anchor() { return state.editor ? state.editor.anchorId() : null; }

  // A block the strip adds is one step of the editor's undo (D-190).
  function undoable(fn) { return state.editor ? state.editor.record(fn) : fn(); }

  // After a block is written the editor draws it now, even with the caret
  // in a line (a remote change waits for the caret to leave; this one is
  // this person's own).
  function redrawEditor() {
    syncMedia();
    if (state.editor) state.editor.rerender();
  }

  function insertTable(docId, cardTable) {
    try {
      const after = anchor();
      undoable(() => Store.insertTable(docId, after, { rows: cardTable ? 2 : 3, columns: cardTable ? 2 : 3, cardTable }));
      redrawEditor();
    } catch (e) { showError(e, "table"); }
  }

  function uploadNote() {
    if (Backend.lastUploadNote) showError(new Error(Backend.lastUploadNote), "pictures");
  }

  // A picture pasted into a line (D-190): the same upload as the strip's
  // Picture button, placed after that line.
  async function pastePicture(docId, file, afterId) {
    try {
      const prepared = await Upload.prepare(file);
      const sha = await Backend.uploadBlob(prepared.blob, prepared.mime);
      undoable(() => Store.insertPicture(docId, afterId, sha, prepared.mime));
      uploadNote();
      redrawEditor();
    } catch (e) { showError(e, "picture"); }
  }

  async function addPicture(docId) {
    const file = await Upload.pick("image/png,image/jpeg,image/gif,image/webp");
    if (!file) return;
    try {
      const prepared = await Upload.prepare(file);
      const sha = await Backend.uploadBlob(prepared.blob, prepared.mime);
      const after = anchor();
      undoable(() => Store.insertPicture(docId, after, sha, prepared.mime));
      uploadNote();
      redrawEditor();
    } catch (e) { showError(e, "picture"); }
  }

  function newDrawing(docId) {
    const after = anchor();
    DrawEdit.open({ title: "Drawing", onSave: async doc => {
      const sha = await Backend.uploadBlob(DrawEdit.encode(doc), Store.DRAWING_MIME);
      undoable(() => Store.insertPicture(docId, after, sha, Store.DRAWING_MIME));
      uploadNote();
      redrawEditor();
    } });
  }

  // A drawing edited in place keeps its row (`replaceMediaBytes`), so its
  // block, width and any regions survive.
  async function editDrawing(docId, noteId, mediaId) {
    try {
      const row = Backend.get("media", mediaId);
      const text = await (await Backend.media(row)).text();
      const doc = Draw.parse(text);
      if (!doc) throw new Error("That drawing could not be read.");
      DrawEdit.open({ doc, title: "Drawing", onSave: async next => {
        const sha = await Backend.uploadBlob(DrawEdit.encode(next), Store.DRAWING_MIME);
        if (sha !== row.bytes_sha) undoable(() => Store.replaceMediaBytes(mediaId, sha, Store.DRAWING_MIME));
        uploadNote();
        redrawEditor();
      } });
    } catch (e) { showError(e, "drawing"); }
  }

  async function newDiagram(docId) {
    const file = await Upload.pick("image/png,image/jpeg,image/gif,image/webp");
    if (!file) return;
    openOcclusion(docId, { file });
  }

  function openOcclusion(docId, source) {
    // A picture turned into a diagram takes the picture's place.
    OccEdit.open({ docId, afterId: source.fromPicture ? source.fromPicture.noteId : anchor(), source,
      onSaved: () => { uploadNote(); redrawEditor(); },
      onError: e => showError(e, "diagram") });
  }

  // ------------------------------------------------------ the count, styles

  function countFooter(docId) {
    const node = h("div.count-footer");
    state.countNode = node;
    drawCount(docId);
    return node;
  }

  // The bottom readout (`word_count_readout`), one statistic, the chevron
  // walking the list (`WordCountStat.next`).
  function drawCount(docId) {
    const node = state.countNode;
    if (!node) return;
    const v = Backend.library().settingsValues || {};
    clear(node);
    if (v.word_count_readout !== "1") { node.classList.add("hidden"); return; }
    node.classList.remove("hidden");
    const stat = Words.valid(v.word_count_stat);
    const c = Words.count(Study.blocksFor(docId));
    node.appendChild(h("button.count-readout", { type: "button", title: "Show another count",
      onclick: () => { try { Backend.setSetting({ word_count_stat: Words.next(stat) }); } catch (e) { showError(e, "count"); } } },
      Words.readout(stat, c), h("span.chev", icon("chev", 10))));
  }

  function wordCountSheet(docId) {
    const c = Words.count(Study.blocksFor(docId));
    const v = Backend.library().settingsValues || {};
    const stat = Words.valid(v.word_count_stat);
    const statSel = h("select.field.inline", { "aria-label": "Statistic" }, Words.STATS.map(k => h("option", { value: k, text: Words.TITLES[k] })));
    statSel.value = stat;
    const write = changes => { try { Backend.setSetting(changes); } catch (e) { showError(e, "count"); } };
    statSel.addEventListener("change", () => write({ word_count_stat: statSel.value }));
    const doc = Backend.get("notebook", docId);
    sheet({ title: "Word Count", right: "Done", body: [
      group(doc ? doc.name || "Untitled" : "Document", [
        valueRow("Words", String(c.words)),
        valueRow("Characters", String(c.characters)),
        valueRow("Characters excluding spaces", String(c.charactersNoSpaces)),
        valueRow("Paragraphs", String(c.blocks)),
        valueRow("Cards", String(c.cards)),
        valueRow("Reading time", Words.duration(Words.readingSeconds(c))),
        valueRow("Speaking time", Words.duration(Words.speakingSeconds(c))),
      ], "Reading at 200 words a minute, speaking at 130. A picture counts nothing; a table counts every cell."),
      group("While typing", [
        valueRow("Show the count at the bottom", toggle(v.word_count_readout === "1", on => write({ word_count_readout: on ? "1" : "0" }), "Show the count at the bottom")),
        h("div.value-row", h("span.value-label", { text: "Statistic" }), statSel),
      ]),
    ] });
  }

  const LANGUAGES = [["", "Follow the browser"], ["en", "English"], ["en-GB", "English (UK)"], ["en-AU", "English (Australia)"],
    ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"],
    ["ja", "Japanese"], ["zh-Hans", "Chinese (Simplified)"], ["ko", "Korean"], ["la", "Latin"]];
  const WEIGHT_NAMES = ["Regular", "Medium", "Semibold", "Bold"];

  // Text Styles for one doc (Ink 17 section 6): its font, language, line
  // spacing and three heading styles, stored as `notebook.style` (DocStyle,
  // only what it changed) so they travel with the doc.
  function textStylesSheet(docId) {
    const doc = Backend.get("notebook", docId);
    if (!doc) return;
    const start = docStyleOf(doc);
    const draft = { f: start.own.f ? start.family : null, lang: start.language, ls: start.own.ls ? start.spacing : null,
                    h: start.own.h ? start.headings.map(l => ({ ...l })) : null };
    const body = h("div");
    const families = [...new Set([...FAMILIES, ...Backend.library().fonts.filter(f => f.deleted_at == null).map(f => f.family)])];
    const draw = () => {
      clear(body);
      const effective = Render.docStyle(JSON.stringify({ ...(draft.h ? { h: draft.h } : {}), ...(draft.ls != null ? { ls: draft.ls } : {}),
                                                         ...(draft.lang ? { lang: draft.lang } : {}), ...(draft.f ? { f: draft.f } : {}) }), Backend.styleDefaults());
      const fontSel = h("select.field.inline", { "aria-label": "Font" }, families.map(f => h("option", { value: f, text: f })));
      fontSel.value = effective.family && families.includes(effective.family) ? effective.family : "San Francisco";
      fontSel.addEventListener("change", () => { draft.f = fontSel.value === "San Francisco" && !Backend.styleDefaults().fontFamily ? null : fontSel.value; draw(); });
      const langSel = h("select.field.inline", { "aria-label": "Language" }, LANGUAGES.map(([v, t]) => h("option", { value: v, text: t })));
      langSel.value = draft.lang && LANGUAGES.some(l => l[0] === draft.lang) ? draft.lang : "";
      if (draft.lang && !LANGUAGES.some(l => l[0] === draft.lang)) { langSel.appendChild(h("option", { value: draft.lang, text: draft.lang })); langSel.value = draft.lang; }
      langSel.addEventListener("change", () => { draft.lang = langSel.value || null; });
      const spacing = h("div.value-row.chips", [1, 1.15, 1.25, 1.5, 2].map(v => chip(String(v), { on: Math.abs(effective.spacing - v) < 0.001,
        onclick: () => { draft.ls = v; draw(); } })));
      const headRows = effective.headings.map((l, i) => {
        const set = patch => { draft.h = (draft.h || effective.headings.map(x => ({ ...x }))); Object.assign(draft.h[i], patch); draw(); };
        const weights = h("span.weight-chips", WEIGHT_NAMES.map((name, w) => chip(["Reg", "Med", "Semi", "Bold"][w], { on: l.weight === w, title: name, onclick: () => set({ weight: w }) })));
        return h("div.value-row.heading-row", h("span.value-label", { text: `Heading ${i + 1}`, style: `font-size:${Math.min(20, l.size)}px;font-weight:${Render.WEIGHTS[l.weight]}` }),
          stepper(l.size, { min: 4, max: 400, format: v => `${v} pt`, onchange: v => set({ size: v }) }), weights);
      });
      const specimen = h("div.block.specimen");
      Render.applyDocStyle(specimen, effective);
      specimen.append(h("div.specimen-h", { text: "Heading 1" }),
        h("div.specimen-body", { text: "The quick brown fox jumps over the lazy dog and keeps running past the second line." }));
      UI.append(body, [h("p.help.sheet-lede", { text: `${doc.name || "Untitled"} · ${draft.f || draft.lang || draft.ls != null || draft.h ? "its own styles" : "follows your defaults"}. A change here applies to this doc only.` }),
        group("Font", [h("div.value-row", h("span.value-label", { text: "Font" }), fontSel), h("div.value-row", h("span.value-label", { text: "Language" }), langSel)],
          "The language names the spelling dictionary the browser checks this doc in."),
        group("Line spacing", [spacing]),
        group("Headings", headRows),
        specimen,
        draft.f || draft.lang || draft.ls != null || draft.h ? h("div.sheet-foot", chip("Use my defaults", { onclick: () => { draft.f = null; draft.lang = null; draft.ls = null; draft.h = null; draw(); } })) : null]);
    };
    draw();
    sheet({ title: "Text Styles", left: "Cancel", right: "Save", width: 520, body: [body],
      onRight: () => {
        try {
          Store.setDocStyle(docId, { f: draft.f, lang: draft.lang, ls: draft.ls, h: draft.h });
          if (state.editor) state.editor.rerender();
          render();
        } catch (e) { showError(e, "text styles"); return false; }
      } });
  }

  // Kept versions (landmine 224): the text a sync replaced here, until a
  // choice is made. "Use the replaced text" writes it back as an edit.
  function keptVersionsSheet(docId) {
    const body = h("div");
    const draw = () => {
      clear(body);
      const list = Backend.versions(docId);
      body.appendChild(h("p.sheet-text", { text: "A sync replaced text this browser had changed and not yet sent. The doc shows the newer text; the replaced one waits here until you choose." }));
      if (!list.length) body.appendChild(h("p.help", { text: "Nothing is waiting." }));
      for (const v of list) {
        const note = Backend.get("note", v.note_id);
        if (!note) continue;
        const kept = Model.rawText({ kind: note.kind, front: v.front, back: v.back, cloze_text: v.cloze_text, attrs: note.attrs });
        const now = Model.rawText(note);
        const when = new Date(Wire.wireMillis(v.kept_at)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        body.append(eyebrow("Replaced by a sync", when),
          h("div.block.kept", h("div.eyebrow", { text: "In the doc now" }), h("div.kept-text", { text: now || "(empty)" }),
            h("div.eyebrow.kept-gap", { text: "Replaced on this device" }), h("div.kept-text", { text: kept || "(empty)" }),
            h("div.kept-actions",
              chip("Use the replaced text", { onclick: () => {
                try {
                  const runs = Spans.decode(v.spans, kept);
                  Store.saveLine(v.note_id, kept, Date.now(), runs && runs.length ? runs : undefined);
                  Backend.resolveVersion(v.id);
                  draw();
                  if (state.editor) state.editor.rerender();
                } catch (e) { showError(e, "kept versions"); }
              } }),
              chip("Keep the doc's", { on: true, onclick: () => { Backend.resolveVersion(v.id); draw(); } }))));
      }
    };
    draw();
    sheet({ title: "Kept Versions", right: "Done", width: 520, body: [body], onClose: () => render() });
  }

  // CARD INFO (`CardInfoSheet`, D-191: the arrow's menu reaches it): the
  // card's question over its answer, its stability and difficulty, its
  // schedule, what each grade would do now (the review's own preview, the
  // deadline clamp included), and its last 20 grades, newest first.
  const GRADE_NAMES = ["", "Again", "Hard", "Good", "Easy"];
  const GRADE_CLASS = ["", "again", "hard", "good", "easy"];
  function cardInfoSheet(cardId) {
    const card = Backend.get("card", cardId);
    if (!card || card.deleted_at != null) {
      sheet({ title: "Card info", right: "Done", body: [h("p.help", { text: "Card not found. It may have been dissolved on another device." })] });
      return;
    }
    const L = Backend.library();
    const face = h("div.info-face");
    let ctx = null;
    if (card.detached) {
      if (card.q_snapshot) face.appendChild(h("div.face.face-q", { text: card.q_snapshot }));
      if (card.a_snapshot) face.appendChild(h("div.face.face-a", { text: card.a_snapshot }));
    } else {
      const d = Study.describe(cardId);
      if (d) {
        ctx = Pictures.context(docStyleOf(d.doc));
        const f = Cards.faces(d.entry, ctx);
        face.appendChild(f.question);
        if (f.together) face.appendChild(f.answer);
      }
    }
    const reps = card.reps || 0;
    const tile = (value, label) => h("div.stat-tile", h("b", { text: value }), h("span", { text: label }));
    const stability = card.stability < 1 ? "<1 d" : `${Math.round(card.stability)} d`;
    const state = card.state === "learning" || card.state === "relearning" ? "learning" : String(card.state || "new");
    const due = card.due ? Sched.relativeDue(Date.parse(card.due), Date.now()) : "-";
    const body = [face,
      h("div.stat-tiles.info-tiles", tile(reps > 0 ? stability : "-", "stability"),
        tile(reps > 0 ? Number(card.difficulty || 0).toFixed(1) : "-", "difficulty, 1 to 10")),
      group("Schedule", [valueRow("State", state.charAt(0).toUpperCase() + state.slice(1)), valueRow("Due", due),
                         valueRow("Reps", String(reps)), valueRow("Lapses", String(card.lapses || 0))])];
    if (!card.suspended && !card.detached) {
      body.push(group("If graded now", [valueRow("Again · Hard · Good · Easy", [1, 2, 3, 4].map(r => Store.preview(cardId, r)).join(" · "))]));
    }
    const events = L.events.filter(e => e.card_id === cardId && e.deleted_at == null)
      .sort((a, b) => Date.parse(b.reviewed_at) - Date.parse(a.reviewed_at)).slice(0, 20);
    const me = Backend.deviceId();
    const title = reps === 0 ? "Not graded yet" : reps > events.length ? `Grades · ${events.length} of ${reps}` : `Grades · ${events.length}`;
    body.push(group(title, events.length ? events.map(e => h("div.value-row.info-grade-row",
      h("span.info-grade.grade-" + (GRADE_CLASS[e.rating] || "again"), { text: GRADE_NAMES[e.rating] || "Grade" }),
      h("span.value", { text: new Date(Date.parse(e.reviewed_at)).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) }),
      h("span.value-sub", { text: e.device_id === me ? "This browser" : "Another device" }))) : [h("div.value-row", h("span.value-label", {
        text: reps === 0 ? "Grades appear here after the first review." : "No grade events found for this card." }))]));
    sheet({ title: "Card info", right: "Done", width: 420, body });
    if (ctx) ctx.resolve();
  }

  // Print or save as PDF: the doc as it reads, on paper (light whatever the
  // Mode, the chrome left out), through the browser's own print dialog.
  async function printDoc(docId) {
    if (parseRoute().name !== "doc" || parseRoute().id !== docId || parseRoute().tab !== "notes") openDoc(docId);
    await new Promise(r => setTimeout(r, 120));
    render();
    try { await document.fonts.ready; } catch (_) { /* no font loading API */ }
    // Every picture of the doc fetched and drawn before the dialog opens.
    await Promise.all(Backend.doc(docId).media.map(m => Media.load(m.id).catch(() => null)));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const pics = [...document.querySelectorAll("#view img")];
    await Promise.all(pics.map(img => (img.complete ? null : new Promise(r => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }))));
    document.documentElement.classList.add("printing");
    const done = () => { document.documentElement.classList.remove("printing"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1000);
  }

  // ----------------------------------------------------- files and AI verbs

  async function importNotes(docId) {
    const file = await Upload.pick(".csv,.tsv,.md,.markdown,.mdown,.txt,.text,text/csv,text/markdown,text/plain");
    if (!file) return;
    const route = parseRoute();
    IO.importFile(file, {
      currentDoc: docId || (route.name === "doc" ? route.id : null),
      onDone: (id, n, dups) => {
        UI.banner($("banners"), { id: "import", source: "Import", message: `${plural(n, "note")} added${dups ? `, ${plural(dups, "duplicate")} skipped` : ""}.` });
        openDoc(id);
      },
      onError: e => showError(e, "import"),
    });
  }

  async function snapshot() {
    UI.banner($("banners"), { id: "export", source: "Snapshot", message: "Gathering the library and its pictures." });
    try {
      const out = await IO.downloadSnapshot();
      UI.banner($("banners"), { id: "export", source: "Snapshot", message: `${plural(out.notes, "note")} and ${plural(out.files, "file")} saved to your downloads${out.missing ? `; ${plural(out.missing, "picture")} could not be read` : ""}.` });
    } catch (e) { UI.banner($("banners"), { id: "export", message: null }); showError(e, "snapshot"); }
  }

  function openPalette() {
    if (Backend.isShared() || !Backend.loaded) return;
    const route = parseRoute();
    Palette.show(app, { docId: route.name === "doc" ? route.id : null });
  }

  function createNote(docId, text) {
    try {
      Store.importLines(docId, [text]);
      openDoc(docId);
    } catch (e) { showError(e, "new note"); }
  }

  function makeCards(docId) {
    AI.makeCards(docId, {
      onAdded: n => UI.banner($("banners"), { id: "cards", source: "Make Cards", message: `${plural(n, "card")} added under ${n === 1 ? "its section" : "their sections"}.` }),
      onError: e => showError(e, "make cards"),
    });
  }

  function quiz(docId) {
    if (Study.isOpen() || AI.isOpen()) return;
    if (state.editor) state.editor.flush();
    AI.startQuiz(docId, { onClose: () => render() });
  }

  // ------------------------------------------------------------ share links

  function shareParams() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash.startsWith("share=")) return null;
    const token = new URLSearchParams(hash).get("share");
    return token ? { token } : null;
  }

  let sharedTab = "notes";

  function drawShared() {
    applyAppearance();
    const data = state.shared;
    const view = clear($("view"));
    view.className = "view";
    if (state.practice) { state.practice.destroy(); state.practice = null; }
    if (!data) { titlebar("Shared doc", "Loading", []); return; }
    if (data.stopped || !data.notebook) {
      titlebar("Not shared", null, []);
      view.appendChild(h("div.page", h("p.empty", { text: (data && data.stopped) || "This link has been stopped, or it never existed." })));
      return;
    }
    const nb = data.notebook;
    Media.reset(data.media || [], data.occlusion || []);
    const flags = new Map();
    for (const c of data.cards || []) flags.set(c.note_id, { detached: !!c.detached });
    const diagrams = Media.diagramsByNote();
    const blocks = Model.build(data.notes || [], flags, new Set(diagrams.keys()));
    const cards = Cards.deck(blocks, data.cards || []);
    const style = Render.docStyle(nb.style);
    const tools = [chip("Notes", { on: sharedTab === "notes", onclick: () => { sharedTab = "notes"; drawShared(); } }),
                   chip(cards.length ? `Cards ${cards.length}` : "Cards", { on: sharedTab === "cards", onclick: () => { sharedTab = "cards"; drawShared(); } }),
                   chip(icon("mode", 14), { title: "Light or dark", onclick: flipMode })];
    const noteCount = (data.notes || []).length;
    titlebar(nb.name || "Untitled", `Shared doc · read only · ${plural(noteCount, "note")} · ${plural(cards.length, "card")}`, tools);
    const ctx = Pictures.context(style);
    if (sharedTab === "cards") {
      const column = h("div.practice");
      Render.applyDocStyle(column, style);
      view.appendChild(column);
      state.practice = Cards.mount(column, cards, ctx, { docName: nb.name || "" });
      return;
    }
    const paper = h("div.paper", Render.document(blocks, ctx));
    view.appendChild(h("div.doc-page", h("div.desk", paper)));
    ctx.resolve();
  }

  async function startShared(params) {
    $("signin").classList.add("hidden");
    $("shell").classList.remove("hidden");
    $("shell").classList.add("shared");
    drawShared();
    try {
      await Backend.checkVersion();
      state.shared = await Backend.sharedDoc(params.token);
      if (state.shared && state.shared.notebook) document.title = `${state.shared.notebook.name || "Untitled"} · Recall`;
    } catch (error) {
      state.shared = { stopped: String(error.message || error) };
    }
    drawShared();
  }

  // ------------------------------------------------------------------ start

  async function start() {
    $("signin").classList.add("hidden");
    $("shell").classList.remove("hidden");
    $("shell").classList.remove("shared");
    titlebar("Recall", "Loading the library", []);
    try {
      await Backend.start();
    } catch (error) {
      if (error.authFailed) {
        // A revocation already erased the copy (its stated design); any other
        // refused credential keeps it, unsent edits included, for the next
        // pairing (review 2026-09-26, web-9).
        const pending = Backend.status.revoked ? 0 : Backend.pendingCount();
        if (!Backend.status.revoked) Backend.forgetCredential();
        showSignIn(String(error.message) + (pending ? " Changes not yet sent are kept in this browser and send once it is paired again." : ""));
        return;
      }
      showError(error, "library");
      return;
    }
    render();
  }

  const app = { go, openDoc, study, titlebar, render, newDoc, signOut, devicesSheet, recentlyDeletedSheet,
                clearModeOverride, error: showError, flipMode, palette: openPalette, createNote, makeCards, quiz,
                wordCount: wordCountSheet, textStyles: textStylesSheet, print: printDoc, importNotes, snapshot,
                exportCSV: () => { try { IO.downloadCSV(); } catch (e) { showError(e, "export"); } } };

  function boot() {
    applyAppearance();
    $("signin-form").addEventListener("submit", signIn);
    $("mode-button").addEventListener("click", flipMode);
    $("new-doc").addEventListener("click", () => newDoc());
    $("search").addEventListener("input", event => {
      state.filter = event.target.value.trim().toLowerCase();
      drawSidebar();
    });
    for (const b of $("tabbar").querySelectorAll("button")) {
      b.addEventListener("click", () => go("#" + b.dataset.tab));
    }
    window.addEventListener("hashchange", () => {
      if (shareParams()) return;
      if (UI.sheetOpen()) closeSheet();
      render();
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { applyAppearance(); scheduleRender(); });
    // The phone and the wide layout are different pages: a width change
    // rebuilds even an open editor (its lines are committed first).
    window.matchMedia("(min-width: 700px)").addEventListener("change", () => { state.layoutChanged = true; scheduleRender(); });
    window.matchMedia("(min-width: 1000px)").addEventListener("change", () => scheduleRender());
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && UI.sheetOpen()) { event.preventDefault(); closeSheet(); return; }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        if (Backend.isShared() || !Backend.loaded || Study.isOpen() || AI.isOpen()) return;
        event.preventDefault();
        if (Palette.isOpen()) Palette.close(); else openPalette();
      }
    });
    $("palette-button").addEventListener("click", () => openPalette());
    Backend.subscribe(detail => {
      if (Backend.status.revoked && !Backend.isSignedIn() && !Backend.isShared()) { removedHere(); return; }
      if (Study.isOpen() || AI.isOpen() || !detail.rows) { drawStatusSafe(); return; }
      scheduleRender();
    });
    setInterval(() => { if (!Backend.isShared() && Backend.loaded) drawSyncLineSafe(); }, 10000);

    // The shell is kept for offline (sw.js); a fixture page is left alone.
    if ("serviceWorker" in navigator && location.protocol.startsWith("http") && !new URLSearchParams(location.search).has("fixture")) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
    const shared = shareParams();
    if (shared) { startShared(shared); return; }
    if (Backend.isSignedIn()) start();
    else showSignIn(null);
  }

  function drawSyncLineSafe() { try { drawSyncLine(); } catch (_) { /* not drawn yet */ } }

  // The status alone: the sidebar's line and the sync banner.
  function drawStatusSafe() {
    if (Backend.isShared() || !Backend.loaded) return;
    drawSyncLineSafe();
    drawSyncBanner();
  }

  // One sentence (AM-20): "Offline: edits and grades wait in this browser
  // and send when it reconnects." with Retry, or "Sync: <what went wrong>".
  function drawSyncBanner() {
    const st = Backend.status;
    const offline = st.phase === "offline";
    UI.banner($("banners"), { id: "sync", source: offline ? "Offline" : "Sync",
                              message: offline ? Backend.OFFLINE_SENTENCE : st.phase === "error" ? st.message : null,
                              action: "Retry", onAction: () => Backend.sync().catch(() => {}) });
  }

  // Recall removed this browser from the library: everything it held is
  // gone, and the pairing screen says why.
  function removedHere() {
    if (state.editor) { try { state.editor.destroy(); } catch (_) { /* gone */ } state.editor = null; }
    if (AI.isOpen()) AI.closeQuiz();
    if (Palette.isOpen()) Palette.close();
    if (UI.sheetOpen()) closeSheet();
    if (Study.isOpen()) Study.close();
    UI.banner($("banners"), { id: "sync", message: null });
    if (location.hash) history.replaceState(null, "", location.pathname);
    showSignIn(Backend.status.message);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
