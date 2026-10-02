// The pages a paired browser draws, each the Mac screen of Ink 17 at the
// browser's width and the phone screen below 700 px: Today (Ink 16 section
// 1 and 6: the hero at 40, Documents, Mastery at 10 with its legend and fact
// line, Coming up with counts and a baseline), the Library (rows with the
// 4pt mastery stripe), Flashcards, Knowledge (four tiles, then the charts)
// and Settings (an index of six pages, AM-22).
//
// A page draws from Backend.library() through Sched, the same rules the Mac
// counts with, so the numbers here are the Mac's numbers.

const Pages = (() => {

  const { h, clear, eyebrow, chip, control, docMark, folderGlyph, icon, tile, listRow, block, stripe, legend,
          bars, group, valueRow, stepper, toggle, plural } = UI;

  const wide = () => window.matchMedia("(min-width: 700px)").matches;
  const twoColumns = () => window.matchMedia("(min-width: 1000px)").matches;
  const ms = t => (t == null ? null : Date.parse(t));

  function liveDocs(L) {
    return [...L.docs.values()].filter(d => d.deleted_at == null)
      .sort(Order.compare);
  }

  function liveFolders(L) {
    return [...L.folders.values()].filter(f => f.deleted_at == null)
      .sort(Order.compare);
  }

  function docFacts(L) {
    const notes = new Map(), cards = new Map(), edited = new Map();
    for (const n of L.notes.values()) {
      if (n.deleted_at != null) continue;
      notes.set(n.notebook_id, (notes.get(n.notebook_id) || 0) + 1);
      const t = ms(n.updated_at);
      if (t > (edited.get(n.notebook_id) || 0)) edited.set(n.notebook_id, t);
    }
    for (const c of L.cards) {
      if (c.deleted_at != null || c.detached) continue;
      const n = L.notes.get(c.note_id);
      if (!n || n.deleted_at != null) continue;
      cards.set(n.notebook_id, (cards.get(n.notebook_id) || 0) + 1);
    }
    return { notes, cards, edited };
  }

  function dayName(t, style) {
    return new Date(t).toLocaleDateString([], style);
  }

  // ------------------------------------------------------------------ Today

  function today(app) {
    const L = Backend.library();
    const now = Date.now();
    const s = L.settings;
    const dc = Sched.dueCounts(L, now, s.newPerDay);
    const perDoc = Sched.docDue(L, now);
    const facts = docFacts(L);

    const tools = [
      chip(icon("plus", 14), { title: "New doc", onclick: () => app.newDoc() }),
      chip(icon("chart", 14), { title: "Statistics", onclick: () => app.go("#knowledge") }),
    ];
    app.titlebar("Today", dayName(now, { weekday: "long", day: "numeric", month: "long" }), tools);

    const page = h("div.page.today");
    const hero = h("div.hero-row",
      h("div",
        h("div.hero", { text: String(dc.total) }, h("small", { text: "due" })),
        h("div.hero-sub", { text: dc.total ? Sched.subtitle(dc, s.newPerDay, wide()) : "nothing due now" })),
      h("button.capsule", { type: "button", disabled: !dc.total, onclick: () => app.study({ kind: "library" }) },
        "Study", h("span.capsule-arrow", { text: "▸" })));
    page.appendChild(hero);

    // Documents: the docs with something due; the whole library when nothing is.
    let docs = liveDocs(L).filter(d => (perDoc.get(d.id) || 0) > 0)
      .sort((a, b) => (perDoc.get(b.id) || 0) - (perDoc.get(a.id) || 0));
    if (!docs.length) docs = liveDocs(L);
    const docsBlock = block(docs.map(d => listRow({
      tileNode: tile(docMark()), name: d.name || "Untitled",
      meta: [UI.edited(facts.edited.get(d.id)), plural(facts.notes.get(d.id) || 0, "note")].filter(Boolean).join(" · "),
      value: perDoc.get(d.id) ? h("span.due", { text: `${perDoc.get(d.id)} due` }) : null,
      onclick: () => app.openDoc(d.id),
    })));
    const left = h("div", eyebrow("Documents", plural(docs.length, "doc")),
      docs.length ? docsBlock : h("p.empty", { text: "No docs yet. New doc makes one." }));

    const m = Sched.mastery(L, now, s.retention);
    const g = Sched.recentGrades(L, now);
    const fc = Sched.forecast(L, now, 7, s.newPerDay);
    const total = fc.reduce((a, b) => a + b.count, 0);
    const right = h("div",
      eyebrow("Mastery", h("button.section-link", { type: "button", onclick: () => app.go("#knowledge"), text: plural(m.total, "card") + " ›" })),
      stripe(m, 10), legend(m),
      h("p.fact-line", { text: `${g.weekCount} reviewed this week` + (g.recalledPct != null ? ` · ${g.recalledPct}% recalled over 30 days` : "") }),
      eyebrow("Coming up", `${plural(total, "card")} over 7 days`),
      bars(fc, 62, (x, i) => dayName(x.day, { weekday: "short" })));
    const leeches = L.cards.filter(c => c.deleted_at == null && !c.suspended && c.lapses >= s.leechThreshold).length;
    if (leeches) right.appendChild(h("p.fact-line.rule-above", { text: `${plural(leeches, "leech", "leeches")} · reviewed but repeatedly forgotten` }));

    page.appendChild(h(twoColumns() ? "div.columns" : "div.stack", left, right));
    return page;
  }

  // ------------------------------------------------------------ the library

  function library(app) {
    const L = Backend.library();
    const now = Date.now();
    const perDoc = Sched.docDue(L, now);
    const facts = docFacts(L);
    const docs = liveDocs(L);
    app.titlebar("Docs", null, [
      chip(icon("search", 14), { title: "Search (⌘K)", onclick: () => app.palette() }),
      chip(icon("cards", 14), { title: "Flashcards", onclick: () => app.go("#cards") }),
      chip(icon("chart", 14), { title: "Statistics", onclick: () => app.go("#knowledge") }),
      chip(icon("plus", 14), { title: "New doc", onclick: () => app.newDoc() }),
    ]);
    const page = h("div.page.library");
    const rows = [];
    const docRow = (d, indent) => {
      const m = Sched.mastery(L, now, L.settings.retention, new Set([d.id]));
      const r = listRow({
        tileNode: tile(docMark()), name: d.name || "Untitled",
        meta: plural(facts.notes.get(d.id) || 0, "note"),
        extra: m.total ? h("span.row-stripe", stripe(m, 4)) : null,
        value: perDoc.get(d.id) ? h("span.due", { text: `${perDoc.get(d.id)} due` }) : null,
        onclick: () => app.openDoc(d.id),
      });
      if (indent) r.classList.add("indent");
      return r;
    };
    const filed = new Set();
    for (const f of liveFolders(L)) {
      const members = docs.filter(d => d.folder_id === f.id);
      members.forEach(d => filed.add(d.id));
      const due = members.reduce((a, d) => a + (perDoc.get(d.id) || 0), 0);
      rows.push(listRow({ tileNode: tile(folderGlyph()), name: f.name || "Folder", meta: plural(members.length, "doc"),
                          value: due ? h("span.due", { text: `${due} due` }) : null, chevron: false }));
      for (const d of members) rows.push(docRow(d, true));
    }
    // A doc naming a folder that is not in the list reads as unfiled (landmine 151).
    for (const d of docs) if (!filed.has(d.id)) rows.push(docRow(d, false));
    page.append(eyebrow("Library", plural(docs.length, "doc")), rows.length ? block(rows) : h("p.empty", { text: "This library is empty." }));
    return page;
  }

  // ------------------------------------------------------------- flashcards

  function flashcards(app, state) {
    const L = Backend.library();
    const now = Date.now();
    const dc = Sched.dueCounts(L, now, L.settings.newPerDay);
    const search = h("input.field.search-field", { type: "search", placeholder: "Search cards", value: state.cardQuery || "", "aria-label": "Search cards" });
    app.titlebar("Flashcards", null, [
      chip(`Study ${dc.total}`, { onclick: () => app.study({ kind: "library" }), disabled: !dc.total }),
    ]);
    const page = h("div.page.flashcards", h("div.toolbar-row", search));
    const listHolder = h("div");
    page.appendChild(listHolder);
    const drawList = () => {
      clear(listHolder);
      const q = (state.cardQuery || "").trim().toLowerCase();
      let shown = 0;
      for (const d of liveDocs(L)) {
        const blocks = Study.blocksFor(d.id);
        const rowsIn = [];
        const visit = b => {
          const cards = L.cards.filter(c => c.note_id === b.id && c.deleted_at == null);
          for (const c of cards.sort((a, x) => (a.cloze_ordinal ?? -2) - (x.cloze_ordinal ?? -2))) {
            const faces = cardText(b, c);
            if (q && !(faces.q + " " + faces.a).toLowerCase().includes(q)) continue;
            const when = c.suspended ? "suspended" : c.detached ? "detached" : c.state === "new" ? "new" : Sched.relativeDue(ms(c.due), now);
            const row = h("button.cardlist-row", { type: "button", onclick: () => app.openDoc(d.id) },
              h("span.card-dot"), h("span.card-q", { text: faces.q }), h("span.card-a", { text: faces.a }),
              h("span.card-due", { text: when }));
            if (c.suspended) row.classList.add("suspended");
            if (c.detached) row.classList.add("detached");
            rowsIn.push(row);
          }
        };
        for (const b of blocks) { visit(b); for (const r of b.rows || []) visit(r); }
        if (!rowsIn.length) continue;
        shown += rowsIn.length;
        listHolder.append(eyebrow(d.name || "Untitled", plural(rowsIn.length, "card")), block(rowsIn));
      }
      if (!shown) listHolder.appendChild(h("p.empty", { text: q ? "No card matches that." : "No cards yet. A line with >> in it makes one." }));
    };
    search.addEventListener("input", () => { state.cardQuery = search.value; drawList(); });
    drawList();
    return page;
  }

  // A card's two sides as plain words, for a list (`CardRow`).
  function cardText(block, card) {
    if (block.isCloze) {
      const text = block.clozeText || "";
      const q = text.replace(/\{\{c(\d+)::([\s\S]*?)(::[^}]*)?\}\}/g, (m, n, inner) => Number(n) === card.cloze_ordinal ? "[…]" : inner);
      const a = (text.match(new RegExp(`\\{\\{c${card.cloze_ordinal}::([\\s\\S]*?)(::[^}]*)?\\}\\}`)) || [])[1] || "";
      return { q, a };
    }
    const hidden = Render.hiddenMarkerLength(block.front || "", block.kind);
    const front = (block.front || "").slice(hidden);
    // D-191: a list-shaped line has no back; its answer is the lines under
    // it, which the card's snapshot holds one to a line.
    const lines = s => String(s || "").split("\n").filter(Boolean).join(" · ");
    if (card.cloze_ordinal === Store.REVERSE_ORDINAL) return { q: block.back || lines(card.q_snapshot), a: front };
    if (block.hasDiagram && card.cloze_ordinal != null) return { q: `${front || "Diagram"} · ${card.cloze_ordinal + 1}`, a: "" };
    return { q: front, a: block.back || lines(card.a_snapshot) };
  }

  // -------------------------------------------------------------- Knowledge

  function knowledge(app) {
    const L = Backend.library();
    const now = Date.now();
    const s = L.settings;
    app.titlebar("Statistics", null, []);
    const live = L.cards.filter(c => {
      if (c.deleted_at != null) return false;
      const n = L.notes.get(c.note_id);
      const d = n && L.docs.get(n.notebook_id);
      return n && n.deleted_at == null && d && d.deleted_at == null;
    });
    const liveIds = new Set(live.map(c => c.id));
    const events = L.events.filter(e => liveIds.has(e.card_id));
    const m = Sched.mastery(L, now, s.retention);
    const g = Sched.recentGrades(L, now);
    const reviewed = live.filter(c => c.state === "review").map(c => c.stability).sort((a, b) => a - b);
    const median = reviewed.length ? reviewed[Math.floor(reviewed.length / 2)] : null;
    const leeches = live.filter(c => !c.suspended && c.lapses >= s.leechThreshold).length;

    const page = h("div.page.knowledge");
    page.appendChild(h("div.scope-line", h("span", "Scope ", h("b", { text: "Whole library" })),
      h("span.section-fact", { text: `${plural(live.length, "card")} · ${plural(events.length, "review")}` })));
    const tileOf = (big, small) => h("div.stat-tile", h("b", { text: big }), h("span", { text: small }));
    page.appendChild(h("div.stat-tiles",
      tileOf(g.recalledPct == null ? "–" : `${g.recalledPct}%`, `recalled, 30 d · target ${s.retention}`),
      tileOf(String(m.solid), `solid of ${m.total}`),
      tileOf(median == null ? "–" : Sched.formatInterval(median * 86400), "median stability"),
      tileOf(String(leeches), leeches === 1 ? "leech" : "leeches")));

    // Review activity: ten weeks of days, the darker the more reviews.
    const start = Sched.startOfDay(now) - 69 * Sched.DAY;
    const perDay = new Array(70).fill(0);
    let thisWeek = 0;
    for (const e of events) {
      const t = ms(e.reviewed_at);
      const i = Sched.daysBetween(start, t);
      if (i >= 0 && i < 70) perDay[i]++;
      if (t >= Sched.startOfDay(now) - 6 * Sched.DAY) thisWeek++;
    }
    const peak = Math.max(1, ...perDay);
    const heat = h("div.heat", { "aria-label": "Review activity, ten weeks" });
    perDay.forEach((n, i) => {
      const level = n === 0 ? 0 : n <= peak / 3 ? 1 : n <= peak * 2 / 3 ? 2 : 3;
      heat.appendChild(h("i", { className: level ? `l${level}` : null, title: `${dayName(start + i * Sched.DAY + Sched.DAY / 2, { day: "numeric", month: "short" })}: ${plural(n, "review")}` }));
    });

    const mix = h("div.stripe", { style: "height:10px" });
    const monthTotal = g.tally.reduce((a, b) => a + b, 0);
    ["again", "hard", "good", "easy"].forEach((k, i) => {
      if (g.tally[i] || !monthTotal) mix.appendChild(h("i.seg-" + k, { style: `flex:${monthTotal ? g.tally[i] : 1}` }));
    });

    const counts = { new: 0, learning: 0, review: 0, suspended: 0 };
    for (const c of live) {
      if (c.suspended) counts.suspended++;
      else if (c.state === "new") counts.new++;
      else if (c.state === "review") counts.review++;
      else counts.learning++;
    }
    const fc = Sched.forecast(L, now, 14, s.newPerDay);
    const fcTotal = fc.reduce((a, b) => a + b.count, 0);

    const left = h("div",
      eyebrow("Mastery", plural(m.total, "card")), stripe(m, 10), legend(m),
      eyebrow("Review activity", `10 weeks · ${thisWeek} this week`), heat,
      eyebrow("Grade mix", "30 days"), mix,
      h("div.legend", ["again", "hard", "good", "easy"].map((k, i) => h("span", h("i.seg-" + k), `${g.tally[i]} ${k}`))));
    const right = h("div",
      eyebrow("Forecast", `14 days · ${plural(fcTotal, "card")}`),
      bars(fc, 70, (x, i) => (i % 2 === 0 ? dayName(x.day, { weekday: "short" }) : "")),
      eyebrow("Card states", "whole library"),
      block(valueRow("New", String(counts.new)), valueRow("Learning", String(counts.learning)),
            valueRow("Review", String(counts.review)), valueRow("Suspended", String(counts.suspended))));
    page.appendChild(h(twoColumns() ? "div.columns.even" : "div.stack", left, right));
    if (!events.length && !live.length) page.appendChild(h("p.empty", { text: "No cards yet. A line with >> in it makes one." }));
    return page;
  }

  // --------------------------------------------------------------- Settings

  const THEMES = [["recall", "Recall", "#6e62e5", "#5b50cf"], ["plum", "Plum", "#b863d6", "#9442b8"],
    ["rose", "Rose", "#d4568c", "#c04378"], ["mocha", "Mocha", "#a88a72", "#7a5f4a"],
    ["pine", "Pine", "#4f9a8a", "#2f7a6a"],
    ["ocean", "Ocean", "#17a3b0", "#0b8592"], ["navy", "Navy", "#4c689e", "#1c346e"],
    ["graphite", "Graphite", "#7f87a0", "#7f87a0"]];
  const MODES = ["System", "Light", "Dark"];

  function settings(app, sub) {
    const L = Backend.library();
    const s = L.settings;
    const st = Backend.status;
    const synced = st.lastSync ? UI.ago(st.lastSync) : "not yet";
    const theme = THEMES.find(t => t[0] === s.theme) || THEMES[0];
    const page = h("div.page.settings");

    if (!sub) {
      app.titlebar("Settings", null, []);
      const deleted = recentlyDeletedDocs(L).length;
      page.appendChild(block(
        valueRow("Sync", `Cloudflare · ${synced}`, { onclick: () => app.go("#settings/sync") }),
        valueRow("Study", `${s.retention}% · ${s.newPerDay} a day`, { onclick: () => app.go("#settings/study") }),
        valueRow("Text", s.fontFamily || "San Francisco", { onclick: () => app.go("#settings/text") }),
        valueRow("Appearance", `${theme[1]} · ${MODES[s.appearance] || "System"}`, { onclick: () => app.go("#settings/appearance") }),
        valueRow("Data", deleted ? `${deleted} recently deleted` : "Nothing deleted", { onclick: () => app.go("#settings/data") }),
        valueRow("About", "web 1.0", { onclick: () => app.go("#settings/about") })));
      return page;
    }

    const back = () => app.go("#settings");
    const write = changes => { try { Backend.setSetting(changes); } catch (error) { app.error(error, "settings"); } };

    if (sub === "sync") {
      app.titlebar("Sync", null, [], back);
      const pending = Backend.pendingCount();
      const uploads = Backend.pendingUploadCount();
      const state = st.phase === "offline" ? "Offline · changes wait in this browser"
        : st.live ? `Live · synced ${synced}` : `Connected · synced ${synced}`;
      page.append(
        group("Backend", [
          h("div.value-row", h("span.tile.accent", icon("today", 14)),
            h("span.value-stack", h("span.value-label", { text: "Cloudflare" }),
              h("span.value-sub", { text: state }))),
          h("div.value-row.chips", chip("Sync now", { onclick: () => Backend.sync().then(() => app.render()).catch(e => app.error(e, "sync")) })),
        ], st.live ? "Changes from the Mac and the phone arrive as they are made." : "Changes from other devices are fetched every 20 seconds until the live connection is back."),
        group("This library", [
          valueRow("Devices", null, { onclick: () => app.devicesSheet() }),
          valueRow("Changes waiting to send", String(pending)),
          uploads ? valueRow("Pictures waiting to send", String(uploads)) : null,
        ].filter(Boolean)),
        group("This browser", [
          valueRow("Name", Backend.label()),
          valueRow("Device", Backend.deviceId().slice(0, 8)),
          valueRow("Sign out of this browser", null, { danger: true, onclick: () => app.signOut() }),
        ], "This browser keeps a copy of the library so docs open offline. Signing out forgets its credential and erases that copy. Remove it from Recall's device list to cut it off."));
      return page;
    }

    if (sub === "study") {
      app.titlebar("Study", null, [], back);
      page.append(
        group("Scheduling", [
          valueRow("Desired retention", stepper(s.retention, { min: 70, max: 97, format: v => `${v}%`, onchange: v => write({ retention_pct: v }) })),
          valueRow("New cards per day", stepper(s.newPerDay, { min: 0, max: 200, onchange: v => write({ new_per_day: v }) })),
          valueRow("Leech threshold", stepper(s.leechThreshold, { min: 1, max: 99, format: v => `${v} lapses`, onchange: v => write({ leech_threshold: v }) })),
          valueRow("Auto-suspend leeches", toggle(s.leechAutoSuspend, on => write({ leech_auto_suspend: on ? "1" : "0" }), "Auto-suspend leeches")),
        ], "Higher retention means fewer lapses and more reviews. Applies from your next grade on."),
        group("Reviewing", [
          valueRow("Show notes under answers", toggle(s.fromYourNotes, on => write({ from_your_notes: on ? "1" : "0" }), "Show notes under answers")),
        ]));
      return page;
    }

    if (sub === "text") {
      app.titlebar("Text", null, [], back);
      const v = L.settingsValues || {};
      const stat = Words.valid(v.word_count_stat);
      const statSelect = h("select.field.inline", { "aria-label": "Statistic" },
        Words.STATS.map(k => h("option", { value: k, text: Words.TITLES[k] })));
      statSelect.value = stat;
      statSelect.addEventListener("change", () => write({ word_count_stat: statSelect.value }));
      page.append(
        group("Documents", [
          valueRow("Font", s.fontFamily || "San Francisco"),
          valueRow("Line spacing", s.lineSpacing ? String(s.lineSpacing) : "1.15"),
        ], "A doc's own font, spacing and heading styles are set from its menu, Text styles, and travel with the doc."),
        group("Writing", [
          // PLAN-BETA-0.6 K1, off by default: the continuous document is the
          // app, and pages are for the times something will be printed.
          valueRow("Page layout", toggle(v.page_layout === "1", on => write({ page_layout: on ? "1" : "0" }), "Page layout")),
          valueRow("Check spelling", toggle(v.spellcheck !== "0", on => write({ spellcheck: on ? "1" : "0" }), "Check spelling")),
          valueRow("Show the count at the bottom", toggle(v.word_count_readout === "1", on => write({ word_count_readout: on ? "1" : "0" }), "Show the count at the bottom")),
          h("div.value-row", h("span.value-label", { text: "Statistic" }), statSelect),
        ], "Spelling is the browser's own checker, in the doc's language when it has one."));
      return page;
    }

    if (sub === "appearance") {
      app.titlebar("Appearance", null, [], back);
      const swatches = h("div.swatches", THEMES.map(([id, name, dark, light]) => {
        const b = h("button.swatch", { type: "button", title: name, "aria-label": name, "aria-pressed": id === s.theme ? "true" : "false",
          style: `--sw-dark:${dark};--sw-light:${light}`, onclick: () => write({ theme: id }) }, h("span.swatch-disc"), h("span.swatch-name", { text: name }));
        if (id === s.theme) b.classList.add("on");
        return b;
      }));
      const seg = h("div.segmented", { role: "group", "aria-label": "Mode" }, MODES.map((name, i) => {
        const b = h("button", { type: "button", text: name, "aria-pressed": i === s.appearance ? "true" : "false",
          onclick: () => { app.clearModeOverride(); write({ appearance: i }); } });
        if (i === s.appearance) b.classList.add("on");
        return b;
      }));
      page.append(group("Theme", [h("div.value-row.swatch-row", swatches)]),
                  group("Mode", [h("div.value-row", seg)], "Theme and Mode are the library's: they follow Recall on every device."));
      return page;
    }

    if (sub === "data") {
      app.titlebar("Data", null, [], back);
      const deleted = recentlyDeletedDocs(L);
      page.append(
        group("Import", [
          valueRow("Import notes", "CSV, Markdown, text", { onclick: () => app.importNotes() }),
        ], "A CSV's rows become cards; a Markdown or text file becomes a doc, one note a paragraph."),
        group("Export", [
          valueRow("Download a snapshot", "JSON", { onclick: () => app.snapshot() }),
          valueRow("Export CSV", "front, back, cloze, tags, deck", { onclick: () => app.exportCSV() }),
        ], "A snapshot is the whole library with its pictures, in the file Recall's own export writes, so Recall can restore it. A doc prints, or saves as a PDF, from its menu."),
        group("Recently deleted", [
          valueRow("Deleted docs", String(deleted.length), { onclick: () => app.recentlyDeletedSheet() }),
        ], "A row goes for good 30 days after it was deleted, on every device."));
      return page;
    }

    if (sub === "about") {
      app.titlebar("About", null, [], back);
      page.append(group("This build", [
        valueRow("Recall on the web", "1.0 · protocol 1"),
        valueRow("Scheduler", "FSRS-6 · default weights"),
        valueRow("Backend", location.host),
      ]));
      return page;
    }
    return page;
  }

  // Docs tombstoned inside the 30 day window, newest first.
  function recentlyDeletedDocs(L) {
    const cutoff = Date.now() - Sched.TOMBSTONE_DAYS * Sched.DAY;
    return [...L.docs.values()].filter(d => d.deleted_at != null && ms(d.deleted_at) >= cutoff)
      .sort((a, b) => ms(b.deleted_at) - ms(a.deleted_at));
  }

  return { today, library, flashcards, knowledge, settings, recentlyDeletedDocs, cardText, liveDocs, liveFolders, docFacts, THEMES };
})();
