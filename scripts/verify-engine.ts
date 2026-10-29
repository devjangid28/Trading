/**
 * The Closed-Loop Engine's acceptance gate.
 *
 *   npm run verify:engine
 *
 * It prints, from REAL data and REAL candles:
 *
 *   - the per-fold walk-forward results (purged, embargoed, symbol-grouped);
 *   - the reliability table;
 *   - the Brier score and the log loss, against the base-rate constant;
 *   - the COVERAGE, always beside the win rate;
 *   - the net expectancy with a cluster-bootstrap interval;
 *   - the comparison against a RANDOM ENTRY with the same geometry, against
 *     buy-and-hold, and against the engine's own conviction score;
 *   - the effective sample size, because 625 signals on 106 symbols are not
 *     625 independent observations.
 *
 * Every net-R figure is charged with MODELLED `RISK.*` costs. Only 54 of the
 * ledger's rows have frozen costs; the rest are recomputed from the config.
 */
import { listSignals, closeLedger } from '../server/src/ledger/store.js';
import { fetchKlinesRange } from '../server/src/data/binance.js';
import { buildRow, featuresOf, isExcludedByPolicy, FEATURE_NAMES, type LabelledRow } from '../server/src/engine/closedloop/dataset.js';
import {
  fitLogistic, walkForwardFolds, predict, brier, logLoss, reliability, applyThreshold,
  DEFAULT_FIT, DEFAULT_SPLIT,
} from '../server/src/engine/closedloop/model.js';
import { clusterBootstrapMean, permutationTestEngineVsRandom } from '../server/src/engine/closedloop/stats.js';
import { engineArm, randomEntryBaseline } from '../server/src/engine/closedloop/random.js';
import { tierRows, wilsonInterval } from '../server/src/engine/lab/calibration.js';
import { beyondPaperCriteria } from '../server/src/engine/lab/learning.js';
import { vetoKindOf } from '../server/src/engine/vetoKind.js';
import type { Bar, Geometry } from '../server/src/engine/closedloop/geometry.js';
import { LAB, LEDGER } from '../server/src/config.js';
import type { LedgerSignal } from '../shared/types.js';

const LIFE_MS = LEDGER.EXPIRY_HOURS * 3600_000;
const TRIALS = Number(process.env.ENGINE_TRIALS ?? 120);
const SEED = 20261020;
const BOOTSTRAP = 2000;
const THRESHOLD = Number(process.env.ENGINE_THRESHOLD ?? 0.55);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function geometryOf(s: LedgerSignal): Geometry | null {
  const plan = s.snapshot?.plan;
  const entry = plan && Number.isFinite(plan.entryMid) && plan.entryMid > 0
    ? plan.entryMid
    : (s.entryZoneLow + s.entryZoneHigh) / 2;
  const risk = s.riskPerUnit > 0 ? s.riskPerUnit : Math.abs(entry - s.stop);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(risk) || risk <= 0) return null;
  return { side: s.side, entry, stop: s.stop, targets: s.targets ?? [], riskPerUnit: risk };
}

/** The matrix a fold is fitted on: features in the fixed order, imputed. */
function matrix(rows: LabelledRow[]): { x: number[]; y: number }[] {
  const decided = rows.filter((r) => r.y !== null);
  // The imputation is the TRAINING FOLD's median. A zero would be a claim.
  const medians: Record<string, number> = {};
  for (const name of FEATURE_NAMES) {
    const vals = decided.map((r) => r.features[name]).filter((v) => v !== undefined).sort((a, b) => a - b);
    medians[name] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  }
  return decided.map((r) => ({
    x: FEATURE_NAMES.map((name) => r.features[name] ?? medians[name]),
    y: r.y as number,
  }));
}

function describe(name: string, rows: { cluster: string; value: number }[], seed: number): void {
  const b = clusterBootstrapMean(rows, BOOTSTRAP, seed);
  console.log(
    `  ${name.padEnd(30)} ${b.mean.toFixed(4).padStart(8)} R   95% CI [${b.ci?.[0]}, ${b.ci?.[1]}]` +
    `   n=${b.n} clusters=${b.clusters} ICC=${b.icc} nEff=${b.nEff}`,
  );
}

async function main(): Promise<void> {
  const signals = listSignals(100_000, 'all');
  const resolved = signals.filter((s) => s.outcome !== 'OPEN');

  console.log('\n=== Closed-Loop Engine: verification ===\n');
  console.log(`ledger: ${signals.length} signals, ${resolved.length} resolved`);

  // ── Re-resolve and build the dataset ─────────────────────────────────────
  const bySymbol = new Map<string, LedgerSignal[]>();
  for (const s of resolved) {
    const arr = bySymbol.get(s.symbol);
    if (arr) arr.push(s);
    else bySymbol.set(s.symbol, [s]);
  }

  const rows: LabelledRow[] = [];
  const engineArms: { cluster: string; netR: number; grossR: number; wasReal: boolean; vetoKind: string }[] = [];
  const randomPerSignal: number[][] = [];
  const randomClusters: string[] = [];
  let fetched = 0;

  for (const [symbol, list] of bySymbol) {
    const from = Math.min(...list.map((s) => s.createdAt));
    const to = Math.max(...list.map((s) => s.createdAt)) + 2 * LIFE_MS;
    let candles: Bar[] = [];
    try {
      const raw = await fetchKlinesRange(`${symbol}USDT`, '5m', from - 10 * 60_000, to);
      candles = raw.filter((c) => c.closed).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
      fetched++;
    } catch { continue; }
    if (candles.length < 2) continue;

    for (const s of list) {
      const row = buildRow(s, candles);
      rows.push(row);
      const g = geometryOf(s);
      if (!g) continue;
      const d = s.snapshot?.deriv ?? null;
      const arm = engineArm(g, candles, s.createdAt, d && Number.isFinite(d.funding8h) ? d.funding8h : null, d?.depth?.spreadBps ?? null);
      if (arm.netR !== null) {
        engineArms.push({
          cluster: symbol, netR: arm.netR, grossR: arm.grossR ?? 0,
          wasReal: !s.shadow, vetoKind: s.shadow ? vetoKindOf(s.vetoReason) : 'real',
        });
      }
      const base = randomEntryBaseline(g, candles, s.createdAt, d && Number.isFinite(d.funding8h) ? d.funding8h : null, d?.depth?.spreadBps ?? null, {
        trials: TRIALS, lifeMs: LIFE_MS, candidateWindowMs: LIFE_MS, seed: SEED + hash(symbol),
      });
      // The random arm's NET R, per trial. Comparing the engine's net R against
      // a random arm's gross R would hand the engine a free round trip of
      // costs, which is exactly the mistake Part XIX's caveat warned about.
      if (base.trials.length) {
        randomPerSignal.push(
          base.trials.filter((t) => t.netR !== null).map((t) => t.netR as number),
        );
        randomClusters.push(symbol);
      }
    }
    if (fetched % 25 === 0) process.stdout.write(`  ...${fetched}/${bySymbol.size} symbols\n`);
  }
  console.log(`  re-resolved ${rows.length} signals across ${fetched} symbols`);

  // ── The population ───────────────────────────────────────────────────────
  const excluded = rows.filter((r) => isExcludedByPolicy(r.vetoKind));
  const population = rows.filter((r) => !isExcludedByPolicy(r.vetoKind));
  console.log('\n--- population ---');
  console.log(`  all re-resolved rows        ${rows.length}`);
  console.log(`  excluded (DATA_HEALTH)      ${excluded.length}`);
  console.log(`  training population          ${population.length}`);
  console.log(`    of which decided           ${population.filter((r) => r.y !== null).length}`);
  console.log(`    of which censored (expiry) ${population.filter((r) => r.y === null).length}`);
  console.log(`    real (grade A/B)           ${population.filter((r) => r.wasReal).length}`);
  console.log(`    shadow                     ${population.filter((r) => !r.wasReal).length}`);

  // ── The walk-forward ─────────────────────────────────────────────────────
  const folds = walkForwardFolds(population, DEFAULT_SPLIT);
  console.log(`\n--- walk-forward: ${folds.length} folds (purged, embargoed ${DEFAULT_SPLIT.embargoMs / 3600_000}h, grouped by symbol) ---`);

  const allPairs: { p: number; y: number }[] = [];
  const allDecisions: { row: LabelledRow; p: number }[] = [];
  const foldLines: string[] = [];

  for (const fold of folds) {
    const train = matrix(fold.train);
    const model = fitLogistic(train, DEFAULT_FIT);
    const test = matrix(fold.test);
    const testRows = fold.test.filter((r) => r.y !== null);
    const probs = test.map((t) => predict(model, t.x));
    const pairs = test.map((t, i) => ({ p: probs[i], y: t.y }));
    allPairs.push(...pairs);
    testRows.forEach((r, i) => allDecisions.push({ row: r, p: probs[i] }));

    const dec = applyThreshold(fold.test, probs, THRESHOLD);
    const b = brier(pairs);
    const l = logLoss(pairs);
    const base = mean(pairs.map((x) => x.y));
    const brierBase = mean(pairs.map((x) => (base - x.y) ** 2));
    const line =
      `  fold ${fold.index}: train ${String(fold.train.length).padStart(3)} (purged ${fold.purged}, embargoed ${fold.embargoed})` +
      `  test ${String(fold.test.length).padStart(3)}` +
      `  brier ${b === null ? '—' : b.toFixed(4)} (base ${brierBase.toFixed(4)})` +
      `  logloss ${l === null ? '—' : l.toFixed(4)}` +
      `  coverage ${dec.coveragePct.toFixed(1)}%  win ${dec.winRatePct === null ? '—' : dec.winRatePct.toFixed(1)}%` +
      `  netR ${dec.netR === null ? '—' : dec.netR.toFixed(3)}`;
    foldLines.push(line);
    console.log(line);
  }
  if (!folds.length) {
    console.log('  (no evaluable fold — the population is too small to split)');
  }

  // ── The out-of-sample metrics ───────────────────────────────────────────
  const oosBrier = brier(allPairs);
  const oosLogLoss = logLoss(allPairs);
  const baseRate = mean(allPairs.map((x) => x.y));
  const oosBrierBase = mean(allPairs.map((x) => (baseRate - x.y) ** 2));
  const decision = applyThreshold(population, allDecisions.map((d) => d.p), THRESHOLD);

  console.log('\n--- out-of-sample (pooled over folds) ---');
  console.log(`  decided rows        ${allPairs.length}`);
  console.log(`  base rate           ${(baseRate * 100).toFixed(2)}%`);
  console.log(`  Brier score         ${oosBrier === null ? '—' : oosBrier.toFixed(4)}`);
  console.log(`  Brier, base rate    ${oosBrierBase.toFixed(4)}`);
  console.log(`  Brier skill         ${oosBrier === null ? '—' : (1 - oosBrier / oosBrierBase).toFixed(4)}`);
  console.log(`  log loss            ${oosLogLoss === null ? '—' : oosLogLoss.toFixed(4)}`);
  console.log(`  threshold           ${THRESHOLD}`);
  console.log(`  COVERAGE            ${decision.coveragePct.toFixed(1)}%   (${decision.taken} of ${allPairs.length} decided rows)`);
  console.log(`  win rate, taken     ${decision.winRatePct === null ? '—' : decision.winRatePct.toFixed(2)}%`);
  console.log(`  win rate, skipped   ${decision.skippedWinRatePct === null ? '—' : decision.skippedWinRatePct.toFixed(2)}%`);
  console.log(`  net R, taken        ${decision.netR === null ? '—' : decision.netR.toFixed(4)}   (MODELLED costs)`);

  console.log('\n--- reliability table (out-of-sample) ---');
  for (const b of reliability(allPairs)) {
    console.log(
      `  p ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}  n=${String(b.n).padStart(4)}` +
      `  predicted ${b.meanPredicted === null ? '—' : b.meanPredicted.toFixed(3)}` +
      `  observed  ${b.observed === null ? '—' : b.observed.toFixed(3)}`,
    );
  }

  // ── The confidence tiers ──────────────────────────────────────────────────
  //
  // The hit rate and the COVERAGE are always on the same row, and a tier below
  // the sample floor quotes no rate at all — it prints the reason instead.
  console.log('\n--- confidence tiers (out-of-sample) ---');
  console.log(
    `  threshold    n   coverage   hit rate   95% Wilson CI        net R`,
  );
  const tierInput = allDecisions.map((d) => ({
    p: d.p,
    y: d.row.y as 0 | 1,
    netR: d.row.netR,
    cluster: d.row.symbol,
  }));
  for (const t of tierRows(tierInput)) {
    const ci = t.hitRateCi
      ? `[${t.hitRateCi[0].toFixed(1)}%, ${t.hitRateCi[1].toFixed(1)}%]`
      : '—';
    console.log(
      `  p >= ${t.threshold.toFixed(2)}  ${String(t.n).padStart(5)}` +
      `  ${t.coveragePct === null ? '      —' : `${t.coveragePct.toFixed(1)}%`.padStart(7)}` +
      `  ${t.hitRatePct === null ? '        —' : `${t.hitRatePct.toFixed(2)}%`.padStart(9)}` +
      `  ${ci.padEnd(20)}` +
      `  ${t.netR === null ? '—' : t.netR.toFixed(3)}`,
    );
    if (t.reason) console.log(`      ${t.reason}`);
  }

  // The Wilson interval on the OVERALL out-of-sample hit rate, so the tier
  // table is not the only place an interval appears.
  const overallWins = allPairs.filter((x) => x.y === 1).length;
  const overallCi = wilsonInterval(overallWins, allPairs.length, LAB.WILSON_Z);
  console.log(
    `  overall     ${String(allPairs.length).padStart(5)}` +
    `  ${((overallWins / (allPairs.length || 1)) * 100).toFixed(2)}%` +
    `  [${overallCi ? `${(overallCi[0] * 100).toFixed(2)}%, ${(overallCi[1] * 100).toFixed(2)}%` : '—'}]`,
  );

  // ── The comparisons ──────────────────────────────────────────────────────
  console.log('\n--- net expectancy, with cluster-bootstrap intervals ---');
  const engineRows = engineArms.map((e) => ({ cluster: e.cluster, value: e.netR }));
  describe('engine (all re-resolved rows)', engineRows, SEED);
  describe('engine, real picks only', engineArms.filter((e) => e.wasReal).map((e) => ({ cluster: e.cluster, value: e.netR })), SEED + 1);
  describe('engine, excluding DATA_HEALTH', engineArms.filter((e) => e.vetoKind !== 'DATA_HEALTH').map((e) => ({ cluster: e.cluster, value: e.netR })), SEED + 2);

  // Buy-and-hold over the same windows: the return from the signal's price to
  // the end of its life, in R, with the same costs.
  const bh: number[] = [];
  const bhClusters: string[] = [];
  for (const s of resolved) {
    const g = geometryOf(s);
    if (!g) continue;
    const from = Math.min(...bySymbol.get(s.symbol)!.map((x) => x.createdAt));
    const to = Math.max(...bySymbol.get(s.symbol)!.map((x) => x.createdAt)) + 2 * LIFE_MS;
    let candles: Bar[] = [];
    try {
      const raw = await fetchKlinesRange(`${s.symbol}USDT`, '5m', from - 600_000, to);
      candles = raw.filter((c) => c.closed).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
    } catch { continue; }
    const inLife = candles.filter((c) => c.t >= s.createdAt && c.t < s.createdAt + LIFE_MS);
    if (inLife.length < 2) continue;
    const p0 = inLife[0].o;
    const p1 = inLife[inLife.length - 1].c;
    const dir = s.side === 'bullish' ? 1 : -1;
    bh.push((dir * (p1 - p0)) / g.riskPerUnit);
    bhClusters.push(s.symbol);
  }
  if (bh.length) {
    describe('buy-and-hold, same windows', bh.map((v, i) => ({ cluster: bhClusters[i], value: v })), SEED + 3);
  }

  // The random-entry control, on the same rows.
  const engineNet = engineArms.map((e) => e.netR);
  const perm = permutationTestEngineVsRandom(engineNet, randomPerSignal, 2000, SEED + 4);
  console.log('\n--- permutation test: engine vs a random entry with the same geometry ---');
  console.log(`  observed difference  ${perm.observed} R over ${perm.n} paired signals`);
  console.log(`  permutation p        ${perm.pValue}`);

  // The random arm's own expectancy, so the comparison is on the page and not
  // only inside the permutation test.
  const randomFlat = randomPerSignal.flatMap((arr, i) =>
    arr.map((v) => ({ cluster: randomClusters[i] ?? 'x', value: v })),
  );
  if (randomFlat.length) {
    describe('random entry, same geometry', randomFlat, SEED + 5);
  }

  // ── The promotion criteria ────────────────────────────────────────────────
  //
  // These are the criteria for promoting BEYOND paper and testnet. They are
  // printed here because a gate nobody can see is a gate nobody can argue
  // with — and because the answer is, today, "not met", and that answer
  // should be visible rather than inferred from silence.
  const closedPaper = engineArms.length;
  const expectancyCi = clusterBootstrapMean(
    engineArms.map((e) => ({ cluster: e.cluster, value: e.netR })),
    BOOTSTRAP,
    SEED,
  );
  const worstGap = reliability(allPairs)
    .filter((b) => b.n >= LAB.TIER_MIN_TRADES && b.meanPredicted !== null && b.observed !== null)
    .map((b) => Math.abs(b.observed! - b.meanPredicted!))
    .sort((a, b) => b - a)[0];
  const criteria = beyondPaperCriteria({
    days: 0,
    paperTrades: closedPaper,
    expectancyCiLowerBound: expectancyCi.ci ? expectancyCi.ci[0] : null,
    calibrationWithinTolerance: worstGap === undefined ? null : worstGap <= LAB.CALIBRATION_TOLERANCE,
    driftGreen: null,
  });

  console.log('\n--- promotion beyond paper/testnet: NOT MET, and here is why ---');
  console.log(`  days of paper trading   ${criteria.days} (needs ${LAB.PROMOTION_MIN_DAYS})`);
  console.log(`  paper trades            ${criteria.paperTrades} (needs ${LAB.PROMOTION_MIN_PAPER_TRADES})`);
  console.log(`  expectancy CI lower     ${expectancyCi.ci ? expectancyCi.ci[0] : '—'} (must be above 0)`);
  console.log(`  calibration worst gap   ${worstGap === undefined ? '—' : worstGap.toFixed(4)} (tolerance ${LAB.CALIBRATION_TOLERANCE})`);
  console.log('  blocked by:');
  for (const b of criteria.blockedBy) console.log(`    - ${b}`);

  console.log('\n=== OK ===\n');
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 100_000;
}

main()
  .then(() => { closeLedger(); process.exit(0); })
  .catch((err) => { console.error(err); closeLedger(); process.exit(1); });
