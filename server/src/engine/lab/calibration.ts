/**
 * The Engine Lab's calibration panel.
 *
 * ## What is measured here
 *
 * Three different questions, and they are NOT the same question:
 *
 *   1. **CALIBRATION** — does a forecast of 70% happen 70% of the time?
 *   2. **DISCRIMINATION** — does a higher forecast mean a better outcome?
 *   3. **PROFITABILITY** — does taking the high forecasts make money?
 *
 * A model can be calibrated and worthless (it says 50% about everything and
 * is right 50% of the time). A model can be profitable and badly calibrated.
 * The Lab reports all three, and never lets one stand in for another.
 *
 * ## Coverage and hit rate are ALWAYS reported together
 *
 * "100% win rate on 3 trades" and "100% win rate on 300" are the same sentence
 * and completely different facts. Every tier row therefore carries the hit
 * rate, the COVERAGE and the sample size, and a tier below the sample floor
 * reports `null` with a reason rather than a number that looks fine.
 *
 * ## The interval is a WILSON interval
 *
 * The normal approximation to a binomial proportion is wrong exactly where it
 * matters here: at a high hit rate on a small sample it understates the
 * interval and produces an over-confident number. The Wilson score interval
 * stays inside [0, 1] and behaves at the extremes, which is why it is the
 * standard for this.
 *
 * ## The base rate is the benchmark
 *
 * A Brier score on its own says nothing. The report always shows the Brier of
 * the constant base-rate predictor on the SAME rows, and the skill score
 * `1 - brier / brierBaseRate`. A model that cannot beat the constant is not a
 * model.
 */

import { LAB } from '../../config.js';
import type { LabCalibration, LabReliabilityRow, LabTierRow } from '../../../../shared/types.js';

/** One scored trade, as the calibration panel sees it. */
export interface ScoredTrade {
  /** The probability the model published. Null when the model was unfitted. */
  p: number | null;
  /** 1 for a take-profit, 0 for a stop, null for a censored expiry. */
  y: 0 | 1 | null;
  /** Net R after costs. Null when it could not be measured. */
  netR: number | null;
  /** The cluster this trade belongs to, for the bootstrap. */
  cluster: string;
}

/**
 * The Wilson score interval for a binomial proportion.
 *
 * Null when `n` is zero — an interval on no observations is not a narrow
 * interval, it is no interval.
 */
export function wilsonInterval(successes: number, n: number, z: number): [number, number] | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number.isFinite(successes)) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** The Brier score over (probability, outcome) pairs. Null when there are none. */
export function brier(pairs: Array<{ p: number; y: number }>): number | null {
  if (!pairs.length) return null;
  return pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / pairs.length;
}

/** The log loss in nats per observation. Null when there are none. */
export function logLoss(pairs: Array<{ p: number; y: number }>): number | null {
  if (!pairs.length) return null;
  let sum = 0;
  for (const x of pairs) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, x.p));
    sum += -(x.y * Math.log(p) + (1 - x.y) * Math.log(1 - p));
  }
  return sum / pairs.length;
}

/**
 * The reliability table.
 *
 * Bins are EQUAL-WIDTH on the probability, because the reader wants to see
 * where the model is over-confident, and equal-width bins put the eye on the
 * part of the range that is populated.
 */
export function reliabilityRows(
  pairs: Array<{ p: number; y: number }>,
  buckets = 10,
): LabReliabilityRow[] {
  const out: LabReliabilityRow[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = i / buckets;
    const hi = (i + 1) / buckets;
    const inBucket = pairs.filter((x) =>
      i === buckets - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi,
    );
    const meanPredicted = inBucket.length
      ? inBucket.reduce((a, x) => a + x.p, 0) / inBucket.length
      : null;
    const observed = inBucket.length
      ? inBucket.reduce((a, x) => a + x.y, 0) / inBucket.length
      : null;
    out.push({
      lo: round4(lo),
      hi: round4(hi),
      n: inBucket.length,
      meanPredicted: meanPredicted === null ? null : round4(meanPredicted),
      observed: observed === null ? null : round4(observed),
      gap: meanPredicted === null || observed === null ? null : round4(Math.abs(observed - meanPredicted)),
    });
  }
  return out;
}

/**
 * The confidence-tier table.
 *
 * For each threshold: how many decided trades the tier speaks on, its share
 * (the COVERAGE), its realised hit rate with a Wilson interval, and its mean
 * net R. A tier below `LAB.TIER_MIN_TRADES` reports `null` for the rate and
 * says why in words.
 */
export function tierRows(
  trades: ScoredTrade[],
  thresholds: readonly number[] = LAB.TIER_THRESHOLDS,
  minTrades: number = LAB.TIER_MIN_TRADES,
  z: number = LAB.WILSON_Z,
): LabTierRow[] {
  const decided = trades.filter((t) => t.y !== null && t.p !== null);
  return thresholds.map((threshold) => {
    const taken = decided.filter((t) => (t.p as number) >= threshold);
    const n = taken.length;
    const wins = taken.filter((t) => t.y === 1).length;
    const hitRatePct = n ? (wins / n) * 100 : null;
    const ci = n ? wilsonInterval(wins, n, z) : null;
    const netRs = taken.map((t) => t.netR).filter((v): v is number => v !== null);
    const netR = netRs.length ? netRs.reduce((a, b) => a + b, 0) / netRs.length : null;

    let reason: string | null = null;
    if (n === 0) {
      reason = `No decided trade reached a probability of ${threshold}.`;
    } else if (n < minTrades) {
      reason =
        `Only ${n} trade${n === 1 ? '' : 's'} reached ${threshold}, and the floor is ${minTrades}. ` +
        `The hit rate is not quoted at this sample size.`;
    }

    return {
      threshold,
      n,
      // The coverage is the tier's share of the DECIDED trades. With no decided
      // trades at all it is undefined, not 0% — a zero would read as "the tier
      // spoke on nothing", which is a different claim from "there is nothing to
      // speak on".
      coveragePct: decided.length ? round4((n / decided.length) * 100) : null,
      hitRatePct: n >= minTrades ? round4(hitRatePct as number) : null,
      hitRateCi:
        n >= minTrades && ci
          ? [round4(ci[0] * 100), round4(ci[1] * 100)]
          : null,
      netR: netR === null ? null : round4(netR),
      reason,
    };
  });
}

/**
 * The whole calibration panel.
 *
 * `verdict` is a SENTENCE, not a score. The numbers are the evidence and the
 * sentence says what they mean, including when they mean "not enough data".
 */
export function calibrationReport(trades: ScoredTrade[]): LabCalibration {
  const decided = trades.filter((t) => t.y !== null && t.p !== null);
  const censored = trades.filter((t) => t.y === null).length;
  const pairs = decided.map((t) => ({ p: t.p as number, y: t.y as number }));
  const baseRate = pairs.length ? pairs.reduce((a, x) => a + x.y, 0) / pairs.length : null;
  const b = brier(pairs);
  const baseBrier = baseRate === null ? null : brier(pairs.map((x) => ({ p: baseRate, y: x.y })));
  const ll = logLoss(pairs);
  const skill = b !== null && baseBrier !== null && baseBrier > 0 ? 1 - b / baseBrier : null;

  const reliability = reliabilityRows(pairs);
  const tiers = tierRows(trades);

  const verdict = calibrationVerdict({
    n: decided.length,
    brier: b,
    baseBrier,
    skill,
    reliability,
    tiers,
  });

  return {
    updatedAt: Date.now(),
    n: decided.length,
    censored,
    baseRate: baseRate === null ? null : round4(baseRate),
    brier: b === null ? null : round4(b),
    brierBaseRate: baseBrier === null ? null : round4(baseBrier),
    brierSkill: skill === null ? null : round4(skill),
    logLoss: ll === null ? null : round4(ll),
    reliability,
    tiers,
    verdict,
  };
}

/**
 * The verdict, in words.
 *
 * The order of the tests matters: a sample-size statement comes FIRST, because
 * "the model is not calibrated" is a much stronger claim than "there are not
 * enough trades to tell", and the second is true when the first is untestable.
 */
export function calibrationVerdict(input: {
  n: number;
  brier: number | null;
  baseBrier: number | null;
  skill: number | null;
  reliability: LabReliabilityRow[];
  tiers: LabTierRow[];
}): string {
  const { n, brier, baseBrier, skill, reliability, tiers } = input;

  if (n === 0) {
    return 'No decided trade carries a model probability yet, so there is nothing to calibrate. This is not a verdict of "uncalibrated" — it is the absence of evidence.';
  }

  const parts: string[] = [];
  parts.push(
    `${n} decided trade${n === 1 ? '' : 's'}. ` +
      (brier === null || baseBrier === null
        ? 'No Brier score could be computed. '
        : `Brier ${brier.toFixed(4)} against a constant-base-rate Brier of ${baseBrier.toFixed(4)}` +
          (skill === null ? '. ' : ` (skill ${(skill * 100).toFixed(1)}%). `)),
  );

  // The worst populated reliability bucket.
  const worst = reliability
    .filter((r) => r.gap !== null && r.n > 0)
    .sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0))[0];
  if (worst && worst.gap !== null) {
    const over = worst.gap > LAB.CALIBRATION_TOLERANCE;
    parts.push(
      `The widest reliability gap is ${(worst.gap * 100).toFixed(1)}pp in the ${worst.lo.toFixed(1)}-${worst.hi.toFixed(1)} bucket (n=${worst.n})` +
        (over
          ? `, which is OUTSIDE the ${(LAB.CALIBRATION_TOLERANCE * 100).toFixed(0)}pp tolerance.`
          : `, inside the ${(LAB.CALIBRATION_TOLERANCE * 100).toFixed(0)}pp tolerance.`),
    );
  }

  // The best populated tier.
  const quoted = tiers.filter((t) => t.hitRatePct !== null);
  if (quoted.length) {
    const best = quoted[quoted.length - 1];
    parts.push(
      `The highest quoted tier (p >= ${best.threshold}) hit ${best.hitRatePct!.toFixed(1)}% on ` +
        `${best.n} trades, covering ${(best.coveragePct ?? 0).toFixed(1)}% of decided trades.`,
    );
  } else {
    parts.push('No confidence tier has enough trades for its hit rate to be quoted.');
  }

  if (skill !== null && skill <= 0) {
    parts.push('The model does not beat the constant base rate, so there is no evidence of edge.');
  }

  return parts.join(' ');
}

function round4(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10_000) / 10_000;
}
