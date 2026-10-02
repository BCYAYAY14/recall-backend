// This browser's own copy of the library (PLAN-BETA-0.12 section 26, W-8).
//
// IndexedDB, one database per origin, four stores:
//   rows      "lane|id" -> the row as js/backend.js holds it, `dirty` and
//             `base_seq` included, so an edit made offline is an OUTBOX
//             entry that survives a closed tab and is pushed on reconnect
//             under the same last-write-wins rules (landmine 83);
//   meta      cursor, epoch and library id, written in the SAME transaction
//             as the rows they describe (PROTOCOL.md section 5);
//   versions  the kept versions a sync replaced (landmine 224: LOCAL, never a
//             lane), as the app's `note_version` table holds them;
//   blobs     picture bytes by sha256, so a doc read once draws offline.
// Nothing here is a credential: the device token stays in localStorage and
// is never copied into a row.

const Local = (() => {

  const NAME = "recall-web";
  const VERSION = 1;
  let dbPromise = null;

  function open() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(resolve => {
      let req;
      try { req = indexedDB.open(NAME, VERSION); } catch (_) { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("rows")) db.createObjectStore("rows");
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("versions")) db.createObjectStore("versions", { keyPath: "id" });
        if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
  }

  function all(store) {
    return new Promise((resolve, reject) => {
      const out = new Map();
      const req = store.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(out); return; }
        out.set(c.key, c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // The whole copy: rows, then the facts about them.
  async function load() {
    const db = await open();
    if (!db) return null;
    const tx = db.transaction(["rows", "meta"], "readonly");
    const [rows, meta] = await Promise.all([all(tx.objectStore("rows")), all(tx.objectStore("meta"))]);
    return { rows, meta: Object.fromEntries(meta) };
  }

  // Rows written and removed with the meta that goes with them, as one
  // transaction: a cursor never runs ahead of the rows it covers.
  async function save(put, remove, meta) {
    const db = await open();
    if (!db) return false;
    const tx = db.transaction(["rows", "meta"], "readwrite");
    const rows = tx.objectStore("rows");
    for (const [k, v] of put) rows.put(v, k);
    for (const k of remove) rows.delete(k);
    const m = tx.objectStore("meta");
    for (const [k, v] of Object.entries(meta || {})) m.put(v, k);
    await done(tx);
    return true;
  }

  // Everything this browser holds, for a sign out or a removed device.
  async function wipe() {
    const db = await open();
    if (!db) return;
    const tx = db.transaction(["rows", "meta", "versions", "blobs"], "readwrite");
    for (const s of ["rows", "meta", "versions", "blobs"]) tx.objectStore(s).clear();
    await done(tx).catch(() => {});
  }

  async function replaceRows(rowsMap, meta) {
    const db = await open();
    if (!db) return false;
    const tx = db.transaction(["rows", "meta"], "readwrite");
    const rows = tx.objectStore("rows");
    rows.clear();
    for (const [k, v] of rowsMap) rows.put(v, k);
    const m = tx.objectStore("meta");
    for (const [k, v] of Object.entries(meta || {})) m.put(v, k);
    await done(tx);
    return true;
  }

  // ------------------------------------------------------------ versions

  async function versions() {
    const db = await open();
    if (!db) return [];
    const tx = db.transaction("versions", "readonly");
    const out = await all(tx.objectStore("versions"));
    return [...out.values()];
  }

  async function putVersion(v) {
    const db = await open();
    if (!db) return;
    const tx = db.transaction("versions", "readwrite");
    tx.objectStore("versions").put(v);
    await done(tx).catch(() => {});
  }

  // ---------------------------------------------------------------- blobs

  async function blob(sha) {
    const db = await open();
    if (!db) return null;
    return new Promise(resolve => {
      const req = db.transaction("blobs", "readonly").objectStore("blobs").get(sha);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function putBlob(sha, value) {
    const db = await open();
    if (!db) return;
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").put(value, sha);
    await done(tx).catch(() => {});
  }

  return { open, load, save, replaceRows, wipe, versions, putVersion, blob, putBlob };
})();
