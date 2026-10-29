/**
 * The Closed-Loop Engine's foundation check.
 *
 *   npm run engine:baseline
 *
 * It answers ONE question, before anything is fitted:
 *
 *   **Is the engine's edge a property of the market, or a property of the
 *   engine?**
 *
 * The instrument is the RANDOM-ENTRY BASELINE: take each signal's own stop
 * and target distances, enter at a random time in the same session, and see
 * what that makes. If a random entry makes about as much as the engine, the
 * engine has found nothing. If a random entry makes MORE, the geometry is the
 * finding and the engine is a worse version of it.
 *
 * ## The two controls, and why there are two
 *
 * A random entry inside the signal's session has LESS time than the engine's
 * trade, because it starts later. Left alone, that handicap would manufacture
 * an edge for the engine. So there are two controls, with the SAME candidate
 * entry times and a different time BUDGET:
 *
 *   - **Control A — window-limited.** The random trade is given only the time
 *     left in the signal's session. This is the literal question "what if I
 *     had entered at a random moment in that session".
 *   - **Control B — time-matched.** The random trade is given the SAME 24-hour
 *     life the engine's trade gets, even though that takes it past the
 *     session. This is the question "the same trade, entered at a random
 *     time", with the time budget held equal.
 *
 * Control B is the headline. Control A is reported beside it because the
 * difference between them IS the size of the handicap.
 *
 * ## The costs
 *
 * Every net-R figure is charged with `RISK.*` — taker fee, slippage, funding
 * across the exchange's own 8-hour boundaries — and is LABELLED MODELLED.
 * Only 54 of the ledger's rows have frozen costs; the rest are recomputed from
 * the config, which is an assumption, not a measurement.
 */
import { listSignals, closeLedger } from '../server/src/ledger/store.js';
import { realisedR } from '../server/src/ledger/resolve.js';
import { fetchKlinesRange } from '../server/src/data/binance.js';
import { engineArm, randomEntryBaseline } from '../server/src/engine/closedloop/random.js';
import { clusterBootstrapMean, permutationTestEngineVsRandom } from '../server/src/engine/closedloop/stats.js';
import { vetoKindOf } from '../server/src/engine/vetoKind.js';
import type { Geometry, Bar } from '../server/src/engine/closedloop/geometry.js';
import { LEDGER } from '../server/src/config.js';
import type { LedgerSignal } from '../shared/types.js';

const LIFE_MS = LEDGER.EXPIRY_HOURS * 3600_000;
const TRIALS = Number(process.env.ENGINE_TRIALS ?? 120);
const SEED = 20261020;
const BOOTSTRAP = 2000;
const PERMUTATIONS = 2000;

interface Arm {
  cluster: string;
  wasReal: boolean;
  vetoKind: string;
  grossR: number | null;
  netR: number | null;
  outcome: string;
}

function geometryOf(s: LedgerSignal): Geometry | null {
  const plan = s.snapshot?.plan;
  const entry = plan && Number.isFinite(plan.entryMid) && plan.entryMid > 0
    ? plan.entryMid
    : (s.entryZoneLow + s.entryZoneHigh) / 2;
  const risk = s.riskPerUnit > 0 ? s.riskPerUnit : Math.abs(entry - s.stop);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(risk) || risk <= 0) return null;
  return { side: s.side, entry, stop: s.stop, targets: s.targets ?? [], riskPerUnit: risk };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function describe(name: string, rows: { cluster: string; value: number }[], seed: number): void {
  const b = clusterBootstrapMean(rows, BOOTSTRAP, seed);
  console.log(
    `  ${name.padEnd(26)} ${b.mean.toFixed(4).padStart(8)} R   95% CI [${b.ci?.[0]}, ${b.ci?.[1]}]` +
    `   n=${b.n} clusters=${b.clusters} ICC=${b.icc} designEffect=${b.designEffect} nEff=${b.nEff}`,
  );
}

async function main(): Promise<void> {
  const signals = listSignals(100_000, 'all');
  const resolved = signals.filter((s) => s.outcome !== 'OPEN');

  console.log('\n=== Closed-Loop Engine: foundation check ===\n');
  console.log(`signals ${signals.length}, resolved ${resolved.length}`);

  // ── 1. The ledger as it stands ────────────────────────────────────────────
  const storedR = resolved.map((s) => realisedR(s)).filter((v): v is number => v !== null);
  const storedWin = resolved.filter((s) => s.outcome === 'TP1' || s.outcome === 'TP2' || s.outcome === 'TP3');
  const expiredR = resolved.filter((s) => s.outcome === 'EXPIRED').reduce((a, s) => a + (realisedR(s) ?? 0), 0);
  const totalR = storedR.reduce((a, b) => a + b, 0);
  console.log('\n--- 1. the ledger as stored (old resolver) ---');
  console.log(`  win rate      ${((storedWin.length / resolved.length) * 100).toFixed(2)}%`);
  console.log(`  avg gross R   ${mean(storedR).toFixed(4)}`);
  console.log(`  expiry rows   ${resolved.filter((s) => s.outcome === 'EXPIRED').length}, carrying ${((expiredR / totalR) * 100).toFixed(1)}% of the ledger's R`);

  // ── 2. Re-resolve with the corrected resolver ───────────────────────────
  const bySymbol = new Map<string, LedgerSignal[]>();
  for (const s of resolved) {
    const arr = bySymbol.get(s.symbol);
    if (arr) arr.push(s);
    else bySymbol.set(s.symbol, [s]);
  }

  console.log('\n--- 2. re-resolving every signal with the corrected resolver ---');
  const engineArms: Arm[] = [];
  const controlA: { cluster: string; value: number }[] = [];
  const controlB: { cluster: string; value: number }[] = [];
  const aSamples: number[][] = [];
  const bSamples: number[][] = [];
  const engineValues: number[] = [];
  let fetched = 0;
  let failed = 0;

  for (const [symbol, list] of bySymbol) {
    const from = Math.min(...list.map((s) => s.createdAt));
    // Two lives of candles: the signal's own session, plus another full life
    // for the time-matched control to run into.
    const to = Math.max(...list.map((s) => s.createdAt)) + 2 * LIFE_MS;
    let candles: Bar[] = [];
    try {
      const raw = await fetchKlinesRange(`${symbol}USDT`, '5m', from - 10 * 60_000, to);
      candles = raw.filter((c) => c.closed).map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c }));
      fetched++;
    } catch {
      failed++;
    }
    if (candles.length < 2) continue;

    for (const s of list) {
      const g = geometryOf(s);
      if (!g) continue;
      const deriv = s.snapshot?.deriv;
      const funding8h = deriv && Number.isFinite(deriv.funding8h) ? deriv.funding8h : null;
      const spreadBps = deriv?.depth?.spreadBps ?? null;
      const wasReal = !s.shadow;
      const vetoKind = s.shadow ? vetoKindOf(s.vetoReason) : 'real';

      const arm = engineArm(g, candles, s.createdAt, funding8h, spreadBps);
      engineArms.push({ cluster: symbol, wasReal, vetoKind, grossR: arm.grossR, netR: arm.netR, outcome: arm.outcome });
      if (arm.netR !== null) engineValues.push(arm.netR);

      // Control A: the random trade may only use the session's candles.
      const sessionCandles = candles.filter((c) => c.t < s.createdAt + LIFE_MS);
      const a = randomEntryBaseline(g, sessionCandles, s.createdAt, funding8h, spreadBps, {
        trials: TRIALS, lifeMs: LIFE_MS, candidateWindowMs: LIFE_MS, seed: SEED + hash(symbol),
      });
      if (a.meanNetR !== null) {
        controlA.push({ cluster: symbol, value: a.meanNetR });
        aSamples.push(a.trials.filter((t) => t.grossR !== null).map((t) => t.grossR as number));
      }

      // Control B: the same candidate entries, but a full life of candles.
      const b = randomEntryBaseline(g, candles, s.createdAt, funding8h, spreadBps, {
        trials: TRIALS, lifeMs: LIFE_MS, candidateWindowMs: LIFE_MS, seed: SEED + hash(symbol),
      });
      if (b.meanNetR !== null) {
        controlB.push({ cluster: symbol, value: b.meanNetR });
        bSamples.push(b.trials.filter((t) => t.grossR !== null).map((t) => t.grossR as number));
      }
    }
    if (fetched % 20 === 0) process.stdout.write(`  ...${fetched}/${bySymbol.size} symbols\n`);
  }
  console.log(`  fetched ${fetched} symbols, ${failed} failed`);

  const reWin = engineArms.filter((e) => e.outcome === 'TP1' || e.outcome === 'TP2' || e.outcome === 'TP3');
  const reGross = engineArms.filter((e) => e.grossR !== null);
  const reNet = engineArms.filter((e) => e.netR !== null);
  const byOutcome = new Map<string, number>();
  for (const e of engineArms) byOutcome.set(e.outcome, (byOutcome.get(e.outcome) ?? 0) + 1);
  console.log('\n--- 3. the ledger after re-resolution ---');
  console.log(`  resolved      ${engineArms.length}`);
  console.log(`  win rate      ${((reWin.length / engineArms.length) * 100).toFixed(2)}%`);
  console.log(`  avg gross R   ${mean(reGross.map((e) => e.grossR as number)).toFixed(4)}`);
  console.log(`  avg net R     ${mean(reNet.map((e) => e.netR as number)).toFixed(4)}  (MODELLED costs)`);
  console.log(`  outcomes      ${[...byOutcome.entries()].sort().map(([k, v]) => `${k}:${v}`).join('  ')}`);

  // ── 4. The two controls ──────────────────────────────────────────────────
  console.log('\n--- 4. the random-entry baselines (same geometry, random entry) ---');
  console.log(`  trials per signal   ${TRIALS}`);
  console.log(`  A = window-limited (the random trade may only use the session's candles)`);
  console.log(`  B = time-matched     (the random trade gets the same ${LEDGER.EXPIRY_HOURS}h life)`);

  // ── 5. The comparison ────────────────────────────────────────────────────
  const engineRows = reNet.map((e) => ({ cluster: e.cluster, value: e.netR as number }));
  console.log('\n--- 5. net expectancy, with cluster-bootstrap intervals ---');
  describe('engine', engineRows, SEED);
  describe('random, control A', controlA, SEED + 1);
  describe('random, control B', controlB, SEED + 2);

  const permB = permutationTestEngineVsRandom(engineValues, bSamples, PERMUTATIONS, SEED + 3);
  console.log('\n--- 6. permutation test (control B, time-matched) ---');
  console.log(`  observed difference  ${permB.observed} R over ${permB.n} paired signals`);
  console.log(`  permutation p        ${permB.pValue}  (${PERMUTATIONS} within-signal permutations)`);

  // ── 7. The population slices ─────────────────────────────────────────────
  console.log('\n--- 7. net expectancy by population (wasReal is a slice, not a feature) ---');
  const keep = (a: Arm) => a.netR !== null;
  const slices: [string, (a: Arm) => boolean][] = [
    ['all rows', () => true],
    ['real (grade A/B)', (a) => a.wasReal],
    ['shadow', (a) => !a.wasReal],
    ['excluding DATA_HEALTH', (a) => a.vetoKind !== 'DATA_HEALTH'],
    ['real, excl DATA_HEALTH', (a) => a.wasReal && a.vetoKind !== 'DATA_HEALTH'],
  ];
  for (const [label, pred] of slices) {
    const rows = engineArms.filter((a) => keep(a) && pred(a)).map((a) => ({ cluster: a.cluster, value: a.netR as number }));
    if (!rows.length) { console.log(`  ${label.padEnd(26)} (no rows)`); continue; }
    describe(label, rows, SEED + 4);
  }

  console.log('\n--- 8. by veto kind (the engine\'s own counter-examples) ---');
  for (const kind of ['real', 'GRADE_C', 'EVENT_RISK_MOVE', 'DATA_HEALTH', 'FUNDING_UNWIND', 'UNKNOWN']) {
    const rows = engineArms.filter((a) => keep(a) && a.vetoKind === kind).map((a) => ({ cluster: a.cluster, value: a.netR as number }));
    if (!rows.length) continue;
    describe(kind, rows, SEED + 5);
  }

  const bMean = mean(controlB.map((r) => r.value));
  const eMean = mean(engineRows.map((r) => r.value));
  console.log('\n--- verdict ---');
  console.log(`  engine ${eMean.toFixed(4)} R vs random (time-matched) ${bMean.toFixed(4)} R  ->  ${(eMean - bMean).toFixed(4)} R`);
  console.log(`  permutation p ${permB.pValue}`);
  console.log('  NOTE: the engine arm fills at the entry mid with no slippage AT THE FILL.');
  console.log('        The random arm fills at a candle open. The comparison favours the engine.');
  console.log('=== OK ===\n');
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 100_000;
}

main()
  .then(() => { closeLedger(); process.exit(0); })
  .catch((err) => { console.error(err); closeLedger(); process.exit(1); });
