// OFFLINE FIXTURE for the viewer: `index.html?fixture=shared` or
// `?fixture=signed`. It replaces the network calls on `Backend` with synthetic
// rows before the shell boots, so every path the page takes (the document,
// the cards, a share link, the Share panel) can be driven with no project,
// no account and no credential. Nothing here is loaded without the query.

(() => {
  const requested = new URLSearchParams(location.search).get("fixture");
  if (requested === null) return;
  const mode = requested || "shared";

  let seq = 0;
  const uuid = () => {
    seq += 1;
    return "00000000-0000-4000-8000-" + String(seq).padStart(12, "0");
  };
  const DOC = "10000000-0000-4000-8000-000000000001";
  const FOLDER = "20000000-0000-4000-8000-000000000001";
  const stamp = "2026-09-13T00:00:00.000Z";

  const notes = [];
  const cards = [];
  const media = [];
  const occlusion = [];

  // A note row exactly as the `note` table holds it.
  function note(kind, text, extra = {}) {
    const row = {
      id: extra.id || uuid(),
      notebook_id: DOC,
      parent_id: extra.parent || null,
      position: extra.position != null ? extra.position : seq,
      front: text,
      back: extra.back != null ? extra.back : null,
      cloze_text: extra.cloze || null,
      occ_mode: extra.occMode || null,
      kind,
      attrs: extra.attrs ? JSON.stringify({ v: 1, ...extra.attrs }) : null,
      spans: null,
      created_at: stamp,
      updated_at: stamp,
      deleted_at: null,
    };
    if (extra.runs) {
      const anchor = Model.rawText(row);
      row.spans = JSON.stringify({
        v: 1, n: anchor.length, h: Spans.fingerprint(anchor),
        r: extra.runs.map(r => r.value ? [r.start, r.end, r.kind, r.value]
                                       : [r.start, r.end, r.kind]),
      });
    }
    notes.push(row);
    return row;
  }

  function card(noteRow, ordinal = null, extra = {}) {
    cards.push({ id: uuid(), note_id: noteRow.id, cloze_ordinal: ordinal,
                 suspended: !!extra.suspended, detached: !!extra.detached, deleted_at: null });
  }

  note("heading1", "Cells and energy");
  const body = "Body text is 11pt on Google Docs' page, with bold, italic, "
    + "struck, code, a highlight, a larger phrase and x2 raised.";
  const at = (word, kind, value) => {
    const start = body.indexOf(word);
    return { start, end: start + word.length, kind, value };
  };
  note("paragraph", body, {
    runs: [at("bold", "b"), at("italic", "i"), at("struck", "s"), at("code", "c"),
           at("a highlight", "h", "#e8c34a"), at("a larger phrase", "z", "16"),
           at("2", "u"), at("Google", "f", "Times New Roman")],
  });

  note("heading2", "Lists");
  note("bullet", "A dot point at depth zero", { attrs: { d: 0 } });
  note("bullet", "One level in, a hollow circle", { attrs: { d: 1 } });
  note("numbered", "1. First", { attrs: { d: 0 } });
  note("numbered", "2. Second", { attrs: { d: 0 } });
  note("numbered", "1. Nested runs a., b.", { attrs: { d: 1 } });

  note("heading2", "Cards and cloze");
  note("quote", "A quote keeps a 2pt bar in the margin and reads in secondary ink.");
  card(note("paragraph", "The capital of France", { back: "Paris" }));
  const cloze = note("paragraph", "", {
    cloze: "The {{c1::mitochondrion}} is the powerhouse of the {{c2::cell::organelle or cell}}." });
  card(cloze, 1);
  card(cloze, 2);
  card(note("paragraph", "A suspended card is not practised", { back: "hidden" }), null,
       { suspended: true });

  // C-72 (OR-4, 2026-09-16): the two block kinds and the reverse pair.
  note("heading2", "Code, tasks and a pair");
  note("code", "let total = cards.filter(isDue).count");
  note("checkbox", "Buy the tickets", { attrs: { chk: true } });
  note("checkbox", "Renew the passport");
  const pair = note("paragraph", "perro", { back: "dog", attrs: { rev: true } });
  card(pair);
  card(pair, -1);

  note("heading2", "A card table");
  const cardTable = note("table", "", { attrs: { card: true, w: [220, 220] } });
  note("tablerow", "French", { parent: cardTable.id, position: 0, back: "English" });
  [["Bonjour", "Hello"], ["Merci", "Thank you"]].forEach(([f, b], i) => {
    card(note("tablerow", f, { parent: cardTable.id, position: i + 1, back: b }));
  });

  note("heading2", "A diagram");
  const diagram = note("paragraph", "Label the parts of the cell", { occMode: "one" });
  const pictureId = "30000000-0000-4000-8000-000000000001";
  media.push({ id: pictureId, note_id: diagram.id, rel_path: "cell.png", mime: "image/png",
               bytes_sha: "fixture", created_at: stamp, updated_at: stamp, deleted_at: null,
               display_width: 420, crop: null, latex: null });
  [[0, 0.08, 0.1, 0.34, 0.16, "Nucleus"], [1, 0.55, 0.62, 0.34, 0.16, "Membrane"]]
    .forEach(([ordinal, x, y, w, h, label]) => {
      occlusion.push({ id: uuid(), note_id: diagram.id, ordinal, x, y, w, h, label,
                       media_id: pictureId, rotation: 0, points_json: null, z: 0,
                       created_at: stamp, updated_at: stamp, deleted_at: null });
      card(diagram, ordinal);
    });

  note("heading2", "A drawing");
  const drawingId = "30000000-0000-4000-8000-000000000002";
  const drawingNote = note("image", "", { attrs: { m: drawingId, mw: 420 } });
  media.push({ id: drawingId, note_id: drawingNote.id, rel_path: "sketch.drawing.json",
               mime: "application/vnd.recall.drawing+json", bytes_sha: "fixture",
               created_at: stamp, updated_at: stamp, deleted_at: null,
               display_width: 420, crop: null, latex: null });

  const drawing = {
    version: 1, width: 420, height: 160,
    shapes: [
      { id: "1", kind: "rectangle", points: [{ x: 20, y: 30 }, { x: 150, y: 110 }],
        stroke: { colour: "accent", width: 3 }, fill: "blue" },
      { id: "2", kind: "arrow", points: [{ x: 160, y: 70 }, { x: 250, y: 70 }],
        stroke: { colour: "ink", width: 3 } },
      { id: "3", kind: "ellipse", points: [{ x: 260, y: 30 }, { x: 390, y: 110 }],
        stroke: { colour: "red", width: 3, dashed: true } },
    ],
  };

  // A cell, drawn once: the picture the diagram's regions sit on.
  function cellPNG() {
    return new Promise(resolve => {
      const c = document.createElement("canvas");
      c.width = 840; c.height = 520;
      const g = c.getContext("2d");
      g.fillStyle = "#f3efe4"; g.fillRect(0, 0, 840, 520);
      g.fillStyle = "#cfe3c7"; g.beginPath(); g.ellipse(420, 260, 380, 220, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#5a7d4f"; g.lineWidth = 8; g.stroke();
      g.fillStyle = "#b58bc7"; g.beginPath(); g.arc(250, 170, 80, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#333"; g.font = "bold 30px sans-serif";
      g.fillText("nucleus", 120, 90); g.fillText("membrane", 470, 400);
      c.toBlob(resolve, "image/png");
    });
  }

  const notebook = {
    id: DOC, folder_id: FOLDER, name: "Biology", emoji: "mark", position: 0,
    style: JSON.stringify({ h: [{ size: 20, weight: 3 }, { size: 15, weight: 2 },
                                { size: 13, weight: 1 }], ls: 1.15 }),
    created_at: stamp, updated_at: stamp, deleted_at: null,
  };

  // `?fixture=injection` (W11): the shared doc plus hostile content in every
  // field the renderer reads. It must draw as TEXT, raise no dialog, add no
  // script and log no CSP violation.
  if (mode === "injection") {
    const hostile = ["<img src=x onerror=alert(1)>", "<script>alert(2)</script>",
      "[link](javascript:alert(3))", "<svg onload=alert(4)>", "\"><iframe src=javascript:alert(5)>"];
    note("heading1", hostile[0]);
    for (const h of hostile) note("paragraph", `${h} :: ${h}`, { back: h });
    note("paragraph", "{{img:\"><svg onload=alert(6)>}}");
    note("paragraph", "{{c1::<img src=x onerror=alert(7)>::<b>hint</b>}}", { cloze: "{{c1::<img src=x onerror=alert(7)>}}" });
    note("paragraph", "$\\href{javascript:alert(8)}{click}$ and $$\\htmlClass{x}{y}$$");
    note("table", "", { attrs: { w: ["<b>", 10] } });
    notebook.name = "<img src=x onerror=alert(9)>";
    notebook.style = "{\"f\":\"</style><script>alert(10)</script>\"}";
  }

  Backend.checkVersion = async () => ({ pv_min: 1, pv_max: 1 });
  Backend.media = async row => row.rel_path === "cell.png"
    ? cellPNG()
    : new Blob([JSON.stringify(drawing)], { type: "application/json" });

  if (mode === "shared" || mode === "injection") {
    // `revoked` is a stopped link; anything else answers the doc.
    Backend.sharedDoc = async token => token === "revoked"
      ? { stopped: "This link has been stopped." }
      : { notebook, notes, cards, media, occlusion };
    Backend.isShared = () => true;
    if (!location.hash.startsWith("#share=")) {
      history.replaceState(null, "", location.pathname + location.search + "#share=fixture-token");
    }
    return;
  }

  // PAIRED: a library of one folder and two docs, and share links in memory,
  // so New link and Stop sharing can be pressed.
  const shares = [];
  const folders = [{ id: FOLDER, name: "HSC", emoji: "📁", position: 0, deleted_at: null }];
  const docs = [notebook, { ...notebook, id: "10000000-0000-4000-8000-000000000002",
                            name: "Empty doc", folder_id: null, style: null }];
  Backend.isSignedIn = () => true;
  Backend.isShared = () => false;
  Backend.folders = async () => folders;
  Backend.notebooks = async () => docs;
  Backend.noteCounts = () => new Map([[DOC, notes.length]]);
  Backend.doc = async docId => docId === DOC
    ? { notes, cards, media, occlusion }
    : { notes: [], cards: [], media: [], occlusion: [] };
  Backend.fontRows = () => [];
  Backend.shares = async docId => shares.filter(x => x.notebook_id === docId && !x.revoked_at);
  Backend.createShare = async docId => {
    const made = { id: uuid(), notebook_id: docId, revoked_at: null };
    shares.push(made);
    return { id: made.id, url: `${location.origin}${location.pathname}#share=fixture-token` };
  };
  Backend.revokeShare = async id => {
    const hit = shares.find(x => x.id === id);
    if (hit) hit.revoked_at = new Date().toISOString();
  };
})();
