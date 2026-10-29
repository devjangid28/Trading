/**
 * Statistics for the closed-loop evaluation.
 *
 * Two things here are not obvious and both matter:
 *
 * 1. **The signals are NOT independent.** The ledger holds 625 signals across
 *    106 symbols, and several signals on the same symbol overlap in time. A
 *    confidence interval that treats 625 rows as 625 independent draws is
 *    too narrow, and the direction of the error is always the flattering one.
 *    So every interval here is a CLUSTER bootstrap: symbols are resampled with
 *    replacement and their signals travel with them.
 *
 * 2. **The effective sample size is reported, not assumed.** The design effect
 *    from the intra-cluster correlation says how many independent observations
 *    the 625 rows are really worth. A reader who is told "n=625" and nothing
 *    else will read a number the data cannot support.
 *
 * Pure. Seeded. No clock.
 */

import { makeRandom } from './geometry.js';

export interface ClusteredValue {
  /** The cluster this value belongs to, e.g. the symbol. */
  cluster: string;
  value: number;
}

export interface BootstrapResult {
  /** The point estimate. */
  mean: number;
  /** The percentile interval. */
  ci: [number, number] | null;
  /** How many values. */
  n: number;
  /** How many clusters. */
  clusters: number;
  /** The intra-cluster correlation. Null when it could not be estimated. */
  icc: number | null;
  /**
   * The effective sample size: how many independent observations the data is
   * really worth, after the clustering.
   */
  nEff: number;
  /** The design effect, `n / nEff`. */
  designEffect: number;
}

/**
 * Cluster bootstrap of a mean, with the effective sample size reported.
 *
 * The bootstrap resamples CLUSTERS with replacement, so every value in a
 * resampled cluster comes with it. The interval therefore reflects the
 * correlation between signals on the same symbol.
 */
export function clusterBootstrapMean(
  rows: ClusteredValue[],
  resamples: number,
  seed: number,
  confidence = 0.95,
): BootstrapResult {
  const n = rows.length;
  if (n === 0) {
    return { mean: 0, ci: null, n: 0, clusters: 0, icc: null, nEff: 0, designEffect: 1 };
  }

  const byCluster = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byCluster.get(r.cluster);
    if (arr) arr.push(r.value);
    else byCluster.set(r.cluster, [r.value]);
  }
  const groups = [...byCluster.values()];
  const k = groups.length;
  const point = rows.reduce((a, b) => a + b.value, 0) / n;

  const icc = intraClusterCorrelation(groups);
  // Kish's design effect for a mean with an average cluster size of m and an
  // intra-cluster correlation of rho:  DE = 1 + (m - 1) * rho.
  const meanCluster = n / k;
  const designEffect = icc === null ? 1 : Math.max(1, 1 + (meanCluster - 1) * icc);
  const nEff = designEffect > 0 ? n / designEffect : n;

  if (k < 2 || resamples < 2) {
    return { mean: point, ci: null, n, clusters: k, icc, nEff, designEffect };
  }

  const rand = makeRandom(seed);
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    let count = 0;
    for (let g = 0; g < k; g++) {
      const arr = groups[Math.floor(rand() * k)];
      for (const v of arr) { sum += v; count++; }
    }
    stats.push(count ? sum / count : 0);
  }
  stats.sort((a, b) => a - b);
  const lo = Math.floor(((1 - confidence) / 2) * stats.length);
  const hi = Math.ceil((1 - (1 - confidence) / 2) * stats.length) - 1;

  return {
    mean: point,
    ci: [round4(stats[Math.max(0, lo)]), round4(stats[Math.min(stats.length - 1, hi)])],
    n,
    clusters: k,
    icc: icc === null ? null : round4(icc),
    nEff: Math.round(nEff * 100) / 100,
    designEffect: round4(designEffect),
  };
}

/**
 * The intra-cluster correlation of a one-way ANOVA.
 *
 * `ICC = (MSB - MSW) / (MSB + (m - 1) * MSW)`. Null when there is only one
 * cluster, or when every value is identical, or when the estimate falls
 * outside [0, 1] — in which case it is reported as unknown rather than
 * clamped, because a clamped ICC is a made-up number.
 */
export function intraClusterCorrelation(groups: number[][]): number | null {
  const k = groups.length;
  if (k < 2) return null;
  const n = groups.reduce((a, g) => a + g.length, 0);
  if (n <= k) return null;

  const grand = groups.reduce((a, g) => a + g.reduce((x, y) => x + y, 0), 0) / n;
  let ssb = 0;
  let ssw = 0;
  for (const g of groups) {
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    ssb += g.length * (m - grand) ** 2;
    for (const v of g) ssw += (v - m) ** 2;
  }
  const dfb = k - 1;
  const dfw = n - k;
  if (dfw <= 0) return null;
  const msb = ssb / dfb;
  const msw = ssw / dfw;
  const m0 = (n - (1 / (k * dfw)) * (n * n - sumSquares(groups))) / dfw;
  if (!(m0 > 0)) return null;
  const icc = (msb - msw) / (msb + (m0 - 1) * msw);
  if (!Number.isFinite(icc) || icc < 0 || icc > 1) return null;
  return icc;
}

function sumSquares(groups: number[][]): number {
  return groups.reduce((a, g) => a + g.reduce((x, y) => x + y * y, 0), 0);
}

/**
 * A within-cluster permutation test: is the engine's trade better than a
 * random entry with the same geometry?
 *
 * Under the null, the engine's R for a signal is exchangeable with any of the
 * random entries for the SAME signal. So the permutation reassigns, for each
 * signal, which of its values is "the engine's", and asks how often the
 * observed difference in means shows up by chance.
 *
 * The permutation is within the cluster, so the correlation between signals on
 * the same symbol is preserved by construction.
 */
export function permutationTestEngineVsRandom(
  engine: number[],
  randomPerSignal: number[][],
  resamples: number,
  seed: number,
): { observed: number; pValue: number; n: number } {
  const k = Math.min(engine.length, randomPerSignal.length);
  if (k === 0) return { observed: 0, pValue: 1, n: 0 };

  const pools: number[][] = [];
  for (let i = 0; i < k; i++) {
    const pool = [engine[i], ...randomPerSignal[i]];
    if (pool.length < 2) continue;
    pools.push(pool);
  }
  if (pools.length < 2) return { observed: 0, pValue: 1, n: pools.length };

  const observed = meanOfEngine(engine.slice(0, pools.length), randomPerSignal.slice(0, pools.length));
  const rand = makeRandom(seed);
  let atLeast = 0;
  for (let r = 0; r < resamples; r++) {
    const shuffledEngine: number[] = [];
    const shuffledRandom: number[][] = [];
    for (const pool of pools) {
      const idx = Math.floor(rand() * pool.length);
      shuffledEngine.push(pool[idx]);
      shuffledRandom.push(pool.filter((_, i) => i !== idx));
    }
    if (meanOfEngine(shuffledEngine, shuffledRandom) >= observed) atLeast++;
  }

  return {
    observed: round4(observed),
    pValue: round4((atLeast + 1) / (resamples + 1)),
    n: pools.length,
  };
}

/** The difference in means: the engine's mean minus the random entries' mean. */
function meanOfEngine(engine: number[], randomPerSignal: number[][]): number {
  if (!engine.length) return 0;
  const e = engine.reduce((a, b) => a + b, 0) / engine.length;
  const all: number[] = [];
  for (const arr of randomPerSignal) all.push(...arr);
  if (!all.length) return e;
  const r = all.reduce((a, b) => a + b, 0) / all.length;
  return e - r;
}

function round4(v: number): number {
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}
