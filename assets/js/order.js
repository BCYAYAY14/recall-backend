// Spaced sibling positions, as the app places them (`OrderSlots.swift`,
// owner rulings 2026-09-25 and 2026-09-26, the app's landmine 256).
//
// A row's place among its siblings is its `position`, and it travels with
// the row. A new row takes a position BETWEEN its neighbours and nothing
// else moves. Only when the neighbours have no integer left are the LINES
// NEARBY respaced (`plan`), and every row whose position changed is written
// (so stamped) like any other edit. Positions are never negative and never
// pass the 32 bit ceiling. A tie two devices made is ordered at read by
// (position, created_at, lower hex id), identically on every device.

const Order = (() => {

  const GAP = 1024;           // `OrderSlots.gap`
  const ROOMY = 64;           // `OrderSlots.roomy`
  const CEILING = 2147483647; // `OrderSlots.ceiling`, Int32.max

  // The read order of every sibling group (`OrderSlots.readOrder`):
  // position, then created_at to the millisecond, then the id's lowercase
  // hex (a UUID string's dashes sit at the same places in both, so they are
  // dropped only for clarity).
  const hex = id => String(id || "").toLowerCase().replace(/-/g, "");
  const stamp = t => (t == null ? 0 : (typeof t === "number" ? t : Date.parse(t)) || 0);
  function compare(a, b) {
    const p = (a.position || 0) - (b.position || 0);
    if (p !== 0) return p;
    const c = stamp(a.created_at) - stamp(b.created_at);
    if (c !== 0) return c;
    const x = hex(a.id), y = hex(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  // `count` positions strictly between `prev` and `next` (null = the
  // group's start, where the first free position is 0, or its open end,
  // where the slots step by GAP while they stay under the ceiling), or null.
  function slots(count, prev, next) {
    if (count <= 0) return [];
    const low = prev == null ? -1 : prev;
    if (next == null) {
      const base = prev == null ? 0 : prev;
      if (base <= CEILING - GAP * count) return Array.from({ length: count }, (_, i) => base + GAP * (i + 1));
    }
    const high = next == null ? CEILING + 1 : next;
    if (high - low - 1 < count) return null;
    const step = Math.floor((high - low) / (count + 1));
    return Array.from({ length: count }, (_, i) => low + step * (i + 1));
  }

  // How `rows` rows spread over the window lo..<hi of `positions`, or null
  // when they would sit closer than ROOMY. At the END the window steps by
  // GAP from its lower bound; at the START the rows take only the upper
  // half of the room, so a run of inserts above the first line finds room.
  function layout(positions, lo, hi, rows) {
    let lower = lo > 0 ? positions[lo - 1] : -1;
    let upper;
    if (hi === positions.length) {
      if (lower <= CEILING - GAP * rows) return { base: lower, step: GAP };
      upper = CEILING + 1;
    } else {
      upper = positions[hi];
    }
    if (lo === 0) lower += Math.floor((upper - lower) / 2);
    const step = Math.floor((upper - lower) / (rows + 1));
    return step >= ROOMY ? { base: lower, step } : null;
  }

  // Where `count` new rows go at `index` of a group whose positions, in
  // read order, are `positions`: { lo, hi, positions } says the existing
  // rows lo..<hi and the new ones at the insertion point take `positions`
  // together. A slot between the neighbours when there is one (a run of more
  // than one row also needs ROOMY between its rows); otherwise the window of
  // existing rows around the insertion point grows 1, 2, 4, ... rows, every
  // placement of it is tried, and the one leaving the widest step wins. A
  // window that would reach both ends or cover more than half the group
  // respaces the whole group at GAP (a dense group written before the rule).
  function plan(positions, count, index) {
    const n = positions.length;
    const at = Math.min(Math.max(0, index), n);
    if (count <= 0) return { lo: at, hi: at, positions: [] };
    const prev = at > 0 ? positions[at - 1] : null;
    const next = at < n ? positions[at] : null;
    const found = slots(count, prev, next);
    if (found && (count === 1 || found[0] - (prev == null ? -1 : prev) >= ROOMY)) {
      return { lo: at, hi: at, positions: found };
    }
    for (let width = 1; width < n && 2 * width <= n; width *= 2) {
      let best = null;
      for (let before = 0; before <= width; before++) {
        const lo = at - before, hi = lo + width;
        if (lo < 0 || hi > n) continue;
        const fit = layout(positions, lo, hi, width + count);
        if (fit && (best == null || fit.step > best.step)) best = { lo, hi, ...fit };
      }
      if (best) {
        const rows = best.hi - best.lo + count;
        return { lo: best.lo, hi: best.hi,
                 positions: Array.from({ length: rows }, (_, i) => best.base + best.step * (i + 1)) };
      }
    }
    const rows = n + count;
    const step = Math.max(1, Math.min(GAP, Math.floor(CEILING / (rows + 1))));
    return { lo: 0, hi: n, positions: Array.from({ length: rows }, (_, i) => (i + 1) * step) };
  }

  // `count` positions at `index` of `group` (live rows in read order). The
  // rows of the window whose position changed are handed to `move(row,
  // position)`, which writes (and so stamps) them; the new rows' positions
  // are returned.
  function allocate(group, index, count, move) {
    const at = Math.min(Math.max(0, index), group.length);
    const p = plan(group.map(r => r.position || 0), count, at);
    const opened = p.positions.slice(at - p.lo, at - p.lo + count);
    const kept = p.positions.slice(0, at - p.lo).concat(p.positions.slice(at - p.lo + count));
    group.slice(p.lo, p.hi).forEach((row, i) => {
      if ((row.position || 0) !== kept[i]) move(row, kept[i]);
    });
    return opened;
  }

  return { GAP, ROOMY, CEILING, compare, slots, plan, allocate };
})();
