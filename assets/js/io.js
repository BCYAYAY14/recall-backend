// Import and export on the web (PLAN-BETA-0.12 section 26, W-8 and the
// gaps): the app's own formats, restated so a file moves between the web and
// Recall unchanged.
//
//  - CSV in: `CSVImporter.parse` (the BOM stripped, the delimiter sniffed
//    from the first 20 lines in the order comma, tab, semicolon, RFC 4180
//    quoting, unquoted cells trimmed), a front and a back column, every note
//    tagged "imported", a front already in the doc skipped;
//  - Markdown and text in: `NoteFileReader.markdown` and `.text`, a doc
//    named from the file (`docName(fileName:)`), every paragraph a note;
//  - CSV out: `Snapshots.exportCSV` (front, back, cloze, tags, deck; a
//    kind's marker back on the front; a BOM and CRLF for Excel);
//  - JSON out, the SNAPSHOT DOWNLOAD: `Snapshots.exportJSON`'s shape, the
//    whole library with every picture's bytes inline, dates as the seconds
//    since 2001 Swift's default encoder writes and ids in upper case. Only
//    live rows travel: a tombstone this browser holds carries no content.
// The pure functions come first and touch no DOM, so the unit suite reads
// them from this same file.

const IO = (() => {

  const BOM = "\uFEFF";
  const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

  // ------------------------------------------------------------------ CSV

  function sniffDelimiter(text) {
    const sample = text.split("\n").slice(0, 20).join("\n");
    let best = ",", bestCount = -1;
    for (const c of [",", "\t", ";"]) {
      let n = 0;
      for (const ch of sample) if (ch === c) n++;
      if (n > bestCount) { best = c; bestCount = n; }
    }
    return bestCount > 0 ? best : ",";
  }

  function parseCSV(raw) {
    let text = String(raw);
    if (text.startsWith(BOM)) text = text.slice(1);
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const delim = sniffDelimiter(text);
    const rows = [];
    let field = "", row = [], quoted = [], cellQuoted = false, inQuotes = false;
    const endRow = () => {
      quoted.push(cellQuoted);
      row.push(field);
      field = "";
      cellQuoted = false;
      if (!(row.length === 1 && row[0] === "" && !quoted[0])) {
        rows.push(row.map((cell, i) => (quoted[i] ? cell : cell.replace(/^[ \t]+|[ \t]+$/g, ""))));
      }
      row = [];
      quoted = [];
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === "\"") {
          if (text[i + 1] === "\"") { field += "\""; i++; } else inQuotes = false;
        } else field += c;
        continue;
      }
      if (c === "\"") { inQuotes = true; cellQuoted = true; }
      else if (c === delim) { row.push(field); field = ""; quoted.push(cellQuoted); cellQuoted = false; }
      else if (c === "\n") endRow();
      else field += c;
    }
    if (field !== "" || row.length) endRow();
    return rows;
  }

  // `CSVImporter.importCSV`'s reading: the entries a mapping makes, with
  // the rows it skipped for an empty front.
  function csvEntries(rows, { skipHeader, front, back }) {
    const body = skipHeader ? rows.slice(1) : rows;
    const entries = [];
    let invalid = 0;
    for (const r of body) {
      if (front >= r.length) { invalid++; continue; }
      const f = r[front].trim();
      if (!f) { invalid++; continue; }
      const b = back != null && back < r.length ? r[back].trim() : "";
      entries.push({ front: f, back: b });
    }
    return { entries, invalid };
  }

  const dupKey = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

  // `DuplicateCheck.filter`: a front already in the doc, or twice in the
  // file, is skipped.
  function withoutDuplicates(entries, existingFronts) {
    const seen = new Set([...existingFronts].map(dupKey));
    const unique = [], duplicates = [];
    for (const e of entries) {
      const k = dupKey(e.front);
      if (seen.has(k)) { duplicates.push(e); continue; }
      seen.add(k);
      unique.push(e);
    }
    return { unique, duplicates };
  }

  // One line per entry, as the doc stores it: a front and a back make a
  // forward card through the same gate as a typed line (D-191: `>>`), and a
  // trigger inside a cell is flattened (`importSide`), so `std::move` is
  // not a concept and the line splits where the file meant.
  const entryLine = e => (e.back ? `${Gate.flattenTriggers(e.front)} >> ${Gate.flattenTriggers(e.back)}` : Gate.flattenTriggers(e.front));

  function csvEscape(field) {
    const s = String(field ?? "");
    return /[",\n\r]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
  }

  // A legacy `code` row (code left Recall, owner 2026-09-29) exports as the
  // paragraph it now is: no prefix.
  const PREFIX = { heading1: "# ", heading2: "## ", heading3: "### ", quote: "> ", bullet: "* ", dash: "- ",
                   checkbox: "[] " };

  // `Snapshots.exportCSV`: every live note of every live doc, grouped by doc
  // name, in document order.
  function exportCSV(L) {
    const docs = [...L.docs.values()].filter(d => d.deleted_at == null)
      .sort((a, b) => (String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0));
    const byDoc = new Map();
    for (const n of L.notes.values()) {
      if (n.deleted_at != null) continue;
      if (!byDoc.has(n.notebook_id)) byDoc.set(n.notebook_id, []);
      byDoc.get(n.notebook_id).push(n);
    }
    const lines = ["front,back,cloze,tags,deck"];
    for (const d of docs) {
      for (const { note } of Model.ordered(byDoc.get(d.id) || [])) {
        const front = (PREFIX[note.kind] || "") + (note.front || "");
        lines.push([front, note.back || "", note.cloze_text || "", note.tags || "", d.name || ""].map(csvEscape).join(","));
      }
    }
    return BOM + lines.join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------ Markdown, text

  const splitLines = s => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  function headingLine(line) {
    const m = /^#{1,6}\s+/.exec(line);
    if (!m) return line;
    const level = Math.min((m[0].match(/#/g) || []).length, 3);
    const title = line.slice(m[0].length).replace(/\s+#+\s*$/, "");
    return "#".repeat(level) + " " + title;
  }

  function listLine(line) {
    let m = /^[-*+]\s+\[[ xX]\]\s+/.exec(line);
    if (m) return "- " + line.slice(m[0].length);
    m = /^[+•◦▪]\s+/.exec(line);
    if (m) return "* " + line.slice(m[0].length);
    m = /^(\d+)\)\s+/.exec(line);
    if (m) return m[1] + ". " + line.slice(m[0].length);
    return line;
  }

  function inline(line) {
    let s = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    s = s.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1");
    s = s.replace(/__(\S(?:.*?\S)?)__/g, "$1");
    s = s.replace(/ {2,}/g, " ");
    return s.trim();
  }

  function isRule(line) {
    const chars = [...line].filter(c => !/\s/.test(c));
    if (chars.length < 3 || !"-*_=".includes(chars[0])) return false;
    return chars.every(c => c === chars[0]);
  }

  function markdownLines(s) {
    const out = [];
    let all = splitLines(s);
    if (all.length && all[0].trim() === "---") {
      const close = all.slice(1).findIndex(l => l.trim() === "---");
      if (close >= 0) all = all.slice(close + 2);
    }
    let fenced = false;
    for (const raw of all) {
      const line = raw.trim();
      if (line.startsWith("```") || line.startsWith("~~~")) { fenced = !fenced; continue; }
      if (!line) continue;
      if (fenced) { out.push(line); continue; }
      if (isRule(line)) continue;
      const cleaned = inline(listLine(headingLine(line)));
      if (cleaned.trim()) out.push(cleaned);
    }
    return out;
  }

  const WRAP_WIDTH = 60;
  const startsBlock = line => line.startsWith("#") || line.startsWith("> ") || line.startsWith("|")
    || /^([-*+•]|\d+[.)])\s/.test(line);
  const endsSentence = text => ".!?:;”\")".includes(text.slice(-1));

  // `NoteFileReader.text`: a hard wrapped paragraph joins back into one
  // line; a list marker is the doc's.
  function textLines(s) {
    const out = [];
    let joinable = false;
    for (const raw of splitLines(s)) {
      const line = raw.trim();
      if (!line) { joinable = false; continue; }
      const listed = listLine(line);
      if (joinable && out.length && listed === line && !startsBlock(line) && !Gate.separatorHits(line).length) {
        const last = out[out.length - 1];
        out[out.length - 1] = /\p{L}-$/u.test(last) ? last.slice(0, -1) + line : last + " " + line;
      } else {
        out.push(listed);
      }
      joinable = line.length >= WRAP_WIDTH && !endsSentence(line) && !Gate.separatorHits(line).length;
    }
    return out;
  }

  function docName(fileName) {
    const base = String(fileName || "").replace(/\.[^.]*$/, "").trim();
    return base || "Notes";
  }

  function decodeText(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if ((b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF)) {
      return new TextDecoder(b[0] === 0xFF ? "utf-16le" : "utf-16be").decode(b.subarray(2));
    }
    try {
      const s = new TextDecoder("utf-8", { fatal: true }).decode(b);
      return s.startsWith(BOM) ? s.slice(1) : s;
    } catch (_) {
      return new TextDecoder("windows-1252").decode(b);
    }
  }

  // ----------------------------------------------------------------- JSON

  // Swift's default JSONEncoder writes a Date as seconds since 2001-01-01.
  const REFERENCE_SECONDS = 978307200;
  // Whole milliseconds first, then one division, so a stamp prints as the
  // three decimals it has.
  const swiftDate = iso => (iso == null ? undefined : (Wire.wireMillis(iso) - REFERENCE_SECONDS * 1000) / 1000);
  const upper = id => (id == null ? undefined : String(id).toUpperCase());

  // Each type's CodingKeys, and which of them are dates or ids.
  const SHAPES = {
    folder: { keys: ["id", "name", "emoji", "position", "created_at", "updated_at", "deleted_at", "exam_at", "retention_pct", "new_per_day"] },
    notebook: { keys: ["id", "folder_id", "name", "emoji", "position", "created_at", "updated_at", "deleted_at", "exam_at", "style", "retention_pct", "new_per_day"] },
    note: { keys: ["id", "notebook_id", "parent_id", "position", "front", "back", "cloze_text", "tags", "unreviewed", "occ_mode", "typed_answer", "spans", "kind", "attrs", "created_at", "updated_at", "deleted_at"] },
    card: { keys: ["id", "note_id", "cloze_ordinal", "flag", "suspended", "stability", "difficulty", "due", "state", "last_review_at", "introduced_on", "reps", "lapses", "q_snapshot", "a_snapshot", "detached", "updated_at", "deleted_at"] },
    grade_event: { keys: ["id", "card_id", "rating", "reviewed_at", "device_id"] },
    media: { keys: ["id", "note_id", "rel_path", "mime", "bytes_sha", "created_at", "updated_at", "deleted_at", "display_width", "crop", "latex"] },
    occlusion: { keys: ["id", "note_id", "ordinal", "x", "y", "w", "h", "label", "media_id", "rotation", "points_json", "z", "created_at", "updated_at", "deleted_at"] },
    dictionary: { keys: ["id", "word", "created_at", "updated_at", "deleted_at"] },
    font: { keys: ["id", "family", "file_name", "rel_path", "bytes_sha", "created_at", "updated_at", "deleted_at"] },
  };
  const DATES = new Set(["created_at", "updated_at", "deleted_at", "exam_at", "due", "last_review_at", "introduced_on", "reviewed_at"]);
  const IDS = new Set(["id", "folder_id", "notebook_id", "parent_id", "note_id", "card_id", "media_id"]);

  function swiftRow(lane, row) {
    const out = {};
    for (const k of SHAPES[lane].keys) {
      let v = row[k];
      if (v === null || v === undefined) continue;
      if (DATES.has(k)) v = swiftDate(v);
      else if (IDS.has(k)) v = upper(v);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  // The bundle, given every live row by lane and the bytes by rel path.
  function exportBundle(rowsByLane, settings, files) {
    const live = lane => (rowsByLane[lane] || []).filter(r => r.deleted_at == null).map(r => swiftRow(lane, r));
    return {
      folders: live("folder"),
      notebooks: live("notebook"),
      notes: live("note"),
      cards: live("card"),
      events: (rowsByLane.grade_event || []).map(r => swiftRow("grade_event", r)),
      media: live("media"),
      mediaFiles: files.map(f => ({ relPath: f.relPath, dataBase64: f.dataBase64 })),
      occlusions: live("occlusion"),
      settings: { ...settings },
      dictionary: live("dictionary"),
      fonts: live("font"),
    };
  }

  function base64(bytes) {
    let s = "";
    const b = new Uint8Array(bytes);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // `recall-export-<stamp>` as `Snapshots.stamp` writes it.
  function stamp(now = new Date()) {
    const p = n => String(n).padStart(2, "0");
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  }

  // ------------------------------------------------------------ the page

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.className = "hidden-input";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // The snapshot: every live row this browser holds, with the bytes of
  // every picture and font it can reach (its own copy first). A picture
  // whose bytes cannot be read is left out of `mediaFiles`, as the app
  // leaves out a file missing from disk.
  async function downloadSnapshot(onProgress) {
    const byLane = {};
    for (const lane of Object.keys(SHAPES)) byLane[lane] = Backend.rowsOf(lane);
    const L = Backend.library();
    const files = [];
    const wanted = [...byLane.media, ...byLane.font].filter(r => r.deleted_at == null && r.rel_path);
    let done = 0, missing = 0;
    for (const row of wanted) {
      try {
        const blob = await Backend.media(row);
        files.push({ relPath: row.rel_path, dataBase64: base64(await blob.arrayBuffer()) });
      } catch (_) { missing++; }
      done++;
      if (onProgress) onProgress(done, wanted.length);
    }
    const bundle = exportBundle(byLane, L.settingsValues || {}, files);
    save(new Blob([JSON.stringify(bundle)], { type: "application/json" }), `recall-export-${stamp()}.json`);
    return { notes: bundle.notes.length, files: files.length, missing };
  }

  function downloadCSV() {
    save(new Blob([exportCSV(Backend.library())], { type: "text/csv;charset=utf-8" }), `recall-export-${stamp()}.csv`);
  }

  // Import: a CSV opens the column sheet; Markdown and text open Upload
  // Notes (Ink 17 section 6: a count, a preview, a destination, a caption).
  async function importFile(file, { onDone, onError, currentDoc } = {}) {
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error(`That file is ${Math.round(file.size / 1048576)} MB. Import handles up to 8 MB; split it first.`);
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      const text = decodeText(new Uint8Array(await file.arrayBuffer()));
      if (ext === "csv" || ext === "tsv") csvSheet(file.name, text, { onDone, onError, currentDoc });
      else if (["md", "markdown", "mdown", "txt", "text"].includes(ext)) {
        notesSheet(file.name, ["md", "markdown", "mdown"].includes(ext) ? markdownLines(text) : textLines(text), { onDone, onError, currentDoc });
      } else {
        throw new Error("Recall on the web imports CSV, Markdown and plain text. Word, PDF and Anki files import in Recall on the Mac.");
      }
    } catch (error) {
      if (onError) onError(error);
    }
  }

  function destination({ currentDoc, name }) {
    const { h, clear } = UI;
    const docs = Pages.liveDocs(Backend.library());
    const state = { into: currentDoc && docs.some(d => d.id === currentDoc) ? "existing" : "new", name, docId: currentDoc || (docs[0] && docs[0].id) || null };
    const host = h("div");
    const draw = () => {
      clear(host);
      const seg = h("div.segmented", { role: "group", "aria-label": "Into" },
        [["new", "New doc"], ["existing", "Existing doc"]].map(([id, label]) => {
          const b = h("button", { type: "button", text: label, "aria-pressed": state.into === id ? "true" : "false",
            disabled: id === "existing" && !docs.length, onclick: () => { state.into = id; draw(); } });
          if (state.into === id) b.classList.add("on");
          return b;
        }));
      let row;
      if (state.into === "new") {
        const field = h("input.field.inline", { type: "text", value: state.name, maxlength: 200, "aria-label": "Name" });
        field.addEventListener("input", () => { state.name = field.value; });
        row = h("div.value-row", h("span.value-label", { text: "Name" }), field);
      } else {
        const select = h("select.field.inline", { "aria-label": "Doc" }, docs.map(d => h("option", { value: d.id, text: d.name || "Untitled" })));
        select.value = state.docId;
        select.addEventListener("change", () => { state.docId = select.value; });
        row = h("div.value-row", h("span.value-label", { text: "Doc" }), select);
      }
      host.append(UI.group("Into", [h("div.value-row", seg), row]));
    };
    draw();
    return { node: host, target: () => {
      if (state.into === "existing" && state.docId) return state.docId;
      return Store.createDoc(state.name.trim() || "Notes");
    } };
  }

  function existingFronts(docId) {
    const out = [];
    for (const n of Backend.library().notes.values()) if (n.deleted_at == null && n.notebook_id === docId && n.front) out.push(n.front);
    return out;
  }

  function notesSheet(fileName, lines, { onDone, onError, currentDoc }) {
    const { h } = UI;
    const dest = destination({ currentDoc: null, name: docName(fileName) });
    const preview = lines.slice(0, 2).map((l, i) => h("div.preview-line", { text: l, className: i ? "muted" : null }));
    if (lines.length > 2) preview.push(h("div.preview-line.faint", { text: `+ ${lines.length - 2} more` }));
    UI.sheet({ title: "Upload Notes", left: "Cancel", right: "Add", width: 480, rightDisabled: !lines.length,
      body: [h("div.section-head", h("span.eyebrow", { text: fileName }), h("span.section-fact", { text: UI.plural(lines.length, "paragraph") })),
             h("div.block.preview", preview.length ? preview : [h("div.preview-line.faint", { text: "Nothing to import in this file." })]),
             dest.node,
             h("p.help", { text: "Every paragraph becomes a note. Add >> later to make cards." })],
      onRight: () => {
        try {
          const docId = dest.target();
          Store.importLines(docId, lines);
          if (onDone) onDone(docId, lines.length);
        } catch (error) { if (onError) onError(error); return false; }
        return true;
      } });
    void currentDoc;
  }

  function csvSheet(fileName, text, { onDone, onError, currentDoc }) {
    const { h, clear } = UI;
    const rows = parseCSV(text);
    if (!rows.length) { if (onError) onError(new Error("No rows found.")); return; }
    const width = Math.max(...rows.slice(0, 50).map(r => r.length));
    const header = rows[0].map(c => c.toLowerCase());
    const pick = (names, fallback) => { const i = header.findIndex(c => names.includes(c)); return i >= 0 ? i : fallback; };
    const state = { skipHeader: header.includes("front") || header.includes("question"),
                    front: pick(["front", "question", "term"], 0),
                    back: width > 1 ? pick(["back", "answer", "definition"], 1) : null };
    const dest = destination({ currentDoc, name: docName(fileName) });
    const mapping = h("div");
    const status = h("p.help");
    const columnName = i => (state.skipHeader && rows[0][i] ? `${i + 1} · ${rows[0][i]}` : `Column ${i + 1}`);
    let handle;
    const draw = () => {
      clear(mapping);
      const select = (value, allowNone, onchange, label) => {
        const s = h("select.field.inline", { "aria-label": label });
        if (allowNone) s.appendChild(h("option", { value: "", text: "None" }));
        for (let i = 0; i < width; i++) s.appendChild(h("option", { value: String(i), text: columnName(i) }));
        s.value = value == null ? "" : String(value);
        s.addEventListener("change", () => { onchange(s.value === "" ? null : Number(s.value)); draw(); });
        return s;
      };
      mapping.append(UI.group("Columns", [
        UI.valueRow("First row is a header", UI.toggle(state.skipHeader, on => { state.skipHeader = on; draw(); }, "First row is a header")),
        h("div.value-row", h("span.value-label", { text: "Front" }), select(state.front, false, v => { state.front = v; }, "Front column")),
        h("div.value-row", h("span.value-label", { text: "Back" }), select(state.back, true, v => { state.back = v; }, "Back column")),
      ]));
      const { entries, invalid } = csvEntries(rows, state);
      const first = entries[0];
      mapping.appendChild(h("div.block.preview", first
        ? [h("div.preview-line", { text: first.front }), h("div.preview-line.muted", { text: first.back || "No back" })]
        : [h("div.preview-line.faint", { text: "No row has a front in that column." })]));
      status.textContent = [UI.plural(entries.length, "row"), invalid ? `${invalid} skipped (empty front)` : null].filter(Boolean).join(" · ");
      if (handle) {
        const same = state.back != null && state.back === state.front;
        handle.rightBtn.disabled = !entries.length || same;
        handle.rightBtn.textContent = entries.length ? `Import ${entries.length}` : "Import";
        if (same) status.textContent = "Back column equals front column: every row would be front only.";
      }
    };
    draw();
    handle = UI.sheet({ title: "Import CSV", left: "Cancel", right: "Import", width: 500,
      body: [h("div.section-head", h("span.eyebrow", { text: fileName }), h("span.section-fact", { text: UI.plural(rows.length, "row") })),
             mapping, dest.node, status,
             h("p.help", { text: "A row with a back becomes a card. Every note is tagged imported; a front already in the doc is skipped." })],
      onRight: () => {
        try {
          const { entries } = csvEntries(rows, state);
          const docId = dest.target();
          const { unique, duplicates } = withoutDuplicates(entries, existingFronts(docId));
          Store.importLines(docId, unique.map(entryLine), "imported");
          if (onDone) onDone(docId, unique.length, duplicates.length);
        } catch (error) { if (onError) onError(error); return false; }
        return true;
      } });
    draw();
  }

  return { sniffDelimiter, parseCSV, csvEntries, withoutDuplicates, entryLine, csvEscape, exportCSV,
           headingLine, listLine, inline, markdownLines, textLines, docName, decodeText,
           swiftRow, exportBundle, base64, stamp, SHAPES, REFERENCE_SECONDS,
           downloadSnapshot, downloadCSV, importFile, save };
})();
