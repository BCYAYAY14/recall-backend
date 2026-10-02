// The queue and the counts, restated from Recall's AppDatabase (buildQueue,
// dueCounts, examQuotas, countIntroducedToday, perNotebookDueCounts,
// scopeDueCount, dueForecast, masteryBuckets, schedulerKnobs) over the rows
// the page holds. Ruling W-B: the same rules, not a nearer guess, so the hero
// the web draws is the number the Mac draws on the same library, and Study
// deals what the hero promised (landmine 6).
//
// `lib` is Backend.library(): { folders, docs, notes (Map id -> flat row),
// cards, events (arrays), settings }. Times are milliseconds.

const Sched = (() => {

  const DAY = 86400000;
  // PLAN-v1.5 ruling 10: a card authored under a minute ago joins the NEXT
  // session, never one started now (`youngCardWindow`).
  const YOUNG_MS = 60000;
  const TOMBSTONE_DAYS = 30;

  const ms = t => (t == null ? null : Date.parse(t));
  const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function daysBetween(fromMs, toMs) {
    // Calendar days between two local midnights, robust to a DST hour.
    return Math.round((startOfDay(toMs) - startOfDay(fromMs)) / DAY);
  }

  // COALESCE(d.exam_at, fo.exam_at), the folder only when it is live.
  function rawExam(lib, doc) {
    if (!doc) return null;
    if (doc.exam_at) return ms(doc.exam_at);
    const f = doc.folder_id ? lib.folders.get(doc.folder_id) : null;
    return f && f.deleted_at == null && f.exam_at ? ms(f.exam_at) : null;
  }

  // The deadline in force: a date earlier than today has passed.
  function examDeadline(lib, docId, now) {
    const exam = rawExam(lib, lib.docs.get(docId));
    return exam != null && exam >= startOfDay(now) ? exam : null;
  }

  // `plainDocClause`: this doc has no deadline in force.
  function isPlainDoc(lib, doc, now) {
    const exam = rawExam(lib, doc);
    return exam == null || exam < startOfDay(now);
  }

  // A card a session may deal: live, attached, unsuspended, on a live note
  // in a live doc.
  function context(lib, card) {
    if (card.deleted_at != null || card.detached || card.suspended) return null;
    const note = lib.notes.get(card.note_id);
    if (!note || note.deleted_at != null) return null;
    const doc = lib.docs.get(note.notebook_id);
    if (!doc || doc.deleted_at != null) return null;
    return { note, doc };
  }

  function fresh(note, now) {
    return ms(note.created_at) <= now - YOUNG_MS;
  }

  // `queueOrder`: due, then the ordinal (a note's blanks spread across the
  // sitting), then the id's hex as a total order.
  function queueOrder(a, b) {
    const d = ms(a.due) - ms(b.due);
    if (d) return d;
    const o = (a.cloze_ordinal ?? 0) - (b.cloze_ordinal ?? 0);
    if (o) return o;
    const x = a.id.replace(/-/g, ""), y = b.id.replace(/-/g, "");
    return x < y ? -1 : x > y ? 1 : 0;
  }

  // DUE REVIEWS, LOWEST RECALL FIRST (`AppDatabase.recallOrder`): the most
  // days since review per day of stability leads.
  function recallOrder(now) {
    const ratio = c => (now - ms(c.last_review_at)) / 86400000 / Math.max(c.stability || 0, 0.001);
    return (a, b) => (ratio(b) - ratio(a)) || queueOrder(a, b);
  }

  // THE DAILY REVIEW CAP (`AppDatabase.reviewAllowance`): null for none, else
  // what today may still deal. A review is a card graded today that was not
  // introduced today.
  function reviewAllowance(lib, now) {
    const cap = (lib.settings && lib.settings.reviewCap) || 0;
    if (!(cap > 0)) return null;
    const start = startOfDay(now);
    const cards = new Map(lib.cards.map(c => [c.id, c]));
    const done = new Set();
    for (const e of lib.events || []) {
      const at = ms(e.reviewed_at);
      if (at < start || at > now) continue;
      const card = cards.get(e.card_id);
      if (!card || (card.introduced_on && ms(card.introduced_on) >= start)) continue;
      done.add(e.card_id);
    }
    return Math.max(0, cap - done.size);
  }

  // SPREAD REVIEWS (`ReviewSpread`): py-fsrs's fuzz range, a day chosen in it
  // weighted 1 / (due + 1)^2 / days, seeded by the card and its reps so the
  // app and the web choose alike.
  const FUZZ = [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]];
  function spreadRange(interval, elapsed) {
    const ivl = Math.min(interval, FSRS.maximumInterval);
    if (ivl < 2.5) return null;
    let delta = 1;
    for (const [a, b, f] of FUZZ) delta += f * Math.max(Math.min(ivl, b) - a, 0);
    let lo = Math.max(2, Math.round(ivl - delta));
    const hi = Math.min(Math.round(ivl + delta), FSRS.maximumInterval);
    if (interval > elapsed) lo = Math.max(lo, elapsed + 1);
    return [Math.min(lo, hi), hi];
  }
  function spreadSeed(cardId, reps) {
    let h = 0xcbf29ce484222325n;
    for (const b of new TextEncoder().encode(`${cardId.toUpperCase()}#${reps}`)) {
      h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return Number(h >> 11n) / 2 ** 53;
  }
  function chooseDay(lo, hi, load, seed) {
    const days = [], weights = [];
    for (let d = lo; d <= hi; d++) {
      const n = load.get(d) || 0;
      days.push(d);
      weights.push(1 / ((n + 1) * (n + 1)) / Math.max(d, 1));
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return days[Math.floor(days.length / 2)];
    let mark = seed * total;
    for (let i = 0; i < days.length; i++) {
      if (mark < weights[i]) return days[i];
      mark -= weights[i];
    }
    return days[days.length - 1];
  }
  function spreadFor(lib, card, elapsedDays, now) {
    if (lib.settings && lib.settings.spreadReviews === false) return null;
    return interval => {
      const r = spreadRange(interval, Math.floor(Math.max(0, elapsedDays)));
      if (!r) return interval;
      const today = startOfDay(now), load = new Map();
      for (const c of lib.cards) {
        if (c.deleted_at != null || c.suspended || c.detached || c.state !== "review" || c.id === card.id) continue;
        const d = Math.round((startOfDay(ms(c.due)) - today) / DAY);
        if (d >= r[0] && d <= r[1]) load.set(d, (load.get(d) || 0) + 1);
      }
      return chooseDay(r[0], r[1], load, spreadSeed(card.id, card.reps));
    };
  }

  function inScope(ctx, scope) {
    if (!scope || scope.kind === "library") return true;
    if (scope.kind === "doc") return ctx.doc.id === scope.id;
    if (scope.kind === "folder") return ctx.doc.folder_id === scope.id;
    if (scope.kind === "cards") return scope.ids.has(ctx.card.id);
    return true;
  }

  // Candidates: live, due now, fresh, in scope.
  function dueCandidates(lib, now, scope) {
    const out = [];
    for (const card of lib.cards) {
      const c = context(lib, card);
      if (!c || ms(card.due) > now || !fresh(c.note, now)) continue;
      c.card = card;
      if (!inScope(c, scope)) continue;
      out.push(c);
    }
    return out;
  }

  // `countIntroducedToday`: cards first graded today; `plainOnly` leaves out
  // the docs whose deadline runs its own ramp.
  function countIntroducedToday(lib, now, plainOnly) {
    const start = startOfDay(now);
    let n = 0;
    for (const card of lib.cards) {
      if (card.deleted_at != null || !card.introduced_on || ms(card.introduced_on) < start) continue;
      if (plainOnly) {
        const note = lib.notes.get(card.note_id);
        const doc = note ? lib.docs.get(note.notebook_id) : null;
        if (!note || !doc) continue;
        if (!isPlainDoc(lib, doc, now)) continue;
      }
      n++;
    }
    return n;
  }

  // TODAY'S RAMP per deadline doc (C-18): the day's pool (what is left plus
  // what today already took) over the days left, less what today took.
  function examQuotas(lib, now) {
    const start = startOfDay(now);
    const per = new Map();
    for (const card of lib.cards) {
      const c = context(lib, card);
      if (!c) continue;
      const exam = rawExam(lib, c.doc);
      if (exam == null || exam < start) continue;
      let e = per.get(c.doc.id);
      if (!e) { e = { exam, fresh: 0, today: 0 }; per.set(c.doc.id, e); }
      if (!fresh(c.note, now)) continue;
      if (card.state === "new" && ms(card.due) <= now) e.fresh++;
      if (card.introduced_on && ms(card.introduced_on) >= start) e.today++;
    }
    const out = new Map();
    for (const [id, e] of per) {
      const pool = e.fresh + e.today;
      if (pool <= 0) { out.set(id, 0); continue; }
      const days = Math.max(1, daysBetween(now, e.exam));
      const perDay = Math.ceil(pool / days);
      out.set(id, Math.max(0, Math.min(e.fresh, perDay - e.today)));
    }
    return out;
  }

  const clampedRetention = p => Math.min(97, Math.max(70, p));

  // `schedulerKnobs`: doc, then its folder, then the global value.
  function knobs(lib, scope, globalRetention, globalNewPerDay) {
    const out = { retention: clampedRetention(globalRetention), newPerDay: globalNewPerDay,
                  retentionInherited: true, newPerDayInherited: true };
    let own = null, folder = null;
    if (scope && scope.kind === "doc") {
      own = lib.docs.get(scope.id);
      folder = own && own.folder_id ? lib.folders.get(own.folder_id) : null;
      if (folder && folder.deleted_at != null) folder = null;
    } else if (scope && scope.kind === "folder") {
      folder = lib.folders.get(scope.id);
    }
    const ret = own && own.retention_pct != null ? own.retention_pct
      : folder && folder.retention_pct != null ? folder.retention_pct : null;
    const cap = own && own.new_per_day != null ? own.new_per_day
      : folder && folder.new_per_day != null ? folder.new_per_day : null;
    if (ret != null) { out.retention = clampedRetention(ret); out.retentionInherited = false; }
    if (cap != null) { out.newPerDay = Math.max(0, Math.min(200, cap)); out.newPerDayInherited = false; }
    return out;
  }

  // A grade's retention: the scope's own, resolved where the grade is written
  // (C-76), else the global.
  function retentionFor(lib, docId, globalRetention) {
    return knobs(lib, { kind: "doc", id: docId }, globalRetention, 0).retention;
  }

  // `buildQueue`: learning, then review, then new cards under the scope's
  // cap (plain docs only), then each deadline doc's ramp.
  function buildQueue(lib, now, newPerDay, scope, allowance) {
    const due = dueCandidates(lib, now, scope);
    const pick = pred => due.filter(pred).map(c => c.card).sort(queueOrder);
    const reviewCap = reviewAllowance(lib, now);
    const reviews = due.filter(c => c.card.state === "review").map(c => c.card).sort(recallOrder(now));
    const ordered = [
      ...pick(c => c.card.state === "learning" || c.card.state === "relearning"),
      ...(reviewCap == null ? reviews : reviews.slice(0, reviewCap)),
    ];
    const cap = knobs(lib, scope, 90, newPerDay).newPerDay;
    const allow = allowance ?? Math.max(0, cap - countIntroducedToday(lib, now, true));
    if (allow > 0) {
      ordered.push(...pick(c => c.card.state === "new" && isPlainDoc(lib, c.doc, now)).slice(0, allow));
    }
    const quotas = [...examQuotas(lib, now)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [docId, quota] of quotas) {
      if (quota <= 0) continue;
      ordered.push(...pick(c => c.card.state === "new" && c.doc.id === docId).slice(0, quota));
    }
    return ordered;
  }

  // `cramQueue`: a whole scope now, due or not, in the queue's state order;
  // grades schedule for real. A card made a moment ago is in it: the app
  // passes no fresh cutoff here (review 2026-09-26, web-13).
  function cramQueue(lib, now, scope, cap = 200) {
    const all = [];
    for (const card of lib.cards) {
      const c = context(lib, card);
      if (!c) continue;
      c.card = card;
      if (inScope(c, scope)) all.push(card);
    }
    const pick = pred => all.filter(pred).sort(queueOrder);
    return [...pick(c => c.state === "learning" || c.state === "relearning"),
            ...pick(c => c.state === "review"), ...pick(c => c.state === "new")].slice(0, cap);
  }

  // `dueCounts`: the hero. Learning and review due now, the capped plain new
  // cards and the ramp, kept apart so the subtitle can name its parts (C-17).
  function dueCounts(lib, now, newPerDay) {
    const due = dueCandidates(lib, now, null);
    const dc = { learning: 0, review: 0, cappedNew: 0, rampNew: 0 };
    let plainNew = 0;
    for (const c of due) {
      const st = c.card.state;
      if (st === "learning" || st === "relearning") dc.learning++;
      else if (st === "review") dc.review++;
      else if (st === "new" && isPlainDoc(lib, c.doc, now)) plainNew++;
    }
    const reviewCap = reviewAllowance(lib, now);
    if (reviewCap != null) dc.review = Math.min(dc.review, reviewCap);
    dc.cappedNew = Math.min(plainNew, Math.max(0, newPerDay - countIntroducedToday(lib, now, true)));
    for (const q of examQuotas(lib, now).values()) dc.rampNew += q;
    dc.newCards = dc.cappedNew + dc.rampNew;
    dc.total = dc.learning + dc.review + dc.newCards;
    return dc;
  }

  // `scopeDueCount` for one doc: its learning and review, its new cards under
  // the remaining allowance, and its ramp.
  function docDueCount(lib, docId, now, newPerDay) {
    const scope = { kind: "doc", id: docId };
    const due = dueCandidates(lib, now, scope);
    const allowance = Math.max(0, knobs(lib, scope, 90, newPerDay).newPerDay - countIntroducedToday(lib, now, true));
    let lr = 0, rv = 0, plainNew = 0, held = 0;
    for (const c of due) {
      const st = c.card.state;
      if (st === "new") {
        held++;
        if (isPlainDoc(lib, c.doc, now)) plainNew++;
      } else if (st === "review") rv++;
      else lr++;
    }
    const reviewCap = reviewAllowance(lib, now);
    lr += reviewCap == null ? rv : Math.min(rv, reviewCap);
    const quota = examQuotas(lib, now).get(docId) || 0;
    return lr + Math.min(plainNew, allowance) + Math.min(quota, held);
  }

  // `perNotebookDueCounts`: what each doc HOLDS that is due, uncapped (v0.8
  // ruling 3: a row states a fact, the hero states the promise).
  function docDue(lib, now) {
    const out = new Map();
    for (const c of dueCandidates(lib, now, null)) out.set(c.doc.id, (out.get(c.doc.id) || 0) + 1);
    return out;
  }

  // `masteryBuckets`: New, then Due (review due or anything mid-learning),
  // then Solid or Shaky by retrievability against the retention line.
  function mastery(lib, now, retentionPercent, docIds) {
    const out = { solid: 0, shaky: 0, due: 0, newCards: 0 };
    const line = Math.max(0.5, Math.min(0.99, retentionPercent / 100));
    const curve = FSRS.params(0.9, (lib.settings && lib.settings.weights) || FSRS.defaultWeights);
    for (const card of lib.cards) {
      if (card.deleted_at != null || card.suspended) continue;
      const note = lib.notes.get(card.note_id);
      if (!note || note.deleted_at != null) continue;
      if (docIds && !docIds.has(note.notebook_id)) continue;
      const doc = lib.docs.get(note.notebook_id);
      if (!doc || doc.deleted_at != null) continue;
      switch (card.state) {
        case "new": out.newCards++; break;
        case "learning": case "relearning": out.due++; break;
        case "review": {
          if (ms(card.due) <= now) { out.due++; break; }
          const elapsed = card.last_review_at ? Math.max(0, (now - ms(card.last_review_at)) / DAY) : 0;
          const r = FSRS.retrievability(elapsed, card.stability || 0, curve);
          if (r >= line) out.solid++; else out.shaky++;
          break;
        }
        default: break;
      }
    }
    out.total = out.solid + out.shaky + out.due + out.newCards;
    return out;
  }

  // `dueForecast`: learning and review by local due day (overdue lands on
  // day 0), and day 0 takes the hero's own new cards (C-15).
  function forecast(lib, now, days, newPerDay) {
    const start = startOfDay(now);
    const counts = new Array(days).fill(0);
    const end = startOfDay(start + days * DAY + DAY / 2);
    for (const card of lib.cards) {
      if (card.state === "new") continue;
      const c = context(lib, card);
      if (!c || !fresh(c.note, now)) continue;
      const due = ms(card.due);
      if (due >= end) continue;
      const i = due < start ? 0 : daysBetween(start, due);
      if (i >= 0 && i < days) counts[i]++;
    }
    counts[0] += dueCounts(lib, now, newPerDay).newCards;
    return counts.map((count, i) => ({ day: startOfDay(start + i * DAY + DAY / 2), count }));
  }

  // The grade line under Mastery: reviewed this week, recalled over 30 days.
  function recentGrades(lib, now) {
    const week = startOfDay(now) - 6 * DAY;
    const month = now - 30 * DAY;
    let weekCount = 0, monthCount = 0, recalled = 0;
    const tally = [0, 0, 0, 0];
    for (const e of lib.events) {
      const at = ms(e.reviewed_at);
      if (at >= week) weekCount++;
      if (at >= month) {
        monthCount++;
        if (e.rating > 1) recalled++;
        if (e.rating >= 1 && e.rating <= 4) tally[e.rating - 1]++;
      }
    }
    return { weekCount, monthCount, recalledPct: monthCount ? Math.round(recalled / monthCount * 100) : null, tally };
  }

  // `StudyEstimate.minutes`: 7 s a learning or new card, 5 s a review.
  function minutes(dc) {
    return Math.max(1, Math.floor(((dc.learning + dc.newCards) * 7 + dc.review * 5) / 60));
  }

  // `HeroCopy.newPhrase`, the parts named.
  function newPhrase(dc, newPerDay, wide) {
    const atCap = dc.cappedNew > 0 && dc.cappedNew >= Math.max(0, newPerDay);
    if (!atCap && dc.rampNew === 0) return `${dc.newCards} new`;
    if (atCap && dc.rampNew === 0) return `${dc.newCards} new, the daily limit`;
    if (!atCap) return wide && dc.cappedNew > 0
      ? `${dc.newCards} new · ${dc.cappedNew} daily, ${dc.rampNew} for a deadline`
      : `${dc.newCards} new, ${dc.rampNew} for a deadline`;
    return wide ? `${dc.newCards} new · ${dc.cappedNew} at the daily limit, ${dc.rampNew} for a deadline`
                : `${dc.newCards} new, ${dc.rampNew} for a deadline`;
  }

  function subtitle(dc, newPerDay, wide) {
    const parts = [`about ${minutes(dc)} min`];
    if (dc.newCards > 0) parts.push(newPhrase(dc, newPerDay, wide));
    return parts.join(" · ");
  }

  // `formatInterval`.
  function formatInterval(seconds) {
    if (seconds < 60) return "<1 m";
    const m = Math.max(1, Math.round(seconds / 60));
    if (m < 60) return `${m} m`;
    const h = Math.max(1, Math.round(seconds / 3600));
    if (h < 48) return `${h} h`;
    const d = Math.round(seconds / 86400);
    if (d < 30) return `${d} d`;
    if (d < 365) return `${Math.floor(d / 30)} mo`;
    return `${Math.floor(d / 365)} y`;
  }

  // `gradeRowInterval` (C-23): a graduated outcome reads in whole days.
  function gradeRowInterval(due, now) {
    if (due !== startOfDay(due)) return formatInterval((due - now) / 1000);
    const days = daysBetween(now, due);
    if (days < 1) return formatInterval((due - now) / 1000);
    if (days < 30) return `${days} d`;
    if (days < 365) return `${Math.floor(days / 30)} mo`;
    return `${Math.floor(days / 365)} y`;
  }

  // `relativeDue` (I9): a value column states WHEN, never the word "due".
  function relativeDue(due, now) {
    const s = (due - now) / 1000;
    if (s <= 0) {
      const late = Math.floor(-s / 86400);
      return late < 1 ? "today" : `${late} d late`;
    }
    if (startOfDay(due) === startOfDay(now)) return "today";
    return "in " + formatInterval(s);
  }

  // `clampToExam`: nothing is scheduled past the exam day.
  function clampToExam(due, examMs, now) {
    if (examMs == null) return due;
    const day = startOfDay(examMs);
    if (!(day > now)) return due;
    return Math.min(due, day);
  }

  return { DAY, YOUNG_MS, TOMBSTONE_DAYS, startOfDay, daysBetween, rawExam, examDeadline, isPlainDoc,
           context, queueOrder, recallOrder, reviewAllowance, spreadRange, spreadSeed, chooseDay, spreadFor,
           countIntroducedToday, examQuotas, knobs, retentionFor, clampedRetention,
           buildQueue, cramQueue, dueCounts, docDueCount, docDue, mastery, forecast, recentGrades, minutes,
           newPhrase, subtitle, formatInterval, gradeRowInterval, relativeDue, clampToExam };
})();
