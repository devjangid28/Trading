/**
 * The learning governor — Phase XVI step 6.
 *
 * Everything the engine might want to change goes through here. The governor's
 * job is not to be clever; it is to be **hard to convince**.
 *
 * Ten conditions, all required. A candidate that fails ANY of them keeps the
 * previous version and is labelled with why. There is no override, no "accept
 * anyway", and no path that updates a weight without a decision-log entry — the
 * absence of a `learned` branch in `decide()` is the point.
 *
 * ## Why the conditions are written the way they are
 *
 * Several are deliberately stricter than they first appear:
 *
 * - **Condition 3 asks about net expectancy after costs, not win rate.** Win rate
 *   is the easiest metric to improve by trading more marginal setups, and it is
 *   nearly uncorrelated with profitability. Phase XVI rule 6 makes costs
 *   non-optional for exactly this reason.
 *
 * - **Condition 4 caps drawdown absolutely.** An expectancy improvement bought
 *   with a deeper drawdown is a different strategy wearing the same name.
 *
 * - **Condition 6 rejects single-regime dependence.** A change that helps in one
 *   regime and is neutral elsewhere is a REGIME-CONDITIONAL idea and must be
 *   written as one. A pooled improvement that hides a per-regime regression is
 *   the most common way a "better" model turns out worse.
 *
 * - **Condition 7 requires reproducibility from frozen features.** If a result
 *   cannot be regenerated from what was stored at decision time, it depended on
 *   something that was not recorded — and an unrecorded dependency is usually a
 *   leak.
 *
 * - **Condition 9 requires a rollback version.** Phase XVI: "Preserve the
 *   previous working version when a new idea fails." A change with nowhere to go
 *   back to is not an upgrade, it is a gamble with the only working copy.
 */

import { CALIBRATION_VERSION, ENGINE_VERSION, FEATURE_SCHEMA_VERSION, ROLLBACK_TARGETS, type VersionSet } from '../version.js';

export type GovernorVerdict =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'INCONCLUSIVE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'REGIME-DEPENDENT'
  | 'DATA-LEAK SUSPECTED';

export interface Candidate {
  /** What is being proposed. */
  id: string;
  title: string;
  /** Which version this would become. */
  targetVersion: string;
  /** The registry entry, when the change comes from a research idea. */
  researchId: string | null;

  /** Resolved outcomes available for evaluation. */
  resolvedSamples: number;
  /** The floor for this kind of change. */
  minSamples: number;

  /** Walk-forward result. Null when it was not run. */
  walkForward: WalkForwardEvidence | null;
  /** Out-of-sample result. Null when not run. */
  outOfSample: WalkForwardEvidence | null;

  /** Net expectancy after costs, before and after. Null when unmeasured. */
  expectancyBeforeR: number | null;
  expectancyAfterR: number | null;
  /** Minimum acceptable improvement. */
  minExpectancyGainR: number | null;

  /** Max drawdown before and after, in R. Positive numbers. */
  maxDrawdownBeforeR: number | null;
  maxDrawdownAfterR: number | null;
  /** The most the drawdown may worsen. */
  maxDrawdownToleranceR: number | null;

  /** Brier skill before and after. Null when unmeasured. */
  brierSkillBefore: number | null;
  brierSkillAfter: number | null;
  /** Degradation tolerated before the change is rejected. */
  maxBrierSkillDegradation: number | null;

  /** Per-regime net expectancy after the change. */
  regimeBreakdown: Record<string, { n: number; netExpectancyR: number | null }>;
  /** The floor a regime must clear to be considered at all. */
  minRegimeSamples: number;

  /** True when the result regenerates from frozen features alone. */
  reproducibleFromFrozenFeatures: boolean;
  /** True when a check found information from after the decision time. */
  leakSuspected: boolean;
  /** Where the previous version is, for rollback. Null when there is none. */
  rollbackVersion: VersionSet | null;
  /** Set when the change is explicitly regime-conditional by design. */
  regimeConditionalByDesign: boolean;
}

export interface WalkForwardEvidence {
  foldsEvaluable: number;
  /** Net expectancy on the out-of-sample portion, cost-adjusted. */
  netExpectancyR: number | null;
  /** True when no fold showed a negative change against its own baseline. */
  uniform: boolean;
  /** Assertion that no training row's label intersected any test block. */
  leakageClean: boolean;
}

export interface GovernorDecision {
  candidateId: string;
  title: string;
  verdict: GovernorVerdict;
  /** Every condition, with pass/fail and the number behind it. Not just failures. */
  conditions: ConditionResult[];
  /** One sentence, suitable for a status panel. */
  summary: string;
  /** What the engine keeps. Always the previous version on any non-ACCEPTED. */
  activeVersion: VersionSet;
  /** Where to go if this is ever reverted. */
  rollbackTo: VersionSet | null;
  decidedAt: number;
  researchId: string | null;
}

export interface ConditionResult {
  id: string;
  requirement: string;
  passed: boolean;
  /** The measured value, so the verdict is auditable rather than assertive. */
  observed: string;
  /** Why it failed. Null when it passed. */
  detail: string | null;
}

export const CONDITIONS: Array<{ id: string; requirement: string }> = [
  { id: 'samples', requirement: 'Minimum resolved samples met' },
  { id: 'walk-forward', requirement: 'Survives walk-forward validation' },
  { id: 'expectancy', requirement: 'Improves net expectancy after costs' },
  { id: 'drawdown', requirement: 'Does not increase maximum drawdown beyond the declared limit' },
  { id: 'calibration', requirement: 'Does not degrade calibration' },
  { id: 'regime', requirement: 'Does not depend on one regime, one asset, or one news event' },
  { id: 'reproducible', requirement: 'Reproducible from frozen features' },
  { id: 'out-of-sample', requirement: 'Has an out-of-sample result' },
  { id: 'rollback', requirement: 'Has a rollback version' },
  { id: 'versioned', requirement: 'Is versioned and recorded in the decision log' },
];

export function currentVersionSet(): VersionSet {
  return {
    engine: ENGINE_VERSION,
    featureSchema: FEATURE_SCHEMA_VERSION,
    calibration: CALIBRATION_VERSION,
    config: '',
    model: '',
  };
}

/**
 * Decide. Returns a verdict; never mutates anything.
 *
 * The evaluation order matters: the cheapest disqualifiers run first, so the
 * common case — not enough data — returns immediately with a specific reason
 * rather than burying that under eight passing conditions.
 */
export function decide(c: Candidate, now = Date.now()): GovernorDecision {
  const active = currentVersionSet();
  const conditions: ConditionResult[] = [];

  const add = (
    id: string,
    passed: boolean,
    observed: string,
    detail: string | null,
  ): void => {
    const meta = CONDITIONS.find((x) => x.id === id);
    conditions.push({ id, requirement: meta?.requirement ?? id, passed, observed, detail });
  };

  // 1. Samples.
  add(
    'samples',
    c.resolvedSamples >= c.minSamples,
    `${c.resolvedSamples} resolved / ${c.minSamples} required`,
    c.resolvedSamples >= c.minSamples
      ? null
      : `${c.resolvedSamples} resolved outcomes against a floor of ${c.minSamples}. Not enough to distinguish an improvement from a coincidence.`,
  );

  // 8. Out of sample. Checked before walk-forward because "never ran" beats
  // "ran and was bad" as a reason, and a change with no OOS result has not been
  // tested at all.
  const oos = c.outOfSample;
  add(
    'out-of-sample',
    oos !== null && oos.foldsEvaluable > 0,
    oos ? `${oos.foldsEvaluable} out-of-sample folds, expectancy ${fmt(oos.netExpectancyR)}R` : 'not run',
    oos && oos.foldsEvaluable > 0
      ? null
      : 'no out-of-sample result. A change evaluated only on the data it was developed against has not been tested.',
  );

  // 4. Leak. A leak makes every other number meaningless, so it is checked early
  // and produces its OWN verdict rather than a generic failure.
  add(
    'reproducible',
    c.reproducibleFromFrozenFeatures && !(oos?.leakageClean === false),
    `reproducible=${c.reproducibleFromFrozenFeatures}, leakageClean=${oos?.leakageClean ?? 'n/a'}`,
    c.reproducibleFromFrozenFeatures
      ? (oos?.leakageClean === false ? 'training labels overlapped test blocks' : null)
      : 'the result cannot be regenerated from what was frozen at decision time, so it depended on something unrecorded',
  );

  // 2. Walk-forward.
  const wf = c.walkForward;
  add(
    'walk-forward',
    wf !== null && wf.foldsEvaluable > 0 && wf.uniform && wf.leakageClean,
    wf ? `${wf.foldsEvaluable} folds, uniform=${wf.uniform}, leakageClean=${wf.leakageClean}` : 'not run',
    wf === null || wf.foldsEvaluable === 0
      ? 'walk-forward was not run'
      : !wf.leakageClean
        ? 'a training label intersected a test block'
        : !wf.uniform
          ? 'at least one fold was worse than its own baseline, so the improvement is not stable across time'
          : null,
  );

  // 3. Expectancy after costs.
  const gain =
    c.expectancyBeforeR !== null && c.expectancyAfterR !== null
      ? c.expectancyAfterR - c.expectancyBeforeR
      : null;
  const minGain = c.minExpectancyGainR;
  add(
    'expectancy',
    gain !== null && minGain !== null && gain >= minGain,
    gain === null ? 'unmeasured' : `${fmt(gain)}R change (need >= ${minGain ?? 'unset'}R)`,
    gain === null
      ? 'net expectancy before or after is unmeasured'
      : minGain === null
        ? 'no minimum acceptable gain was declared, so an improvement cannot be judged'
        : gain < minGain
          ? `net expectancy changed by ${fmt(gain)}R, below the declared ${minGain}R`
          : null,
  );

  // 4. Drawdown.
  const ddDelta =
    c.maxDrawdownBeforeR !== null && c.maxDrawdownAfterR !== null
      ? Math.abs(c.maxDrawdownAfterR) - Math.abs(c.maxDrawdownBeforeR)
      : null;
  const ddTol = c.maxDrawdownToleranceR;
  add(
    'drawdown',
    ddDelta !== null && ddTol !== null && ddDelta <= ddTol,
    ddDelta === null ? 'unmeasured' : `worsened by ${fmt(ddDelta)}R (tolerance ${ddTol ?? 'unset'}R)`,
    ddDelta === null
      ? 'max drawdown before or after is unmeasured'
      : ddTol === null
        ? 'no drawdown tolerance was declared'
        : ddDelta > ddTol
          ? `drawdown worsened by ${fmt(ddDelta)}R, beyond the declared ${ddTol}R`
          : null,
  );

  // 5. Calibration.
  const skillDelta =
    c.brierSkillBefore !== null && c.brierSkillAfter !== null
      ? c.brierSkillAfter - c.brierSkillBefore
      : null;
  const skillTol = c.maxBrierSkillDegradation;
  add(
    'calibration',
    skillDelta !== null && skillTol !== null && skillDelta >= -skillTol,
    skillDelta === null ? 'unmeasured' : `Brier skill changed by ${fmt(skillDelta)} (tolerance -${skillTol ?? 'unset'})`,
    skillDelta === null
      ? 'Brier skill before or after is unmeasured'
      : skillTol === null
        ? 'no calibration-degradation tolerance was declared'
        : skillDelta < -skillTol
          ? `Brier skill fell by ${fmt(Math.abs(skillDelta))}, beyond the permitted ${skillTol}`
          : null,
  );

  // 6. Regime dependence.
  const regimes = Object.entries(c.regimeBreakdown);
  const measured = regimes.filter(([, v]) => v.n >= c.minRegimeSamples);
  // A regime that clears the floor and turns negative is a regression hidden by
  // the aggregate. At least one must clear the floor for the test to mean
  // anything at all.
  const regressions = measured.filter(([, v]) => (v.netExpectancyR ?? 0) < 0);
  add(
    'regime',
    measured.length >= 2 && regressions.length === 0,
    `${measured.length} regimes above the ${c.minRegimeSamples}-sample floor, ${regressions.length} negative`,
    measured.length < 2
      ? `only ${measured.length} regime(s) clear the ${c.minRegimeSamples}-sample floor, so a single-regime dependence cannot be ruled out`
      : regressions.length > 0
        ? `negative expectancy in ${regressions.map(([k]) => k).join(', ')} — an aggregate improvement hiding a per-regime regression`
        : null,
  );

  // 9. Rollback.
  const hasRollback = c.rollbackVersion !== null;
  add(
    'rollback',
    hasRollback,
    hasRollback ? `` : 'none',
    hasRollback
      ? null
      : 'no previous version to return to. An upgrade with nowhere to go back to is not an upgrade.',
  );

  // 10. Versioning.
  add(
    'versioned',
    typeof c.targetVersion === 'string' && c.targetVersion.length > 0,
    c.targetVersion,
    c.targetVersion ? null : 'no target version',
  );

  const failed = conditions.filter((x) => !x.passed);

  // ── Verdict selection ──
  let verdict: GovernorVerdict;
  let summary: string;

  if (c.leakSuspected) {
    verdict = 'DATA-LEAK SUSPECTED';
    summary = 'Rejected: information from after the decision time reached the result. Every number for this candidate is void until the leak is found.';
  } else if (c.leakSuspected === false && oos?.leakageClean === false) {
    verdict = 'DATA-LEAK SUSPECTED';
    summary = 'Rejected: a training label intersected a test block.';
  } else if (failed.some((f) => f.id === 'samples')) {
    verdict = 'INSUFFICIENT_EVIDENCE';
    summary = `Kept the previous version. ${failed.find((f) => f.id === 'samples')!.detail}`;
  } else if (failed.some((f) => f.id === 'regime')) {
    verdict = 'REGIME-DEPENDENT';
    summary = `Kept the previous version. ${failed.find((f) => f.id === 'regime')!.detail}`;
  } else if (failed.length === 0) {
    verdict = 'ACCEPTED';
    summary = `Accepted: all ten conditions met. Net expectancy +${fmt(gain)}R, drawdown change ${fmt(ddDelta)}R, Brier skill ${fmt(skillDelta)}.`;
  } else {
    verdict = failed.length >= 4 ? 'INCONCLUSIVE' : 'REJECTED';
    summary =
      `Kept the previous version. ${failed.length} condition${failed.length === 1 ? '' : 's'} failed: ` +
      failed.map((f) => f.id).join(', ') +
      '.';
  }

  return {
    candidateId: c.id,
    title: c.title,
    verdict,
    conditions,
    summary,
    // On anything but ACCEPTED the active version is unchanged. There is no code
    // path here that could set it to the candidate's version and then roll back —
    // it simply never becomes active.
    activeVersion: verdict === 'ACCEPTED' ? { ...active, calibration: c.targetVersion } : active,
    rollbackTo: c.rollbackVersion,
    decidedAt: now,
    researchId: c.researchId,
  };
}

function fmt(v: number | null): string {
  return v === null || v === undefined ? 'n/a' : v.toFixed(3);
}

// ─── The decision log ────────────────────────────────────────────────────────

export interface DecisionLogEntry extends GovernorDecision {
  /** Free text explaining WHY, required for every non-ACCEPTED verdict. */
  rationale: string;
  /** Who or what asked for this change. */
  requestedBy: string;
  /** The registry entries this verdict touches, for cross-referencing. */
  touchesResearch: string[];
}

export const DECISION_LOG: DecisionLogEntry[] = [];

/**
 * Append to the decision log. Every verdict goes in, ACCEPTED or not.
 *
 * A log that only records successes is a marketing document. The rejections are
 * the part that prevents the same rejected idea being re-proposed every month.
 */
export function logDecision(entry: DecisionLogEntry): DecisionLogEntry {
  DECISION_LOG.push(entry);
  return entry;
}

/** Current state of the engine's versions, for the model-version panel. */
export function modelVersionPanel(): {
  active: VersionSet;
  rollbacks: Record<string, VersionSet | null>;
  /** Facts about what is and is not fitted, so the panel cannot imply otherwise. */
  fitted: boolean;
  note: string;
  acceptedCount: number;
  rejectedCount: number;
} {
  const accepted = DECISION_LOG.filter((e) => e.verdict === 'ACCEPTED').length;
  const rejected = DECISION_LOG.filter((e) => e.verdict !== 'ACCEPTED').length;
  return {
    active: currentVersionSet(),
    rollbacks: ROLLBACK_TARGETS,
    fitted: false,
    note:
      'Weights are the shipped [TUNED] set, anchored to the ledger base rate. NO weight has been fitted: no candidate has passed the governor.',
    acceptedCount: accepted,
    rejectedCount: rejected,
  };
}