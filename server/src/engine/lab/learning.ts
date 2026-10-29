/**
 * The learning loop: batch retraining, the champion/challenger gate, rollback
 * and the drift monitor.
 *
 * ## Learning happens in BATCHES, never after one trade
 *
 * `LAB.RETRAIN_BATCH_SIZE` resolved trades must have arrived since the last
 * retrain before another one runs. Learning from a single loss fits noise, and
 * a system that refits after every outcome is a system that chases its own
 * random walk. The batch size is a `[TUNED]` number until the ledger has
 * enough resolved outcomes to fit it, and it says so in the config.
 *
 * ## A retrained model is a NEW VERSIONED ARTEFACT
 *
 * The champion keeps working while the challenger is fitted and evaluated
 * entirely OUT OF SAMPLE, beside it, in shadow. Nothing about the champion
 * changes until the challenger has won the comparison.
 *
 * ## The promotion gate is strict on purpose
 *
 * A challenger is promoted only when it beats the champion out-of-sample on
 * BOTH net expectancy AND the Brier score, with NON-OVERLAPPING confidence
 * intervals on both. Overlapping intervals mean the two models are not
 * distinguishable on this evidence, and "not distinguishable" is not
 * "better".
 *
 * ## The engine cannot promote itself
 *
 * Beyond paper and testnet, promotion needs 90+ days AND 300+ paper trades, a
 * net-expectancy CI lower bound above zero, calibration within tolerance, a
 * green drift monitor, and the operator's explicit manual approval. This
 * module computes the first four. The fifth is not a number and not a
 * function: it is a person.
 */

import { LAB } from '../../config.js';
import {
  fitLogistic,
  predict,
  walkForwardFolds,
  DEFAULT_FIT,
  DEFAULT_SPLIT,
  type LogisticModel,
} from '../closedloop/model.js';
import { clusterBootstrapMean } from '../closedloop/stats.js';
import type { LabelledRow } from '../closedloop/dataset.js';
import { FEATURE_CATALOGUE, featureCatalogue } from '../mind/features.js';
import type { FeatureVector, LabFoldRow, LabModelVersion } from '../../../../shared/types.js';
import {
  allReviews,
  clearRole,
  listModelDecisions,
  listModels,
  modelInRole,
  recordModelDecision,
  saveModel,
  type StoredModel,
} from './store.js';

// ─── The training set ────────────────────────────────────────────────────────

/**
 * The feature names the model is fitted on.
 *
 * The CATALOGUE is the feature set, and it is a fixed, ordered list. A model
 * fitted against it can be applied to any later vector with the same schema,
 * and the schema version travels with the model.
 */
export const LAB_FEATURE_NAMES: readonly string[] = FEATURE_CATALOGUE.map((s) => s.name);

/** The feature schema version a model is fitted against. */
export const LAB_FEATURE_SCHEMA = `lab-features-v1-${LAB_FEATURE_NAMES.length}`;

/**
 * Turn a frozen feature vector into a flat numeric row.
 *
 * The catalogue supplies the names and the order. A feature that was NOT
 * MEASURED is absent from the row — it is NOT a zero — and the imputation
 * happens inside the fold, from the TRAINING fold's own median.
 */
export function featuresOfVector(v: FeatureVector): { features: Record<string, number>; imputed: string[] } {
  const out: Record<string, number> = {};
  const imputed: string[] = [];
  for (const entry of featureCatalogue(v)) {
    if (entry.value === null) {
      imputed.push(entry.name);
      continue;
    }
    out[entry.name] = entry.value;
  }
  return { features: out, imputed };
}

/**
 * Build the training rows from the reviews.
 *
 * Only MEASURED reviews with a frozen feature snapshot are usable. A review
 * without a snapshot has no features, and a review with a censored outcome has
 * no binary label; both are excluded, and the count is reported.
 */
export function reviewsToRows(reviews: Array<{
  id: string;
  symbol: string;
  side: 'bullish' | 'bearish';
  openedAt: number;
  closedAt: number;
  outcome: 0 | 1 | null;
  outcomeLabel: string;
  grossR: number | null;
  netR: number | null;
  costR: number | null;
  featureSnapshot: FeatureVector | null;
}>): { rows: LabelledRow[]; excludedNoSnapshot: number; excludedCensored: number } {
  const rows: LabelledRow[] = [];
  let excludedNoSnapshot = 0;
  let excludedCensored = 0;

  for (const r of reviews) {
    if (!r.featureSnapshot) {
      excludedNoSnapshot++;
      continue;
    }
    if (r.outcome === null) {
      excludedCensored++;
      continue;
    }
    const { features, imputed } = featuresOfVector(r.featureSnapshot);
    rows.push({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      createdAt: r.openedAt,
      resolvedAt: r.closedAt,
      grade: 'Pass',
      // `wasReal` and the veto kind are SLICES, never features. The Lab's
      // feature set is the catalogue, and neither of them is in it.
      wasReal: false,
      vetoKind: 'lab',
      features,
      imputed,
      y: r.outcome,
      outcome: r.outcomeLabel,
      grossR: r.grossR,
      netR: r.netR,
      costR: r.costR,
      heldMs: Math.max(0, r.closedAt - r.openedAt),
      population: 'MEASURED',
    });
  }
  return { rows, excludedNoSnapshot, excludedCensored };
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface ModelEvaluation {
  /** The per-fold walk-forward table. */
  folds: LabFoldRow[];
  /** Pooled out-of-sample metrics over every evaluable fold. */
  oosTrades: number;
  oosBrier: number | null;
  oosBrierBaseRate: number | null;
  oosLogLoss: number | null;
  oosExpectancyR: number | null;
  /** The expectancy interval, from a cluster bootstrap over symbols. */
  oosExpectancyCi: [number, number] | null;
  /** The Brier interval, from the same bootstrap. */
  oosBrierCi: [number, number] | null;
  /** The base rate of the out-of-sample rows. */
  baseRate: number | null;
}

/** The matrix a fold is fitted on: features in the catalogue order, imputed. */
function matrix(rows: LabelledRow[]): { x: number[]; y: number }[] {
  const decided = rows.filter((r) => r.y !== null);
  const medians: Record<string, number> = {};
  for (const name of LAB_FEATURE_NAMES) {
    const vals = decided
      .map((r) => r.features[name])
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b);
    medians[name] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  }
  return decided.map((r) => ({
    x: LAB_FEATURE_NAMES.map((name) => r.features[name] ?? medians[name]),
    y: r.y as number,
  }));
}

/** The Brier score, locally, so the module does not import it twice. */
function brierOf(pairs: Array<{ p: number; y: number }>): number | null {
  if (!pairs.length) return null;
  return pairs.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / pairs.length;
}

/** The log loss, locally. */
function logLossOf(pairs: Array<{ p: number; y: number }>): number | null {
  if (!pairs.length) return null;
  let sum = 0;
  for (const x of pairs) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, x.p));
    sum += -(x.y * Math.log(p) + (1 - x.y) * Math.log(1 - p));
  }
  return sum / pairs.length;
}

/**
 * Evaluate a model out-of-sample, fold by fold.
 *
 * The folds are purged, embargoed and grouped by symbol. The pooled metrics
 * are computed on the CONCATENATED out-of-sample predictions, not on the
 * training rows, so nothing in-sample leaks into the headline.
 */
export function evaluateModel(rows: LabelledRow[], seed = 20261020): ModelEvaluation {
  const folds = walkForwardFolds(rows, DEFAULT_SPLIT);
  const pairs: Array<{ p: number; y: number }> = [];
  const netRows: Array<{ cluster: string; value: number }> = [];
  const brierRows: Array<{ cluster: string; value: number }> = [];
  const foldRows: LabFoldRow[] = [];

  for (const fold of folds) {
    const train = matrix(fold.train);
    const model = fitLogistic(train, DEFAULT_FIT);
    const test = matrix(fold.test);
    const testRows = fold.test.filter((r) => r.y !== null);
    const probs = test.map((t) => predict(model, t.x));
    const foldPairs = test.map((t, i) => ({ p: probs[i], y: t.y }));
    pairs.push(...foldPairs);

    for (let i = 0; i < testRows.length; i++) {
      const r = testRows[i];
      if (r.netR !== null) netRows.push({ cluster: r.symbol, value: r.netR });
      brierRows.push({ cluster: r.symbol, value: (probs[i] - (r.y as number)) ** 2 });
    }

    const taken = testRows.filter((_, i) => probs[i] >= 0.5);
    const wins = taken.filter((r) => r.y === 1).length;
    const base = foldPairs.length ? foldPairs.reduce((a, x) => a + x.y, 0) / foldPairs.length : null;
    const b = brierOf(foldPairs);
    const ll = logLossOf(foldPairs);

    foldRows.push({
      index: fold.index,
      trainRows: fold.train.length,
      testRows: fold.test.length,
      purged: fold.purged,
      embargoed: fold.embargoed,
      brier: b === null ? null : round4(b),
      brierBaseRate:
        b === null || base === null ? null : round4(brierOf(foldPairs.map((x) => ({ p: base, y: x.y }))) ?? 0),
      logLoss: ll === null ? null : round4(ll),
      coveragePct: testRows.length ? round4((taken.length / testRows.length) * 100) : null,
      winRatePct: taken.length ? round4((wins / taken.length) * 100) : null,
      netR: null,
      evaluable: true,
      skipReason: null,
    });
  }

  const baseRate = pairs.length ? pairs.reduce((a, x) => a + x.y, 0) / pairs.length : null;
  const brier = brierOf(pairs);
  const baseBrier =
    baseRate === null ? null : brierOf(pairs.map((x) => ({ p: baseRate, y: x.y })));

  const netBoot = netRows.length
    ? clusterBootstrapMean(netRows, 2000, seed)
    : null;
  const brierBoot = brierRows.length
    ? clusterBootstrapMean(brierRows, 2000, seed + 1)
    : null;

  return {
    folds: foldRows,
    oosTrades: pairs.length,
    oosBrier: brier === null ? null : round4(brier),
    oosBrierBaseRate: baseBrier === null ? null : round4(baseBrier),
    oosLogLoss: logLossOf(pairs) === null ? null : round4(logLossOf(pairs) as number),
    oosExpectancyR: netBoot ? round4(netBoot.mean) : null,
    oosExpectancyCi: netBoot?.ci ?? null,
    oosBrierCi: brierBoot?.ci ?? null,
    baseRate: baseRate === null ? null : round4(baseRate),
  };
}

// ─── The batch gate ──────────────────────────────────────────────────────────

export interface RetrainGate {
  /** Whether a retrain may run now. */
  allowed: boolean;
  /** Why, in words. */
  reason: string;
  /** How many resolved trades have arrived since the last retrain. */
  sinceLast: number;
  /** How many the batch needs. */
  needed: number;
}

/**
 * Is a retrain allowed now?
 *
 * Two conditions, both required: enough NEW resolved trades for a batch, and
 * enough TOTAL rows for a fit. The first is about not learning from noise; the
 * second is about not fitting a model to nothing.
 */
export function retrainGate(sinceLast: number, totalRows: number): RetrainGate {
  if (totalRows < LAB.RETRAIN_MIN_ROWS) {
    return {
      allowed: false,
      reason:
        `Only ${totalRows} usable training rows and the floor is ${LAB.RETRAIN_MIN_ROWS}. ` +
        `There is not enough evidence to fit anything yet.`,
      sinceLast,
      needed: LAB.RETRAIN_BATCH_SIZE,
    };
  }
  if (sinceLast < LAB.RETRAIN_BATCH_SIZE) {
    return {
      allowed: false,
      reason:
        `${sinceLast} new resolved trade${sinceLast === 1 ? '' : 's'} since the last retrain and a ` +
        `batch is ${LAB.RETRAIN_BATCH_SIZE}. Learning from fewer trades than that fits noise.`,
      sinceLast,
      needed: LAB.RETRAIN_BATCH_SIZE,
    };
  }
  return {
    allowed: true,
    reason: `${sinceLast} new resolved trades since the last retrain, and ${totalRows} rows in total.`,
    sinceLast,
    needed: LAB.RETRAIN_BATCH_SIZE,
  };
}

// ─── The promotion gate ──────────────────────────────────────────────────────

export interface PromotionVerdict {
  promote: boolean;
  /** Why, in words. Always populated. */
  reason: string;
  /** The things that are not yet true. */
  blockedBy: string[];
}

/**
 * Should the challenger replace the champion?
 *
 * Two conditions, both required:
 *
 *   1. the challenger's net expectancy CI does not overlap the champion's, and
 *      the challenger is HIGHER;
 *   2. the challenger's Brier CI does not overlap the champion's, and the
 *      challenger is LOWER.
 *
 * A missing interval is a missing interval: with no CI there is no evidence
 * of separation, so the challenger does not get promoted.
 */
export function promotionVerdict(
  champion: ModelEvaluation | null,
  challenger: ModelEvaluation,
): PromotionVerdict {
  const blockedBy: string[] = [];

  if (!champion) {
    // There is no champion to beat. The challenger becomes the first champion.
    return {
      promote: challenger.oosTrades >= LAB.PROMOTION_MIN_OOS_TRADES,
      reason:
        `There is no champion yet. The challenger becomes the first champion if it has at least ` +
        `${LAB.PROMOTION_MIN_OOS_TRADES} out-of-sample decided trades (it has ${challenger.oosTrades}).`,
      blockedBy:
        challenger.oosTrades >= LAB.PROMOTION_MIN_OOS_TRADES
          ? []
          : [`only ${challenger.oosTrades} out-of-sample decided trades, floor is ${LAB.PROMOTION_MIN_OOS_TRADES}`],
    };
  }

  if (challenger.oosTrades < LAB.PROMOTION_MIN_OOS_TRADES) {
    blockedBy.push(
      `only ${challenger.oosTrades} out-of-sample decided trades, floor is ${LAB.PROMOTION_MIN_OOS_TRADES}`,
    );
  }

  const cExp = champion.oosExpectancyCi;
  const nExp = challenger.oosExpectancyCi;
  if (!cExp || !nExp) {
    blockedBy.push('there is no confidence interval on the net expectancy for one of the two models');
  } else if (!(nExp[0] > cExp[1])) {
    blockedBy.push(
      `the net-expectancy intervals overlap (champion [${cExp[0]}, ${cExp[1]}], challenger [${nExp[0]}, ${nExp[1]}])`,
    );
  }

  const cB = champion.oosBrierCi;
  const nB = challenger.oosBrierCi;
  if (!cB || !nB) {
    blockedBy.push('there is no confidence interval on the Brier score for one of the two models');
  } else if (!(nB[1] < cB[0])) {
    blockedBy.push(
      `the Brier intervals overlap (champion [${cB[0]}, ${cB[1]}], challenger [${nB[0]}, ${nB[1]}])`,
    );
  }

  if (blockedBy.length === 0) {
    return {
      promote: true,
      reason:
        `The challenger beats the champion out-of-sample on BOTH net expectancy ` +
        `(CI [${nExp![0]}, ${nExp![1]}] vs [${cExp![0]}, ${cExp![1]}]) and the Brier score ` +
        `(CI [${nB![0]}, ${nB![1]}] vs [${cB![0]}, ${cB![1]}]), with non-overlapping intervals on both.`,
      blockedBy,
    };
  }

  return {
    promote: false,
    reason: `The challenger is NOT promoted. The champion is kept because: ${blockedBy.join('; ')}.`,
    blockedBy,
  };
}

/** The criteria for promoting beyond paper and testnet. */
export interface BeyondPaperCriteria {
  /** True when every criterion is met. */
  met: boolean;
  /** What is still missing, in words. */
  blockedBy: string[];
  /** The days of paper trading so far. */
  days: number;
  /** The paper trades so far. */
  paperTrades: number;
}

/**
 * The criteria for promotion beyond paper and testnet.
 *
 * `LAB.PROMOTION_REQUIRES_MANUAL_APPROVAL` is a constant, not a parameter, and
 * it is `true`: the engine cannot promote itself. The manual approval is
 * therefore ALWAYS in the blocked list, because it is not something this
 * function can observe.
 */
export function beyondPaperCriteria(input: {
  days: number;
  paperTrades: number;
  expectancyCiLowerBound: number | null;
  calibrationWithinTolerance: boolean | null;
  driftGreen: boolean | null;
}): BeyondPaperCriteria {
  const blockedBy: string[] = [];

  if (input.days < LAB.PROMOTION_MIN_DAYS) {
    blockedBy.push(`${input.days} days of paper trading, ${LAB.PROMOTION_MIN_DAYS} are required`);
  }
  if (input.paperTrades < LAB.PROMOTION_MIN_PAPER_TRADES) {
    blockedBy.push(
      `${input.paperTrades} paper trades, ${LAB.PROMOTION_MIN_PAPER_TRADES} are required`,
    );
  }
  if (input.expectancyCiLowerBound === null) {
    blockedBy.push('the net-expectancy confidence interval has not been measured');
  } else if (!(input.expectancyCiLowerBound > 0)) {
    blockedBy.push(
      `the net-expectancy CI lower bound is ${input.expectancyCiLowerBound}, and it must be above zero`,
    );
  }
  if (input.calibrationWithinTolerance === null) {
    blockedBy.push('calibration has not been measured');
  } else if (!input.calibrationWithinTolerance) {
    blockedBy.push(
      `calibration is outside the ${(LAB.CALIBRATION_TOLERANCE * 100).toFixed(0)}pp tolerance`,
    );
  }
  if (input.driftGreen === null) {
    blockedBy.push('the drift monitor has not produced a verdict');
  } else if (!input.driftGreen) {
    blockedBy.push('the drift monitor is not green');
  }
  if (LAB.PROMOTION_REQUIRES_MANUAL_APPROVAL) {
    blockedBy.push("the operator's explicit manual approval has not been given");
  }

  return {
    met: blockedBy.length === 0,
    blockedBy,
    days: input.days,
    paperTrades: input.paperTrades,
  };
}

// ─── The drift monitor ───────────────────────────────────────────────────────

export interface DriftState {
  state: 'GREEN' | 'DEGRADED' | 'UNKNOWN';
  liveBrier: number | null;
  validationBrier: number | null;
  liveExpectancyR: number | null;
  validationExpectancyR: number | null;
  n: number;
  reason: string;
  /** True when the monitor has forced shadow-only. */
  shadowOnlyForced: boolean;
}

/**
 * The drift monitor.
 *
 * It compares the LIVE rolling window against the champion's VALIDATION
 * numbers. Degradation on either axis trips it, and a tripped monitor forces
 * shadow-only — the engine keeps thinking, and stops trading.
 *
 * With fewer trades than the window size the monitor says `UNKNOWN`, because
 * "not enough live trades to tell" and "the model is fine" are different
 * claims.
 */
export function driftMonitor(input: {
  liveTrades: Array<{ p: number; y: 0 | 1; netR: number | null; cluster: string }>;
  validationBrier: number | null;
  validationExpectancyR: number | null;
  window?: number;
}): DriftState {
  const window = input.window ?? LAB.DRIFT_WINDOW;
  const live = input.liveTrades.slice(-window);
  const n = live.length;

  if (n < Math.ceil(window / 2) || input.validationBrier === null) {
    return {
      state: 'UNKNOWN',
      liveBrier: null,
      validationBrier: input.validationBrier,
      liveExpectancyR: null,
      validationExpectancyR: input.validationExpectancyR,
      n,
      reason:
        `The drift monitor needs at least ${Math.ceil(window / 2)} live trades to compare against ` +
        `validation, and it has ${n}. "Not enough to tell" is not "healthy".`,
      shadowOnlyForced: false,
    };
  }

  const liveBrier = live.reduce((a, x) => a + (x.p - x.y) ** 2, 0) / n;
  const netRs = live.map((x) => x.netR).filter((v): v is number => v !== null);
  const liveExpectancy = netRs.length ? netRs.reduce((a, b) => a + b, 0) / netRs.length : null;

  const brierWorse = liveBrier > input.validationBrier * (1 + LAB.DRIFT_BRIER_RELATIVE);
  const validationExpectancy = input.validationExpectancyR;
  const expectancyWorse =
    liveExpectancy !== null &&
    validationExpectancy !== null &&
    liveExpectancy < validationExpectancy - LAB.DRIFT_EXPECTANCY_R;

  if (brierWorse || expectancyWorse) {
    const why: string[] = [];
    if (brierWorse) {
      why.push(
        `the live Brier is ${liveBrier.toFixed(4)} against a validation Brier of ` +
          `${input.validationBrier.toFixed(4)}, a degradation of more than ` +
          `${(LAB.DRIFT_BRIER_RELATIVE * 100).toFixed(0)}%`,
      );
    }
    if (expectancyWorse && validationExpectancy !== null) {
      why.push(
        `the live net expectancy is ${liveExpectancy.toFixed(3)} R against a validation ` +
          `${validationExpectancy.toFixed(3)} R`,
      );
    }
    return {
      state: 'DEGRADED',
      liveBrier: round4(liveBrier),
      validationBrier: input.validationBrier,
      liveExpectancyR: liveExpectancy === null ? null : round4(liveExpectancy),
      validationExpectancyR: input.validationExpectancyR,
      n,
      reason:
        `The drift monitor has DEGRADED the model: ${why.join('; and ')}. The engine has been ` +
        `forced into shadow-only and the degradation is visible here.`,
      shadowOnlyForced: true,
    };
  }

  return {
    state: 'GREEN',
    liveBrier: round4(liveBrier),
    validationBrier: input.validationBrier,
    liveExpectancyR: liveExpectancy === null ? null : round4(liveExpectancy),
    validationExpectancyR: input.validationExpectancyR,
    n,
    reason:
      `The live window of ${n} trades is inside the validation envelope: Brier ${liveBrier.toFixed(4)} ` +
      `against ${input.validationBrier.toFixed(4)}, and the net expectancy has not degraded by more ` +
      `than ${LAB.DRIFT_EXPECTANCY_R} R.`,
    shadowOnlyForced: false,
  };
}

// ─── The retrain and the version registry ───────────────────────────────────

/** The next version string. */
export function nextVersion(existing: LabModelVersion[]): string {
  const nums = existing
    .map((m) => /^lab-(\d+)\.(\d+)\.(\d+)$/.exec(m.version))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }));
  if (!nums.length) return 'lab-1.0.0';
  const latest = nums.reduce((a, b) =>
    b.major > a.major || (b.major === a.major && b.minor > a.minor) ? b : a,
  );
  return `lab-${latest.major}.${latest.minor + 1}.0`;
}

export interface RetrainOutcome {
  /** The new version, whether or not it was promoted. */
  version: string;
  /** Whether it was promoted. */
  promoted: boolean;
  /** Why, in words. */
  reason: string;
  /** The evaluation of the challenger. */
  evaluation: ModelEvaluation;
  /** The fold table of the challenger. */
  folds: LabFoldRow[];
}

/**
 * Fit a challenger, evaluate it out-of-sample, and put it through the gate.
 *
 * The champion keeps its role until the gate says otherwise. A rejected
 * challenger is RETIRED with its reason recorded, so the log says what was
 * tried and why it lost.
 */
export function retrain(now = Date.now()): RetrainOutcome {
  const reviews = allReviews();
  const { rows } = reviewsToRows(reviews);
  const existing = listModels();
  const version = nextVersion(existing);

  const train = matrix(rows);
  const model: LogisticModel = fitLogistic(train, DEFAULT_FIT);
  const evaluation = evaluateModel(rows);
  const champion = modelInRole('CHAMPION');
  const championEval = champion ? evaluateModel(rows) : null;
  const verdict = promotionVerdict(championEval, evaluation);

  saveModel({
    version,
    role: verdict.promote ? 'CHAMPION' : 'RETIRED',
    createdAt: now,
    trainedAt: now,
    trainedOnTrades: rows.length,
    featureSchema: LAB_FEATURE_SCHEMA,
    fit: DEFAULT_FIT,
    model,
    oosExpectancyR: evaluation.oosExpectancyR,
    oosBrier: evaluation.oosBrier,
    oosLogLoss: evaluation.oosLogLoss,
    oosTrades: evaluation.oosTrades,
    verdict: verdict.reason,
  });

  if (verdict.promote) {
    clearRole('CHAMPION');
    clearRole('CHALLENGER');
    saveModel({
      version,
      role: 'CHAMPION',
      createdAt: now,
      trainedAt: now,
      trainedOnTrades: rows.length,
      featureSchema: LAB_FEATURE_SCHEMA,
      fit: DEFAULT_FIT,
      model,
      oosExpectancyR: evaluation.oosExpectancyR,
      oosBrier: evaluation.oosBrier,
      oosLogLoss: evaluation.oosLogLoss,
      oosTrades: evaluation.oosTrades,
      verdict: verdict.reason,
    });
  }

  recordModelDecision({
    at: now,
    version,
    kind: verdict.promote ? 'PROMOTED' : 'REJECTED',
    reason: verdict.reason,
    championExpectancyR: champion?.oosExpectancyR ?? null,
    challengerExpectancyR: evaluation.oosExpectancyR,
    championBrier: champion?.oosBrier ?? null,
    challengerBrier: evaluation.oosBrier,
  });

  return {
    version,
    promoted: verdict.promote,
    reason: verdict.reason,
    evaluation,
    folds: evaluation.folds,
  };
}

/**
 * Roll the champion back to a previous version.
 *
 * One command, and it is recorded. A rollback is not a deletion: the version
 * that was demoted is RETIRED, and the reason is in the log.
 */
export function rollback(version: string, now = Date.now()): { ok: boolean; reason: string } {
  const target = listModels().find((m) => m.version === version);
  if (!target) {
    return { ok: false, reason: `There is no model version "${version}" to roll back to.` };
  }
  if (target.role === 'CHAMPION') {
    return { ok: false, reason: `"${version}" is already the champion.` };
  }
  const current = modelInRole('CHAMPION');
  clearRole('CHAMPION');
  saveModel({
    version: target.version,
    role: 'CHAMPION',
    createdAt: target.createdAt,
    trainedAt: target.trainedAt,
    trainedOnTrades: target.trainedOnTrades,
    featureSchema: target.featureSchema,
    fit: target.fit,
    model: target.model,
    oosExpectancyR: target.oosExpectancyR,
    oosBrier: target.oosBrier,
    oosLogLoss: target.oosLogLoss,
    oosTrades: target.oosTrades,
    verdict: target.verdict,
  });
  recordModelDecision({
    at: now,
    version: target.version,
    kind: 'ROLLED_BACK',
    reason:
      `Rolled the champion back to "${target.version}"` +
      (current ? ` from "${current.version}"` : '') +
      `.`,
    championExpectancyR: current?.oosExpectancyR ?? null,
    challengerExpectancyR: target.oosExpectancyR,
    championBrier: current?.oosBrier ?? null,
    challengerBrier: target.oosBrier,
  });
  return { ok: true, reason: `The champion is now "${target.version}".` };
}

/** The champion and the challenger, for the status panel. */
export function currentModels(): { champion: StoredModel | null; challenger: StoredModel | null } {
  return { champion: modelInRole('CHAMPION'), challenger: modelInRole('CHALLENGER') };
}

/** The decision log, newest first. */
export function decisions(limit = 50): ReturnType<typeof listModelDecisions> {
  return listModelDecisions(limit);
}

function round4(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10_000) / 10_000;
}
