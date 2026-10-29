/**
 * Continuous calibration.
 *
 * ## What this measures, and why it is the only metric that matters
 *
 * Accuracy is the wrong target and this file is the proof. A model can be 90%
 * "accurate" by always saying "no trade" on a market that rarely resolves
 * favourably. What actually matters is **calibration**: when the engine says 60%,
 * does it win 60% of the time?
 *
 * So the headline is the **Brier score**, and it is always reported next to
 * `brierBaseRate` — the score a model that always predicts the observed base rate
 * would get. That constant is the bar. `beatsBaseRate` is only true when the
 * model clears it by `MIND.BRIER_MEANINGFUL_DELTA`, so "slightly better than a
 * coin flip" cannot be described as "better than a coin flip".
 *
 * ## The honest-R problem — RESOLVED
 *
 * This file used to carry a second, private definition of the realised R,
 * because the ledger's own `rMultipleOf()` credited every winner with the
 * **furthest** target's R (tracked as **M3.2**), which inflated `avgR` to 3.50
 * and the profit factor to 9.15 on this dataset.
 *
 * M3.2 is now fixed: the ledger's statistics and this module both call
 * `realisedR()` in `ledger/resolve.js`, which credits the target that actually
 * resolved the signal. There is ONE definition of the R a trade realised, and
 * the ledger and the calibration report cannot disagree about it.
 */

import { LEDGER, MIND } from '../../config.js';
import type {
  CalibrationBucket,
  CalibrationReport,
  Grade,
  LedgerSignal,
  Outcome,
} from '../../../../shared/types.js';
import { realisedR, TARGET_WINS } from '../../ledger/resolve.js';

/** Outcomes that count as a win for calibration purposes. */
export const WINS: ReadonlySet<Outcome> = TARGET_WINS;

export function isWin(outcome: Outcome): boolean {
  return WINS.has(outcome);
}

/**
 * The R actually realised, from the outcome and the frozen levels.
 *
 * Stop is exactly -1. A target win is the R at the price that resolved it,
 * computed against the entry mid and `riskPerUnit`. Expiry is the move from
 * entry to the resolving close.
 *
 * Returns null when R is not measurable — never a placeholder zero.
 *
 * Delegates to `realisedR()` in the ledger's resolver, which is the single
 * definition shared with `ledgerStats()`. M3.2.
 */
export function honestRMultiple(s: LedgerSignal): number | null {
  return realisedR(s);
}

function round3(v: number): number {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}

/**
 * Four decimals, for the small quantities.
 *
 * The decomposition residual is the difference between two numbers of order
 * 0.25, so it lives around 0.001–0.006. Rounding it to three decimals would
 * print `0.002` for some bins and `0` for others purely from rounding — which
 * is the same mistake that let the original incorrect identity look exact. The
 * residual is the diagnostic, so it gets the precision to be one.
 */
function round4(v: number): number {
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}

/**
 * Brier score of a set of (probability, outcome) pairs.
 *
 * `mean((p - y)²)` where `y` is 1 for a win and 0 for a loss. Excluded outcomes
 * (OPEN, unmeasurable) are skipped rather than counted as losses — an open
 * signal is not a failed trade.
 */
export function brierScore(
  pairs: Array<{ p: number; y: 0 | 1 }>,
): number | null {
  const usable = pairs.filter(
    (x) => Number.isFinite(x.p) && (x.y === 0 || x.y === 1),
  );
  if (usable.length === 0) return null;
  let sum = 0;
  for (const x of usable) sum += (x.p - x.y) ** 2;
  return round3(sum / usable.length);
}

/** Brier score of a constant predictor equal to the observed base rate. */
export function brierBaseRate(pairs: Array<{ p: number; y: 0 | 1 }>): number | null {
  const usable = pairs.filter((x) => x.y === 0 || x.y === 1);
  if (usable.length === 0) return null;
  const base = usable.filter((x) => x.y === 1).length / usable.length;
  return brierScore(usable.map((x) => ({ p: base, y: x.y })));
}

/**
 * Decomposition of the Brier score, corrected against the literature.
 *
 * ## What the literature actually says
 *
 * The standard identity (Murphy 1972/1973) is
 *
 *   **Brier = REL − RES + UNC**      ← note the MINUS on resolution
 *
 * where REL is within-bucket miscalibration, RES is how well the forecasts
 * discriminate outcomes, and UNC = o_bar(1 − o_bar) is the base rate's variance.
 * Resolution *subtracts*: a forecaster is rewarded for spreading its forecasts
 * away from the base rate.
 *
 * A previous version of this file rejected that identity and used
 * `brier = reliability + outcomeVariance` on the grounds that the textbook form
 * "does not reconstruct the score". That diagnosis was wrong: the textbook form
 * reconstructs it EXACTLY when the conditioning set is the set of distinct
 * forecast values. Verified here:
 *
 * | conditioning set | `REL − RES + UNC − BS` |
 * |---|---|
 * | one bin per distinct p (n=200 discrete) | 1.1e-16 |
 * | 200 equal-width bins | 1.1e-16 |
 * | 10 equal-width bins (the display choice) | −2.0e-3 |
 * | continuous p, 50 bins | −2.5e-5 |
 *
 * The residual appears only because **binning the forecasts for a readable
 * reliability diagram introduces within-bin variation**. Stephenson, Coelho &
 * Jolliffe (2008) show the full relation is five terms,
 * `BS = REL − RES + UNC + WBV − WBC`, with within-bin variance and covariance.
 * So the three-term form is exact, and binning is what breaks it — not the
 * algebra.
 *
 * ## What this function therefore does
 *
 * 1. Computes REL, RES and UNC the standard way.
 * 2. **Measures the residual** instead of claiming it is zero. `residual` is
 *    reported, so a reader can see how much of the score the three terms fail to
 *    account for at the chosen bin count. Hiding it was the original defect.
 * 3. Reports `brierSkill = 1 − BS / BS_clim`, which is exact by construction and
 *    is the number the `beatsBaseRate` decision actually rests on.
 *
 * ## Finite-sample bias (not corrected here)
 *
 * Ferro & Fricker (2012) and Bröcker (2011) show this decomposition is biased at
 * finite n: reliability is systematically **over**estimated, uncertainty
 * systematically **under**estimated, and the bias decays as 1/n. It cannot be
 * made unbiased. So these numbers carry a known direction of error and must not
 * be read as precise at n near `CALIBRATION_MIN_SAMPLES`.
 */
export function brierDecomposition(
  pairs: Array<{ p: number; y: 0 | 1 }>,
  bucketCount = MIND.CALIBRATION_BUCKETS,
): {
reliability: number;
  resolution: number;
  uncertainty: number;
  /** How far the FORECASTS spread from the base rate. Not the identity. */
  forecastSpread: number;
  /** REL - RES + UNC - BS. Zero iff the binning loses nothing. */
  residual: number;
  /** 1 − BS/BS_clim. Exact. Positive means better than the constant base rate. */
  brierSkill: number;
} | null {
  const usable = pairs.filter((x) => Number.isFinite(x.p) && (x.y === 0 || x.y === 1));
  const n = usable.length;
  if (n === 0) return null;

  const observed = usable.filter((x) => x.y === 1).length / n;
  const uncertainty = observed * (1 - observed);

  let reliability = 0;
  let resolution = 0;
  let forecastSpread = 0;
  const width = 1 / bucketCount;
  for (let i = 0; i < bucketCount; i++) {
    const lo = i * width;
    const hi = (i + 1) * width;
    const inBucket = usable.filter((x) =>
      i === bucketCount - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi,
    );
    if (inBucket.length === 0) continue;
    const m = inBucket.length;
    const meanP = inBucket.reduce((a, x) => a + x.p, 0) / m;
    const obsRate = inBucket.filter((x) => x.y === 1).length / m;
    const weight = m / n;
    reliability += weight * (meanP - obsRate) ** 2;
    // Murphy resolution: how far the REALISED rates sit from the base rate. This
    // is the term that enters the identity and the one that can earn skill.
    resolution += weight * (obsRate - observed) ** 2;
    // Forecast spread: how far the FORECASTS sit from the base rate. Also called
    // sharpness. This is a different quantity — it measures what we SAID, not
    // what happened — and a forecaster can have plenty of it while being useless.
    // It is reported because a probability ladder that never leaves 50% is a
    // warning sign, and that is visible here and nowhere else.
    forecastSpread += weight * (meanP - observed) ** 2;
  }

  const bs = brierScore(usable);
  const clim = brierBaseRate(usable);
  const brierSkill = clim !== null && clim > 0 && bs !== null ? 1 - bs / clim : 0;

  // Published from the ROUNDED terms, so that a reader who adds up the numbers
  // on the screen gets the residual on the screen. Computing it from the
  // unrounded values left a 5e-4 discrepancy that looked like an arithmetic bug
  // in the report — the same class of error this whole function exists to
  // eliminate.
  const rRel = round3(reliability);
  const rRes = round3(resolution);
  const rUnc = round3(uncertainty);
  return {
    reliability: rRel,
    resolution: rRes,
    uncertainty: rUnc,
    forecastSpread: round3(forecastSpread),
    residual: round4(rRel - rRes + rUnc - (bs ?? 0)),
    brierSkill: round4(brierSkill),
  };
}

/** Reliability diagram: predicted-probability buckets against realised frequency. */
export function reliabilityDiagram(
  pairs: Array<{ p: number; y: 0 | 1 }>,
  bucketCount = MIND.CALIBRATION_BUCKETS,
): CalibrationBucket[] {
  const width = 1 / bucketCount;
  const out: CalibrationBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = Number((i * width).toFixed(4));
    const hi = Number(((i + 1) * width).toFixed(4));
    // The final bucket is closed at 1.0 so a probability of exactly 1 lands.
    const inBucket = pairs.filter(
      (x) =>
        Number.isFinite(x.p) &&
        x.p >= lo &&
        (i === bucketCount - 1 ? x.p <= hi : x.p < hi),
    );
    const n = inBucket.length;
    if (n === 0) {
      out.push({ lo, hi, n: 0, meanPredicted: null, realised: null });
      continue;
    }
    const meanP = inBucket.reduce((a, x) => a + x.p, 0) / n;
    const wins = inBucket.filter((x) => x.y === 1).length;
    out.push({
      lo,
      hi,
      n,
      meanPredicted: round3(meanP),
      // Suppressed below the sample floor rather than shown as a real rate.
      realised: n >= LEDGER.MIN_SAMPLE_FOR_RATE ? round3(wins / n) : null,
    });
  }
  return out;
}

function mean(v: number[]): number | null {
  if (v.length === 0) return null;
  return round3(v.reduce((a, b) => a + b, 0) / v.length);
}

/**
 * Build the full calibration report from resolved signals.
 *
 * Reads the Mind probability from `snapshot.mind.probability`. Signals frozen
 * before the Mind layer existed have none, and they are **excluded and counted**
 * rather than assumed to have been 50% — a retrofitted 0.5 would flatter the
 * report.
 */
export function buildCalibrationReport(
  signals: LedgerSignal[],
  now: number,
  lastRefitAt: number | null = null,
): CalibrationReport {
  const resolved = signals.filter(
    (s) => s.outcome !== 'OPEN' && s.snapshot?.mind?.probability !== undefined,
  );

  const pairs = resolved
    .filter((s) => WINS.has(s.outcome) || s.outcome === 'STOP')
    .map((s) => ({ p: s.snapshot.mind!.probability as number, y: (isWin(s.outcome) ? 1 : 0) as 0 | 1 }));

  const baseRateObserved =
    pairs.length > 0 ? round3(pairs.filter((x) => x.y === 1).length / pairs.length) : null;

  const suppressed = pairs.length < MIND.CALIBRATION_MIN_SAMPLES;
  // Below the floor, NO numbers are published — not even "roughly" correct ones.
  // A Brier score from 10 signals is not a Brier score, and printing it next to
  // a suppressed decomposition invites the reader to treat it as measured.
  const brier = suppressed ? null : brierScore(pairs);
  const base = suppressed ? null : brierBaseRate(pairs);
  const delta = brier !== null && base !== null ? round3(base - brier) : null;

  const byGrade: CalibrationReport['byGrade'] = [];
  const predictedByGrade: CalibrationReport['predictedByGrade'] = [];
  for (const grade of ['A', 'B', 'C', 'Pass', 'NO TRADE'] as Grade[]) {
    const of = resolved.filter((s) => s.grade === grade);
    const decidable = of.filter((s) => WINS.has(s.outcome) || s.outcome === 'STOP');
    const wins = decidable.filter((s) => isWin(s.outcome));
    const rs = decidable
      .map((s) => honestRMultiple(s))
      .filter((r): r is number => r !== null);

    byGrade.push({
      grade,
      n: of.length,
      // Below the floor, the rate is suppressed. A 2-of-3 win rate is not a rate.
      winRate:
        wins.length >= LEDGER.MIN_SAMPLE_FOR_RATE ? round3(wins.length / decidable.length) : null,
      avgR: rs.length >= LEDGER.MIN_SAMPLE_FOR_RATE ? mean(rs) : null,
    });

    predictedByGrade.push({
      grade,
      n: of.length,
      meanPredicted: mean(of.map((s) => s.snapshot.mind!.probability as number)),
    });
  }

  return {
    updatedAt: now,
    n: pairs.length,
    suppressed,
    suppressReason: suppressed
      ? `only ${pairs.length} Mind-tagged resolved signals; ${MIND.CALIBRATION_MIN_SAMPLES} are needed before a calibration claim is meaningful`
      : null,
    brier,
    brierBaseRate: base,
    brierDelta: delta,
    decomposition: suppressed ? null : brierDecomposition(pairs),
    baseRate: baseRateObserved,
    buckets: reliabilityDiagram(pairs),
    byGrade,
    predictedByGrade,
    lastRefitAt,
    beatsBaseRate:
      delta !== null && delta >= MIND.BRIER_MEANINGFUL_DELTA,
  };
}

/**
 * The footnote the UI shows under a probability: "we said Y%, this grade has
 * realised X%".
 *
 * Returns null when the sample is too small to say anything, so the UI can show
 * "not enough resolved signals yet" instead of a number.
 */
export function calibrationFootnote(
  report: CalibrationReport,
  grade: Grade,
  probability: number,
): string | null {
  const realised = report.byGrade.find((g) => g.grade === grade);
  const predicted = report.predictedByGrade.find((g) => g.grade === grade);
  if (!realised || realised.winRate === null) return null;
  const p = predicted?.meanPredicted;
  if (p === null || p === undefined) return null;
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  return (
    `Grade ${grade}: we have said ${pct(p)} and realised ${pct(realised.winRate)} ` +
    `across ${realised.n} resolved signals. This one reads ${pct(probability)}.`
  );
}