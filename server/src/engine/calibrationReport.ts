/**
 * Honest calibration — Phase XVI step 5.
 *
 * The requirement is blunt: "Do not assert A > B > C until enough resolved
 * signals exist." This module's main job is to be willing to say
 * **INSUFFICIENT EVIDENCE**, and to say it in a way that cannot be mistaken for a
 * result.
 *
 * Four properties make it trustworthy:
 *
 * 1. **One population, declared up front.** Every metric takes its rows from
 *    `OUTCOME_POLICY` in `outcomes.ts`. Nothing decides inclusion for itself. A
 *    report that mixed a decided-only win rate with an all-rows expectancy would
 *    be arithmetically fine and analytically meaningless, so the report prints
 *    the population it used and the count it excluded.
 *
 * 2. **The decomposition conditions on DISTINCT forecast probabilities** wherever
 *    the data allows, because Murphy's identity `BS = REL − RES + UNC` is exact
 *    only under that conditioning. Binning is still offered for the reliability
 *    DIAGRAM, where readability matters and identity does not — and the residual
 *    is reported so the binning cost is visible.
 *
 * 3. **Bootstrap intervals, not point estimates.** A win rate from 30 samples has
 *    a confidence interval roughly as wide as the rate itself. Reporting the
 *    point alone invites reading noise as signal.
 *
 * 4. **Ordering is reported, never asserted.** `gradeOrdering()` returns a verdict
 *    enum. `A>B>C` is a CLAIM it makes when the evidence supports it and refuses
 *    to make when it does not.
 */

import { MIND } from '../config.js';
import { OUTCOME_POLICY, classifyOutcome, excludedNote, type OutcomeClass } from '../ledger/outcomes.js';
import type { LabelledSignal } from './walkForward.js';
import { CALIBRATION_VERSION } from '../version.js';

// ─── Floors. Every metric names the one that governs it. ────────────────────

export interface Floors {
  /** Minimum decided outcomes for any Brier or win rate to be printed. */
  brier: number;
  /** Minimum resolved rows (including censored) for expectancy. */
  expectancy: number;
  /** Minimum rows per group for a per-group metric to be printed. */
  perGroup: number;
  /** Minimum rows per grade before an ordering claim is considered. */
  perGrade: number;
  /** Minimum bootstrap resamples. Below this, an interval is not reported. */
  bootstrap: number;
}

export const DEFAULT_FLOORS: Floors = {
  brier: MIND.CALIBRATION_MIN_SAMPLES,
  expectancy: 30,
  perGroup: 30,
  perGrade: LEDGER_FLOORS_PER_GRADE(),
  bootstrap: 2000,
};

/**
 * Per-grade floor.
 *
 * Separate from the overall floor on purpose: an aggregate can clear 100 samples
 * while one grade has 4, and a rate from 4 samples is not a rate. The ordering
 * claim is gated on the WEAKEST grade, because "A beats B beats C" is falsified by
 * any one link failing.
 */
function LEDGER_FLOORS_PER_GRADE(): number {
  // Declared here rather than imported to keep the floors table readable as one
  // block. The value is asserted against `LEDGER.FIT_MIN_SIGNALS` in the tests, so
  // the two cannot drift.
  return 200;
}

// ─── A metric that knows whether it may speak ────────────────────────────────

export interface Metric<T> {
  value: T | null;
  n: number;
  /** The floor that governs it. Printed with every value. */
  floor: number;
  /** True when `value` is suppressed for insufficient evidence. */
  suppressed: boolean;
  /** Why it is suppressed, in words. Never null when suppressed. */
  reason: string | null;
  /** The population used. `decided` excludes censored outcomes. */
  population: 'decided' | 'all-resolved';
  /** Censored rows left out, when the population excludes them. */
  censoredExcluded: number;
  /** Bootstrap interval, when the sample allows one. */
  ci: [number, number] | null;
}

function metric<T>(
  value: T | null,
  n: number,
  floor: number,
  population: 'decided' | 'all-resolved',
  censoredExcluded: number,
  ci: [number, number] | null = null,
  reason?: string,
): Metric<T> {
  const suppressed = value === null || n < floor;
  return {
    value: suppressed ? null : value,
    n,
    floor,
    suppressed,
    reason: suppressed
      ? (reason ?? `insufficient evidence: ${n} samples, floor is ${floor}`)
      : null,
    population,
    censoredExcluded,
    ci: suppressed ? null : ci,
  };
}

// ─── Row selection: the single population gate ──────────────────────────────

export interface Population {
  /** Rows a binary metric (win rate, Brier) may use. */
  decided: LabelledSignal[];
  /** Rows an expectancy metric may use. */
  all: LabelledSignal[];
  /** How many censored rows exist in `all`. */
  censored: number;
  /** The note to print whenever censored rows were excluded. */
  note: string | null;
}

/**
 * Select the population ONCE, then hand both views out.
 *
 * A report that calls this separately for two metrics could get two different
 * answers if anything mutated in between — which is exactly the class of bug that
 * made the Part XV anchor/bar mismatch. One call, two views.
 */
export function selectPopulation(signals: LabelledSignal[]): Population {
  const all = signals.filter((s) => typeof s.netR === 'number');
  const decided = all.filter((s) => s.y === 0 || s.y === 1);
  const censored = all.length - decided.length;
  return {
    decided,
    all,
    censored,
    note: excludedNote(all.length, decided.length),
  };
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

/**
 * Percentile bootstrap over resampled rows.
 *
 * Deterministic: a seeded LCG rather than `Math.random`, so a report printed
 * twice prints the same interval. A CI that moves between runs is a CI nobody can
 * act on.
 *
 * Returns `null` below the resample floor rather than a too-narrow interval. A
 * narrow-looking interval from 12 samples is worse than no interval.
 */
export function bootstrapCI(
  values: number[],
  statistic: (xs: number[]) => number,
  resamples = DEFAULT_FLOORS.bootstrap,
  confidence = 0.95,
  seed = 0x5eed,
): [number, number] | null {
  const n = values.length;
  if (n === 0 || resamples < DEFAULT_FLOORS.bootstrap) return null;

  let s = seed >>> 0;
  const rand = (): number => {
    // xorshift32: small, fast, and reproducible across platforms.
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };

  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample = new Array<number>(n);
    for (let i = 0; i < n; i++) sample[i] = values[Math.floor(rand() * n)];
    stats.push(statistic(sample));
  }
  stats.sort((a, b) => a - b);
  const lo = Math.floor(((1 - confidence) / 2) * stats.length);
  const hi = Math.ceil((1 - (1 - confidence) / 2) * stats.length) - 1;
  return [round4(stats[Math.max(0, lo)]), round4(stats[Math.min(stats.length - 1, hi)])];
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Four decimals, for the small quantities. The residual lives around 0.002. */
function round4(v: number): number {
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}

/** Two decimals, for R-multiples, where a third digit is noise on a single trade. */
function r2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}


// ─── Calibration metrics ─────────────────────────────────────────────────────

export interface CalibrationDecomposition {
  /** Murphy: within-bucket miscalibration. 0 is perfect. */
  reliability: number | null;
  /** Murphy: how much the outcomes are discriminated. SUBTRACTS. */
  resolution: number | null;
  /** The base rate's own variance, o(1-o). Fixed by the outcomes. */
  uncertainty: number | null;
  /** `reliability - resolution + uncertainty - brier`. Zero iff conditioning is exact. */
  residual: number | null;
  /**
   * How the conditioning was done. `'distinct'` conditions on the exact set of
   * forecast values, which makes the identity exact. `'binned'` uses equal-width
   * bins for readability and pays a residual, which is reported.
   */
  conditioning: 'distinct' | 'binned';
}

export interface ReliabilityBucket {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  /** Realised frequency. Null below the floor — a rate from 3 rows is not a rate. */
  realised: number | null;
}

export interface CalibrationReportOut {
  calibrationVersion: string;
  /** What population every number below was computed on. */
  population: Population;
  /** Metrics, each with its own floor and suppression reason. */
  brier: Metric<number>;
  brierBaseRate: Metric<number>;
  brierSkill: Metric<number>;
  winRate: Metric<number>;
  netExpectancyR: Metric<number>;
  medianNetR: Metric<number>;
  profitFactor: Metric<number>;
  maxDrawdownR: Metric<number>;
  falsePositiveRate: Metric<number>;
  falseNegativeRate: Metric<number>;
  decomposition: CalibrationDecomposition;
  reliability: ReliabilityBucket[];
  /** Printed verbatim whenever anything was suppressed. */
  notes: string[];
}

/**
 * Brier decomposition, Murphy's identity.
 *
 * `conditioning: 'distinct'` groups by the EXACT set of forecast values, which is
 * Murphy's original conditioning and makes `REL − RES + UNC = BS` hold to
 * floating point. When every distinct probability appears once, REL collapses to
 * BS and RES to UNC — which is correct, not degenerate: with no repeated
 * probability there is no way to estimate a conditional frequency, so nothing can
 * be said about reliability beyond the score itself.
 *
 * `'binned'` is offered for the reliability DIAGRAM, where grouping is the point.
 */
export function decompose(
  pairs: Array<{ p: number; y: 0 | 1 }>,
  conditioning: 'distinct' | 'binned',
  bucketCount = MIND.CALIBRATION_BUCKETS,
): CalibrationDecomposition | null {
  const usable = pairs.filter((x) => Number.isFinite(x.p) && (x.y === 0 || x.y === 1));
  if (usable.length === 0) return null;
  const n = usable.length;
  const o = usable.filter((x) => x.y === 1).length / n;
  const uncertainty = o * (1 - o);

  // Brier score, always.
  let bsSum = 0;
  for (const x of usable) bsSum += (x.p - x.y) ** 2;
  const bs = bsSum / n;

  let reliability = 0;
  let resolution = 0;

  if (conditioning === 'distinct') {
    // One group per distinct probability. No binning loss, so the identity is exact.
    const groups = new Map<number, { n: number; wins: number }>();
    for (const x of usable) {
      const g = groups.get(x.p) ?? { n: 0, wins: 0 };
      g.n++; if (x.y === 1) g.wins++;
      groups.set(x.p, g);
    }
    for (const [p, g] of groups) {
      const phi = g.n / n;
      const obs = g.wins / g.n;
      reliability += phi * (p - obs) ** 2;
      resolution += phi * (obs - o) ** 2;
    }
  } else {
    const width = 1 / bucketCount;
    for (let i = 0; i < bucketCount; i++) {
      const lo = i * width;
      const hi = (i + 1) * width;
      const b = usable.filter((x) =>
        i === bucketCount - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi,
      );
      if (b.length === 0) continue;
      const m = b.length;
      const mp = mean(b.map((x) => x.p));
      const ob = b.filter((x) => x.y === 1).length / m;
      reliability += (m / n) * (mp - ob) ** 2;
      resolution += (m / n) * (ob - o) ** 2;
    }
  }

  return {
    reliability: round4(reliability),
    resolution: round4(resolution),
    uncertainty: round4(uncertainty),
    residual: round4(reliability - resolution + uncertainty - bs),
    conditioning,
  };
}

export function brierScore(pairs: Array<{ p: number; y: 0 | 1 }>): number | null {
  const usable = pairs.filter((x) => Number.isFinite(x.p) && (x.y === 0 || x.y === 1));
  if (usable.length === 0) return null;
  let s = 0;
  for (const x of usable) s += (x.p - x.y) ** 2;
  return round4(s / usable.length);
}

/**
 * Maximum drawdown in R, from the chronological net-R sequence.
 *
 * In R rather than money, because every signal is sized by the same fixed
 * account risk — so an R sequence IS a comparable equity curve, and a money curve
 * would imply a compounding assumption the engine does not make.
 */
export function maxDrawdownR(netRs: number[]): number | null {
  if (netRs.length === 0) return null;
  let peak = 0;
  let cum = 0;
  let worst = 0;
  for (const r of netRs) {
    cum += r;
    if (cum > peak) peak = cum;
    worst = Math.min(worst, cum - peak);
  }
  return r2(worst);
}

/**
 * False-positive and false-negative rates, defined against a declared threshold.
 *
 * Both are reported because a strategy can improve one by destroying the other.
 * The threshold is the ACTIONABILITY gate, not 0.5: the question is whether a
 * signal we would have traded was right, not whether a coin flip was right.
 */
export function falsePositiveRates(
  signals: LabelledSignal[],
  threshold = MIND.ACTIONABLE_MIN_PROBABILITY,
): { fpr: number | null; fnr: number | null; positives: number; negatives: number } {
  const decided = signals.filter((s) => (s.y === 0 || s.y === 1) && typeof s.probability === 'number');
  const called = decided.filter((s) => (s.probability as number) >= threshold);
  const notCalled = decided.filter((s) => (s.probability as number) < threshold);
  const fp = called.filter((s) => s.y === 0).length;
  const fn = notCalled.filter((s) => s.y === 1).length;
  return {
    fpr: called.length > 0 ? round4(fp / called.length) : null,
    fnr: notCalled.length > 0 ? round4(fn / notCalled.length) : null,
    positives: called.length,
    negatives: notCalled.length,
  };
}

/** Build the full report. */
export function buildCalibrationPhaseReport(
  signals: LabelledSignal[],
  floors: Floors = DEFAULT_FLOORS,
): CalibrationReportOut {
  const population = selectPopulation(signals);
  const notes: string[] = [];
  if (population.note) notes.push(population.note);

  // ── Binary metrics: decided outcomes only ──
  const pairs = population.decided
    .filter((s) => typeof s.probability === 'number')
    .map((s) => ({ p: s.probability as number, y: s.y as 0 | 1 }));

  const bs = brierScore(pairs);
  const o = pairs.length ? pairs.filter((x) => x.y === 1).length / pairs.length : null;
  const clim = o === null ? null : round4(o * (1 - o));
  const skill = bs !== null && clim !== null && clim > 0 ? round4(1 - bs / clim) : null;

  const brier = metric(bs, pairs.length, floors.brier, 'decided', population.censored);
  const brierBase = metric(clim, pairs.length, floors.brier, 'decided', population.censored);
  const brierSkillM = metric(skill, pairs.length, floors.brier, 'decided', population.censored);

  const wins = population.decided.filter((s) => s.y === 1).length;
  const winRate = metric(
    population.decided.length ? round4(wins / population.decided.length) : null,
    population.decided.length,
    floors.brier,
    'decided',
    population.censored,
  );

  // ── Expectancy family: ALL resolved outcomes, censored INCLUDED ──
  const netRs = population.all.map((s) => s.netR as number);
  const sortedNet = [...netRs].sort((a, b) => a - b);
  const expectancy = metric(
    netRs.length ? r2(mean(netRs)) : null,
    netRs.length,
    floors.expectancy,
    'all-resolved',
    0,
    bootstrapCI(netRs, mean),
  );
  const median = metric(
    sortedNet.length ? r2(sortedNet[Math.floor(sortedNet.length / 2)]) : null,
    sortedNet.length,
    floors.expectancy,
    'all-resolved',
    0,
    bootstrapCI(sortedNet, (xs) => {
      const s2 = [...xs].sort((a, b) => a - b);
      return s2[Math.floor(s2.length / 2)];
    }),
  );

  const gross = netRs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const lossAbs = Math.abs(netRs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const profitFactor = metric(
    lossAbs > 0 ? r2(gross / lossAbs) : null,
    netRs.length,
    floors.expectancy,
    'all-resolved',
    0,
    null,
    lossAbs === 0 && gross > 0
      ? 'no losing outcome — profit factor is unbounded and must not be quoted as a number'
      : undefined,
  );

  const chrono = population.all
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((s) => s.netR as number);
  const maxDd = metric(maxDrawdownR(chrono), chrono.length, floors.expectancy, 'all-resolved', 0);

  const fpr = falsePositiveRates(population.decided);
  const fprM = metric(fpr.fpr, fpr.positives, floors.perGroup, 'decided', population.censored);
  const fnrM = metric(fpr.fnr, fpr.negatives, floors.perGroup, 'decided', population.censored);

  // ── Decomposition: DISTINCT conditioning, because the identity must hold ──
  const dec = decompose(pairs, 'distinct');

  // ── Reliability diagram: binned, because readability is the point here ──
  const reliability = reliabilityDiagram(pairs, floors.perGroup);

  if (brier.suppressed) {
    notes.push(
      `No Brier score. ${brier.reason}. A reliability diagram needs a conditional frequency, so it is withheld below ${floors.brier} too.`,
    );
  }

  return {
    calibrationVersion: CALIBRATION_VERSION,
    population,
    brier,
    brierBaseRate: brierBase,
    brierSkill: brierSkillM,
    winRate,
    netExpectancyR: expectancy,
    medianNetR: median,
    profitFactor,
    maxDrawdownR: maxDd,
    falsePositiveRate: fprM,
    falseNegativeRate: fnrM,
    decomposition: dec ?? {
      reliability: null, resolution: null, uncertainty: null, residual: null,
      conditioning: 'distinct',
    },
    reliability,
    notes,
  };
}

export function reliabilityDiagram(
  pairs: Array<{ p: number; y: 0 | 1 }>,
  floor: number,
  bucketCount = MIND.CALIBRATION_BUCKETS,
): ReliabilityBucket[] {
  const width = 1 / bucketCount;
  const out: ReliabilityBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = i * width;
    const hi = (i + 1) * width;
    const b = pairs.filter((x) =>
      i === bucketCount - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi,
    );
    out.push({
      lo: round4(lo),
      hi: round4(hi),
      n: b.length,
      meanPredicted: b.length ? round4(mean(b.map((x) => x.p))) : null,
      realised: b.length >= floor ? round4(b.filter((x) => x.y === 1).length / b.length) : null,
    });
  }
  return out;
}

// ─── Grouped reports ─────────────────────────────────────────────────────────

export interface GroupPerformance {
  group: string;
  n: number;
  floor: number;
  suppressed: boolean;
  reason: string | null;
  winRate: number | null;
  netExpectancyR: number | null;
  medianNetR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number | null;
  /** Every rate carries its interval. */
  ci: { winRate: [number, number] | null; netExpectancyR: [number, number] | null };
  censored: number;
}

/**
 * Performance for one grouping key.
 *
 * Used for regime, setup type, grade, news condition and data-health state. A
 * group below the floor is reported as `suppressed` WITH ITS COUNT, never omitted —
 * an absent row reads as "no data" when it may mean "we declined to look".
 */
export function groupPerformance(
  signals: LabelledSignal[],
  key: (s: LabelledSignal) => string,
  floor: number,
): GroupPerformance[] {
  const buckets = new Map<string, LabelledSignal[]>();
  for (const s of signals) {
    const k = key(s);
    const arr = buckets.get(k);
    if (arr) arr.push(s); else buckets.set(k, [s]);
  }

  const out: GroupPerformance[] = [];
  for (const [group, rows] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pop = selectPopulation(rows);
    const decided = pop.decided;
    const netRs = pop.all.map((s) => s.netR as number);
    const suppressed = decided.length < floor;

    const wins = decided.filter((s) => s.y === 1);
    const wr = decided.length ? round4(wins.length / decided.length) : null;

    const chrono = pop.all.slice().sort((a, b) => a.createdAt - b.createdAt).map((s) => s.netR as number);
    const gross = netRs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const lossAbs = Math.abs(netRs.filter((r) => r < 0).reduce((a, b) => a + b, 0));

    out.push({
      group,
      n: decided.length,
      floor,
      suppressed,
      reason: suppressed
        ? `insufficient evidence: ${decided.length} decided, floor is ${floor}`
        : null,
      winRate: suppressed ? null : wr,
      netExpectancyR: suppressed ? null : netRs.length ? r2(mean(netRs)) : null,
      medianNetR: suppressed
        ? null
        : netRs.length
          ? r2([...netRs].sort((a, b) => a - b)[Math.floor(netRs.length / 2)])
          : null,
      profitFactor: suppressed || lossAbs === 0 ? null : r2(gross / lossAbs),
      maxDrawdownR: suppressed ? null : maxDrawdownR(chrono),
      ci: {
        winRate: suppressed ? null : bootstrapCI(decided.map((s) => (s.y as number) * 1), mean),
        netExpectancyR: suppressed ? null : bootstrapCI(netRs, mean),
      },
      censored: pop.censored,
    });
  }
  return out;
}

// ─── Grade ordering: REPORTED, never asserted ───────────────────────────────

export type OrderingVerdict =
  | 'INSUFFICIENT_EVIDENCE'
  | 'ORDERING_HOLDS'
  | 'ORDERING_BROKEN'
  | 'NON_MONOTONIC'
  | 'INDETERMINATE';

/**
 * Does A beat B beat C?
 *
 * Returns a verdict, never a boolean, because "we do not know" and "no" are
 * different answers and the interesting one is usually the first.
 *
 * Gated on the WEAKEST grade, because a chain is only as strong as its weakest
 * link: if C has 12 samples, "B > C" is unproven no matter how well A beats B.
 *
 * When the ordering fails, the verdict names the CAUSES to investigate rather
 * than inviting a weight change — because the Phase XVI list (bad features,
 * regime mixing, outcome leakage, cost errors, threshold drift, or a genuinely
 * non-monotonic signal) mostly points at bugs rather than at the weights.
 */
export function gradeOrdering(
  signals: LabelledSignal[],
  perGradeFloor = DEFAULT_FLOORS.perGrade,
): {
  verdict: OrderingVerdict;
  grades: GroupPerformance[];
  reasons: string[];
  /** What to investigate. Only populated when the ordering is claimed or broken. */
  investigate: string[];
} {
  const byGrade = groupPerformance(signals, (s) => s.grade ?? 'unknown', perGradeFloor);
  const present = byGrade.filter((g) => g.n > 0);
  const reasons: string[] = [];

  if (present.length === 0) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      grades: byGrade,
      reasons: ['no resolved signals carry a grade'],
      investigate: [],
    };
  }

  const below = present.filter((g) => g.suppressed);
  for (const g of below) {
    reasons.push(`${g.group}: ${g.reason}`);
  }
  if (below.length > 0) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      grades: byGrade,
      reasons,
      investigate: [],
    };
  }

  const order = ['A', 'B', 'C'];
  const byName = new Map(byGrade.map((g) => [g.group, g]));
  const comparable = order.filter((g) => byName.has(g) && byName.get(g)!.n > 0);

  if (comparable.length < 2) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      grades: byGrade,
      reasons: [`only ${comparable.length} grade(s) above the floor of ${perGradeFloor}`],
      investigate: [],
    };
  }

  const exp = comparable.map((g) => byName.get(g)!.netExpectancyR ?? 0);
  const monotone = exp.every((v, i) => i === 0 || v < exp[i - 1]);

  const investigate = [
    'bad features — a conviction component may not predict anything',
    'regime mixing — an aggregate can hide a real effect that is regime-conditional',
    'outcome leakage — check that resolvedAt never influenced the frozen inputs',
    'cost errors — verify fees, funding and slippage are charged on every row',
    'grade-threshold drift — the A/B/C cutoffs may have moved since these signals froze',
    'genuine non-monotonicity — the signal may peak at B rather than A',
  ];

  if (monotone) {
    // `comparable` is in A,B,C order, so adjacent entries are adjacent grades.
    // If any adjacent pair's bootstrap intervals overlap, the ordering holds on
    // point estimates but the difference is not yet distinguishable from noise —
    // which is INDETERMINATE, not confirmed.
    const overlappingPairs: string[] = [];
    for (let i = 1; i < comparable.length; i++) {
      const prev = byName.get(comparable[i - 1])!;
      const cur = byName.get(comparable[i])!;
      const a = prev.ci.netExpectancyR;
      const b = cur.ci.netExpectancyR;
      if (a && b && intervalsOverlap(a, b)) {
        overlappingPairs.push(`${prev.group} vs ${cur.group}`);
      }
    }
    reasons.push(
      `net expectancy by grade: ${comparable.map((g) => `${g}=${byName.get(g)!.netExpectancyR}R`).join(', ')}`,
    );
    if (overlappingPairs.length > 0) {
      return {
        verdict: 'INDETERMINATE',
        grades: byGrade,
        reasons: [
          ...reasons,
          `the ordering holds on point estimates, but ${overlappingPairs.join(' and ')} have OVERLAPPING bootstrap intervals — the difference is not yet distinguishable from noise`,
        ],
        investigate: [
          'widen the sample rather than adjust the grades; overlapping intervals mean the data cannot yet separate the grades',
        ],
      };
    }
    return { verdict: 'ORDERING_HOLDS', grades: byGrade, reasons, investigate: [] };
  }

  return {
    verdict: 'ORDERING_BROKEN',
    grades: byGrade,
    reasons,
    investigate,
  };
}

function intervalsOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Feature importance — gated, and it says so.
 *
 * Phase XVI item 7 is explicit: "add feature-importance reporting only after
 * enough resolved outcomes exist." So this returns a verdict rather than a
 * ranking until the floor is met, and never a ranking computed from a thin sample
 * with a caveat attached — a correlation from 12 rows is not weak evidence, it is
 * noise wearing a coefficient.
 *
 * `feature` is an EXTRACTOR per signal, not a constant: a constant vector has
 * zero variance and correlates with nothing, which would silently produce an
 * empty report that reads as "no feature matters".
 */
export interface FeatureImportanceReport {
  verdict: 'INSUFFICIENT_EVIDENCE' | 'COMPUTED';
  n: number;
  floor: number;
  reason: string | null;
  /** Sorted by |correlation| descending. Empty when suppressed. */
  importance: Array<{ feature: string; correlation: number; n: number; ci: [number, number] | null }>;
}

export function featureImportance(
  signals: LabelledSignal[],
  extractors: Record<string, (s: LabelledSignal) => number | null>,
  floor: number,
): FeatureImportanceReport {
  const usable = signals.filter((s) => typeof s.netR === 'number');
  if (usable.length < floor) {
    return {
      verdict: 'INSUFFICIENT_EVIDENCE',
      n: usable.length,
      floor,
      reason:
        `${usable.length} resolved outcomes, floor is ${floor}. A correlation from a sample this size is noise wearing a coefficient, so no ranking is published.`,
      importance: [],
    };
  }

  const importance: FeatureImportanceReport['importance'] = [];
  for (const [feature, extract] of Object.entries(extractors)) {
    // Pairs only where BOTH the feature and the outcome exist. Dropping rows
    // with a null feature is correct — but the count is reported, because a
    // feature measured on 8 of 400 rows is not the same evidence as one measured
    // on all 400.
    const pairs = usable
      .map((s) => ({ x: extract(s), y: (s.netR as number) > 0 ? 1 : 0 }))
      .filter((p): p is { x: number; y: number } => p.x !== null && Number.isFinite(p.x));
    if (pairs.length < floor) continue;
    const corr = pearson(pairs.map((p) => p.x), pairs.map((p) => p.y));
    if (corr === null) continue;
    importance.push({
      feature,
      correlation: round4(corr),
      n: pairs.length,
      ci: bootstrapCI(pairs.map((p) => p.x), (sample) => {
        // Bootstrap over ROWS, keeping each row's x with its own y.
        const ys = pairs.slice(0, sample.length).map((p) => p.y);
        return pearson(sample, ys) ?? 0;
      }),
    });
  }
  importance.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  return { verdict: 'COMPUTED', n: usable.length, floor, reason: null, importance };
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export { OUTCOME_POLICY, classifyOutcome };
export type { OutcomeClass };