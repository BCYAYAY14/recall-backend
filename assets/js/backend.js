// The viewer's one network client, speaking protocol 1 (PROTOCOL.md) to the
// backend at location.origin. There is no server to configure and no key in
// the page: the page and the API share an origin (plan 10.3).
//
// Two modes. PAIRED is a browser that entered a pairing code from Recall and
// holds a read_share device token: it reads the whole library and makes and
// stops share links. SHARED is a visitor holding a share link and nothing
// else: the token travels in a POST body, never in a URL (finding F-14).
//
// It never writes a note, a card or a schedule. The server refuses it anyway:
// a browser's scope is read_share.

const Backend = (() => {

  const PROTOCOL = 1;
  const TOKEN_KEY = "recall.viewer.device-token";
  const DEVICE_KEY = "recall.viewer.device-id";

  let shareToken = null;
  let library = null;     // lane -> Map(id -> flat row)
  let cursor = 0;

  function authError(message) {
    const error = new Error(message);
    error.authFailed = true;
    return error;
  }

  function token() { return localStorage.getItem(TOKEN_KEY); }
  function isSignedIn() { return !!token(); }
  function isShared() { return !!shareToken; }

  function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    library = null;
    cursor = 0;
  }

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
      throw new Error("The backend is unreachable. Check the connection and try again.");
    }
    if (raw && res.ok) return res;
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
    if (!res.ok) {
      const message = data.message || `The backend answered ${res.status}.`;
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

  async function pair(code, label) {
    const digits = String(code || "").replace(/\s+/g, "");
    if (!/^\d{8}$/.test(digits)) throw new Error("A pairing code is eight digits.");
    const out = await call("POST", "/v1/pair/claim",
      { code: digits, device_id: deviceId(), label: label || "Web browser", platform: "web" }, { auth: false });
    localStorage.setItem(TOKEN_KEY, out.token);
    library = null;
    return out;
  }

  // A wire row flattened to the column shape the renderer reads: the same
  // names the app's tables use.
  function flat(row) {
    return { id: row.id, updated_at: row.updated_at, ...row.env, ...row.content,
             deleted_at: row.env.deleted_at === undefined ? null : row.env.deleted_at };
  }

  function put(row) {
    if (!library[row.lane]) library[row.lane] = new Map();
    library[row.lane].set(row.id, flat(row));
  }

  // The whole library, paged by (lane, id), then caught up from the pinned
  // sequence. Later calls only pull what changed.
  async function sync() {
    if (!library) {
      library = {};
      let after = { after_lane: "", after_id: "" };
      let pinned = null;
      for (;;) {
        const q = new URLSearchParams({ ...after, limit: "1000" });
        const page = await call("GET", `/v1/snapshot?${q}`);
        if (pinned === null) pinned = page.pinned_seq;
        for (const row of page.rows) put(row);
        if (!page.more) break;
        after = page.next;
      }
      cursor = pinned || 0;
    }
    for (;;) {
      let frame;
      try {
        frame = await call("GET", `/v1/pull?since=${cursor}&limit=1000`);
      } catch (error) {
        if (error.code === "resync_required") { library = null; return sync(); }
        throw error;
      }
      if (frame.from > cursor + 1) { library = null; return sync(); }
      for (const row of frame.ops.sort((a, b) => a.seq - b.seq)) put(row);
      cursor = Math.max(cursor, frame.to);
      if (!frame.more) break;
    }
  }

  function rows(lane, predicate) {
    const all = library && library[lane] ? [...library[lane].values()] : [];
    return predicate ? all.filter(predicate) : all;
  }

  const live = r => r.deleted_at == null;
  const byPosition = (a, b) => (a.position || 0) - (b.position || 0);

  async function folders() { await sync(); return rows("folder", live).sort(byPosition); }
  async function notebooks() { await sync(); return rows("notebook", live).sort(byPosition); }
  function noteCounts() {
    const counts = new Map();
    for (const n of rows("note", live)) counts.set(n.notebook_id, (counts.get(n.notebook_id) || 0) + 1);
    return counts;
  }

  // The same five lists a share link is answered with.
  async function doc(notebookId) {
    await sync();
    const notes = rows("note", n => live(n) && n.notebook_id === notebookId);
    const ids = new Set(notes.map(n => n.id));
    return {
      notes,
      cards: rows("card", c => live(c) && ids.has(c.note_id)),
      media: rows("media", m => live(m) && ids.has(m.note_id)),
      occlusion: rows("occlusion", o => live(o) && ids.has(o.note_id)),
    };
  }

  function fontRows(family) {
    return rows("font", f => live(f) && f.family === family);
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

  // The bytes behind a media or font row, by content address.
  async function media(row) {
    const sha = row && row.bytes_sha;
    if (!/^[0-9a-f]{64}$/.test(String(sha))) throw new Error("Image not available");
    const res = shareToken
      ? await call("POST", "/v1/share/blob", { token: shareToken, sha }, { auth: false, raw: true })
      : await call("GET", `/v1/blob/${sha}`, undefined, { raw: true });
    return await res.blob();
  }

  return { checkVersion, pair, signOut, isSignedIn, isShared, folders, notebooks, noteCounts,
           doc, fontRows, sync, shares, createShare, revokeShare, sharedDoc, media };
})();
