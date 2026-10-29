/**
 * The ledger's own statistics, printed in full — and the M3.2 before/after.
 *
 *   npm run ledger:stats
 *
 * Two things this script exists for:
 *
 * 1. **The M3.2 before/after.** It computes the OLD accounting (every winner
 *    credited with the plan's FURTHEST target R) alongside the NEW one (the
 *    R at the target that actually resolved the signal) from the SAME rows, so
 *    the two numbers are directly comparable and the difference is
 *    attributable to the fix rather than to a different dataset.
 *
 * 2. **The honesty of the calibration claim.** It prints the ladder, the
 *    monotonicity verdict with its interval and p-value, and the veto
 *    breakdown BY KIND. A rate below the sample floor is printed as `—` with
 *    the sample count, never as a number.
 */
import { listSignals, ledgerStats, closeLedger, DB_PATH } from '../server/src/ledger/store.js';
import { realisedR, TARGET_WINS } from '../server/src/ledger/resolve.js';
import { vetoKindOf, VETO_KIND_LABEL } from '../server/src/engine/vetoKind.js';
import { LEDGER } from '../server/src/config.js';
import type { LedgerSignal } from '../shared/types.js';

/** The OLD accounting, for the before/after. Never used anywhere else. */
function oldRMultipleOf(s: LedgerSignal): number | null {
  if (s.outcome === 'STOP') return -1;
  if (TARGET_WINS.has(s.outcome)) {
    const r = s.snapshot.plan;
    return r && r.rr > 0 ? r.rr : null;
  }
  if (s.outcome === 'EXPIRED' && s.priceAtResolve !== null) {
    const risk = Math.abs(s.entryZoneHigh - s.stop) || Math.abs(s.entryZoneLow - s.stop) || 1;
    const dir = s.side === 'bullish' ? 1 : -1;
    return (dir * (s.priceAtResolve - s.entryZoneHigh)) / risk;
  }
  return null;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function r2(v: number): string {
  return v.toFixed(2);
}

function main(): void {
  const signals = listSignals(100_000, 'all');
  const resolved = signals.filter((s) => s.outcome !== 'OPEN');
  const wins = resolved.filter((s) => TARGET_WINS.has(s.outcome));

  console.log('\n=== Ledger statistics ===\n');
  console.log(`database        ${DB_PATH}`);
  console.log(`signals         ${signals.length}`);
  console.log(`resolved        ${resolved.length}`);
  console.log(`open            ${signals.length - resolved.length}`);
  console.log(`wins            ${wins.length} (${wins.filter((s) => s.outcome === 'TP1').length} at TP1, ` +
    `${wins.filter((s) => s.outcome === 'TP2').length} at TP2, ${wins.filter((s) => s.outcome === 'TP3').length} at TP3)`);

  // ── The M3.2 before/after ──────────────────────────────────────────────────
  const oldRs = resolved.map(oldRMultipleOf).filter((v): v is number => v !== null);
  const newRs = resolved.map(realisedR).filter((v): v is number => v !== null);

  const oldWin = oldRs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const oldLoss = Math.abs(oldRs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const newWin = newRs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const newLoss = Math.abs(newRs.filter((r) => r < 0).reduce((a, b) => a + b, 0));

  console.log('\n--- M3.2: the R a trade actually realised ---');
  console.log('                    OLD (plan.rr)      NEW (target hit)');
  console.log(`avg R                 ${r2(mean(oldRs)).padStart(10)}         ${r2(mean(newRs)).padStart(10)}`);
  console.log(`profit factor         ${r2(oldWin / oldLoss).padStart(10)}         ${r2(newWin / newLoss).padStart(10)}`);
  console.log(`gross win R           ${r2(oldWin).padStart(10)}         ${r2(newWin).padStart(10)}`);
  console.log(`gross loss R          ${r2(oldLoss).padStart(10)}         ${r2(newLoss).padStart(10)}`);
  console.log('\nThe OLD column credited every winner with the plan\'s FURTHEST target R.');
  console.log('The NEW column credits the target that actually resolved the signal.');

  // ── The reported statistics ───────────────────────────────────────────────
  const stats = ledgerStats('all');
  console.log('\n--- What /api/ledger reports ---');
  console.log(`win rate           ${stats.winRate === null ? '—' : `${stats.winRate}%`}`);
  console.log(`avg R              ${stats.avgR === null ? '—' : stats.avgR}`);
  console.log(`profit factor      ${stats.profitFactor === null ? '—' : stats.profitFactor}`);
  console.log(`sample floor       ${stats.sampleFloor}`);

  // ── Calibration ────────────────────────────────────────────────────────────
  console.log('\n--- Calibration ladder ---');
  for (const b of stats.calibration) {
    const wr = b.winRate === null ? '—' : `${b.winRate}%`;
    console.log(`  ${b.bucket.padStart(6)}  n=${String(b.n).padStart(4)}  win rate ${wr.padStart(7)}` +
      (b.winRate === null ? `   (below the ${stats.sampleFloor}-sample floor)` : ''));
  }
  const m = stats.monotonicity;
  console.log(`\n  verdict           ${m.verdict}`);
  console.log(`  Spearman rho      ${m.rho === null ? '—' : m.rho}` +
    (m.rhoCi ? `  95% CI [${m.rhoCi[0]}, ${m.rhoCi[1]}]` : ''));
  console.log(`  permutation p     ${m.permutationP === null ? '—' : m.permutationP}`);
  console.log(`  isotonic slope    ${m.isotonicSlope === null ? '—' : m.isotonicSlope}` +
    (m.isotonicSlopeCi ? `  95% CI [${m.isotonicSlopeCi[0]}, ${m.isotonicSlopeCi[1]}]` : ''));
  console.log(`  spread            ${m.spread === null ? '—' : `${(m.spread * 100).toFixed(1)}pp`}`);
  console.log(`  violations        ${m.violations === null ? '—' : m.violations}`);
  console.log(`  isPredictive      ${stats.isPredictive === null ? '— (unproven)' : stats.isPredictive}`);
  console.log(`  reason            ${m.reason}`);

  // ── Veto kinds ────────────────────────────────────────────────────────────
  console.log('\n--- Veto breakdown BY KIND (M1.6) ---');
  const vetoKeys = Object.keys(stats.byVeto).sort();
  for (const k of vetoKeys) {
    const g = stats.byVeto[k];
    const label = (VETO_KIND_LABEL as Record<string, string>)[k] ?? k;
    const wr = g.winRate === null ? `— (n=${g.n}, floor ${LEDGER.MIN_SAMPLE_FOR_RATE})` : `${g.winRate}%`;
    console.log(`  ${k.padEnd(16)} n=${String(g.n).padStart(4)}  win rate ${wr.padStart(24)}  ${label}`);
  }
  console.log('\n=== OK ===\n');
}

try {
  main();
} finally {
  closeLedger();
}
