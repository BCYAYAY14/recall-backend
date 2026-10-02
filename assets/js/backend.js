// The web app's one network client and its row store, speaking protocol 1
// (PROTOCOL.md) to the backend at location.origin. No server to configure and
// no key in the page: the page and the API share an origin (plan 10.3).
//
// Two modes. PAIRED is a browser that typed a pairing code from Recall: a
// DEVICE with full scope since ruling W-0 (2026-09-23), so it reads the whole
// library and writes grades and edits under its own device id. SHARED is a
// visitor holding a share link and nothing else: read-only for ever, the
// token in a POST body, never in a URL (finding F-14).
//
// The rules it keeps, all from PROTOCOL.md and the reference client:
// - every row travels WHOLE (every column of its lane; null is a clear);
// - a write is stamped one millisecond past the row's own stamp when the
//   clock has not moved past it, and last write wins with a TIE TO THE SERVER
//   (landmine 83; `Wire.isNewer`);
// - one push in flight; the acknowledgement rule: an `applied` or
//   `duplicate` cleans a row only if it still carries the stamp and the
//   payload digest that were sent; `stale` and `conflict` adopt the winner
//   unless the row moved on; `rejected` stays dirty and is not re-sent until
//   the row changes;
// - one cursor, advanced only by a continuous frame; this device's own ops
//   come back and only move `base_seq`; a gap or `resync_required`
//   bootstraps from the snapshot, dirty rows kept.
// W-8: the rows are also kept in this browser (js/local.js). A dirty row
// is an outbox entry that survives a closed tab and is pushed on reconnect
// under the same rules; the cursor is written with the rows it covers. Live
// changes arrive over the Worker's WebSocket (the token offered as a
// subprotocol, never in a URL); the HTTP poll runs only while the socket is
// down (P4: HTTP alone is a complete client).

const Backend = (() => {

  const PROTOCOL = 1;
  const SCHEMA = 219;
  const APP = "web 1.0";
  const TOKEN_KEY = "recall.viewer.device-token";
  const DEVICE_KEY = "recall.viewer.device-id";
  const LABEL_KEY = "recall.viewer.device-label";
  const LIBRARY_KEY = "recall.viewer.library-id";
  const CLOCK_LIMIT_MS = 60000;
  // The banner reads "Offline: " and this sentence (AM-20: "Source: message").
  const OFFLINE_SENTENCE = "Edits and grades wait in this browser and send when it reconnects.";
  const POLL_MS = 20000;

  // `LANES` in src/protocol.ts, restated. A column the lane does not name is
  // never sent, and every column it names always is.
  const LANES = {
    folder: { env: { position: "int", created_at: "ts", deleted_at: "ts?", exam_at: "ts?", retention_pct: "int?", new_per_day: "int?" }, content: { name: "str", emoji: "str" }, tombstones: true },
    notebook: { env: { folder_id: "uuid?", position: "int", created_at: "ts", deleted_at: "ts?", exam_at: "ts?", retention_pct: "int?", new_per_day: "int?" }, content: { name: "str", emoji: "str", style: "str?" }, tombstones: true },
    note: { env: { notebook_id: "uuid", parent_id: "uuid?", position: "int", kind: "str", unreviewed: "bool", occ_mode: "str?", typed_answer: "bool", created_at: "ts", deleted_at: "ts?" }, content: { front: "str?", back: "str?", cloze_text: "str?", tags: "str", spans: "str?", attrs: "str?" }, tombstones: true },
    card: { env: { note_id: "uuid", cloze_ordinal: "int?", flag: "int", suspended: "bool", stability: "num", difficulty: "num", due: "ts", state: "str", last_review_at: "ts?", introduced_on: "ts?", reps: "int", lapses: "int", detached: "bool", deleted_at: "ts?" }, content: { q_snapshot: "str?", a_snapshot: "str?" }, tombstones: true },
    grade_event: { env: { card_id: "uuid", rating: "int", reviewed_at: "ts", device_id: "str" }, content: {}, tombstones: false, stampColumn: "reviewed_at" },
    media: { env: { note_id: "uuid", rel_path: "str", mime: "str", bytes_sha: "sha", display_width: "num?", created_at: "ts", deleted_at: "ts?" }, content: { crop: "str?", latex: "str?" }, tombstones: true },
    occlusion: { env: { note_id: "uuid", ordinal: "int", x: "num", y: "num", w: "num", h: "num", media_id: "uuid?", rotation: "num", z: "int", created_at: "ts", deleted_at: "ts?" }, content: { label: "str", points_json: "str?" }, tombstones: true },
    dictionary: { env: { created_at: "ts", deleted_at: "ts?" }, content: { word: "str" }, tombstones: true },
    font: { env: { rel_path: "str", bytes_sha: "sha", created_at: "ts", deleted_at: "ts?" }, content: { family: "str", file_name: "str" }, tombstones: true },
    settings: { env: {}, content: { values: "strmap" }, tombstones: false },
    device: { env: { platform: "str", app_version: "str", first_seen_at: "ts", last_seen_at: "ts", deleted_at: "ts?" }, content: { name: "str" }, tombstones: true },
  };
  const LANE_ORDER = ["folder", "notebook", "note", "card", "grade_event", "media", "occlusion", "dictionary", "font", "settings", "device"];

  // `BackupContents.settingsKeys`: the only keys the settings lane carries.
  const SETTINGS_KEYS = ["ai_enabled", "ai_provider", "animations", "app_icon_badge", "appearance", "auto_capitalise",
    "cloze_hide_others", "correct_typing", "face_text_size", "font_family", "from_your_notes", "fsrs_fit", "fsrs_weights", "haptics",
    "heading_styles", "hide_math_source", "leech_auto_suspend", "leech_threshold", "line_spacing",
    "new_per_day", "openrouter_model", "outline_pane", "outside_surfaces", "page_layout", "quiz_length",
    "reading_font", "reminder_card", "reminder_enabled", "reminder_hour", "reminder_minute", "reschedule_on_change",
    "retention_pct", "review_cap",
    "spell_language", "spellcheck", "spread_reviews", "theme", "word_count_readout", "word_count_stat"];

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  let shareToken = null;
  let rows = null;            // "lane|id" -> { lane, id, kind, updated_at, env, content, dirty, base_seq }
  let cursor = 0;
  let epoch = null;
  const issued = new Set();   // op ids this page sent: their echoes are not applied again
  const rejected = new Map(); // key -> the stamp that was rejected, so it is not re-sent unchanged
  const lastContent = new Map(); // key -> the content a row carried before a tombstone reached it
  let version = 0;
  const listeners = new Set();
  let notifyQueued = false;

  const status = {
    phase: "idle",           // idle | syncing | offline | error
    lastSync: null,          // ms of the last complete round trip
    message: null,           // one sentence when something is wrong
    clockSkewMs: 0,
    writable: true,          // false when the clock check fails
    server: null,            // the hello answer's build facts
    live: false,             // the WebSocket is open and past hello
    revoked: false,          // Recall removed this browser from the library
    restored: false,         // the rows came from this browser's own copy
  };

  const key = (lane, id) => lane + "|" + id;

  // ------------------------------------------------------------ the copy

  const touched = new Set();
  const removedKeys = new Set();
  let persistTimer = null;
  let replaceAll = false;

  function mark(k) { touched.add(k); removedKeys.delete(k); libDirty.add(k); schedulePersist(); }
  function unmark(k) { touched.delete(k); removedKeys.add(k); libDirty.add(k); schedulePersist(); }
  function markAll() { replaceAll = true; schedulePersist(); }

  function schedulePersist() {
    if (fixtureMode || isShared()) return;
    if (persistTimer) return;
    persistTimer = setTimeout(persist, 60);
  }

  function metaNow() {
    return { cursor, epoch, device: deviceId(), library: localStorage.getItem(LIBRARY_KEY) || "",
             lastSync: status.lastSync || 0 };
  }

  async function persist() {
    persistTimer = null;
    // A fixture or a share never touches this browser's copy of the real
    // library (review 2026-09-26, web-7).
    if (!rows || !token() || fixtureMode || isShared()) return;
    const put = [];
    let gone = [];
    try {
      if (replaceAll) {
        replaceAll = false;
        touched.clear();
        removedKeys.clear();
        await Local.replaceRows(rows, metaNow());
        return;
      }
      for (const k of touched) { const r = rows.get(k); if (r) put.push([k, r]); }
      gone = [...removedKeys];
      touched.clear();
      removedKeys.clear();
      await Local.save(put, gone, metaNow());
    } catch (error) {
      // What did not reach the copy is still unwritten, so the next persist
      // retries it and closing the tab still warns (review 2026-09-26, web-14).
      for (const [k] of put) if (!removedKeys.has(k)) touched.add(k);
      for (const k of gone) if (!touched.has(k)) removedKeys.add(k);
      console.warn("local copy", error);
    }
  }

  // The rows this browser kept, when they are this device's and this
  // library's. Nothing is restored across a re-pairing to another library.
  async function restore() {
    const got = await Local.load();
    if (!got || !got.rows.size) return false;
    const m = got.meta || {};
    // A browser paired before the library id was kept holds "" on both sides.
    if (m.device !== deviceId() || (m.library || "") !== (localStorage.getItem(LIBRARY_KEY) || "")) return false;
    rows = got.rows;
    libFull = true;
    cursor = Number(m.cursor) || 0;
    epoch = m.epoch || null;
    status.lastSync = m.lastSync || null;
    status.restored = true;
    pendingUploads.clear();
    for (const [sha, mime] of Array.isArray(m.uploads) ? m.uploads : []) pendingUploads.set(sha, mime);
    keptVersions = (await Local.versions()).filter(v => !v.resolved_at);
    changed();
    return true;
  }

  function authError(message) {
    const error = new Error(message);
    error.authFailed = true;
    return error;
  }

  function token() { return localStorage.getItem(TOKEN_KEY); }
  function isSignedIn() { return !!token(); }
  function isShared() { return !!shareToken; }
  function label() { return localStorage.getItem(LABEL_KEY) || "Web browser"; }

  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !UUID_RE.test(id)) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  // Signing out forgets the credential AND this browser's copy of the
  // library: a browser is often a shared machine. Unsent edits go with it,
  // which is why the page asks first when there are any.
  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LIBRARY_KEY);
    rows = null;
    libFull = true;
    cursor = 0;
    epoch = null;
    issued.clear();
    keptVersions = [];
    pendingUploads.clear();
    stopPolling();
    closeSocket();
    Local.wipe();
    changed();
  }

  // A credential the backend no longer knows (not a revocation): the token
  // goes, and THIS BROWSER'S COPY STAYS, unsent edits included, so pairing
  // again with the same library sends them (review 2026-09-26, web-9). Only
  // Sign Out, which asks first, and a revocation erase the copy.
  function forgetCredential() {
    localStorage.removeItem(TOKEN_KEY);
    rows = null;
    libFull = true;
    cursor = 0;
    epoch = null;
    issued.clear();
    keptVersions = [];
    pendingUploads.clear();
    stopPolling();
    closeSocket();
    changed();
  }

  // Recall's device list removed this browser (Remove on the Mac or the
  // phone): the backend refuses every door with `revoked`, the socket says
  // `bye`. The credential and the copy go, and the pairing screen says why.
  function revokedHere() {
    if (status.revoked) return;
    signOut();
    status.revoked = true;
    status.message = "This browser was removed from the library in Recall. Pair it again to use it.";
    notify(true);
  }

  // ------------------------------------------------------------- listeners

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // A listener hears `{ rows: true }` when a row changed (the pages redraw)
  // and `{ rows: false }` when only the sync status did (the status line
  // redraws, and a field being typed in keeps its focus).
  let rowsChangedSinceNotify = false;
  function notify(rowsChanged) {
    if (rowsChanged) { version++; rowsChangedSinceNotify = true; }
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      const detail = { rows: rowsChangedSinceNotify };
      rowsChangedSinceNotify = false;
      for (const fn of listeners) {
        try { fn(detail); } catch (error) { console.error(error); }
      }
    });
  }

  function changed() { notify(true); }

  function setPhase(phase, message) {
    status.phase = phase;
    status.message = message || null;
    notify(false);
  }

  // ------------------------------------------------------------------ HTTP

  async function call(method, path, body, { auth = true, raw = false } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      const t = token();
      if (!t) throw authError("This browser is not paired.");
      headers.Authorization = `Bearer ${t}`;
    }
    let res;
    try {
      res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
    } catch (_) {
      const error = new Error("The backend is unreachable. Check the connection and try again.");
      error.offline = true;
      throw error;
    }
    if (raw && res.ok) return res;
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
    if (!res.ok) {
      const message = data.message || `The backend answered ${res.status}.`;
      if (res.status === 401 && auth && data.error === "revoked") { revokedHere(); throw authError(status.message); }
      if (res.status === 401 && auth) throw authError(message);
      const error = new Error(message);
      error.status = res.status;
      error.code = data.error;
      throw error;
    }
    return data;
  }

  // The page refuses to run against a backend outside its protocol range,
  // and says which side is older (plan 11.2, item 6).
  async function checkVersion() {
    const v = await call("GET", "/v1/version", undefined, { auth: false });
    if (PROTOCOL < v.pv_min) throw new Error("This page is older than its backend. Reload to get the new page.");
    if (PROTOCOL > v.pv_max) throw new Error("This backend is older than this page. Update the backend.");
    return v;
  }

  async function pair(code, name) {
    const digits = String(code || "").replace(/\s+/g, "");
    if (!/^\d{8}$/.test(digits)) throw new Error("A pairing code is eight digits.");
    const labelText = (name || "").trim() || "Web browser";
    const out = await call("POST", "/v1/pair/claim",
      { code: digits, device_id: deviceId(), label: labelText, platform: "web" }, { auth: false });
    const previous = localStorage.getItem(LIBRARY_KEY);
    if (previous && previous !== out.library_id) await Local.wipe();
    localStorage.setItem(TOKEN_KEY, out.token);
    localStorage.setItem(LABEL_KEY, labelText);
    localStorage.setItem(LIBRARY_KEY, out.library_id);
    status.revoked = false;
    status.message = null;
    rows = null;
    libFull = true;
    return out;
  }

  // ------------------------------------------------------------ the rows

  function flat(row) {
    return { id: row.id, updated_at: row.updated_at, ...row.env, ...row.content,
             deleted_at: row.env.deleted_at === undefined ? null : row.env.deleted_at };
  }

  function fromWire(w) {
    return { lane: w.lane, id: w.id, kind: w.kind, updated_at: w.updated_at, env: w.env,
             content: w.content || {}, dirty: false, base_seq: w.seq || 0 };
  }

  // The client's applier (reference-client.ts `applyRemote`): the log's
  // order wins; a dirty local row newer than the remote one survives.
  //
  // A pulled revision a dirty row did not take is NOT seen: its `base_seq`
  // stays, so the push is adjudicated against that revision instead of
  // replacing it as its successor (Recall landmine 250). A resync keeps a
  // version of what it overwrites exactly as a pull does (review 2026-09-26,
  // web-6).
  function applyRemote(target, op) {
    const k = key(op.lane, op.id);
    const local = target.get(k);
    if (target === rows) mark(k);
    if (op.kind === "tombstone" && local && local.kind === "upsert" && local.content) {
      lastContent.set(k, { env: local.env, content: local.content });
    }
    if (!local) { target.set(k, fromWire(op)); return; }
    if (op.seq <= local.base_seq && !local.dirty) return;
    if (local.dirty && Wire.isNewer(local.updated_at, op.updated_at)) return;
    keepIfOverwriting(local, op);
    target.set(k, fromWire(op));
  }

  // ------------------------------------------------------- kept versions

  let keptVersions = [];

  // `KeptVersions.keepIfOverwriting`: a paragraph this browser changed and
  // had not sent, about to be replaced by different text from another
  // device, is kept (landmine 224). So is this browser's revision when the
  // server says an op REPLACED it (plan F-22), even though the row was clean.
  function keepIfOverwriting(local, op) {
    if (op.lane !== "note" || !local || local.kind !== "upsert" || local.env.deleted_at) return;
    const replaced = op.replaced && op.replaced.updated_at === local.updated_at;
    if (!local.dirty && !replaced) return;
    const incoming = op.content || {};
    const same = f => (local.content[f] || "") === (incoming[f] || "");
    if (same("front") && same("back") && same("cloze_text")) return;
    const open = keptVersions.some(v => v.note_id === local.id && !v.resolved_at
      && (v.front || "") === (local.content.front || "") && (v.back || "") === (local.content.back || "")
      && (v.cloze_text || "") === (local.content.cloze_text || ""));
    if (open) return;
    const v = { id: crypto.randomUUID(), note_id: local.id, notebook_id: local.env.notebook_id,
                front: local.content.front ?? null, back: local.content.back ?? null,
                cloze_text: local.content.cloze_text ?? null, spans: local.content.spans ?? null,
                local_updated_at: local.updated_at, remote_updated_at: op.updated_at,
                kept_at: Wire.wireTime(Date.now()), resolved_at: null };
    keptVersions.push(v);
    Local.putVersion(v);
  }

  function versions(notebookId) {
    return keptVersions.filter(v => !v.resolved_at && v.notebook_id === notebookId
      && rows && rows.get(key("note", v.note_id)) && !rows.get(key("note", v.note_id)).env.deleted_at)
      .sort((a, b) => (a.kept_at < b.kept_at ? 1 : -1));
  }

  function resolveVersion(id) {
    const v = keptVersions.find(x => x.id === id);
    if (!v) return;
    v.resolved_at = Wire.wireTime(Date.now());
    Local.putVersion(v);
    notify(true);
  }

  let libCache = null;
  let libVersion = -1;
  let libFull = true;             // the rows were replaced: rebuild from scratch
  const libDirty = new Set();     // keys written since the last build
  let libParts = null;            // the collections, patched in place
  const MAP_LANES = { folder: "folders", notebook: "docs", note: "notes", media: "media" };
  const LIST_LANES = { card: "cards", grade_event: "events", occlusion: "occlusion", font: "fonts",
                       settings: "settingsRows", device: "devices" };

  function rebuildParts() {
    const p = { folders: new Map(), docs: new Map(), notes: new Map(), media: new Map(),
                cards: [], events: [], occlusion: [], fonts: [], devices: [], settingsRows: [], index: {} };
    for (const lane of Object.keys(LIST_LANES)) p.index[lane] = new Map();
    if (rows) {
      for (const r of rows.values()) place(p, r);
    }
    return p;
  }

  function place(p, r) {
    if (r.lane === "grade_event" && dismissed().has(r.id)) return;
    const m = MAP_LANES[r.lane];
    if (m) { p[m].set(r.id, flat(r)); return; }
    const l = LIST_LANES[r.lane];
    if (!l) return;
    const at = p.index[r.lane].get(r.id);
    if (at === undefined) { p.index[r.lane].set(r.id, p[l].length); p[l].push(flat(r)); }
    else p[l][at] = flat(r);
  }

  function unplace(p, lane, id) {
    const m = MAP_LANES[lane];
    if (m) { p[m].delete(id); return; }
    const l = LIST_LANES[lane];
    const at = l ? p.index[lane].get(id) : undefined;
    if (at === undefined) return;
    p[l].splice(at, 1);
    p.index[lane] = new Map(p[l].map((f, i) => [f.id, i]));
  }

  // One snapshot of the library. A write patches only the rows it touched,
  // so an import or a paste no longer re-flattens every row, grade events
  // included, once a line (review 2026-09-26, web-12); replacing the rows
  // (a bootstrap, a restore, a sign out) rebuilds.
  function library() {
    if (libCache && libVersion === version) return libCache;
    if (libFull || !libParts || libDirty.size > 5000) {
      libParts = rebuildParts();
    } else {
      for (const k of libDirty) {
        const bar = k.indexOf("|");
        const lane = k.slice(0, bar), id = k.slice(bar + 1);
        const r = rows && rows.get(k);
        if (r) place(libParts, r); else unplace(libParts, lane, id);
      }
    }
    libFull = false;
    libDirty.clear();
    const p = libParts;
    // Each device carries its own bag; a device applies every row newer than
    // its own, key by key (`SettingsLane.apply`), so the bag in force is the
    // rows applied oldest first.
    const settingsRows = p.settingsRows.slice()
      .sort((a, b) => Wire.wireMillis(a.updated_at) - Wire.wireMillis(b.updated_at));
    const values = {};
    for (const r of settingsRows) Object.assign(values, r.values || {});
    libCache = { folders: p.folders, docs: p.docs, notes: p.notes, media: p.media, cards: p.cards,
                 events: p.events, occlusion: p.occlusion, fonts: p.fonts, devices: p.devices,
                 settings: readSettings(values), settingsValues: values };
    libVersion = version;
    return libCache;
  }

  function readSettings(v) {
    const int = (k, d) => { const n = parseInt(v[k], 10); return Number.isFinite(n) ? n : d; };
    return {
      retention: Math.min(97, Math.max(70, int("retention_pct", 90))),
      newPerDay: Math.max(0, int("new_per_day", 10)),
      weights: FSRS.decodeWeights(v.fsrs_weights),
      spreadReviews: (v.spread_reviews || "1") === "1",
      reviewCap: Math.max(0, int("review_cap", 0)),
      theme: v.theme || "recall",
      appearance: int("appearance", 0),        // 0 system, 1 light, 2 dark
      leechThreshold: Math.max(1, int("leech_threshold", 6)),
      leechAutoSuspend: (v.leech_auto_suspend || "0") === "1",
      fromYourNotes: (v.from_your_notes || "1") === "1",
      fontFamily: v.font_family || null,
      lineSpacing: v.line_spacing ? Number(v.line_spacing) : null,
    };
  }

  function get(lane, id) {
    const r = rows && rows.get(key(lane, id));
    return r ? flat(r) : null;
  }

  function rawRow(lane, id) {
    return rows ? rows.get(key(lane, id)) || null : null;
  }

  function contentBefore(lane, id) {
    return lastContent.get(key(lane, id)) || null;
  }

  // ------------------------------------------------------------ the writes

  function typeOk(t, v) {
    const nullable = t.endsWith("?");
    if (v === null) return nullable;
    const base = nullable ? t.slice(0, -1) : t;
    switch (base) {
      case "uuid": return typeof v === "string" && UUID_RE.test(v);
      case "ts": return Wire.wireMillis(v) !== null;
      case "int": return typeof v === "number" && Number.isSafeInteger(v);
      case "num": return typeof v === "number" && Number.isFinite(v);
      case "bool": return typeof v === "boolean";
      case "str": return typeof v === "string";
      case "sha": return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
      case "strmap": return typeof v === "object" && v !== null && !Array.isArray(v)
        && Object.values(v).every(x => typeof x === "string");
      default: return false;
    }
  }

  function checkColumns(spec, got, part, lane) {
    for (const k of Object.keys(got)) {
      if (!(k in spec)) throw new Error(`${lane}.${part}.${k} is not a column of this lane`);
    }
    for (const [k, t] of Object.entries(spec)) {
      if (!(k in got)) throw new Error(`${lane}.${part}.${k} is missing`);
      if (!typeOk(t, got[k])) throw new Error(`${lane}.${part}.${k} has the wrong type`);
    }
  }

  // Writes one WHOLE row: the patch over what the row already holds. A
  // tombstone keeps env complete with `deleted_at` set and carries no
  // content; an upsert on a tombstoned row is an undelete.
  //
  // `base` is the seq of the revision the writer SHOWED (the editor's line):
  // when a newer revision landed unseen, the write goes out on the older
  // base and the backend records the conflict, so the other device keeps a
  // version (Recall landmine 249; review 2026-09-26, web-3).
  // The editor's undo (D-190) watches the writes one edit makes: each
  // observer hears a row's state BEFORE the write (null for a new row).
  const writeObservers = new Set();
  function observeWrites(fn) { writeObservers.add(fn); return () => writeObservers.delete(fn); }

  function write(lane, id, patch = {}, { tombstone = false, now = Date.now(), base = null } = {}) {
    if (!rows) throw new Error("The library is not loaded.");
    if (!status.writable) throw new Error(status.message || "Writing is paused.");
    const spec = LANES[lane];
    if (!spec) throw new Error("unknown lane " + lane);
    const k = key(lane, id);
    const existing = rows.get(k);
    if (writeObservers.size) {
      const prior = existing ? { kind: existing.kind, env: { ...existing.env }, content: { ...(existing.kind === "upsert" ? existing.content : (lastContent.get(k) || {}).content || {}) } } : null;
      for (const fn of writeObservers) fn(lane, id, prior);
    }
    const env = { ...(existing ? existing.env : {}), ...(patch.env || {}) };
    let content = { ...(existing && existing.kind === "upsert" ? existing.content : {}), ...(patch.content || {}) };
    let updatedAt;
    if (spec.stampColumn) {
      updatedAt = env[spec.stampColumn];
    } else {
      updatedAt = Wire.stampAfter(existing ? existing.updated_at : null, now);
    }
    let kind = "upsert";
    if (tombstone) {
      if (!spec.tombstones) throw new Error(lane + " refuses tombstones");
      if (existing && existing.kind === "upsert") lastContent.set(k, { env: existing.env, content: existing.content });
      env.deleted_at = updatedAt;
      kind = "tombstone";
      content = {};
    } else if ("deleted_at" in spec.env) {
      env.deleted_at = null;
    }
    checkColumns(spec.env, env, "env", lane);
    if (kind === "upsert") checkColumns(spec.content, content, "content", lane);
    const seen = existing ? existing.base_seq : 0;
    rows.set(k, { lane, id, kind, updated_at: updatedAt, env, content, dirty: true,
                  base_seq: base == null ? seen : Math.min(seen, base) });
    rejected.delete(k);
    mark(k);
    changed();
    schedulePush();
    return flat(rows.get(k));
  }

  // Drops a row this page wrote and never sent (an undone grade whose event
  // had not left yet). A row the server already holds stays: grade events
  // are append-only, and an undone grade is not retracted remotely, as in
  // the app.
  //
  // A grade event that already left stays in the log but leaves THIS
  // browser's stats, as `cf_dismissed_events` does in the app (review
  // 2026-09-26, web-17).
  function discard(lane, id) {
    const k = key(lane, id);
    const r = rows && rows.get(k);
    if (!r) return false;
    if (!r.dirty || r.base_seq > 0 || pushing) {
      if (lane === "grade_event") { dismissEvent(id); changed(); }
      return false;
    }
    rows.delete(k);
    unmark(k);
    changed();
    return true;
  }

  const DISMISSED_KEY = "recall.viewer.dismissed-events";
  let dismissedEvents = null;
  function dismissed() {
    if (!dismissedEvents) {
      try { dismissedEvents = new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]")); }
      catch (_) { dismissedEvents = new Set(); }
    }
    return dismissedEvents;
  }
  function dismissEvent(id) {
    const set = dismissed();
    set.add(id);
    // The newest thousand: a dismissal only matters to recent stats.
    const list = [...set].slice(-1000);
    dismissedEvents = new Set(list);
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(list)); } catch (_) { /* stats only */ }
    libFull = true;
  }

  function pendingCount() {
    if (!rows) return 0;
    let n = 0;
    for (const [k, r] of rows) if (r.dirty && rejected.get(k) !== r.updated_at) n++;
    return n;
  }

  // ------------------------------------------------------------ the push

  let pushTimer = null;
  let pushFirstAt = 0;
  let pushing = null;
  let pushAgain = false;
  let retryDelay = 0;

  // `PushPacer`: 400 ms after the last write, never more than 1.2 s after
  // the first one in a run.
  function schedulePush() {
    const now = Date.now();
    if (!pushTimer) pushFirstAt = now;
    clearTimeout(pushTimer);
    const wait = Math.max(0, Math.min(400, 1200 - (now - pushFirstAt)));
    pushTimer = setTimeout(() => { pushTimer = null; push().catch(() => {}); }, wait);
  }

  // A batch is at most 500 ops AND fits the backend's 1 MiB body, or a 413
  // refuses it whole and the same batch is rebuilt for ever (review
  // 2026-09-26, web-4). One row too large to send on its own is set aside
  // as rejected, so the rest still leave.
  const BATCH_BYTES = 1_048_576 - 4096;
  const encoder = new TextEncoder();

  async function buildBatch() {
    const order = lane => LANE_ORDER.indexOf(lane);
    const dirty = [...rows.entries()]
      .filter(([k, r]) => r.dirty && rejected.get(k) !== r.updated_at)
      .map(([, r]) => r)
      .sort((a, b) => order(a.lane) - order(b.lane));
    const ops = [];
    const capture = new Map();
    let bytes = 64;
    for (const r of dirty) {
      if (ops.length >= 500) break;
      const op = { lane: r.lane, id: r.id, kind: r.kind, updated_at: r.updated_at, base_seq: r.base_seq, env: r.env };
      if (r.kind === "upsert") op.content = r.content;
      const size = encoder.encode(JSON.stringify(op)).length + 64;
      if (size > BATCH_BYTES) {
        rejected.set(key(r.lane, r.id), r.updated_at);
        console.warn("rejected", r.lane, "too_large");
        continue;
      }
      if (bytes + size > BATCH_BYTES) break;
      bytes += size;
      const digest = await Wire.payloadDigest(op);
      const id = await Wire.opId({ device: deviceId(), ...op });
      op.op_id = id;
      ops.push(op);
      capture.set(id, { key: key(r.lane, r.id), updated_at: r.updated_at, digest });
    }
    return { batch: crypto.randomUUID(), ops, capture };
  }

  async function handleAck(results, capture) {
    let adopted = false;
    for (const r of results || []) {
      const cap = capture.get(r.op_id);
      if (!cap) continue;
      const row = rows.get(cap.key);
      if (!row) continue;
      const op = { env: row.env };
      if (row.kind === "upsert") op.content = row.content;
      const unchanged = row.updated_at === cap.updated_at && (await Wire.payloadDigest(op)) === cap.digest;
      if (r.outcome === "rejected") {
        if (unchanged) rejected.set(cap.key, row.updated_at);
        console.warn("rejected", row.lane, r.reason);
        continue;
      }
      if (r.outcome === "applied" || r.outcome === "duplicate") {
        if (unchanged) { row.dirty = false; row.base_seq = Math.max(row.base_seq, r.seq); mark(cap.key); }
        continue;
      }
      // stale or conflict: the server's row wins unless this row moved on,
      // and on a conflict this browser's text is kept (PROTOCOL.md 6.2).
      if (!unchanged) { row.base_seq = Math.max(row.base_seq, r.winner.seq); mark(cap.key); continue; }
      if (r.outcome === "conflict") keepIfOverwriting(row, r.winner);
      rows.set(cap.key, fromWire(r.winner));
      mark(cap.key);
      adopted = true;
    }
    if (adopted) changed();
  }

  // Offline fixtures only (js/fixture.js): rows adopted as if a snapshot had
  // arrived, and every write acknowledged locally with nothing sent.
  let fixtureMode = false;
  function adoptFixture(list) {
    fixtureMode = true;
    rows = new Map();
    libFull = true;
    for (const w of list) rows.set(key(w.lane, w.id), fromWire({ seq: 0, ...w }));
    status.lastSync = Date.now();
    changed();
  }

  // One push, one in flight (race X1); a write during it pushes again after.
  async function push() {
    if (fixtureMode && rows) {
      for (const r of rows.values()) r.dirty = false;
      status.lastSync = Date.now();
      notify(false);
      return;
    }
    if (!rows || isShared() || !token()) return;
    if (pushing) { pushAgain = true; return pushing; }
    pushing = (async () => {
      try {
        for (let round = 0; round < 20; round++) {
          const b = await buildBatch();
          if (!b.ops.length) break;
          for (const id of b.capture.keys()) issued.add(id);
          setPhase("syncing");
          const ack = await call("POST", "/v1/push", { t: "push", batch: b.batch, ops: b.ops });
          await handleAck(ack.results, b.capture);
        }
        retryDelay = 0;
        status.lastSync = Date.now();
        setPhase("idle");
      } catch (error) {
        if (error.authFailed) { setPhase("error", error.message); throw error; }
        setPhase(error.offline ? "offline" : "error", error.offline ? OFFLINE_SENTENCE : error.message);
        retryDelay = Math.min(60000, retryDelay ? retryDelay * 2 : 4000);
        setTimeout(() => push().catch(() => {}), retryDelay);
      } finally {
        pushing = null;
        if (pushAgain) { pushAgain = false; schedulePush(); }
      }
    })();
    return pushing;
  }

  // ------------------------------------------------------------ the pull

  async function hello() {
    const sent = Date.now();
    const ok = await call("POST", "/v1/hello", { t: "hello", pv: PROTOCOL, device: deviceId(), since: cursor,
                                                  schema: SCHEMA, app: APP, ...(epoch ? { epoch } : {}) });
    const back = Date.now();
    const server = Wire.wireMillis(ok.server_time);
    if (server !== null) {
      // The server stamped its answer somewhere inside the round trip.
      const mid = (sent + back) / 2;
      status.clockSkewMs = server - mid;
      if (Math.abs(status.clockSkewMs) > CLOCK_LIMIT_MS + (back - sent) / 2) {
        status.writable = false;
        const s = Math.round(Math.abs(status.clockSkewMs) / 1000);
        status.message = `This computer's clock is ${s} s off the backend's. Grades and edits are paused until it is set right.`;
      } else {
        status.writable = true;
      }
    }
    status.server = { seq: ok.seq, epoch: ok.epoch };
    if (ok.resync === true || !rows) await bootstrap();
    else if (epoch === null) epoch = String(ok.epoch);
    return ok;
  }

  // Pages the row table by (lane, id), then catches up from the pinned seq.
  // Dirty local rows survive.
  async function bootstrap() {
    const next = new Map();
    if (rows) for (const [k, r] of rows) if (r.dirty) next.set(k, { ...r, base_seq: 0 });
    let after = { after_lane: "", after_id: "" };
    let pinned = null;
    for (;;) {
      const q = new URLSearchParams({ ...after, limit: "1000" });
      const page = await call("GET", `/v1/snapshot?${q}`);
      if (pinned === null) { pinned = page.pinned_seq; epoch = String(page.epoch || ""); }
      for (const row of page.rows) applyRemote(next, row);
      if (!page.more) break;
      after = page.next;
    }
    rows = next;
    libFull = true;
    cursor = pinned || 0;
    issued.clear();
    markAll();
    changed();
  }

  let lastAck = 0;

  async function pull() {
    if (!rows) { await bootstrap(); }
    let applied = 0;
    for (let guard = 0; guard < 200; guard++) {
      let frame;
      try {
        frame = await call("GET", `/v1/pull?since=${cursor}&limit=1000`);
      } catch (error) {
        if (error.code === "resync_required") { await bootstrap(); continue; }
        throw error;
      }
      if (frame.from > cursor + 1) { await bootstrap(); continue; }
      applied += applyFrame(frame);
      if (!frame.more) break;
    }
    if (applied) changed();
    if (Date.now() - lastAck > 10000) {
      lastAck = Date.now();
      call("POST", "/v1/ack", { seq: cursor }).catch(() => {});
    }
    return applied;
  }

  // One CONTINUOUS frame (the caller has checked `from <= cursor + 1`): own
  // ops only move `base_seq`, the rest go through the applier, and the
  // cursor is written with the rows it covers.
  function applyFrame(frame) {
    let applied = 0;
    for (const op of frame.ops.slice().sort((a, b) => a.seq - b.seq)) {
      if (op.seq <= cursor) continue;
      if (op.op_id && issued.has(op.op_id)) {
        const mine = rows.get(key(op.lane, op.id));
        if (mine) { mine.base_seq = Math.max(mine.base_seq, op.seq); mark(key(op.lane, op.id)); }
        continue;
      }
      applyRemote(rows, op);
      applied++;
    }
    cursor = Math.max(cursor, frame.to);
    schedulePersist();
    return applied;
  }

  // ------------------------------------------------------------- the socket

  let socket = null;
  let socketRetry = 0;
  let socketTimer = null;
  let pingTimer = null;
  let frameChain = Promise.resolve();
  let socketAck = 0;

  function socketUrl() {
    return location.origin.replace(/^http/, "ws") + "/v1/sync";
  }

  function connectSocket() {
    if (fixtureMode || isShared() || !token() || socket || status.revoked) return;
    if (typeof WebSocket === "undefined") { startPolling(); return; }
    clearTimeout(socketTimer);
    let ws;
    try {
      ws = new WebSocket(socketUrl(), ["recall.v1", "recall.bearer." + token()]);
    } catch (_) {
      startPolling();
      reconnectLater();
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ t: "hello", pv: PROTOCOL, device: deviceId(), since: cursor, schema: SCHEMA, app: APP }));
    });
    ws.addEventListener("message", event => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch (_) { return; }
      frameChain = frameChain.then(() => onFrame(ws, frame)).catch(error => console.warn("frame", error));
    });
    ws.addEventListener("close", event => {
      if (socket === ws) socket = null;
      clearInterval(pingTimer);
      const wasLive = status.live;
      status.live = false;
      if (event.code === 4001) { revokedHere(); return; }
      if (!token()) return;
      startPolling();
      reconnectLater();
      if (wasLive) notify(false);
      // One HTTP round trip now: it catches up if only the socket failed,
      // and says "Offline" at once if the backend is gone.
      if (wasLive) sync().catch(() => {});
    });
  }

  function reconnectLater() {
    clearTimeout(socketTimer);
    socketRetry = Math.min(30000, socketRetry ? socketRetry * 2 : 1000);
    socketTimer = setTimeout(() => {
      if (document.visibilityState === "visible" || !socket) connectSocket();
    }, socketRetry);
  }

  function closeSocket() {
    clearTimeout(socketTimer);
    clearInterval(pingTimer);
    status.live = false;
    if (socket) { const ws = socket; socket = null; try { ws.close(1000, "done"); } catch (_) { /* closed */ } }
  }

  function sendPull(ws) {
    try { ws.send(JSON.stringify({ t: "pull", since: cursor, limit: 1000 })); } catch (_) { /* closing */ }
  }

  async function onFrame(ws, frame) {
    switch (frame.t) {
      case "hello_ok": {
        socketRetry = 0;
        status.live = true;
        stopPolling();
        clearInterval(pingTimer);
        // A ping the runtime answers itself keeps the connection warm and
        // never wakes the library object.
        pingTimer = setInterval(() => { try { ws.send('{"t":"ping"}'); } catch (_) { /* closing */ } }, 30000);
        if (frame.resync === true) await bootstrap();
        sendPull(ws);
        if (status.phase === "offline") setPhase("idle");
        notify(false);
        if (pendingCount() > 0) schedulePush();
        if (pendingUploads.size) drainUploads().catch(() => {});
        break;
      }
      case "ops": {
        if (!rows) return;
        if (frame.from > cursor + 1) { sendPull(ws); return; }
        const applied = applyFrame(frame);
        if (frame.more) sendPull(ws);
        status.lastSync = Date.now();
        if (applied) changed(); else notify(false);
        if (Date.now() - socketAck > 10000) {
          socketAck = Date.now();
          try { ws.send(JSON.stringify({ t: "ack", seq: cursor })); } catch (_) { /* closing */ }
        }
        break;
      }
      case "bye":
        if (frame.reason === "revoked") revokedHere();
        break;
      case "limit":
        setPhase("error", frame.message || "The backend's daily allowance is used up.");
        break;
      default:
        break;
    }
  }

  // Push what is dirty, then pull what changed.
  async function sync() {
    if (isShared() || !token()) return;
    setPhase("syncing");
    try {
      await push();
      await pull();
      if (pendingUploads.size) await drainUploads();
      status.lastSync = Date.now();
      setPhase("idle");
    } catch (error) {
      if (error.authFailed) throw error;
      setPhase(error.offline ? "offline" : "error", error.offline ? OFFLINE_SENTENCE : error.message);
    }
  }

  let pollTimer = null;
  function startPolling() {
    if (fixtureMode) return;
    stopPolling();
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") sync().catch(() => {});
    }, POLL_MS);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  // Paired start: this browser's own copy first (so a doc opens at once and
  // offline), then the version, the clock, a catch-up pull, the socket.
  async function start() {
    const restored = rows ? true : await restore();
    try {
      await checkVersion();
      setPhase("syncing");
      await hello();
      await pull();
    } catch (error) {
      if (error.authFailed || !restored || !error.offline) throw error;
      setPhase("offline", OFFLINE_SENTENCE);
      startPolling();
      reconnectLater();
      return;
    }
    status.lastSync = Date.now();
    schedulePersist();
    setPhase(status.writable ? "idle" : "error", status.writable ? null : status.message);
    announceDevice();
    if (pendingCount() > 0) schedulePush();
    connectSocket();
    if (!status.live) startPolling();
  }

  window.addEventListener("online", () => {
    if (!rows || isShared() || !token()) return;
    sync().catch(() => {});
    connectSocket();
  });
  window.addEventListener("offline", () => {
    if (!rows || isShared() || !token()) return;
    setPhase("offline", OFFLINE_SENTENCE);
  });

  // This browser's row in the device lane, so the app's device list names it.
  function announceDevice() {
    if (!status.writable) return;
    const mine = get("device", deviceId());
    const now = Date.now();
    if (mine && mine.name === label() && mine.last_seen_at
        && now - Date.parse(mine.last_seen_at) < 12 * 3600000) return;
    try {
      write("device", deviceId(), {
        env: { platform: "web", app_version: APP, first_seen_at: mine ? mine.first_seen_at : Wire.wireTime(now),
               last_seen_at: Wire.wireTime(now) },
        content: { name: label() },
      });
    } catch (error) { console.warn(error); }
  }

  // Settings travel as one bag per device (`SettingsLane`): this browser's
  // row is the bag in force with the change applied, allowlisted keys only.
  function setSetting(changes) {
    const values = { ...library().settingsValues };
    for (const [k, v] of Object.entries(changes)) {
      if (!SETTINGS_KEYS.includes(k)) continue;
      if (v === null || v === undefined) delete values[k]; else values[k] = String(v);
    }
    for (const k of Object.keys(values)) if (!SETTINGS_KEYS.includes(k)) delete values[k];
    return write("settings", deviceId(), { env: {}, content: { values } });
  }

  // ---------------------------------------------------------------- shares

  async function shares(notebookId) {
    const out = await call("GET", "/v1/shares");
    return out.shares.filter(s => s.notebook_id === notebookId && !s.revoked_at
      && (!s.expires_at || Date.parse(s.expires_at) > Date.now()));
  }

  async function createShare(notebookId) {
    return call("POST", "/v1/shares", { notebook_id: notebookId });
  }

  async function revokeShare(id) {
    await call("DELETE", `/v1/shares/${encodeURIComponent(id)}`);
  }

  async function devices() {
    const out = await call("GET", "/v1/devices");
    return out.devices || [];
  }

  // A visitor's document. A stopped or expired link answers its own sentence.
  async function sharedDoc(tokenValue) {
    shareToken = tokenValue;
    try {
      return await call("POST", "/v1/share/resolve", { token: tokenValue }, { auth: false });
    } catch (error) {
      if (error.status === 410 || error.status === 404) return { stopped: error.message };
      throw error;
    }
  }

  // ----------------------------------------------------------------- media

  // Bytes by sha: this browser's copy first, then the backend (a visitor's
  // through the share route). A paired browser keeps what it fetched.
  async function media(row) {
    const sha = row && row.bytes_sha;
    if (!/^[0-9a-f]{64}$/.test(String(sha))) throw new Error("Image not available");
    if (!shareToken) {
      const kept = await Local.blob(sha);
      if (kept) return kept;
    }
    const res = shareToken
      ? await call("POST", "/v1/share/blob", { token: shareToken, sha }, { auth: false, raw: true })
      : await call("GET", `/v1/blob/${sha}`, undefined, { raw: true });
    const blob = await res.blob();
    if (!shareToken && !fixtureMode) Local.putBlob(sha, blob);
    return blob;
  }

  // Uploads bytes by their sha256 (PROTOCOL.md 7: begin, put, done). Returns
  // the sha. A picture the backend already holds is not sent again; bytes
  // are kept here first, so a picture added offline draws at once and is
  // sent when the outbox is.
  let lastUploadNote = null;

  async function uploadBlob(blob, mime) {
    lastUploadNote = null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("That picture is larger than 5 MB after resizing.");
    await Local.putBlob(sha, new Blob([bytes], { type: mime }));
    if (fixtureMode) return sha;
    try {
      await sendBlob(sha, bytes, mime);
    } catch (error) {
      if (!error.offline) throw error;
      // OFFLINE: the bytes are in this browser's copy and the sha is queued,
      // so the picture's rows can be written now and the bytes follow them
      // when the backend answers again.
      pendingUploads.set(sha, mime);
      await Local.save([], [], { uploads: [...pendingUploads] });
    }
    return sha;
  }

  const pendingUploads = new Map();   // sha -> mime, bytes waiting in Local

  async function drainUploads() {
    for (const [sha, mime] of [...pendingUploads]) {
      const blob = await Local.blob(sha);
      if (!blob) { pendingUploads.delete(sha); continue; }
      try {
        await sendBlob(sha, new Uint8Array(await blob.arrayBuffer()), mime);
        pendingUploads.delete(sha);
      } catch (error) {
        // Only a refusal that will never change drops the bytes; a busy or
        // failing backend is asked again at the next drain (review
        // 2026-09-26, web-11).
        console.warn("upload", error.message);
        const refused = error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
        if (error.permanent || refused) { pendingUploads.delete(sha); continue; }
        break;
      }
    }
    await Local.save([], [], { uploads: [...pendingUploads] }).catch(() => {});
  }

  function pendingUploadCount() { return pendingUploads.size; }

  async function sendBlob(sha, bytes, mime) {
    const begun = await call("POST", "/v1/blob/begin", { sha, bytes: bytes.byteLength, mime });
    if (begun.status === "have") return sha;
    if (begun.status === "absent" || begun.status === "disabled") {
      // Notes-only, or storage switched off: the picture is written and
      // draws here, and the other devices show "Image not available".
      lastUploadNote = begun.message || "This backend has no attachment storage, so this picture stays on this browser only.";
      return sha;
    }
    if (begun.status !== "put") {
      const error = new Error(begun.message || "The backend refused the picture.");
      error.permanent = begun.status === "refused" || begun.status === "multipart";
      throw error;
    }
    const t = token();
    let res;
    try {
      res = await fetch(`/v1/blob/put/${sha}`, { method: "PUT", headers: { Authorization: `Bearer ${t}`, "Content-Type": mime }, body: bytes });
    } catch (_) {
      const error = new Error(OFFLINE_SENTENCE);
      error.offline = true;
      throw error;
    }
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch (_) { data = {}; }
      const error = new Error(data.message || `The backend answered ${res.status}.`);
      error.permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 && res.status !== 401;
      throw error;
    }
    return sha;
  }

  // Make Cards and the quiz: the prompt goes to the Worker, which holds the
  // OpenRouter key (never this page).
  async function ai(body) {
    return call("POST", "/v1/ai", body);
  }

  // The library's text defaults a doc without its own style follows.
  function styleDefaults() {
    const v = library().settingsValues || {};
    return { headingStyles: v.heading_styles || null, lineSpacing: v.line_spacing || null, fontFamily: v.font_family || null };
  }

  // Every row of one lane, flat, tombstones included (the snapshot
  // download keeps only the live ones).
  function rowsOf(lane) {
    if (!rows) return [];
    const out = [];
    for (const r of rows.values()) if (r.lane === lane) out.push(flat(r));
    return out;
  }

  function fontRows(family) {
    return library().fonts.filter(f => f.deleted_at == null && f.family === family);
  }

  // The rows of one doc, the same lists a share link is answered with.
  function doc(notebookId) {
    const lib = library();
    const notes = [...lib.notes.values()].filter(n => n.deleted_at == null && n.notebook_id === notebookId);
    const ids = new Set(notes.map(n => n.id));
    return {
      notes,
      cards: lib.cards.filter(c => c.deleted_at == null && ids.has(c.note_id)),
      media: [...lib.media.values()].filter(m => m.deleted_at == null && ids.has(m.note_id)),
      occlusion: lib.occlusion.filter(o => o.deleted_at == null && ids.has(o.note_id)),
    };
  }

  // Unsent edits are safe in this browser's copy once written there (60 ms
  // after the edit); the page asks before closing only while one is not.
  // Hooks that put what is only on screen into the rows first: the editor's
  // line typed less than 700 ms ago (review 2026-09-26, web-8).
  const flushHooks = new Set();
  function onFlush(fn) { flushHooks.add(fn); return () => flushHooks.delete(fn); }
  function runFlushHooks() {
    for (const fn of flushHooks) { try { fn(); } catch (error) { console.warn(error); } }
  }

  function beforeUnload(event) {
    runFlushHooks();
    if (!rows || isShared() || fixtureMode) return;
    const unwritten = touched.size > 0 || removedKeys.size > 0 || replaceAll;
    if (unwritten) persist();
    if (pendingCount() > 0) push().catch(() => {});
    if (unwritten && pendingCount() > 0) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("pagehide", () => {
    runFlushHooks();
    if (rows && !isShared() && !fixtureMode && (touched.size || removedKeys.size || replaceAll)) persist();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") runFlushHooks();
    if (!rows || isShared() || !token()) return;
    if (document.visibilityState === "hidden") push().catch(() => {});
    // Coming back pulls, at most once in ten seconds: a window flicked
    // between tabs is not a reason to ask the server again.
    else if (Date.now() - (status.lastSync || 0) > 10000) sync().catch(() => {});
  });

  return {
    LANES, SETTINGS_KEYS, status, checkVersion, pair, signOut, isSignedIn, isShared, deviceId, label,
    subscribe, library, get, rawRow, contentBefore, write, observeWrites, discard, pendingCount, push, pull, sync, start,
    forgetCredential, onFlush, buildBatch,
    setSetting, shares, createShare, revokeShare, devices, sharedDoc, media, uploadBlob, pendingUploadCount, ai,
    fontRows, rowsOf, styleDefaults, doc,
    adoptFixture, versions, resolveVersion, OFFLINE_SENTENCE,
    get cursor() { return cursor; },
    get lastUploadNote() { return lastUploadNote; },
    get version() { return version; },
    get loaded() { return !!rows; },
  };
})();
