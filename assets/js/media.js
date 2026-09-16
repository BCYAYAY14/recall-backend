// Pictures, drawings and occlusion diagrams.
//
// Bytes are content addressed by sha256 and reach the page only through the
// backend (never a bucket URL): a paired browser with its device credential,
// a visitor with the share token. Each is held as an object URL for the life
// of the page. The derived PNG beside a drawing is NOT synced,
// so a drawing is rendered from its JSON here (see js/drawing.js).

const Media = (() => {

  const DRAWING_MIME = "application/vnd.recall.drawing+json";

  const urls = new Map();     // media id -> object URL
  const drawings = new Map(); // media id -> parsed DrawingDocument
  const pending = new Map();

  let rows = new Map();       // media id -> row
  let regions = new Map();    // media id -> [occlusion]
  let legacyByNote = new Map();// note id -> [occlusion] with a null media_id

  function reset(mediaRows, occlusionRows) {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    drawings.clear();
    pending.clear();
    rows = new Map(mediaRows.map(r => [r.id, r]));
    regions = new Map();
    legacyByNote = new Map();
    for (const o of occlusionRows) {
      if (o.deleted_at != null) continue;
      if (o.media_id) {
        if (!regions.has(o.media_id)) regions.set(o.media_id, []);
        regions.get(o.media_id).push(o);
      } else {
        if (!legacyByNote.has(o.note_id)) legacyByNote.set(o.note_id, []);
        legacyByNote.get(o.note_id).push(o);
      }
    }
  }

  function isDrawing(row) {
    return !!row && (row.mime === DRAWING_MIME
                     || String(row.rel_path || "").endsWith(".drawing.json"));
  }

  // A note's FIRST image by created_at, which is what a legacy region (null
  // media_id) binds to (the pre v1.7 single image shape).
  function firstImageOf(noteId) {
    const mine = [...rows.values()]
      .filter(r => r.note_id === noteId && r.deleted_at == null)
      .sort((a, b) => (a.created_at || "") < (b.created_at || "") ? -1 : 1);
    return mine[0] || null;
  }

  // Live regions of `noteId` that belong to this media row. The rule the
  // review face applies, restated: an explicit `media_id` wins, and a legacy
  // region binds to the note's first image.
  function regionsFor(mediaId, noteId) {
    const own = (regions.get(mediaId) || []).slice();
    if (noteId) {
      const legacy = legacyByNote.get(noteId) || [];
      const first = firstImageOf(noteId);
      if (legacy.length && first && first.id === mediaId) own.push(...legacy);
    }
    // The face sorts by (z, ordinal); the same order here keeps a stacked
    // region drawn the same way in both places.
    return own.sort((a, b) => (a.z || 0) - (b.z || 0) || (a.ordinal || 0) - (b.ordinal || 0));
  }

  // WHICH media rows this document draws as a diagram the text never names:
  // a row with regions on it (landmine 104: the honest question is REGIONS,
  // not "untokened").
  function diagramsByNote() {
    const out = new Map();
    for (const row of rows.values()) {
      if (row.deleted_at != null) continue;
      if (!regionsFor(row.id, row.note_id).length) continue;
      if (!out.has(row.note_id)) out.set(row.note_id, []);
      out.get(row.note_id).push(row.id);
    }
    return out;
  }

  function row(mediaId) {
    return rows.get(mediaId) || rows.get(String(mediaId).toLowerCase())
        || [...rows.values()].find(r => r.id.toLowerCase() === String(mediaId).toLowerCase())
        || null;
  }

  async function load(mediaId) {
    const r = row(mediaId);
    if (!r) return null;
    if (urls.has(r.id)) return { row: r, url: urls.get(r.id), drawing: drawings.get(r.id) };
    if (pending.has(r.id)) return pending.get(r.id);
    const job = (async () => {
      const blob = await Backend.media(r);
      if (isDrawing(r)) {
        const doc = Draw.parse(await blob.text());
        if (doc) drawings.set(r.id, doc);
        urls.set(r.id, "");
        return { row: r, url: "", drawing: doc };
      }
      const url = URL.createObjectURL(blob);
      urls.set(r.id, url);
      return { row: r, url, drawing: null };
    })();
    pending.set(r.id, job);
    try { return await job; } finally { pending.delete(r.id); }
  }

  return { reset, load, row, regionsFor, diagramsByNote, isDrawing, DRAWING_MIME };
})();
