/**
 * The model, the splits, and the evaluation.
 *
 * ## The model: regularised logistic regression on P(win)
 *
 * Logistic regression, L2-regularised, fitted by gradient descent with a fixed
 * number of iterations and a seeded start. It is the first model deliberately:
 *
 *   - it is the only model whose output is a calibrated PROBABILITY, which is
 *     the thing the whole system is judged on;
 *   - it has a coefficient per feature, so "which feature carried this?" has an
 *     answer, and the answer is checkable;
 *   - it cannot memorise 625 rows the way a tree ensemble can, which matters
 *     when the honest answer is "there is no edge here".
 *
 * Gradient-boosted trees are NOT fitted, because the brief says they come
 * second and only if they beat this one out-of-sample. They are not built
 * until there is a baseline to beat and a dataset with enough rows to fit one.
 *
 * ## The splits: purged, embargoed, and grouped
 *
 * Three separate jobs, and conflating them is how a walk-forward test stops
 * being one:
 *
 * 1. **Purging.** A signal's label is only known at its RESOLUTION time, so a
 *    training row whose resolution falls inside the test block is training on
 *    the answer. Those rows are dropped.
 * 2. **Embargo.** After the test block, a gap is left so that a training row
 *    created just after the test block cannot be correlated with it through a
 *    price series that has not decayed yet.
 * 3. **Grouping.** Signals on the same symbol are correlated. The splits are
 *    made on SYMBOL TIME BINS, so every signal on a symbol lands in the same
 *    fold, and a symbol cannot be in the training set and the test set at once.
 *    This is what makes the confidence intervals mean something.
 *
 * ## The evaluation
 *
 * Every metric states its population, because a report that mixes a
 * decided-only win rate with an all-resolved expectancy is arithmetically fine
 * and analytically meaningless.
 */

import { makeRandom } from './geometry.js';
import type { LabelledRow } from './dataset.js';

// ─── The model ────────────────────────────────────────────────────────────────

export interface LogisticModel {
  /** One coefficient per feature, in `FEATURE_NAMES` order. */
  weights: number[];
  /** The intercept. */
  bias: number;
  /**
   * The standardisation the fit used.
   *
   * It travels with the model because the features are on wildly different
   * scales — a score in 0..100, a basis in percent, a CVD in millions. A model
   * that cannot reproduce its own standardisation cannot be applied to new
   * rows, and a model that has to be re-standardised by hand at the call site
   * is a model that will be applied wrongly.
   */
  scale: { mean: number[]; sd: number[] };
  /** The L2 penalty used. */
  lambda: number;
  /** The iterations actually run. */
  iterations: number;
  /** The final training loss. */
  loss: number;
}

export interface FitOptions {
  /** L2 penalty. Larger = more shrinkage. */
  lambda: number;
  /** Gradient-descent iterations. */
  iterations: number;
  /** Learning rate. */
  learningRate: number;
  /** Seed for the (zero) initialisation and any shuffling. */
  seed: number;
}

export const DEFAULT_FIT: FitOptions = {
  lambda: 1,
  iterations: 4000,
  learningRate: 0.08,
  seed: 20261020,
};

/**
 * Fit a logistic regression by L2-regularised gradient descent.
 *
 * The features are STANDARDISED using the TRAINING fold's mean and standard
 * deviation. That matters: the features are on wildly different scales (a
 * score in 0..100, a basis in percent, a CVD in millions) and an unstandardised
 * fit would be dominated by whichever happened to be largest.
 */
export function fitLogistic(
  rows: { x: number[]; y: number }[],
  opts: FitOptions = DEFAULT_FIT,
): LogisticModel {
  const n = rows.length;
  const p = rows[0]?.x.length ?? 0;
  if (n === 0 || p === 0) {
    return {
      weights: new Array<number>(p).fill(0), bias: 0,
      scale: { mean: new Array<number>(p).fill(0), sd: new Array<number>(p).fill(1) },
      lambda: opts.lambda, iterations: 0, loss: 0,
    };
  }

  // Standardise on the training fold.
  const means = new Array<number>(p).fill(0);
  const sds = new Array<number>(p).fill(0);
  for (const r of rows) for (let j = 0; j < p; j++) means[j] += r.x[j];
  for (let j = 0; j < p; j++) means[j] /= n;
  for (const r of rows) for (let j = 0; j < p; j++) sds[j] += (r.x[j] - means[j]) ** 2;
  for (let j = 0; j < p; j++) sds[j] = Math.sqrt(sds[j] / n) || 1;

  const z = rows.map((r) => r.x.map((v, j) => (v - means[j]) / sds[j]));
  const ys = rows.map((r) => r.y);

  const w = new Array<number>(p).fill(0);
  let bias = Math.log(ys.reduce((a, b) => a + b, 0) / n) || 0;

  const rand = makeRandom(opts.seed);
  const order = Array.from({ length: n }, (_, i) => i);
  let loss = 0;

  for (let it = 0; it < opts.iterations; it++) {
    // Shuffle, so the descent is not order-dependent.
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }

    const gw = new Array<number>(p).fill(0);
    let gb = 0;
    loss = 0;
    for (const idx of order) {
      const xi = z[idx];
      const yi = ys[idx];
      let z0 = bias;
      for (let j = 0; j < p; j++) z0 += w[j] * xi[j];
      const pr = 1 / (1 + Math.exp(-z0));
      const err = pr - yi;
      for (let j = 0; j < p; j++) gw[j] += err * xi[j];
      gb += err;
      loss -= yi * Math.log(Math.max(1e-12, pr)) + (1 - yi) * Math.log(Math.max(1e-12, 1 - pr));
    }
    for (let j = 0; j < p; j++) {
      w[j] -= opts.learningRate * (gw[j] / n + opts.lambda * w[j]);
    }
    bias -= opts.learningRate * (gb / n);
    loss = loss / n + (opts.lambda / 2) * w.reduce((a, b) => a + b * b, 0);
  }

  // The model stores the STANDARDISED weights, and the standardisation travels
  // with it, so `predict` reproduces the fit exactly.
  return {
    weights: w,
    bias,
    scale: { mean: means, sd: sds },
    lambda: opts.lambda,
    iterations: opts.iterations,
    loss,
  };
}

/**
 * The probability the model assigns to a row.
 *
 * The model is fitted on standardised features, so the standardisation is
 * applied from the model itself — never from a caller-supplied array that
 * could disagree with the fit.
 */
export function predict(model: LogisticModel, x: number[]): number {
  let z0 = model.bias;
  for (let j = 0; j < model.weights.length; j++) {
    const v = (x[j] - model.scale.mean[j]) / (model.scale.sd[j] || 1);
    z0 += model.weights[j] * v;
  }
  return 1 / (1 + Math.exp(-z0));
}

// ─── The splits ───────────────────────────────────────────────────────────────

export interface Fold {
  /** 1-based fold number. */
  index: number;
  /** The test block's start and end, in trade time. */
  testFrom: number;
  testTo: number;
  /** The training rows. */
  train: LabelledRow[];
  /** The test rows. */
  test: LabelledRow[];
  /** How many training rows the purge removed. */
  purged: number;
  /** How many training rows the embargo removed. */
  embargoed: number;
}

export interface SplitOptions {
  /** How many folds. */
  folds: number;
  /** Purging: a training row whose resolution falls inside the test block. */
  purge: boolean;
  /** Embargo length, in ms, after the test block. */
  embargoMs: number;
  /**
   * Group signals by symbol so a symbol never spans two folds.
   *
   * The folds are cut on SYMBOL TIME BINS: every signal of a symbol is
   * assigned to the bin its creation time falls in, and a bin is a test block.
   * A symbol whose signals straddle a bin boundary is assigned to the bin of
   * its EARLIEST signal, so it still never spans two folds.
   */
  groupBySymbol: boolean;
}

export const DEFAULT_SPLIT: SplitOptions = {
  folds: 4,
  purge: true,
  embargoMs: 6 * 3600_000,
  groupBySymbol: true,
};

/**
 * A walk-forward split: an expanding training window, a purged and embargoed
 * boundary, and symbol-grouped test blocks.
 */
export function walkForwardFolds(rows: LabelledRow[], opts: SplitOptions = DEFAULT_SPLIT): Fold[] {
  if (!rows.length) return [];

  // Group by symbol so a symbol cannot straddle a fold.
  const bySymbol = new Map<string, LabelledRow[]>();
  for (const r of rows) {
    const arr = bySymbol.get(r.symbol);
    if (arr) arr.push(r);
    else bySymbol.set(r.symbol, [r]);
  }
  // Each symbol is placed by its EARLIEST signal.
  const symbolStart = new Map<string, number>();
  for (const [sym, list] of bySymbol) {
    symbolStart.set(sym, Math.min(...list.map((r) => r.createdAt)));
  }

  const times = [...symbolStart.values()].sort((a, b) => a - b);
  const t1 = times[times.length - 1];

  /**
   * The bin boundaries are QUANTILES of the symbol start times, not equal
   * slices of the span.
   *
   * The signals are not spread evenly over the eight days — they arrive in
   * bursts — so equal time slices put 52 test rows in the first fold and 1 in
   * the last, which is not a walk-forward test, it is one fold and two
   * stubs. Quantile bins give each fold roughly the same number of symbols,
   * while keeping the folds in time order.
   *
   * There are `folds + 1` bins: the FIRST is the initial training window and
   * is never a test block. Without it the first fold has nothing to train on
   * — an expanding window that starts empty is not a walk-forward test, it is
   * a coin flip with a model attached.
   */
  const boundaries: number[] = [];
  for (let f = 1; f <= opts.folds; f++) {
    const idx = Math.min(times.length - 1, Math.floor((times.length * f) / (opts.folds + 1)));
    boundaries.push(times[idx]);
  }
  const binOf = (start: number): number => {
    let b = 0;
    while (b < boundaries.length && start >= boundaries[b]) b++;
    return b;
  };

  // A symbol with signals in several bins goes to the EARLIEST bin, so it
  // still never spans two folds.
  const symbolBin = new Map<string, number>();
  for (const [sym, list] of bySymbol) {
    let minBin = opts.folds;
    for (const r of list) {
      const b = binOf(r.createdAt);
      if (b < minBin) minBin = b;
    }
    symbolBin.set(sym, minBin);
  }

  const folds: Fold[] = [];
  let previousTestTo: number | null = null;
  for (let f = 0; f < opts.folds; f++) {
    const testFrom = boundaries[f];
    const testTo = f === opts.folds - 1 ? t1 + 1 : boundaries[f + 1];

    const train: LabelledRow[] = [];
    const test: LabelledRow[] = [];
    let purged = 0;
    let embargoed = 0;
    let future = 0;

    for (const r of rows) {
      const bin = symbolBin.get(r.symbol) ?? 0;
      if (bin === f + 1) {
        test.push(r);
        continue;
      }
      // Expanding window: only what was known BEFORE the test block trains it.
      if (r.createdAt >= testFrom) { future++; continue; }
      // Purge: a training row whose label was not yet OBSERVABLE when the test
      // block began is training on the answer. The condition is
      // `resolvedAt >= testFrom`, not "resolves inside the test block": a
      // signal's label only becomes known 24 hours after it is taken, so the
      // second form would delete the entire initial training window.
      if (opts.purge && r.resolvedAt >= testFrom) { purged++; continue; }
      // Embargo: a gap after the PREVIOUS fold's test block, so the training
      // set of this fold cannot contain signals that were still being resolved
      // while the previous test block was being scored.
      if (opts.embargoMs > 0 && previousTestTo !== null
        && r.createdAt >= previousTestTo && r.createdAt < previousTestTo + opts.embargoMs) {
        embargoed++;
        continue;
      }
      train.push(r);
    }

    if (!train.length || !test.length) continue;
    folds.push({ index: folds.length + 1, testFrom, testTo, train, test, purged, embargoed });
    previousTestTo = testTo;
  }
  return folds;
}

// ─── The metrics ──────────────────────────────────────────────────────────────

export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  /** The mean predicted probability in the bucket. */
  meanPredicted: number | null;
  /** The realised win rate in the bucket. */
  observed: number | null;
}

/** The Brier score over (probability, outcome) pairs. */
export function brier(pairs: { p: number; y: number }[]): number | null {
  if (!pairs.length) return null;
  return pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / pairs.length;
}

/** The log loss. The natural log, so it is in nats per observation. */
export function logLoss(pairs: { p: number; y: number }[]): number | null {
  if (!pairs.length) return null;
  let sum = 0;
  for (const x of pairs) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, x.p));
    sum += -(x.y * Math.log(p) + (1 - x.y) * Math.log(1 - p));
  }
  return sum / pairs.length;
}

/** The reliability diagram: predicted probability against realised frequency. */
export function reliability(pairs: { p: number; y: number }[], buckets = 10): ReliabilityBucket[] {
  const out: ReliabilityBucket[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = i / buckets;
    const hi = (i + 1) / buckets;
    const inBucket = pairs.filter((x) => (i === buckets - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi));
    out.push({
      lo: round4(lo), hi: round4(hi), n: inBucket.length,
      meanPredicted: inBucket.length ? round4(inBucket.reduce((a, x) => a + x.p, 0) / inBucket.length) : null,
      observed: inBucket.length ? round4(inBucket.reduce((a, x) => a + x.y, 0) / inBucket.length) : null,
    });
  }
  return out;
}

/** The decision threshold and the coverage it produces. */
export interface Decision {
  /** Take the trade when the probability is at or above this. */
  threshold: number;
  /** How many rows the model spoke on, as a percentage of the decided rows. */
  coveragePct: number;
  /** Of the rows it spoke on, how many were wins. */
  winRatePct: number | null;
  /** Of the rows it skipped, how many were wins. */
  skippedWinRatePct: number | null;
  /** The mean net R of the rows it took. */
  netR: number | null;
  /** How many rows it took. */
  taken: number;
}

/**
 * Apply a probability threshold and report what it bought.
 *
 * COVERAGE AND WIN RATE ARE REPORTED TOGETHER, always. A win rate without a
 * coverage says nothing: "100% win rate on 3 trades" and "100% win rate on
 * 300" are the same sentence and completely different facts.
 */
export function applyThreshold(
  rows: LabelledRow[],
  probabilities: number[],
  threshold: number,
): Decision {
  const decided = rows.map((r, i) => ({ r, p: probabilities[i] })).filter((x) => x.r.y !== null);
  const taken = decided.filter((x) => x.p >= threshold);
  const skipped = decided.filter((x) => x.p < threshold);
  const winOf = (xs: typeof decided) =>
    xs.length ? (xs.filter((x) => x.r.y === 1).length / xs.length) * 100 : null;
  const netOf = (xs: typeof decided) => {
    const ns = xs.map((x) => x.r.netR).filter((v): v is number => v !== null);
    return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
  };
  return {
    threshold,
    coveragePct: decided.length ? (taken.length / decided.length) * 100 : 0,
    winRatePct: winOf(taken),
    skippedWinRatePct: winOf(skipped),
    netR: netOf(taken),
    taken: taken.length,
  };
}

function round4(v: number): number {
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}
