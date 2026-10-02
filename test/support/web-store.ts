// The page's own store scripts over a Backend that holds flat rows, stamps
// every write past the row's own stamp and keeps what a tombstone replaced
// (the real Backend's `contentBefore`), for the unit suites that write
// through Store as the page does.

import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "..", "assets", "js");

export const STORE_FILES = ["wire.js", "order.js", "fsrs.js", "gate.js", "cardline.js", "spans.js", "model.js",
  "geometry.js", "clip.js", "find.js", "sched.js", "store.js"];

/* eslint-disable @typescript-eslint/no-explicit-any */
export function storeStub(t0: number, files: string[] = STORE_FILES, names: string[] = ["Store", "Model", "Find", "Clip", "Spans", "Geometry"]): any {
  const prelude = `
    const rowsMap = new Map();
    const lastContent = new Map();
    let clock = ${t0};
    let version = 0;
    const Backend = {
      rowsMap,
      get version() { return version; },
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
          else if (lane === "grade_event") events.push(r);
        }
        return { notes, docs, folders, media, cards, occlusion, events, fonts: [],
                 settings: { retention: 90, newPerDay: 50, leechAutoSuspend: false, leechThreshold: 8, fromYourNotes: false } };
      },
      doc(id) {
        const L = this.library();
        const notes = [...L.notes.values()].filter(n => n.notebook_id === id);
        const ids = new Set(notes.map(n => n.id));
        return { notes, cards: L.cards.filter(c => ids.has(c.note_id) && c.deleted_at == null) };
      },
      get(lane, id) { return rowsMap.get(lane + "|" + id) || null; },
      write(lane, id, patch = {}, opts = {}) {
        version += 1;
        const k = lane + "|" + id;
        const prior = rowsMap.get(k);
        const t = Math.max(opts.now ?? clock, prior && prior.updated_at ? Date.parse(prior.updated_at) + 1 : 0);
        clock = t + 1;
        const stamp = new Date(t).toISOString();
        if (opts.tombstone) {
          if (prior && prior.deleted_at == null) {
            const { id: _i, updated_at: _u, ...rest } = prior;
            lastContent.set(k, { env: { ...rest, deleted_at: null }, content: {} });
          }
          rowsMap.set(k, { ...(prior || { id }), deleted_at: stamp, updated_at: stamp });
        } else {
          const next = { ...(prior || { id }), ...(patch.env || {}), ...(patch.content || {}), updated_at: stamp };
          if (!(patch.env && "deleted_at" in patch.env)) next.deleted_at = prior ? prior.deleted_at ?? null : null;
          rowsMap.set(k, next);
        }
        return { ...rowsMap.get(k) };
      },
      contentBefore(lane, id) { return lastContent.get(lane + "|" + id) || null; },
      discard() { return true; },
      deviceId() { return "dev"; },
      styleDefaults() { return {}; },
    };`;
  const src = files.map((f) => readFileSync(path.join(root, f), "utf8")).join("\n;\n");
  return new Function(`${prelude}\n${src}\nreturn { Backend, ${names.join(", ")} };`)();
}

/** The doc's blocks as the page builds them. */
export function blocksOf(S: any, docId: string): any[] {
  const d = S.Backend.doc(docId);
  const cards = new Map(d.cards.map((c: any) => [c.note_id, c]));
  return S.Model.build(d.notes.filter((n: any) => n.deleted_at == null), cards, new Set());
}
