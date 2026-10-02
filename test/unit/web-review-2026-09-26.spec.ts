// The 2026-09-26 review's web findings, over the exact bytes the browser
// runs (the repros in design/review-2026-09-26/findings/repro-tests/web,
// turned into assertions). Each failed on the tree the review read.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssets } from "../support/web-assets.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const root = path.join(import.meta.dirname, "..", "..", "assets", "js");
const T0 = "2026-09-25T00:00:00.000Z";

// Store over a stub Backend that holds flat rows and records every write.
function stubbed() {
  const prelude = `
    const writes = [];
    const rowsMap = new Map();
    const Backend = {
      writes, rowsMap,
      library() {
        const notes = new Map(), docs = new Map(), folders = new Map(), media = new Map();
        const cards = [], occlusion = [], events = [];
        for (const [k, r] of rowsMap) {
          const lane = k.split("|")[0];
          if (lane === "note") notes.set(r.id, r);
          else if (lane === "notebook") docs.set(r.id, r);
          else if (lane === "folder") folders.set(r.id, r);
          else if (lane === "media") media.set(r.id, r);
          else if (lane === "card") cards.push(r);
          else if (lane === "occlusion") occlusion.push(r);
        }
        return { notes, docs, folders, media, cards, occlusion, events, settings: { retention: 90, newPerDay: 10 } };
      },
      get(lane, id) { return rowsMap.get(lane + "|" + id) || null; },
      write(lane, id, patch = {}, opts = {}) {
        const k = lane + "|" + id;
        const next = { ...(rowsMap.get(k) || { id }), ...(patch.env || {}), ...(patch.content || {}) };
        next.deleted_at = opts.tombstone ? "2026-09-26T00:00:00.000Z" : next.deleted_at ?? null;
        if (!opts.tombstone && patch.env && "deleted_at" in patch.env) next.deleted_at = patch.env.deleted_at;
        rowsMap.set(k, next);
        writes.push({ lane, id, patch, opts });
        return next;
      },
      contentBefore(lane, id) { return this.before?.get(lane + "|" + id) || null; },
      deviceId() { return "dev"; },
    };`;
  const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "spans.js", "model.js", "sched.js", "store.js"]
    .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${prelude}\n${src}\nreturn { Backend, Store, Spans, Model, Sched };`)() as any;
}

// The real Backend (backend.js) with a browser stubbed around it.
type Answer = (url: string, init?: { method?: string }) => { status: number; body: unknown };

function real(store = new Map<string, string>([["recall.viewer.device-id", "11111111-1111-4111-8111-111111111111"]]), answer: Answer = () => ({ status: 404, body: {} })) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const fetchStub = async (url: string, init?: { method?: string }) => {
    const a = answer(url, init); // an answer that throws is the network failing
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  const src = ["wire.js", "order.js", "fsrs.js", "gate.js", "spans.js", "model.js", "local.js", "backend.js", "sched.js", "store.js"]
    .map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  const prelude = `
    const window = { addEventListener(n, f) { HANDLERS[n] = f; } };
    const document = { addEventListener() {}, visibilityState: "visible" };
    const localStorage = { getItem: k => STORE.get(k) ?? null, setItem: (k, v) => STORE.set(k, String(v)), removeItem: k => STORE.delete(k) };
    const setTimeout = () => 0; const clearTimeout = () => {};
    const setInterval = () => 0; const clearInterval = () => {};
    const fetch = FETCH;`;
  const api = new Function("STORE", "HANDLERS", "FETCH", `${prelude}\n${src}\nreturn { Backend, Store, Local, Model };`)(store, handlers, fetchStub) as any;
  return { ...api, handlers };
}

const noteRow = (id: string, doc: string, front: string, seq: number, at: string, extra: Record<string, unknown> = {}) => ({
  lane: "note", id, kind: "upsert", updated_at: at, seq,
  env: { notebook_id: doc, parent_id: null, position: 1024, kind: "paragraph", unreviewed: false, occ_mode: null, typed_answer: false, created_at: T0, deleted_at: null, ...extra },
  content: { front, back: null, cloze_text: null, tags: "", spans: null, attrs: null },
});

// A paired browser whose own copy (Local, stubbed) holds `held`, started
// against a backend that answers `extra` first and a quiet library after.
const DEV = "11111111-1111-4111-8111-111111111111", LIB = "lib-1";
function pairedBrowser(held: Map<string, unknown>, meta: Record<string, unknown> = {}, extra: Answer = () => null as never) {
  const store = new Map([["recall.viewer.device-token", "t"], ["recall.viewer.device-id", DEV], ["recall.viewer.library-id", LIB]]);
  const answer: Answer = (url, init) => extra(url, init) ?? (
    url.startsWith("/v1/version") ? { status: 200, body: { pv_min: 1, pv_max: 1 } }
    : url.startsWith("/v1/hello") ? { status: 200, body: { t: "hello_ok", server_time: new Date().toISOString(), seq: 5, epoch: "e" } }
    : url.startsWith("/v1/pull") ? { status: 200, body: { t: "ops", from: 6, to: 5, more: false, ops: [] } }
    : url.startsWith("/v1/push") ? { status: 503, body: { error: "down", message: "The backend is busy." } }
    : { status: 200, body: { ok: true } });
  const api = real(store, answer);
  const log = { saved: [] as unknown[][], wiped: 0, failSave: false };
  const disk = { rows: held, meta: { device: DEV, library: LIB, cursor: 5, epoch: "e", ...meta } };
  api.Local.load = async () => ({ rows: new Map(disk.rows), meta: disk.meta });
  api.Local.versions = async () => [];
  api.Local.save = async (...a: unknown[]) => { log.saved.push(a); if (log.failSave) throw new Error("QuotaExceededError"); return true; };
  api.Local.replaceRows = async (...a: unknown[]) => { log.saved.push(a); return true; };
  api.Local.wipe = async () => { log.wiped++; };
  api.Local.putBlob = async () => {};
  return { ...api, store, log };
}

// A row as this browser keeps it, dirty (an outbox entry) when `edited`.
function heldRow(id: string, doc: string, front: string, edited?: string) {
  const { Backend } = real();
  Backend.adoptFixture([noteRow(id, doc, front, 3, "2026-09-26T00:00:00.000Z")]);
  if (edited) Backend.write("note", id, { content: { front: edited } }, { now: Date.parse("2026-09-26T00:09:00.000Z") });
  return structuredClone(Backend.rawRow("note", id));
}
const tick = () => new Promise((r) => setImmediate(r));

describe("review 2026-09-26, the web app", () => {
  it("web-1: leaving the cells of a card table's header and of a half row writes nothing and grows no ::", () => {
    const S = stubbed();
    const id = S.Store.insertTable("doc", null, { rows: 2, cardTable: true });
    const header = () => S.Store.tableOf(id).rows[0];
    expect(S.Store.rowCells(header(), true)).toEqual(["Term", "Meaning"]);
    const writes = S.Backend.writes.length;
    for (let blur = 0; blur < 3; blur++) S.Store.saveTableRow(header().id, S.Store.rowCells(header(), true));
    expect(S.Backend.get("note", header().id).front).toBe("Term::Meaning");
    const row = S.Store.tableOf(id).rows[1];
    S.Store.saveTableRow(row.id, ["H", ""]);
    for (let blur = 0; blur < 2; blur++) S.Store.saveTableRow(row.id, S.Store.rowCells(S.Backend.get("note", row.id), true));
    expect(S.Backend.get("note", row.id).front).toBe("H::");
    expect(S.Backend.writes.slice(writes).filter((w: any) => w.id === header().id)).toEqual([]);
    // The table's derived text is the app's `plainText`: TAB between cells.
    expect(S.Backend.get("note", id).front).toBe("Term\tMeaning\nH\t");
  });

  it("web-2: focusing and leaving a line keeps its kind and its words whatever its text starts with", () => {
    const S = stubbed();
    const seed = (id: string, kind: string, front: string, spans: string | null = null) =>
      S.Backend.rowsMap.set("note|" + id, { id, notebook_id: "doc", parent_id: null, position: 1024, kind, front, back: null,
        cloze_text: null, attrs: null, spans, deleted_at: null, unreviewed: false, created_at: T0, updated_at: T0 });
    seed("a", "heading1", "1. Introduction");
    // b and c are LEGACY code rows (code left Recall, owner 2026-09-29):
    // read as paragraphs, and an untouched one is still never written.
    seed("b", "code", "# install the deps");
    seed("c", "code", "- name: build");
    seed("d", "heading2", "- Summary");
    const anchor = "Hello world";
    seed("e", "paragraph", anchor, `{"v":1,"n":11,"h":"${S.Spans.fingerprint(anchor)}","r":[[0,5,"h","#e8c34a"],[0,5,"i"]]}`);
    for (const id of ["a", "b", "c", "d", "e"]) {
      const block = S.Model.build([S.Backend.get("note", id)], new Map(), new Set())[0];
      expect(S.Store.saveLine(id, block.text, Date.now(), block.runs)).toBe(false);
    }
    expect(S.Backend.writes).toEqual([]);
    // Editing the words keeps the kind too.
    S.Store.saveLine("a", "1. Introduction, revised", Date.now(), []);
    expect(S.Backend.get("note", "a")).toMatchObject({ kind: "heading1", front: "1. Introduction, revised" });
    // A marker TYPED in front still declares its kind.
    S.Store.saveLine("e", "## Hello world", Date.now(), []);
    expect(S.Backend.get("note", "e")).toMatchObject({ kind: "heading2", front: "Hello world" });
  });

  it("web-3: a line written over a revision it never showed goes out on the seq it showed (landmine 249)", () => {
    const { Backend, Store } = real();
    const DOC = "10000000-0000-4000-8000-000000000001", ID = "20000000-0000-4000-8000-000000000001";
    Backend.adoptFixture([noteRow(ID, DOC, "Mitochondria make ATP.", 7, "2026-09-26T00:00:00.000Z")]);
    const shownSeq = Backend.rawRow("note", ID).base_seq;
    Backend.adoptFixture([noteRow(ID, DOC, "Mitochondria make ATP from glucose and oxygen.", 9, "2026-09-26T00:05:00.000Z")]);
    Store.saveLine(ID, "Mitochondria make ATP. Typed here.", Date.parse("2026-09-26T00:06:00.000Z"), [], { base: shownSeq });
    expect(Backend.rawRow("note", ID)).toMatchObject({ dirty: true, base_seq: 7 });
  });

  it("web-3: a pulled revision a dirty row did not take leaves its base_seq alone (landmine 250)", async () => {
    const DOC = "10000000-0000-4000-8000-000000000001", ID = "20000000-0000-4000-8000-000000000002";
    const token = new Map([["recall.viewer.device-token", "t"], ["recall.viewer.device-id", "11111111-1111-4111-8111-111111111111"]]);
    const { Backend } = real(token, (url) => url.startsWith("/v1/pull")
      ? { status: 200, body: { t: "ops", from: 1, to: 5, more: false, ops: [{ ...noteRow(ID, DOC, "the Mac's words", 5, "2026-09-26T00:05:00.000Z"), op_id: crypto.randomUUID() }] } }
      : { status: 200, body: { ok: true } });
    Backend.adoptFixture([noteRow(ID, DOC, "one", 3, "2026-09-26T00:00:00.000Z")]);
    Backend.write("note", ID, { content: { front: "mine, newer" } }, { now: Date.parse("2026-09-26T00:09:00.000Z") });
    await Backend.pull();
    expect(Backend.rawRow("note", ID).content.front).toBe("mine, newer");
    const b = await Backend.buildBatch();
    expect(b.ops[0].base_seq).toBe(3);
  });

  it("web-4: a batch of long rows stays under the backend's 1 MiB body", async () => {
    const { Backend } = real();
    const DOC = "10000000-0000-4000-8000-000000000001";
    const list = Array.from({ length: 600 }, (_, i) => noteRow(`30000000-0000-4000-8000-${String(i).padStart(12, "0")}`, DOC, "x", 1, T0));
    Backend.adoptFixture(list);
    for (const r of list) Backend.write("note", r.id, { content: { front: "y".repeat(2000) } });
    const b = await Backend.buildBatch();
    const body = JSON.stringify({ t: "push", batch: b.batch, ops: b.ops });
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(1_048_576);
    expect(b.ops.length).toBeGreaterThan(300);
    expect(b.ops.length).toBeLessThan(600);
  });

  it("web-5: a Mac spans blob with two runs at one start re-encodes to the same bytes", () => {
    const { Spans } = loadAssets<{ Spans: any }>(["spans.js"], ["Spans"]);
    const anchor = "Hello world";
    const mac = `{"v":1,"n":${anchor.length},"h":"${Spans.fingerprint(anchor)}","r":[[0,5,"h","#e8c34a"],[0,5,"i"]]}`;
    expect(Spans.encode(Spans.decode(mac, anchor), anchor)).toBe(mac);
  });

  it("web-5: leaving an untouched card table row rewrites neither the row, its card nor the table", () => {
    const S = stubbed();
    const base = { notebook_id: "doc", deleted_at: null, unreviewed: false, created_at: T0, updated_at: T0, spans: null, cloze_text: null };
    S.Backend.rowsMap.set("note|T", { ...base, id: "T", parent_id: null, position: 1024, kind: "table", front: "Term\tMeaning\nH\thydrogen", back: null, attrs: '{"card":true,"v":1}' });
    S.Backend.rowsMap.set("note|R0", { ...base, id: "R0", parent_id: "T", position: 1024, kind: "tablerow", front: "Term::Meaning", back: null, attrs: null });
    S.Backend.rowsMap.set("note|R1", { ...base, id: "R1", parent_id: "T", position: 2048, kind: "tablerow", front: "H", back: "hydrogen", attrs: null });
    S.Backend.rowsMap.set("card|C1", { id: "C1", note_id: "R1", cloze_ordinal: null, deleted_at: null, detached: false, reps: 4, state: "review",
      due: "2026-10-01T00:00:00.000Z", q_snapshot: "H", a_snapshot: "hydrogen", updated_at: T0 });
    expect(S.Store.rowCells(S.Backend.get("note", "R1"), true)).toEqual(["H", "hydrogen"]);
    expect(S.Store.saveTableRow("R1", ["H", "hydrogen"])).toBe(false);
    expect(S.Backend.writes).toEqual([]);
  });

  it("web-6: a resync keeps a version of an unsent edit it overwrites", async () => {
    const DOC = "10000000-0000-4000-8000-000000000001", ID = "20000000-0000-4000-8000-000000000003";
    const token = new Map([["recall.viewer.device-token", "t"], ["recall.viewer.device-id", "11111111-1111-4111-8111-111111111111"]]);
    let pulls = 0;
    const { Backend } = real(token, (url) => {
      if (url.startsWith("/v1/pull")) return pulls++ === 0 ? { status: 409, body: { error: "resync_required" } } : { status: 200, body: { t: "ops", from: 8, to: 7, more: false, ops: [] } };
      if (url.startsWith("/v1/snapshot")) return { status: 200, body: { pinned_seq: 7, epoch: "e", more: false, next: null, rows: [noteRow(ID, DOC, "the Mac's newer words", 7, "2026-09-26T10:05:00.000Z")] } };
      return { status: 200, body: { ok: true } };
    });
    Backend.adoptFixture([noteRow(ID, DOC, "old", 2, "2026-09-26T09:00:00.000Z")]);
    Backend.write("note", ID, { content: { front: "typed offline" } }, { now: Date.parse("2026-09-26T10:00:00.000Z") });
    await Backend.pull();
    expect(Backend.rawRow("note", ID).content.front).toBe("the Mac's newer words");
    expect(Backend.versions(DOC).map((v: any) => v.front)).toEqual(["typed offline"]);
  });

  it("web-7: a fixture never writes the paired browser's copy of the library", async () => {
    const store = new Map([["recall.viewer.device-token", "paired-token"], ["recall.viewer.device-id", "11111111-1111-4111-8111-111111111111"],
                           ["recall.viewer.library-id", "real-library"]]);
    const { Backend, Local, handlers } = real(store);
    const saved: unknown[] = [];
    Local.save = async (...a: unknown[]) => { saved.push(a); return true; };
    Local.replaceRows = async (...a: unknown[]) => { saved.push(a); return true; };
    Backend.adoptFixture([noteRow("00000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000001", "fixture line", 0, T0)]);
    Backend.write("note", "00000000-0000-4000-8000-000000000001", { content: { front: "edited in the fixture" } });
    handlers.beforeunload!({ preventDefault() {}, returnValue: undefined });
    await new Promise((r) => setImmediate(r));
    expect(saved).toEqual([]);
  });

  it("web-10: restoring a deleted doc brings back its pictures and its regions", () => {
    const S = stubbed();
    const t = Date.parse("2026-09-26T00:00:00.000Z");
    S.Backend.rowsMap.set("notebook|D", { id: "D", folder_id: null, deleted_at: null, name: "Doc" });
    S.Backend.rowsMap.set("note|N", { id: "N", notebook_id: "D", parent_id: null, kind: "paragraph", front: "p", deleted_at: null });
    S.Backend.rowsMap.set("media|M", { id: "M", note_id: "N", deleted_at: null });
    S.Backend.rowsMap.set("occlusion|O", { id: "O", note_id: "N", deleted_at: null });
    S.Backend.before = new Map(["notebook|D", "note|N", "media|M", "occlusion|O"].map((k) => [k, { env: {}, content: {} }]));
    S.Store.deleteDoc("D", t);
    expect(S.Backend.get("media", "M").deleted_at).not.toBeNull();
    S.Store.restoreDoc("D", t + 5000);
    expect(S.Backend.get("media", "M").deleted_at).toBeNull();
    expect(S.Backend.get("occlusion", "O").deleted_at).toBeNull();
  });

  it("web-12: a 50 line import into a 6668 line doc with 40,000 grades does not rebuild the library per line", () => {
    const { Backend, Store } = real();
    const DOC = "40000000-0000-4000-8000-000000000001";
    const list: any[] = [{ lane: "notebook", id: DOC, kind: "upsert", updated_at: T0,
      env: { folder_id: null, position: 1024, created_at: T0, deleted_at: null, exam_at: null, retention_pct: null, new_per_day: null },
      content: { name: "Big", emoji: "x", style: null } }];
    const cards: string[] = [];
    for (let i = 0; i < 6668; i++) {
      const id = crypto.randomUUID();
      list.push({ ...noteRow(id, DOC, "Question " + i, 1, T0), env: { ...noteRow(id, DOC, "", 1, T0).env, position: (i + 1) * 1024 } });
      const cid = crypto.randomUUID(); cards.push(cid);
      list.push({ lane: "card", id: cid, kind: "upsert", updated_at: T0, seq: 1,
        env: { note_id: id, cloze_ordinal: null, flag: 0, suspended: false, stability: 3, difficulty: 5, due: T0, state: "review", last_review_at: T0, introduced_on: T0, reps: 3, lapses: 0, detached: false, deleted_at: null },
        content: { q_snapshot: "q", a_snapshot: "a" } });
    }
    for (let i = 0; i < 40000; i++) {
      list.push({ lane: "grade_event", id: crypto.randomUUID(), kind: "upsert", updated_at: T0, seq: 1,
        env: { card_id: cards[i % cards.length], rating: 3, reviewed_at: T0, device_id: "d" }, content: {} });
    }
    Backend.adoptFixture(list);
    Backend.library();
    const started = performance.now();
    expect(Store.importLines(DOC, Array.from({ length: 50 }, (_, i) => `pasted ${i} >> back`))).toBe(50);
    const ms = performance.now() - started;
    const lib = Backend.library();
    expect([...lib.notes.values()].filter((n: any) => n.front?.startsWith("pasted")).length).toBe(50);
    expect(lib.cards.length).toBe(6668 + 50);
    expect(lib.events.length).toBe(40000);
    // The review measured 1,817 ms for this import; a whole-library rebuild is about 35 ms a call.
    expect(ms).toBeLessThan(1500);
  }, 120_000);

  it("web-13: custom study deals a card made a moment ago", () => {
    const { Sched } = loadAssets<{ Sched: any }>(["fsrs.js", "sched.js"], ["Sched"]);
    const now = Date.parse("2026-09-26T12:00:00.000Z");
    const lib = { folders: new Map(), docs: new Map([["d", { id: "d", folder_id: null, deleted_at: null, exam_at: null }]]),
      notes: new Map([["n", { id: "n", notebook_id: "d", created_at: new Date(now - 5000).toISOString(), deleted_at: null }]]),
      cards: [{ id: "c", note_id: "n", state: "new", due: new Date(now - 5000).toISOString(), cloze_ordinal: null, deleted_at: null, detached: false, suspended: false }],
      events: [] };
    expect(Sched.cramQueue(lib, now, null).map((c: any) => c.id)).toEqual(["c"]);
  });

  it("web-16: clearing a doc's deadline clamps its cards to its folder's", () => {
    const S = stubbed();
    const now = Date.now();
    const folderExam = S.Sched.startOfDay(now + 5 * 86_400_000);
    S.Backend.rowsMap.set("folder|F", { id: "F", deleted_at: null, exam_at: new Date(folderExam).toISOString() });
    S.Backend.rowsMap.set("notebook|D", { id: "D", folder_id: "F", deleted_at: null, exam_at: new Date(now + 20 * 86_400_000).toISOString() });
    S.Backend.rowsMap.set("note|N", { id: "N", notebook_id: "D", deleted_at: null });
    S.Backend.rowsMap.set("card|C", { id: "C", note_id: "N", state: "review", due: new Date(now + 15 * 86_400_000).toISOString(), deleted_at: null });
    expect(S.Store.setDeadline("D", null, now)).toBe(1);
    expect(Date.parse(S.Backend.get("card", "C").due)).toBe(folderExam);
  });

  it("web-17: an undone grade that already left stays out of this browser's stats", () => {
    const { Backend } = real();
    const E = "50000000-0000-4000-8000-000000000001";
    Backend.adoptFixture([{ lane: "grade_event", id: E, kind: "upsert", updated_at: T0, seq: 4,
      env: { card_id: "60000000-0000-4000-8000-000000000001", rating: 3, reviewed_at: T0, device_id: "d" }, content: {} }]);
    expect(Backend.library().events.length).toBe(1);
    expect(Backend.discard("grade_event", E)).toBe(false);
    expect(Backend.library().events.length).toBe(0);
  });
  it("web-8: the flush hooks run on beforeunload and pagehide, so a line typed a moment ago is saved and the close warns", async () => {
    const DOC = "10000000-0000-4000-8000-000000000001", ID = "20000000-0000-4000-8000-000000000008";
    const { Backend, handlers, log } = pairedBrowser(new Map([["note|" + ID, heldRow(ID, DOC, "one")]]));
    await Backend.start();
    expect(Backend.rawRow("note", ID).dirty).toBe(false);
    let flushed = 0;
    // What the editor registers: its 700 ms timer's line, committed now.
    Backend.onFlush(() => { flushed++; Backend.write("note", ID, { content: { front: "typed just now" } }); });
    let warned = false;
    handlers.beforeunload!({ preventDefault() { warned = true; }, returnValue: undefined });
    expect(flushed).toBe(1);
    expect(Backend.rawRow("note", ID)).toMatchObject({ dirty: true, content: { front: "typed just now" } });
    expect(warned).toBe(true);
    expect(log.saved.length).toBeGreaterThan(0);
    handlers.pagehide!({});
    expect(flushed).toBe(2);
    // The editor is what registers it.
    expect(readFileSync(path.join(root, "editor.js"), "utf8")).toMatch(/Backend\.onFlush\(\s*\(\)\s*=>\s*\{\s*if \(!destroyed\) api\.flush\(\);/);
  });

  it("web-9: a 401 at start keeps the outbox for the next pairing", async () => {
    const DOC = "10000000-0000-4000-8000-000000000001", ID = "20000000-0000-4000-8000-000000000009";
    let refuse = true;
    const { Backend, store, log } = pairedBrowser(new Map([["note|" + ID, heldRow(ID, DOC, "one", "typed offline")]]), {},
      (url) => (refuse && url.startsWith("/v1/hello") ? { status: 401, body: { error: "auth", message: "Sign in again: this device credential is not recognised." } } : null as never));
    await expect(Backend.start()).rejects.toMatchObject({ authFailed: true });
    expect(Backend.rawRow("note", ID).dirty).toBe(true);
    // What the page does with it (app.js): forget the credential, keep the copy.
    Backend.forgetCredential();
    expect(log.wiped).toBe(0);
    expect(store.has("recall.viewer.device-token")).toBe(false);
    expect(store.get("recall.viewer.library-id")).toBe(LIB);
    // Paired again: the outbox is back and goes out on its old base.
    refuse = false;
    store.set("recall.viewer.device-token", "t2");
    await Backend.start();
    expect(Backend.rawRow("note", ID).dirty).toBe(true);
    const b = await Backend.buildBatch();
    expect(b.ops.filter((o: any) => o.lane === "note").map((o: any) => [o.id, o.content.front, o.base_seq])).toEqual([[ID, "typed offline", 3]]);
    const app = readFileSync(path.join(root, "app.js"), "utf8");
    const branch = app.slice(app.indexOf("if (error.authFailed) {"), app.indexOf("showSignIn(", app.indexOf("if (error.authFailed) {")));
    expect(branch).toContain("Backend.forgetCredential()");
    expect(branch).not.toContain("Backend.signOut()");
  });

  it("web-11: a 503 on blob begin keeps the upload pending; only a lasting refusal drops it", async () => {
    const sha = "ab".repeat(32);
    let begin = { status: 503, body: { error: "budget", message: "Attachment storage is paused." } } as { status: number; body: unknown };
    const ID = "20000000-0000-4000-8000-000000000011";
    const { Backend, Local, log } = pairedBrowser(new Map([["note|" + ID, heldRow(ID, "10000000-0000-4000-8000-000000000001", "one")]]), { uploads: [[sha, "image/png"]] },
      (url) => (url.startsWith("/v1/blob/begin") ? begin : null as never));
    Local.blob = async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    await Backend.start();
    expect(Backend.pendingUploadCount()).toBe(1);
    await Backend.sync();
    expect(Backend.pendingUploadCount()).toBe(1);
    expect((log.saved.at(-1)![2] as { uploads: unknown }).uploads).toEqual([[sha, "image/png"]]);
    begin = { status: 429, body: { error: "rate", message: "Too many." } };
    await Backend.sync();
    expect(Backend.pendingUploadCount()).toBe(1);
    begin = { status: 413, body: { error: "object_too_large", message: "Too large." } };
    await Backend.sync();
    expect(Backend.pendingUploadCount()).toBe(0);
  });

  it("web-14: a failed save re-marks the rows, so the next save retries them and closing still warns", async () => {
    const DOC = "10000000-0000-4000-8000-000000000001", ID = "20000000-0000-4000-8000-000000000014";
    const { Backend, handlers, log } = pairedBrowser(new Map([["note|" + ID, heldRow(ID, DOC, "one")]]));
    await Backend.start();
    Backend.write("note", ID, { content: { front: "not yet on disk" } });
    log.failSave = true;
    let warned = 0;
    const event = { preventDefault() { warned++; }, returnValue: undefined };
    handlers.beforeunload!(event);
    await tick();
    expect(warned).toBe(1);
    const tried = log.saved.length;
    // The save failed: the row is still unwritten, so the next close warns and saves it again.
    handlers.beforeunload!(event);
    await tick();
    expect(warned).toBe(2);
    expect(log.saved.length).toBe(tried + 1);
    expect((log.saved.at(-1)![0] as [string, any][]).filter(([k]) => k.startsWith("note|")).map(([k, r]) => [k, r.content.front])).toEqual([["note|" + ID, "not yet on disk"]]);
    log.failSave = false;
    handlers.pagehide!({});
    await tick();
    handlers.beforeunload!(event);
    expect(warned).toBe(2);
  });

  it("the More chip is named More", () => {
    // D-154: the doc's More chip goes through UI.chip with its title, and a
    // chip whose face is a glyph or a number is named by that title.
    const app = readFileSync(path.join(root, "app.js"), "utf8");
    expect(app).toMatch(/chip\("⋯", \{ title: "More"/);
    class El {
      attrs: Record<string, string> = {};
      children: unknown[] = [];
      className = "";
      classList = { add: () => {} };
      setAttribute(k: string, v: string) { this.attrs[k] = v; }
      appendChild(c: unknown) { this.children.push(c); return c; }
      addEventListener() {}
      set textContent(_: string) { this.children = []; }
    }
    const fake = { createElement: () => new El(), createTextNode: (t: string) => Object.assign(new El(), { text: t }) };
    const UI = new Function("document", "Node", `${readFileSync(path.join(root, "ui.js"), "utf8")}\nreturn UI;`)(fake, El) as any;
    const more = UI.chip("⋯", { title: "More", onclick: () => {} });
    expect(more.attrs["aria-label"]).toBe("More");
    expect(UI.chip("2", { title: "Width 2" }).attrs["aria-label"]).toBe("Width 2");
    // A chip with words on its face keeps them as its name.
    expect(UI.chip("Edit", { title: "Edit the doc" }).attrs["aria-label"]).toBeUndefined();
    expect(UI.chip("1.15", {}).attrs["aria-label"]).toBeUndefined();
  });
});
