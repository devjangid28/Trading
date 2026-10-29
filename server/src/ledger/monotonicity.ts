/**
 * Monotonicity of the calibration ladder — the M1.5 fix.
 *
 * ## What was wrong
 *
 * `ledgerStats().isPredictive` was computed as
 *
 *   `topAvg > bottomAvg`
 *
 * over the populated score buckets: take the mean win rate of the bottom half
 * of the buckets and the mean win rate of the top half, and declare the score
 * predictive if the top half is bigger.
 *
 * That is not a test. It has no null hypothesis, no interval, and it does not
 * distinguish "slightly higher" from "meaningfully higher". With only two
 * populated buckets it is a coin flip: the two halves are the two buckets, and
 * whichever is larger wins the comparison. It also cannot say *how* strong the
 * relationship is.
 *
 * The bug it caused is written down in Part XIII as bug #24: `/api/ledger`
 * reported `isPredictive: true` and called the buckets *monotone* while the
 * four populated buckets read 63.41 / 36.14 / 62.30 / 44.19 — which is not
 * monotone at all.
 *
 * ## What this does instead
 *
 * Three statistics, all on the same buckets, all with a stated uncertainty:
 *
 * 1. **Spearman's rho** between the bucket's score midpoint and its realised
 *    win rate. Rank-based, so it does not assume a linear relationship, and
 *    it is the standard answer to "does the ordering carry information".
 * 2. **A bootstrap confidence interval** for that rho, so the verdict can be
 *    "the interval excludes zero" rather than "the point estimate is bigger".
 * 3. **A permutation p-value** — the win rates are shuffled across the
 *    buckets and the statistic recomputed, so the p-value answers "how often
 *    would a relationship this strong appear by chance?". This is the same
 *    test the Phase 1 hypothesis rules use.
 *
 * Plus the **isotonic slope**: a pool-adjacent-violators fit of the win rate
 * on the score, weighted by bucket size. The fit is non-decreasing *by
 * construction*, so it cannot answer "is it monotone?" — what it answers is
 * "how much monotone signal is there, and how close is the raw data to it?".
 * The count of adjacent decreases is the companion diagnostic.
 *
 * ## The verdict is three-state, not two
 *
 * `MONOTONE` / `NOT_MONOTONE` / `INSUFFICIENT_EVIDENCE`. A two-state verdict
 * forces a choice between "yes" and "no" when the honest answer is "not yet
 * distinguishable from noise", and that is the answer this file gives most
 * often on a real ledger.
 *
 * Pure: no I/O, no clock, no config read at call time. Every threshold arrives
 * as a parameter.
 */

/** One point of the calibration ladder. */
import type { LadderBucket, MonotonicityResult, MonotonicityVerdict } from '../../../shared/types';

export type { LadderBucket, MonotonicityResult, MonotonicityVerdict };

export interface MonotonicityOptions {
  /** Minimum samples in a bucket before it may speak. */
  minBucketN: number;
  /** Minimum populated buckets before a verdict may be made. */
  minBuckets: number;
  /** Bootstrap resamples. */
  resamples: number;
  /** Permutation resamples. */
  permutations: number;
  /** Significance level for the permutation test. */
  alpha: number;
  /** Seed, so a report printed twice prints the same numbers. */
  seed: number;
}

/**
 * Test whether the calibration ladder is monotone.
 *
 * `buckets` may arrive in any order; they are sorted by their lower bound
 * before anything is computed, so a caller cannot accidentally invert the
 * ladder by passing them backwards.
 */
export function testMonotonicity(
  buckets: readonly LadderBucket[],
  opts: MonotonicityOptions,
): MonotonicityResult {
  const sorted = [...buckets]
    .filter((b) => b.winRate !== null && b.n >= opts.minBucketN)
    .sort((a, b) => a.lo - b.lo);

  const n = sorted.reduce((a, b) => a + b.n, 0);

  if (sorted.length < opts.minBuckets) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      rho: null, rhoCi: null, permutationP: null,
      isotonicSlope: null, isotonicSlopeCi: null,
      violations: null, maxViolation: null, spread: null,
      buckets: sorted.length, n,
      reason:
        `only ${sorted.length} score bucket${sorted.length === 1 ? '' : 's'} cleared the ` +
        `${opts.minBucketN}-sample floor; ${opts.minBuckets} are needed to test monotonicity`,
    };
  }

  const xs = sorted.map((b) => (b.lo + b.hi) / 2);
  const ys = sorted.map((b) => b.winRate as number);
  const ws = sorted.map((b) => b.n);

  const rho = spearman(xs, ys);
  const violations = countViolations(ys);
  const maxViolation = maxDrop(ys);
  const slope = isotonicSlope(xs, ys, ws);
  const spread = ys[ys.length - 1] - ys[0];

  const boot = bootstrapStats(xs, ys, ws, opts);
  const perm = permutationP(xs, ys, opts);

  let verdict: MonotonicityVerdict;
  let reason: string;

  const ci = boot.rhoCi;
  if (ci !== null && ci[0] > 0) {
    verdict = 'MONOTONE';
    reason =
      `score and win rate are positively rank-associated across ${sorted.length} populated ` +
      `buckets (Spearman rho ${fmt(rho)}, 95% CI ${fmt(ci[0])} to ${fmt(ci[1])}, ` +
      `permutation p ${fmt(perm)}); the top bucket wins ${pct(spread)} more than the bottom, ` +
      `and ${violations} adjacent bucket pair${violations === 1 ? '' : 's'} decrease`;
  } else if (ci !== null && ci[1] < 0) {
    verdict = 'NOT_MONOTONE';
    reason =
      `score and win rate are NEGATIVELY rank-associated across ${sorted.length} populated ` +
      `buckets (Spearman rho ${fmt(rho)}, 95% CI ${fmt(ci[0])} to ${fmt(ci[1])}); ` +
      `a higher score is not paying`;
  } else {
    verdict = 'INSUFFICIENT_EVIDENCE';
    reason =
      `the association between score and win rate across ${sorted.length} populated buckets ` +
      `is not distinguishable from noise (Spearman rho ${fmt(rho)}, 95% CI ` +
      `${ci ? `${fmt(ci[0])} to ${fmt(ci[1])}` : 'not computable'}, permutation p ${fmt(perm)})`;
  }

  return {
    verdict,
    rho: round4(rho),
    rhoCi: boot.rhoCi,
    permutationP: perm === null ? null : round4(perm),
    isotonicSlope: slope === null ? null : round4(slope),
    isotonicSlopeCi: boot.slopeCi,
    violations,
    maxViolation: maxViolation === null ? null : round4(maxViolation),
    spread: round4(spread),
    buckets: sorted.length,
    n,
    reason,
  };
}

// ─── Statistics ───────────────────────────────────────────────────────────────

/**
 * Spearman's rho.
 *
 * Ranks with AVERAGE ranks for ties, then Pearson on the ranks. The x values
 * here are bucket midpoints, which are strictly increasing, so their ranks
 * are 1..k; the y values (win rates) can tie, so they need the tie handling.
 */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const rx = rank(xs);
  const ry = rank(ys);
  return pearson(rx, ry);
}

function rank(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    // Average rank for the tie group (1-based).
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k].i] = avg;
    i = j + 1;
  }
  return out;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** How many adjacent populated buckets decrease. */
function countViolations(ys: number[]): number {
  let v = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] < ys[i - 1]) v++;
  return v;
}

/** The largest single decrease between adjacent buckets. */
function maxDrop(ys: number[]): number | null {
  let worst: number | null = null;
  for (let i = 1; i < ys.length; i++) {
    const d = ys[i - 1] - ys[i];
    if (d > 0 && (worst === null || d > worst)) worst = d;
  }
  return worst;
}

/**
 * Slope of the isotonic (non-decreasing) fit, per unit of x.
 *
 * Pool-adjacent-violators: repeatedly merge adjacent blocks whose means
 * decrease, weighting each block by its sample count. The result is the
 * closest non-decreasing sequence in weighted least squares.
 *
 * The fit is non-decreasing BY CONSTRUCTION, so this number cannot be
 * negative and cannot be used to decide monotonicity. What it measures is the
 * SIZE of the monotone trend the data supports, which is a different and
 * useful quantity.
 */
export function isotonicSlope(xs: number[], ys: number[], ws: number[]): number | null {
  const fitted = pava(ys, ws);
  if (!fitted) return null;
  const first = fitted[0];
  const last = fitted[fitted.length - 1];
  const dx = xs[xs.length - 1] - xs[0];
  if (dx === 0) return null;
  return (last - first) / dx;
}

/**
 * Pool-adjacent-violators algorithm.
 *
 * Returns the fitted non-decreasing values, one per input point.
 */
export function pava(values: number[], weights: number[]): number[] | null {
  const n = values.length;
  if (n === 0 || n !== weights.length) return null;

  // Each block: { sum, weight, count, start }.
  const sum: number[] = [];
  const wsum: number[] = [];
  const count: number[] = [];
  const start: number[] = [];
  let blocks = 0;

  for (let i = 0; i < n; i++) {
    sum[blocks] = values[i];
    wsum[blocks] = weights[i] > 0 ? weights[i] : 1;
    count[blocks] = 1;
    start[blocks] = i;
    blocks++;
    while (blocks > 1 && sum[blocks - 2] / wsum[blocks - 2] > sum[blocks - 1] / wsum[blocks - 1]) {
      const w = wsum[blocks - 2] + wsum[blocks - 1];
      const s = sum[blocks - 2] + sum[blocks - 1];
      const c = count[blocks - 2] + count[blocks - 1];
      sum[blocks - 2] = s;
      wsum[blocks - 2] = w;
      count[blocks - 2] = c;
      blocks--;
    }
  }

  const out = new Array<number>(n);
  for (let b = 0; b < blocks; b++) {
    const mean = sum[b] / wsum[b];
    for (let k = 0; k < count[b]; k++) out[start[b] + k] = mean;
  }
  return out;
}

// ─── Resampling ───────────────────────────────────────────────────────────────

/** A seeded xorshift32, so a report printed twice prints the same numbers. */
function makeRandom(seed: number): () => number {
  let s = (seed >>> 0) || 0x5eed;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function bootstrapStats(
  xs: number[],
  ys: number[],
  ws: number[],
  opts: MonotonicityOptions,
): { rhoCi: [number, number] | null; slopeCi: [number, number] | null } {
  const k = xs.length;
  if (k < 2 || opts.resamples < 2) return { rhoCi: null, slopeCi: null };

  const rand = makeRandom(opts.seed);
  const rhos: number[] = [];
  const slopes: number[] = [];

  const by = new Array<number>(k);
  const bw = new Array<number>(k);

  for (let r = 0; r < opts.resamples; r++) {
    // Resample INSIDE each bucket, not across buckets.
    //
    // A bucket holds `n_i` outcomes, of which `p_i * n_i` were wins. Drawing
    // `n_i` outcomes with replacement from that bucket's own outcomes is
    // exactly the nonparametric bootstrap of its win rate. The alternative —
    // resampling the BUCKETS — throws away the sampling noise that actually
    // lives inside a bucket, and would report a spuriously tight interval for
    // a ladder whose buckets are each 30 trades wide.
    for (let i = 0; i < k; i++) {
      const n = Math.max(1, Math.round(ws[i]));
      const p = ys[i];
      let wins = 0;
      for (let j = 0; j < n; j++) if (rand() < p) wins++;
      by[i] = wins / n;
      bw[i] = n;
    }
    rhos.push(spearman(xs, by));
    const s = isotonicSlope(xs, by, bw);
    if (s !== null) slopes.push(s);
  }

  return {
    rhoCi: percentileCI(rhos, 0.95),
    slopeCi: slopes.length >= 2 ? percentileCI(slopes, 0.95) : null,
  };
}

function percentileCI(values: number[], confidence: number): [number, number] | null {
  if (values.length < 2) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const lo = Math.floor(((1 - confidence) / 2) * sorted.length);
  const hi = Math.ceil((1 - (1 - confidence) / 2) * sorted.length) - 1;
  return [
    round4(sorted[Math.max(0, lo)]),
    round4(sorted[Math.min(sorted.length - 1, hi)]),
  ];
}

/**
 * Permutation p-value for a POSITIVE rank association.
 *
 * The win rates are shuffled across the buckets and the statistic recomputed.
 * The p-value is the share of shuffles that produce a rho at least as large as
 * the observed one, with the standard `+1` correction so it is never exactly
 * zero.
 */
function permutationP(xs: number[], ys: number[], opts: MonotonicityOptions): number | null {
  const k = xs.length;
  if (k < 3 || opts.permutations < 1) return null;

  const observed = spearman(xs, ys);
  const rand = makeRandom(opts.seed ^ 0x9e3779b9);
  const shuffled = [...ys];
  let atLeast = 0;

  for (let p = 0; p < opts.permutations; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    const r = spearman(xs, shuffled);
    if (r >= observed) atLeast++;
  }

  return (atLeast + 1) / (opts.permutations + 1);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function round4(v: number): number {
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : String(v);
}

/** A fraction as a percentage, for prose. */
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}pp`;
}
