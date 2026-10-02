// The ⌘K palette (PLAN-BETA-0.12 section 26, W-7; Ink 17 section 6): the
// float rung, one field, results grouped DOCS, NOTES and ACTIONS, the
// selection travelling with the arrows, one keycap drawing. A note shows the
// doc and heading it sits under in tertiary. "Create note: <words>" writes
// the words as a new line at the end of the open doc (or the doc edited
// last) through the same save as a typed line.

const Palette = (() => {

  let open = null;

  function isOpen() { return !!open; }

  function close() {
    if (!open) return;
    const o = open;
    open = null;
    document.removeEventListener("keydown", o.onKey, true);
    o.layer.remove();
    if (o.restore && o.restore.focus) { try { o.restore.focus({ preventScroll: true }); } catch (_) { /* gone */ } }
  }

  // Words, all of them, anywhere in the text, case folded.
  function matches(text, words) {
    const t = String(text || "").toLowerCase();
    return words.every(w => t.includes(w));
  }

  // The heading above each note of a doc, computed once per doc per open.
  function headingPaths(docId, cache) {
    if (cache.has(docId)) return cache.get(docId);
    const out = new Map();
    const chain = [];
    for (const b of Study.blocksFor(docId)) {
      const level = { heading1: 1, heading2: 2, heading3: 3 }[b.kind];
      if (level) {
        while (chain.length && chain[chain.length - 1].level >= level) chain.pop();
        chain.push({ level, title: b.text.trim() });
        continue;
      }
      out.set(b.id, chain.map(c => c.title));
      for (const r of b.rows || []) out.set(r.id, chain.map(c => c.title));
    }
    cache.set(docId, out);
    return out;
  }

  function show(app, { docId } = {}) {
    const { h, clear, docMark, icon } = UI;
    if (open) { open.field.focus(); return; }
    const L = Backend.library();
    const facts = Pages.docFacts(L);
    const docs = Pages.liveDocs(L);
    const folders = new Map(Pages.liveFolders(L).map(f => [f.id, f]));
    const paths = new Map();
    const lastEdited = () => docs.slice().sort((a, b) => (facts.edited.get(b.id) || 0) - (facts.edited.get(a.id) || 0))[0];

    const field = h("input.palette-field", { type: "text", placeholder: "Search docs, notes and actions", autocomplete: "off",
                                             spellcheck: "false", "aria-label": "Search", role: "combobox", "aria-expanded": "true" });
    const list = h("div.palette-list", { role: "listbox" });
    const panel = h("div.palette", { role: "dialog", "aria-label": "Palette" },
      h("div.palette-head", h("span.palette-glyph", icon("search", 16)), field, h("span.keycap", { text: "⌘K" })), list);
    const layer = h("div.palette-layer", h("div.scrim", { onclick: close }), panel);
    let items = [];
    let at = 0;

    function target() {
      if (docId && L.docs.get(docId) && L.docs.get(docId).deleted_at == null) return L.docs.get(docId);
      return lastEdited() || null;
    }

    const ACTIONS = [
      { label: "New doc", keys: "new doc create", run: () => app.newDoc() },
      { label: "Study everything due", keys: "study review due today", run: () => app.study({ kind: "library" }) },
      { label: "Today", keys: "today home", run: () => app.go("#today") },
      { label: "Docs", keys: "docs library browse", run: () => app.go("#docs") },
      { label: "Flashcards", keys: "flashcards cards browse", run: () => app.go("#cards") },
      { label: "Statistics", keys: "statistics knowledge stats charts", run: () => app.go("#knowledge") },
      { label: "Settings", keys: "settings preferences", run: () => app.go("#settings") },
      { label: "Sync now", keys: "sync now refresh", run: () => Backend.sync().catch(e => app.error(e, "sync")) },
      { label: "Import notes", keys: "import csv markdown upload file", run: () => app.importNotes() },
      { label: "Download a snapshot", keys: "export json snapshot backup download", run: () => app.snapshot() },
      { label: "Export CSV", keys: "export csv spreadsheet", run: () => app.exportCSV() },
      { label: "Light or dark", keys: "mode dark light appearance theme", run: () => app.flipMode() },
    ];
    if (docId) {
      ACTIONS.unshift(
        { label: "Make Cards from this doc", keys: "make cards ai generate", run: () => app.makeCards(docId) },
        { label: "Quiz on this doc", keys: "quiz practice test", run: () => app.quiz(docId) },
        { label: "Word count", keys: "word count words characters", run: () => app.wordCount(docId) },
        { label: "Text styles", keys: "text styles headings font spacing language", run: () => app.textStyles(docId) },
        { label: "Print or save as PDF", keys: "print pdf export", run: () => app.print(docId) });
    }

    function draw() {
      clear(list);
      const q = field.value.trim();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      items = [];
      const groups = [];
      // DOCS: the name matches; with no words, the docs edited last.
      const docHits = (words.length ? docs.filter(d => matches(d.name, words))
        : docs.slice().sort((a, b) => (facts.edited.get(b.id) || 0) - (facts.edited.get(a.id) || 0))).slice(0, words.length ? 6 : 5);
      if (docHits.length) groups.push(["Docs", docHits.map(d => ({
        glyph: docMark(14), name: d.name || "Untitled",
        meta: [UI.plural(facts.notes.get(d.id) || 0, "note"), d.folder_id && folders.get(d.folder_id) ? folders.get(d.folder_id).name : "Library"].join(" · "),
        run: () => app.openDoc(d.id),
      }))]);
      // NOTES: every word in the note's text, with where it sits.
      if (words.length) {
        const hits = [];
        for (const n of L.notes.values()) {
          if (n.deleted_at != null || !L.docs.get(n.notebook_id) || L.docs.get(n.notebook_id).deleted_at != null) continue;
          if (n.kind === "table" || n.kind === "image") continue;
          const text = Model.rawText(n);
          if (!text || !matches(text, words)) continue;
          hits.push(n);
          if (hits.length >= 8) break;
        }
        if (hits.length) groups.push(["Notes", hits.map(n => {
          const doc = L.docs.get(n.notebook_id);
          const heads = headingPaths(n.notebook_id, paths).get(n.id) || [];
          return { glyph: h("span.palette-pilcrow", { text: "¶" }), name: Model.rawText(n).replace(/\s+/g, " ").slice(0, 120),
                   meta: [doc.name || "Untitled", ...heads.slice(-1)].join(" › "),
                   run: () => app.openDoc(n.notebook_id, null, n.id) };
        })]);
      }
      // ACTIONS: the verbs whose words match, and "Create note" for any words.
      const acts = (words.length ? ACTIONS.filter(a => matches(a.label + " " + a.keys, words)) : ACTIONS.slice(0, 4))
        .map(a => ({ glyph: icon("chev", 12), name: a.label, run: a.run }));
      const into = target();
      // Last, as Ink 17 draws it: Enter opens what matched, ⌘↩ creates.
      if (q && into) acts.push({ glyph: icon("plus", 14), name: `Create note: ${q}`, meta: into.name || "Untitled", key: "⌘↩", create: true,
        run: () => app.createNote(into.id, q) });
      if (acts.length) groups.push(["Actions", acts]);
      for (const [title, rows] of groups) {
        list.appendChild(h("div.eyebrow.palette-eyebrow", { text: title }));
        for (const item of rows) {
          const index = items.length;
          items.push(item);
          const row = h("button.palette-row", { type: "button", role: "option", dataset: { index: String(index) },
            onclick: () => choose(index) },
            h("span.palette-tile", item.glyph),
            h("span.palette-body", h("span.palette-name", { text: item.name }), item.meta ? h("span.palette-meta", { text: item.meta }) : null),
            h("span.keycap.palette-key", { text: item.key || "↩" }));
          row.addEventListener("mousemove", () => { if (at !== index) { at = index; mark(); } });
          list.appendChild(row);
        }
      }
      if (!items.length) list.appendChild(h("div.palette-empty", { text: "Nothing matches that." }));
      at = Math.min(at, Math.max(0, items.length - 1));
      mark();
    }

    function mark() {
      list.querySelectorAll(".palette-row").forEach(r => {
        const on = Number(r.dataset.index) === at;
        r.classList.toggle("on", on);
        r.setAttribute("aria-selected", on ? "true" : "false");
        if (on) r.scrollIntoView({ block: "nearest" });
      });
    }

    function choose(index) {
      const item = items[index];
      if (!item) return;
      close();
      try { item.run(); } catch (error) { app.error(error, "palette"); }
    }

    const onKey = event => {
      if (!open) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); at = Math.min(items.length - 1, at + 1); mark(); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); at = Math.max(0, at - 1); mark(); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey) {
          const i = items.findIndex(x => x.create);
          if (i >= 0) choose(i);
          return;
        }
        choose(at);
      }
    };
    field.addEventListener("input", () => { at = 0; draw(); });
    open = { layer, field, onKey, restore: document.activeElement };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(layer);
    draw();
    setTimeout(() => field.focus(), 0);
  }

  return { show, close, isOpen };
})();
