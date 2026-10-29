/**
 * Post-trade reviews.
 *
 * ## A review is EVIDENCE, never state
 *
 * The review row records what happened: what the model said, what the market
 * did, what it cost, and — the part that needs judgement — WHY. It is written
 * once and never edited by the learning loop. The retrainer reads reviews; it
 * does not write them, and it does not change a threshold because of one.
 *
 * ## "Variance, no fault" is a real verdict and a common one
 *
 * Most losing trades are not a mistake. The engine was right about the
 * structure, the timing was reasonable, the stop was sensible, and the market
 * went the other way. Calling that a failure of the model would teach the
 * model to avoid trades that were correct, which is how a system learns to
 * stop taking any risk at all.
 *
 * So `variance` is a first-class classification, and `no-fault-no-change` is
 * its explicit synonym. A review that says "no fault, no change" is a
 * SUCCESSFUL review, not a missing one.
 *
 * ## The classifier is a pure function of the evidence
 *
 * It reads the frozen features at entry, the realised outcome, the costs, the
 * maximum favourable and adverse excursion, the news that landed DURING the
 * trade and the regime at entry and exit. It has no clock and no I/O, so the
 * same evidence always produces the same verdict.
 */

import type { LabFailureClass } from '../../../../shared/types.js';
import type { FeatureVector } from '../../../../shared/types.js';
import { MIND, NEWS } from '../../config.js';

/** Everything the classifier reads. */
export interface ReviewEvidence {
  /** The probability the model published at entry. */
  predictedPWin: number | null;
  /** 1 for a take-profit, 0 for a stop, null for a censored expiry. */
  outcome: 0 | 1 | null;
  /** What the resolver decided, e.g. `TP1`, `STOP`, `EXPIRED`. */
  outcomeLabel: string;
  /** Gross R before costs. */
  grossR: number | null;
  /** Net R after modelled costs. */
  netR: number | null;
  /** The modelled cost, in R. */
  costR: number | null;
  /** The features at entry. */
  features: FeatureVector | null;
  /** The highest-NIS headline published DURING the trade. */
  newsDuringTrade: { nis: number; publishedAt: number } | null;
  /** The regime label at entry. */
  regimeAtEntry: string | null;
  /** The regime label at exit. */
  regimeAtExit: string | null;
  /** The maximum favourable excursion, in R. */
  mfeR: number | null;
  /** The maximum adverse excursion, in R. */
  maeR: number | null;
  /** The feature coverage at entry: measured over total. */
  coverage: { measured: number; total: number } | null;
}

export interface ReviewVerdict {
  failureClass: LabFailureClass;
  /** A sentence saying why. */
  note: string;
  /** True when the review says the model was right and nothing should change. */
  noFault: boolean;
}

/**
 * Classify one trade.
 *
 * The order of the tests is the order of specificity, and it matters: a trade
 * that was stopped by a headline is a `news-shock`, not a `stop-too-tight`,
 * even though it was also stopped. The most specific cause wins.
 */
export function classifyTrade(e: ReviewEvidence): ReviewVerdict {
  // ── A WIN ────────────────────────────────────────────────────────────────
  // There is no failure to classify. The review says so, and says the model
  // should not change.
  if (e.outcome === 1) {
    return {
      failureClass: 'no-fault-no-change',
      note:
        `Won ${fmtR(e.netR)} net as planned (${e.outcomeLabel}). ` +
        `Nothing to change: a win is not evidence that a rule is right.`,
      noFault: true,
    };
  }

  // ── AN EXPIRY ────────────────────────────────────────────────────────────
  // Censored. It is included in the expectancy and excluded from the win rate
  // and the Brier, and it is not a failure of the model.
  if (e.outcome === null) {
    return {
      failureClass: 'variance',
      note:
        `Expired without hitting a level (${e.outcomeLabel}). This is a CENSORED observation: ` +
        `it counts towards the expectancy and is excluded from the win rate and the Brier. ` +
        `No fault found, no change.`,
      noFault: true,
    };
  }

  // ── A LOSS ───────────────────────────────────────────────────────────────
  // The tests below run most-specific first.

  // 1. A data problem. The trade was decided on inputs that were stale or
  //    missing, so the outcome says nothing about the rule.
  if (e.coverage && e.coverage.total > 0) {
    const frac = e.coverage.measured / e.coverage.total;
    if (frac < 0.6) {
      return {
        failureClass: 'data-problem',
        note:
          `Only ${e.coverage.measured} of ${e.coverage.total} features could be measured at entry ` +
          `(${(frac * 100).toFixed(0)}%). The trade was decided on a thin vector, so the loss says ` +
          `nothing about the rule. This row must not train anything.`,
        noFault: false,
      };
    }
  }

  // 2. A news shock. A headline landed inside the trade window.
  if (e.newsDuringTrade && e.newsDuringTrade.nis >= NEWS.SEVERITY.HIGH) {
    return {
      failureClass: 'news-shock',
      note:
        `A headline with a news-impact score of ${e.newsDuringTrade.nis.toFixed(0)} landed while the ` +
        `trade was open. The setup was fine; the catalyst was new information.`,
      noFault: false,
    };
  }

  // 3. Cost drag. The trade was fine and the costs ate it.
  if (e.grossR !== null && e.netR !== null && e.grossR > 0 && e.netR <= 0) {
    return {
      failureClass: 'cost-drag',
      note:
        `The trade was ${fmtR(e.grossR)} gross and ${fmtR(e.netR)} after costs. The costs ate the ` +
        `whole move, so this is a cost problem, not a signal problem.`,
      noFault: false,
    };
  }

  // 4. The stop was too tight. The stop sat inside the noise band.
  if (e.features) {
    const atrPct = e.features.timeframes.atrPct5m.value;
    const entry = e.features.structure.vwapDistFrac.at;
    void entry;
    if (atrPct !== null && atrPct > 0 && e.features.structure.liqPoolDistFrac.value !== null) {
      // The stop distance is not in the vector, so the test uses the excursion:
      // a stop taken at a shallow adverse excursion means the stop was inside
      // the noise rather than at the intended distance.
      if (e.maeR !== null && e.maeR > -1) {
        return {
          failureClass: 'stop-too-tight',
          note:
            `The stop was taken at ${e.maeR.toFixed(2)} R of adverse excursion — inside the 1 R the ` +
            `plan budgeted. The stop was sitting in the noise.`,
          noFault: false,
        };
      }
    }
  }

  // 5. The regime changed under the trade.
  if (e.regimeAtEntry && e.regimeAtExit && e.regimeAtEntry !== e.regimeAtExit) {
    return {
      failureClass: 'regime-misread',
      note:
        `The regime was "${e.regimeAtEntry}" at entry and "${e.regimeAtExit}" at exit. The market ` +
        `changed shape under the trade.`,
      noFault: false,
    };
  }

  // 6. Bad timing. The entry was late — the price had already gone.
  const displacement = e.features?.structure.displacementX.value ?? null;
  if (displacement !== null && displacement >= 1) {
    return {
      failureClass: 'bad-timing',
      note:
        `Price had already travelled ${displacement.toFixed(2)}× the local range away from the zone ` +
        `by the time the entry filled. The setup was real; the entry was late.`,
      noFault: false,
    };
  }

  // 7. Variance. The engine was right and the market was not. This is the
  //    common case, and the review says so.
  const mfe = e.mfeR;
  const note =
    mfe !== null && mfe > 0
      ? `The trade reached ${mfe.toFixed(2)} R in our favour before being stopped. The rule was ` +
        `working; the outcome was variance. No fault, no change.`
      : `The trade was stopped with no fault found: no news shock, no regime change, no timing ` +
        `problem and no cost problem. The outcome was variance. No fault, no change.`;
  return { failureClass: 'variance', note, noFault: true };
}

/**
 * The probability at or above which a trade was "confident".
 *
 * Used only to describe a review. It is NOT the actionability gate: a review
 * describes what happened, and the gate decides what to do next.
 */
export function confidentThreshold(): number {
  return MIND.BAND_HIGH;
}

function fmtR(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)} R`;
}
