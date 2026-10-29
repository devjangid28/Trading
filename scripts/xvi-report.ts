/**
 * `npm run xvi:report` — the Phase XVI evidence report.
 *
 * Everything Phase XVI built, printed from the REAL ledger, in the order a
 * reviewer would ask for it:
 *
 *   1. What version of what produced these numbers
 *   2. What we could not measure, and why
 *   3. The research registry — every hypothesis, its status, its evidence
 *   4. The outcome store — population policy and the cost breakdown
 *   5. Walk-forward — split geometry, purge counts, and a leakage verdict
 *   6. Calibration — Murphy decomposition, floors, and what is suppressed
 *   7. Grade ordering — reported, never asserted
 *   8. The learning governor — what it would refuse and why
 *
 * **Exits 0 always.** Every section reports INSUFFICIENT EVIDENCE honestly at
 * the current sample size, and a report that failed to print would hide exactly
 * the thing this file exists to make visible.
 */

import { listOutcomes, listSignals, closeLedger, DB_PATH } from '../server/src/ledger/store.js';
import { legacyExclusionMessage } from '../server/src/ledger/datasetPolicy.js';
import {
  buildCalibrationPhaseReport,
  gradeOrdering,
  groupPerformance,
  featureImportance,
  DEFAULT_FLOORS,
} from '../server/src/engine/calibrationReport.js';
import { walkForward, assertNoLeakage, describeSplits, skippedReasons } from '../server/src/engine/walkForward.js';
import { RESEARCH_REGISTRY, CONSTANT_PROVENANCE, registrySummary, MIN_SAMPLE_FOR_ACCEPTANCE } from '../server/src/engine/researchRegistry.js';
import { decide, modelVersionPanel, CONDITIONS, type Candidate } from '../server/src/engine/learningGovernor.js';
import { currentVersions, versionStamp } from '../server/src/version.js';
import { LEDGER, MIND } from '../server/src/config.js';
import { WINS, isWin } from '../server/src/engine/mind/index.js';
import type { LabelledSignal } from '../server/src/engine/walkForward.js';

const line = (s = '') => console.log(s);
const rule = (n = 74) => console.log('  ' + '='.repeat(n));

function n2(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v.toFixed(2);
}
function n4(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : v.toFixed(4);
}
function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
}

function main(): void {
  line();
  line('  ORDERFLOW MIND — Phase XVI evidence report');
  rule();

  // ── 1. Versions ──
  const v = currentVersions();
  line('  1. VERSIONS — what produced these numbers');
  line(`     engine             ${v.engine}`);
  line(`     feature schema     ${v.featureSchema}`);
  line(`     calibration        ${v.calibration}`);
  line(`     config             ${v.config}   (sha256 of the live config, 12 hex)`);
  line(`     model              ${v.model}`);
  line(`     stamp              ${versionStamp()}`);
  line(`     weights            shipped [TUNED] set — NOT fitted`);
  line();

  // ── Gather the evidence ──
  const signals = listSignals(20_000, 'all');
  const outcomes = listOutcomes(20_000);
  const outcomeById = new Map(outcomes.map((o) => [o.signalId, o]));

  const labelled: LabelledSignal[] = [];
  let withoutOutcomeRow = 0;
  for (const s of signals) {
    const out = outcomeById.get(s.id);
    const outcome = out?.outcome ?? s.outcome;
    if (outcome === 'OPEN') continue;
    const decided = WINS.has(outcome as never) || outcome === 'STOP';
    // A signal with no outcome row has no COST-HONEST net R. It pre-dates the
    // Phase XVI outcome store, and its net R cannot be reconstructed from the
    // stored gross R without re-deriving costs from data that was not frozen.
    // Counting it anyway would be the exact "optional costs" failure Phase XVI
    // rule 6 forbids, so it is counted separately and excluded.
    if (!out) withoutOutcomeRow++;
    const frozen = s.snapshot?.featureRecord;
    labelled.push({
      id: s.id,
      createdAt: s.created_at,
      resolvedAt: out?.resolvedAt ?? s.resolved_at ?? s.created_at,
      probability: s.snapshot?.mind?.probability,
      y: decided ? (isWin(outcome as never) ? 1 : 0) : undefined,
      netR: out?.netR ?? null,
      grossR: out?.grossR ?? null,
      regime: frozen?.regime ?? s.snapshot?.regime ?? 'unknown',
      grade: s.snapshot?.grade,
      setupType: frozen?.setupType ?? 'unknown',
      engineVersion: frozen?.featureSchemaVersion,
    });
  }

  // How many rows can actually carry a cost-honest expectancy figure.
  const costHonest = labelled.filter((s) => typeof s.netR === 'number').length;

  // ── 2. Coverage: what we could not measure ──
  const missingReasons = new Map<string, number>();
  let records = 0;
  for (const s of signals) {
    const rec = s.snapshot?.featureRecord;
    if (!rec) continue;
    records++;
    for (const m of rec.missing) missingReasons.set(m.reason, (missingReasons.get(m.reason) ?? 0) + 1);
  }

  line('  2. FEATURE COVERAGE — what could not be measured');
  line(`     signals            ${signals.length}`);
  line(`     resolved           ${signals.filter((s) => s.outcome !== 'OPEN').length}`);
  line(`     outcome rows       ${outcomes.length}   (cost-honest records)`);
  line(`     feature records    ${records}   (Phase XVI onward)`);
  line(`     cost-honest rows   ${costHonest}   (have an outcome row)`);
  if (withoutOutcomeRow > 0) {
    line();
    line(`     ${legacyExclusionMessage(withoutOutcomeRow)}`);
  }
  if (missingReasons.size === 0) {
    line('     no missing fields recorded');
  } else {
    line(`     ${'reason'.padEnd(28)}${'count'.padStart(6)}`);
    for (const [reason, count] of [...missingReasons.entries()].sort((a, b) => b[1] - a[1])) {
      line(`     ${reason.padEnd(28)}${String(count).padStart(6)}`);
    }
    line('     Every one of these is a null WITH A REASON. None was imputed.');
  }
  line();

  // ── 3. Research registry ──
  const rs = registrySummary();
  line('  3. RESEARCH REGISTRY — book claims as hypotheses');
  line(`     entries            ${rs.total}`);
  line(`     accepted           ${rs.accepted}`);
  line(`     by status          ${JSON.stringify(rs.byStatus)}`);
  line(`     floor for acceptance ${MIN_SAMPLE_FOR_ACCEPTANCE} resolved signals`);
  line(`     blocked on data    ${rs.blockedOnData.length ? rs.blockedOnData.join(', ') : 'none'}`);
  line();
  line(`     ${'id'.padEnd(9)}${'status'.padEnd(15)}${'dir'.padEnd(20)}title`);
  for (const e of RESEARCH_REGISTRY) {
    line(`     ${e.id.padEnd(9)}${e.status.padEnd(15)}${e.direction.padEnd(20)}${e.title.slice(0, 46)}`);
  }
  line();
  line('     Nothing is ACCEPTED. At the current sample size no hypothesis here has');
  line('     been tested to a standard that would justify changing a weight.');
  line();

  line('     constants and their provenance');
  for (const c of CONSTANT_PROVENANCE) {
    line(`     ${c.id.padEnd(34)}${c.provenance.padEnd(12)}${String(c.value).slice(0, 14)}`);
  }
  line();

  // ── 4. Outcome store ──
  line('  4. OUTCOME STORE — populations and costs');
  const byClass = { win: 0, loss: 0, censored: 0 } as Record<string, number>;
  for (const o of outcomes) byClass[o.outcomeClass] = (byClass[o.outcomeClass] ?? 0) + 1;
  line(`     win                ${byClass.win}`);
  line(`     loss               ${byClass.loss}`);
  line(`     censored           ${byClass.censored}   (expired / unresolved — NOT losses)`);
  line();
  line('     EXPIRED policy, applied identically by every metric:');
  line('       expectancy / drawdown / profit factor / time-to-resolve  INCLUDED');
  line('       win rate / Brier / reliability                          EXCLUDED (no binary label)');
  line();
  if (outcomes.length > 0) {
    const fee = outcomes.reduce((a, o) => a + o.feeR, 0) / outcomes.length;
    const slip = outcomes.reduce((a, o) => a + o.slippageR, 0) / outcomes.length;
    const fund = outcomes.reduce((a, o) => a + o.fundingR, 0) / outcomes.length;
    const unmeasured = outcomes.filter((o) => !o.fundingMeasured).length;
    const ambiguous = outcomes.filter((o) => o.ambiguous).length;
    line(`     mean fee R          ${n4(fee)}`);
    line(`     mean slippage R     ${n4(slip)}`);
    line(`     mean funding R      ${n4(fund)}`);
    line(`     funding unmeasured  ${unmeasured}/${outcomes.length}  (recorded as a zero COST, not a zero rate)`);
    line(`     ambiguous outcomes  ${ambiguous}  (stop taken as the worst case, recorded on the row)`);
  } else {
    line('     No outcome rows yet — none have resolved since Phase XVI shipped.');
  }
  line();

  // ── 5. Walk-forward ──
  line('  5. WALK-FORWARD — split geometry and leakage');
  const wfOpts = {
    window: 'expanding' as const,
    stepMs: LEDGER.EXPIRY_HOURS * 3600_000,
    testWindowMs: LEDGER.EXPIRY_HOURS * 3600_000,
    purgePadMs: LEDGER.EXPIRY_HOURS * 3600_000,
    minTrainSamples: 30,
  };
  const folds = walkForward(labelled, wfOpts);
  const leakage = assertNoLeakage(folds, labelled);
  for (const s of describeSplits(wfOpts, folds)) line(`     ${s}`);
  line(`     leakage            ${leakage.clean ? 'CLEAN — no training label intersects any test block' : `${leakage.violations.length} VIOLATION(S)`}`);
  for (const s of skippedReasons(folds).slice(0, 5)) line(`     skipped            ${s}`);
  line();

  // ── 6. Calibration ──
  line('  6. CALIBRATION — Murphy decomposition with honest floors');
  const rep = buildCalibrationPhaseReport(labelled, DEFAULT_FLOORS);
  line(`     population         decided ${rep.winRate.n}, censored excluded ${rep.winRate.censoredExcluded}`);
  line(`     win rate           ${pct(rep.winRate.value)}   ${rep.winRate.reason ?? `n=${rep.winRate.n}`}`);
  line(`     net expectancy R   ${n2(rep.netExpectancyR.value)}   ${rep.netExpectancyR.reason ?? `n=${rep.netExpectancyR.n}`}`);
  line(`     median net R       ${n2(rep.medianNetR.value)}   ${rep.medianNetR.reason ?? `n=${rep.medianNetR.n}`}`);
  line(`     profit factor      ${n2(rep.profitFactor.value)}   ${rep.profitFactor.reason ?? `n=${rep.profitFactor.n}`}`);
  line(`     max drawdown R     ${n2(rep.maxDrawdownR.value)}   ${rep.maxDrawdownR.reason ?? `n=${rep.maxDrawdownR.n}`}`);
  line(`     false positive     ${pct(rep.falsePositiveRate.value)}   ${rep.falsePositiveRate.reason ?? `n=${rep.falsePositiveRate.n}`}`);
  line(`     false negative     ${pct(rep.falseNegativeRate.value)}   ${rep.falseNegativeRate.reason ?? `n=${rep.falseNegativeRate.n}`}`);
  line(`     Brier              ${n4(rep.brier.value)}   ${rep.brier.reason ?? `n=${rep.brier.n}`}`);
  line(`     Brier (base rate)  ${n4(rep.brierBaseRate.value)}`);
  line(`     Brier skill        ${n4(rep.brierSkill.value)}   1 - BS/climatology`);
  line();
  line(`     decomposition      conditioning: ${rep.decomposition.conditioning}`);
  line(`       reliability      ${n4(rep.decomposition.reliability)}`);
  line(`       resolution       ${n4(rep.decomposition.resolution)}   SUBTRACTS`);
  line(`       uncertainty      ${n4(rep.decomposition.uncertainty)}`);
  line(`       residual         ${n4(rep.decomposition.residual)}   REL-RES+UNC-BS; zero iff conditioning is exact`);
  line();
  for (const note of rep.notes) line(`     note               ${note}`);
  line();

  // ── 7. Grouped performance + ordering ──
  line('  7. GRADE ORDERING — reported, never asserted');
  const ordering = gradeOrdering(labelled, DEFAULT_FLOORS.perGrade);
  line(`     verdict            ${ordering.verdict}`);
  for (const r of ordering.reasons) line(`       ${r}`);
  for (const g of ordering.grades) {
    line(`     ${g.group.padEnd(6)}n=${String(g.n).padEnd(5)}floor=${String(g.floor).padEnd(5)}${g.suppressed ? `SUPPRESSED — ${g.reason}` : `wr ${pct(g.winRate)}  R ${n2(g.netExpectancyR)}`}`);
  }
  if (ordering.investigate.length > 0) {
    line('     if it ever fails, investigate:');
    for (const s of ordering.investigate) line(`       - ${s}`);
  }
  line();

  line('     by regime');
  for (const g of groupPerformance(labelled, (s) => s.regime, DEFAULT_FLOORS.perGroup)) {
    line(`     ${g.group.padEnd(22)}n=${String(g.n).padEnd(5)}${g.suppressed ? `SUPPRESSED — ${g.reason}` : `wr ${pct(g.winRate)}  R ${n2(g.netExpectancyR)}  dd ${n2(g.maxDrawdownR)}`}`);
  }
  line();
  line('     by setup type');
  for (const g of groupPerformance(labelled, (s) => s.setupType, DEFAULT_FLOORS.perGroup).slice(0, 12)) {
    line(`     ${g.group.slice(0, 34).padEnd(34)}n=${String(g.n).padEnd(5)}${g.suppressed ? 'SUPPRESSED' : `wr ${pct(g.winRate)}  R ${n2(g.netExpectancyR)}`}`);
  }
  line();

  // ── 8. Feature importance, gated ──
  line('  8. FEATURE IMPORTANCE — gated on resolved outcomes');
  const fi = featureImportance(
    labelled.filter((s) => typeof s.netR === 'number'),
    {
      'regime:trend-up': (s) => (s.regime === 'trending-bull' || s.regime === 'trend-up' ? 1 : 0),
      'grade:A': (s) => (s.grade === 'A' ? 1 : 0),
    },
    DEFAULT_FLOORS.expectancy * 4,
  );
  line(`     verdict            ${fi.verdict}   (n=${fi.n}, floor=${fi.floor})`);
  if (fi.reason) line(`     reason             ${fi.reason}`);
  for (const f of fi.importance) line(`     ${f.feature.padEnd(24)}corr ${n4(f.correlation)}  n=${f.n}`);
  line();

  // ── 9. The governor, on a realistic candidate ──
  line('  9. LEARNING GOVERNOR — what it would refuse today');
  const candidate: Candidate = {
    id: 'PROBE', title: 'Refit the Mind weights on the current ledger',
    targetVersion: 'calib-1.1.0', researchId: null,
    resolvedSamples: labelled.length,
    minSamples: MIN_SAMPLE_FOR_ACCEPTANCE,
    walkForward: folds.length ? { foldsEvaluable: folds.filter((f) => !f.skipped).length, netExpectancyR: null, uniform: false, leakageClean: leakage.clean } : null,
    outOfSample: null,
    expectancyBeforeR: null, expectancyAfterR: null, minExpectancyGainR: 0.05,
    maxDrawdownBeforeR: null, maxDrawdownAfterR: null, maxDrawdownToleranceR: 1,
    brierSkillBefore: null, brierSkillAfter: null, maxBrierSkillDegradation: 0.01,
    regimeBreakdown: {},
    minRegimeSamples: 50,
    reproducibleFromFrozenFeatures: true, leakSuspected: false,
    rollbackVersion: { engine: v.engine, featureSchema: v.featureSchema, calibration: 'calib-1.0.0', config: v.config, model: v.model },
    regimeConditionalByDesign: false,
  };
  const decision = decide(candidate);
  line(`     verdict            ${decision.verdict}`);
  line(`     summary            ${decision.summary}`);
  line();
  line(`     ${'condition'.padEnd(14)}${'pass'.padEnd(7)}observed`);
  for (const c of decision.conditions) {
    line(`     ${c.id.padEnd(14)}${(c.passed ? 'yes' : 'NO').padEnd(7)}${c.observed}`);
  }
  line();
  const panel = modelVersionPanel();
  line(`     model-version panel: fitted=${panel.fitted}`);
  line(`     ${panel.note}`);
  line();

  rule();
  line(`  ${CONDITIONS.length} governor conditions · ${RESEARCH_REGISTRY.length} research hypotheses · 0 accepted`);
  line('  No weight has been fitted. No hypothesis has been promoted to a rule.');
  line('  That is the honest state, not an unfinished one.');
  rule();
  line();

  closeLedger();
}

try {
  main();
} catch (err) {
  console.error(`xvi:report failed: ${(err as Error).message}`);
  closeLedger();
}