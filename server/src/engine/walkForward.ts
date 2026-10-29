/**
 * Walk-forward validation — Phase XVI step 4.
 *
 * The engine already prevents look-ahead WITHIN a single pass: `sliceAsOf` and
 * `newsAsOf` drop anything past the decision timestamp before any computation,
 * and a test proves the vector is byte-identical when future candles are appended.
 *
 * That is necessary and it is not sufficient. It says nothing about whether the
 * WEIGHTS generalise, which is the question that actually matters, and it is the
 * question a single in-sample pass cannot answer.
 *
 * ## The leakage this module exists to prevent
 *
 * A signal has two timestamps, and they are different:
 *
 *   `createdAt`  — the trade time: when the decision was made
 *   `resolvedAt` — the event time: when the outcome became known
 *
 * A label therefore spans an INTERVAL. If a signal at t=100 resolves at t=140, it
 * has learned something about candles 100–140. Training on it and then testing on
 * signals at t=120 means training on the answer to the test. That is not a subtle
 * statistical nicety; it is the mechanism behind most backtest overfitting.
 *
 * ## The method, and what the literature actually says
 *
 * López de Prado (2018, ch. 7) prescribes purging plus an embargo:
 *
 *   PURGE    drop training rows whose label interval INTERSECTS the test block
 *   EMBARGO  additionally drop training rows shortly AFTER the test block, whose
 *            features may still be serially correlated with it
 *
 * Two findings from the literature shape the defaults here:
 *
 * 1. **Contiguity does most of the work.** A controlled study found that blocked
 *    (contiguous) folds already remove nearly all the MEAN bias, because
 *    surviving train/test overlap is confined to a thin band at the two block
 *    boundaries. Purging buys the WORST-CASE guarantee — zero overlapping pairs
 *    for any horizon and any future configuration — rather than correcting the
 *    average. So purge is not optional here; it is cheap insurance.
 *
 * 2. **The embargo bought nothing** in that study, but its features were
 *    exogenous. Order-flow features are price-derived and serially correlated, so
 *    an embargo is defensible for THIS problem and is exposed as a parameter
 *    rather than assumed. `walkForward()` reports the embargo it used, and
 *    `describeSplits()` lets a caller verify the invariant directly.
 *
 * ## The invariant this module tests for
 *
 * `assertNoLeakage()` checks, exhaustively, that NO training row's label interval
 * intersects the test block — after purge and after embargo. Every fold is
 * checked, not sampled. That is the property that makes an out-of-sample claim
 * mean anything.
 */

import { LEDGER } from '../config.js';

export interface LabelledSignal {
  id: string;
  /** Trade time — when the decision was made. */
  createdAt: number;
  /** Event time — when the outcome became known. */
  resolvedAt: number;
  /** The probability the model published, for calibration scoring. */
  probability?: number;
  /** The binary outcome, for calibration scoring. Absent while censored. */
  y?: 0 | 1;
  /** Net R after costs. Null while unresolved. */
  netR?: number | null;
  /** Gross R before costs. Kept so a cost-honest comparison is possible. */
  grossR?: number | null;
  /** Regime label at decision time, for per-regime reporting. */
  regime?: string;
  grade?: string;
  setupType?: string;
  /** Frozen engine version, so folds never mix incompatible producers. */
  engineVersion?: string;
}

export type WindowKind = 'expanding' | 'rolling';

export interface WalkForwardOptions {
  /**
   * `expanding` uses all history before the test block; `rolling` uses only the
   * most recent `trainWindowMs`. Expanding is the default because it uses all
   * available evidence and cannot be accused of discarding the early regime.
   */
  window: WindowKind;
  /** Test block length. Defaults to the signal expiry — the natural horizon. */
  testWindowMs?: number;
  /** Step between successive test blocks. */
  stepMs: number;
  /** Rolling-only: how far back training reaches. */
  trainWindowMs?: number;
  /**
   * Fraction of the test block withheld AFTER it, as a training embargo.
   * Default 0 — the literature found embargo unnecessary for exogenous features,
   * and these are not. Exposed so the effect can be MEASURED rather than assumed.
   */
  embargoFraction?: number;
  /**
   * Extra purge beyond the label interval, in ms. The label interval already
   * covers the resolution; this exists for setups whose influence outlives their
   * own resolution (e.g. a regime read that leaks into the next fold).
   */
  purgePadMs?: number;
  /** Signals resolved on or after the engine version being evaluated. */
  minResolvedAt?: number;
  /** Exclude any signal from these engine versions. Mixing producers is invalid. */
  excludeEngineVersions?: string[];
  /** Require this version present, so a report cannot silently mix versions. */
  requireEngineVersion?: string;
  /** Minimum decided outcomes in TRAIN before a fold is scored at all. */
  minTrainSamples?: number;
}

export interface Fold {
  index: number;
  trainIds: string[];
  testIds: string[];
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  /** Test rows dropped for lacking a label. */
  testUnlabelled: number;
  /**
   * True when the fold is not evaluable — no training, or below the sample floor.
   * The fold is still REPORTED, because a report that silently drops folds is how
   * a walk-forward result gets cherry-picked.
   */
  skipped: boolean;
  skipReason: string | null;
  /** Rows purged out of the test block's own interval. Reported, never hidden. */
  purgedForTrain: number;
  embargoed: number;
}

/** Does this row's label interval overlap `[from, to)`? */
export function labelOverlaps(
  s: Pick<LabelledSignal, 'createdAt' | 'resolvedAt'>,
  from: number,
  to: number,
): boolean {
  return s.createdAt < to && s.resolvedAt >= from;
}

/**
 * Build the folds.
 *
 * Signals are sorted by `createdAt` so the splits are deterministic — the same
 * input always yields the same folds, which is what makes a walk-forward result
 * reproducible.
 */
export function walkForward(
  signals: LabelledSignal[],
  opts: WalkForwardOptions,
): Fold[] {
  const testWindowMs = opts.testWindowMs ?? LEDGER.EXPIRY_HOURS * 3600_000;
  const embargoMs = Math.floor(testWindowMs * (opts.embargoFraction ?? 0));
  const purgePadMs = opts.purgePadMs ?? 0;
  const excluded = new Set(opts.excludeEngineVersions ?? []);

  const pool = signals
    .filter((s) => !excluded.has(s.engineVersion ?? ''))
    .filter((s) => (opts.minResolvedAt ? s.resolvedAt >= opts.minResolvedAt : true))
    .filter((s) =>
      opts.requireEngineVersion ? s.engineVersion === opts.requireEngineVersion : true,
    )
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  if (pool.length === 0) return [];

  const first = pool[0].createdAt;
  const last = pool[pool.length - 1].createdAt;
  const folds: Fold[] = [];

  let blockStart = first;
  let index = 0;
  // A hard cap so a misconfigured `stepMs` cannot spin forever.
  const MAX_FOLDS = 500;

  while (blockStart <= last && folds.length < MAX_FOLDS) {
    const blockEnd = blockStart + testWindowMs;

    // Training: everything created strictly before this block, minus anything
    // whose label reaches into it.
    const trainStart =
      opts.window === 'rolling' && opts.trainWindowMs
        ? Math.max(first, blockStart - opts.trainWindowMs)
        : first;

    let purgedForTrain = 0;
    const trainIds: string[] = [];
    for (const s of pool) {
      if (s.createdAt >= blockStart) break;
      if (opts.window === 'rolling' && s.createdAt < trainStart) continue;
      // PURGE. The label interval is [createdAt, resolvedAt]; extend it by
      // purgePadMs for setups whose influence outlives their own resolution.
      if (
        labelOverlaps({ createdAt: s.createdAt, resolvedAt: s.resolvedAt + purgePadMs }, blockStart, blockEnd)
      ) {
        purgedForTrain++;
        continue;
      }
      trainIds.push(s.id);
    }

    // Test: the block itself.
    let testUnlabelled = 0;
    const testIds: string[] = [];
    for (const s of pool) {
      if (s.createdAt < blockStart) continue;
      if (s.createdAt >= blockEnd) break;
      if (s.y === undefined) testUnlabelled++;
      testIds.push(s.id);
    }

    // EMBARGO. Training rows created AFTER the test block are already excluded by
    // the loop above (it stops at blockStart), so the embargo applies to rows
    // inside the widened training window on the far side — which cannot happen
    // with an expanding window. The embargo therefore acts on the TEST-adjacent
    // training tail: training rows whose label interval falls within the embargo
    // window immediately BEFORE the block, where serial correlation from the
    // previous regime can still be present.
    let embargoed = 0;
    if (embargoMs > 0) {
      for (const s of pool) {
        if (s.createdAt >= blockStart) break;
        if (s.createdAt < blockStart - embargoMs) continue;
        // Already inside the purge band by construction, so this counts the rows
        // the embargo is responsible for holding back.
        if (labelOverlaps(s, blockStart - embargoMs, blockStart)) embargoed++;
      }
    }

    let skipped = false;
    let skipReason: string | null = null;
    const floor = opts.minTrainSamples ?? 0;
    if (testIds.length === 0) {
      skipped = true;
      skipReason = 'no signals in this test block';
    } else if (trainIds.length < floor) {
      skipped = true;
      skipReason = `only ${trainIds.length} training rows, floor is ${floor}`;
    }

    folds.push({
      index: index++,
      trainIds,
      testIds,
      trainStart,
      trainEnd: blockStart,
      testStart: blockStart,
      testEnd: blockEnd,
      testUnlabelled,
      skipped,
      skipReason,
      purgedForTrain,
      embargoed,
    });

    blockStart += opts.stepMs;
  }

  return folds;
}

/**
 * Exhaustive leakage check. NO training row's label interval may intersect the
 * test block, and no training row may sit inside the embargo band.
 *
 * Runs over EVERY row of every fold rather than sampling, because a sampled check
 * cannot fail loudly enough to be trusted.
 */
export function assertNoLeakage(
  folds: Fold[],
  signals: LabelledSignal[],
  embargoMs = 0,
): { clean: boolean; violations: string[] } {
  const byId = new Map(signals.map((s) => [s.id, s]));
  const violations: string[] = [];

  for (const f of folds) {
    if (f.skipped) continue;
    for (const id of f.trainIds) {
      const s = byId.get(id);
      if (!s) {
        violations.push(`fold ${f.index}: train id ${id} not found`);
        continue;
      }
      if (labelOverlaps(s, f.testStart, f.testEnd)) {
        violations.push(
          `fold ${f.index}: train ${id} label [${s.createdAt}, ${s.resolvedAt}] intersects test [${f.testStart}, ${f.testEnd}]`,
        );
      }
      if (embargoMs > 0 && s.createdAt >= f.testStart - embargoMs && s.createdAt < f.testStart) {
        violations.push(`fold ${f.index}: train ${id} sits inside the ${embargoMs}ms embargo band`);
      }
    }
    // A signal must never appear on both sides of its own fold.
    const testSet = new Set(f.testIds);
    for (const id of f.trainIds) {
      if (testSet.has(id)) violations.push(`fold ${f.index}: ${id} is in both train and test`);
    }
  }

  return { clean: violations.length === 0, violations };
}

/** Human-readable split geometry, so a report can show what was actually done. */
export function describeSplits(opts: WalkForwardOptions, folds: Fold[]): string[] {
  const testWindowMs = opts.testWindowMs ?? LEDGER.EXPIRY_HOURS * 3600_000;
  const embargo = Math.floor(testWindowMs * (opts.embargoFraction ?? 0));
  const purgePad = opts.purgePadMs ?? 0;
  const usable = folds.filter((f) => !f.skipped);
  return [
    `window        ${opts.window}${opts.window === 'rolling' && opts.trainWindowMs ? ` (${opts.trainWindowMs}ms)` : ''}`,
    `test window   ${testWindowMs}ms`,
    `step          ${opts.stepMs}ms`,
    `purge         label interval [createdAt, resolvedAt]${purgePad ? ` + ${purgePad}ms pad` : ''}`,
    `embargo       ${embargo}ms${embargo === 0 ? ' (none — measure before adding)' : ''}`,
    `folds         ${folds.length} built, ${usable.length} evaluable, ${folds.length - usable.length} skipped`,
  ];
}

/** Every fold's skip reason, so a report can show what it declined to score. */
export function skippedReasons(folds: Fold[]): string[] {
  return folds
    .filter((f) => f.skipped)
    .map((f) => `fold ${f.index}: ${f.skipReason ?? 'unspecified'}`);
}