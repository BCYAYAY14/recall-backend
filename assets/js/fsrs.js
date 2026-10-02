// FSRS-6 with the published default parameters, restated from Recall's
// Sources/Core/FSRS.swift line for line (ruling W-B, 2026-09-23: one JS port
// of exactly the rules the web needs, held to the Swift suite's numbers).
//
// test/unit/web-fsrs.spec.ts runs THIS file against the values
// Tests/RecallTests/FSRSTests.swift pins from py-fsrs (`test_memo_state`,
// `test_review_card`), so a weight or a formula that drifts fails `npm test`
// instead of scheduling a card differently on the web than on the Mac.

const FSRS = (() => {

  const Rating = { again: 1, hard: 2, good: 3, easy: 4 };

  // FSRS-6's 21 defaults. w17..w19 are the same-day terms; w20 is the decay.
  const defaultWeights = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
    1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
    1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
  ];

  const stabilityMin = 0.001;
  const maximumInterval = 36500;
  // SPEC learning step: Again keeps the card in the session for +10 min.
  const learningStepMs = 600 * 1000;
  const DAY_MS = 86400 * 1000;

  function params(requestRetention = 0.90, weights = defaultWeights) {
    const decay = -weights[20];
    return { weights, requestRetention, decay, factor: Math.pow(0.9, 1 / decay) - 1 };
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Weights fitted to the owner's reviews (the app's `FSRSFit`, SPEC's
  // 2026-09-29 fitted weights amendment): settings key `fsrs_weights`, 21
  // numbers comma separated, empty for the defaults. Anything else reads as
  // the defaults, as `FSRSFit.decode` does.
  const bounds = [[0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100],
    [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5],
    [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2],
    [0, 0.8], [0.1, 0.8]];
  function decodeWeights(stored) {
    if (!stored) return defaultWeights;
    const parts = String(stored).split(",").map((x) => Number(x.trim()));
    if (parts.length !== defaultWeights.length) return defaultWeights;
    const ok = parts.every((w, i) => Number.isFinite(w) && w >= bounds[i][0] && w <= bounds[i][1]);
    return ok ? parts : defaultWeights;
  }

  function retrievability(elapsedDays, stability, p = params()) {
    if (!(stability > 0.0001)) return 0;
    const t = Math.max(0, elapsedDays);
    return Math.pow(1 + p.factor * t / stability, p.decay);
  }

  function initialStability(g, p) {
    return Math.max(p.weights[g - 1], stabilityMin);
  }

  // `clamp: false` is the mean reversion's target: D0(Easy) sits below 1 with
  // the FSRS-6 defaults, and clamping it moves every difficulty (landmine 219).
  function initialDifficulty(g, p, doClamp = true) {
    const d = p.weights[4] - Math.exp(p.weights[5] * (g - 1)) + 1;
    return doClamp ? clamp(d, 1, 10) : d;
  }

  function nextDifficulty(d, g, p) {
    const delta = -p.weights[6] * (g - 3);
    const linearDamped = d + delta * (10 - d) / 9;
    const target = initialDifficulty(Rating.easy, p, false);
    const meanReverted = p.weights[7] * target + (1 - p.weights[7]) * linearDamped;
    return clamp(meanReverted, 1, 10);
  }

  function nextStabilitySuccess(s, d, r, g, p) {
    const hardPenalty = g === Rating.hard ? p.weights[15] : 1;
    const easyBonus = g === Rating.easy ? p.weights[16] : 1;
    const growth = Math.exp(p.weights[8]) * (11 - d) * Math.pow(s, -p.weights[9])
      * (Math.exp((1 - r) * p.weights[10]) - 1) * hardPenalty * easyBonus;
    return Math.max(s * (1 + growth), stabilityMin);
  }

  function nextStabilityLapse(s, d, r, p) {
    const longTerm = p.weights[11] * Math.pow(d, -p.weights[12])
      * (Math.pow(s + 1, p.weights[13]) - 1) * Math.exp((1 - r) * p.weights[14]);
    const shortTermCap = s / Math.exp(p.weights[17] * p.weights[18]);
    return Math.max(Math.min(longTerm, shortTermCap), stabilityMin);
  }

  function shortTermStability(s, g, p) {
    let increase = Math.exp(p.weights[17] * (g - 3 + p.weights[18])) * Math.pow(s, -p.weights[19]);
    // Only Good and Easy are floored at "no loss"; a same-day Hard may lower
    // stability, as FSRS-6 (py-fsrs, ts-fsrs, fsrs-rs) has it (review
    // 2026-09-26, core-study-3).
    if (g >= Rating.good) increase = Math.max(increase, 1);
    return Math.max(s * increase, stabilityMin);
  }

  // Python's round: half to even, as `.toNearestOrEven` is.
  function roundHalfEven(x) {
    const f = Math.floor(x);
    const diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  function interval(stability, p) {
    const raw = (stability / p.factor) * (Math.pow(p.requestRetention, 1 / p.decay) - 1);
    if (!Number.isFinite(raw)) return maximumInterval;
    return Math.min(Math.max(1, roundHalfEven(raw)), maximumInterval);
  }

  // C-15: a graduated outcome is due at the START of its day in the local
  // calendar, never at the clock time it was graded.
  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function graduatedDue(nowMs, days) {
    return startOfDay(nowMs + days * DAY_MS);
  }

  // One grade, pure. `current` is { stability, difficulty } or null; the
  // state is "new" | "learning" | "review" | "relearning". Times in ms.
  // `spread` (optional) maps the graduated interval to the day it lands on
  // (the app's `ReviewSpread`: fuzz and load balancing).
  function grade(current, currentState, rating, elapsedDays, nowMs, p, spread) {
    const landingDays = s => {
      const ivl = interval(s, p);
      return spread ? Math.min(Math.max(1, spread(ivl)), maximumInterval) : ivl;
    };
    if (!current || currentState === "new" || !(current.stability > 0)) {
      const s0 = initialStability(rating, p);
      const d0 = initialDifficulty(rating, p);
      if (rating === Rating.again) {
        return { state: { stability: s0, difficulty: d0 }, due: nowMs + learningStepMs, newState: "learning" };
      }
      const s = rating === Rating.hard ? Math.min(s0, initialStability(Rating.good, p)) : s0;
      return { state: { stability: s, difficulty: d0 }, due: graduatedDue(nowMs, landingDays(s)), newState: "review" };
    }

    const days = Math.floor(Math.max(0, elapsedDays));
    let s;
    if (days < 1) {
      s = shortTermStability(current.stability, rating, p);
    } else {
      const r = retrievability(days, current.stability, p);
      s = rating !== Rating.again
        ? nextStabilitySuccess(current.stability, current.difficulty, r, rating, p)
        : nextStabilityLapse(current.stability, current.difficulty, r, p);
    }
    const d = nextDifficulty(current.difficulty, rating, p);
    const state = { stability: s, difficulty: d };
    const graduate = { state, due: graduatedDue(nowMs, landingDays(s)), newState: "review" };

    if (currentState === "learning" || currentState === "relearning") {
      if (rating !== Rating.again) return graduate;
      return { state, due: nowMs + learningStepMs, newState: currentState };
    }
    if (rating !== Rating.again) return graduate;
    return { state, due: nowMs + learningStepMs, newState: "relearning" };
  }

  return { Rating, defaultWeights, decodeWeights, stabilityMin, maximumInterval, params, retrievability,
           initialStability, initialDifficulty, nextDifficulty, nextStabilitySuccess,
           nextStabilityLapse, shortTermStability, interval, grade, startOfDay,
           graduatedDue, roundHalfEven, DAY_MS };
})();
