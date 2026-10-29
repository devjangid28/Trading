/**
 * `npm run mind:report` — is the model better than the base rate?
 *
 * The one question the Mind layer has to answer about itself, printed from the
 * real ledger. It exists because a claim like "this is calibrated" that can only
 * be checked by reading a React component is a claim nobody checks.
 *
 * Reads the SQLite ledger read-only and prints:
 *   - how many Mind-tagged resolved signals exist
 *   - the Brier score of the probabilities against the base-rate bar
 *   - the reliability diagram
 *   - per-grade realised win rate and HONEST average R
 *
 * Exits 0 either way. A model that is not beating the base rate yet is a
 * legitimate state to be in, not a test failure — but the report says so in
 * words rather than leaving it to be inferred from two numbers.
 */

import { listSignals, closeLedger, DB_PATH } from '../server/src/ledger/store.js';
import { buildCalibrationReport, honestRMultiple } from '../server/src/engine/mind/index.js';
import { MIND, LEDGER } from '../server/src/config.js';

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function padL(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
}

function main(): void {
  const all = listSignals(200_000, 'all');
  const resolved = all.filter((s) => s.outcome !== 'OPEN');
  const tagged = resolved.filter((s) => s.snapshot?.mind?.probability !== undefined);

  console.log('');
  console.log('  MIND — calibration of the probability layer against resolved outcomes');
  console.log('  ' + '='.repeat(74));
  console.log(`  ledger                ${DB_PATH}`);
  console.log(`  signals (all)         ${all.length}`);
  console.log(`  resolved              ${resolved.length}`);
  console.log(`  Mind-tagged resolved  ${tagged.length}`);
  console.log('');

  // How many of the old signals have no Mind block at all. They are EXCLUDED
  // rather than assumed to have been 50% — back-filling them would flatter the
  // report with a number nobody ever produced.
  const untagged = resolved.length - tagged.length;
  if (untagged > 0) {
    console.log(`  ${untagged} resolved signal(s) predate the Mind layer and are excluded.`);
    console.log('  They are not counted as 50% calls; doing so would improve the score artificially.');
    console.log('');
  }

  const report = buildCalibrationReport(all, Date.now());

  if (tagged.length === 0) {
    console.log('  NO MIND-TAGGED SIGNALS YET.');
    console.log('');
    console.log('  The layer only writes a probability into a snapshot for signals frozen after');
    console.log('  it was enabled. Until enough of those have resolved, every calibration number');
    console.log('  below would be noise. This is the correct state, not a failure.');
    closeLedger();
    return;
  }

  console.log(`  base rate             ${report.baseRate === null ? 'not enough decided signals' : pct(report.baseRate)}`);
  console.log(`  sample floor          ${MIND.CALIBRATION_MIN_SAMPLES}`);
  console.log('');

  if (report.suppressed) {
    console.log('  SUPPRESSED');
    console.log(`  ${report.suppressReason}`);
    console.log('');
    console.log('  No Brier score is printed below that floor. A score from a handful of');
    console.log('  signals is not a measurement, and printing it would be the exact failure');
    console.log('  this report exists to prevent.');
    console.log('');
  } else {
    console.log(`  Brier (model)         ${report.brier!.toFixed(4)}`);
    console.log(`  Brier (base rate)     ${report.brierBaseRate!.toFixed(4)}   <- the bar to beat`);
    console.log(`  delta                 ${report.brierDelta! > 0 ? '+' : ''}${report.brierDelta!.toFixed(4)}`);
    console.log('');
    console.log(
      report.beatsBaseRate
        ? `  VERDICT: better than the base rate by more than ${MIND.BRIER_MEANINGFUL_DELTA}.`
        : `  VERDICT: NOT better than the base rate by a meaningful margin.`,
    );
    console.log(
      report.beatsBaseRate
        ? '  The probabilities are carrying information the base rate does not have.'
        : '  Read the probabilities as a ranking, not as a forecast. This is expected\n  while the weights are still the shipped [TUNED] set.',
    );
    console.log('');

    const d = report.decomposition;
    if (d) {
      console.log('  decomposition   brier = reliability - resolution + uncertainty');
      console.log(`    reliability       ${d.reliability?.toFixed(4) ?? '-'}   within-bucket miscalibration`);
      console.log(`    resolution        ${d.resolution?.toFixed(4) ?? '-'}   discrimination; SUBTRACTS (larger is better)`);
      console.log(`    uncertainty       ${d.uncertainty?.toFixed(4) ?? '-'}   base rate variance o(1-o)`);
      console.log(`    residual          ${d.residual?.toFixed(4) ?? '-'}   non-zero only because of binning`);
      console.log(`    brier skill       ${d.brierSkill?.toFixed(4) ?? '-'}   1 - BS/climatology; this is the exact one`);
      console.log('');
      console.log('  Note: reliability is OVERestimated and uncertainty UNDERestimated at finite n');
      console.log('  (Ferro & Fricker 2012), with the bias decaying as 1/n. Not corrected here.');
      console.log('');
    }

    console.log('  reliability diagram   predicted bucket -> realised');
    console.log(`    ${padL('bucket', 10)}${padL('n', 8)}${padL('predicted', 12)}${padL('realised', 12)}`);
    for (const b of report.buckets) {
      if (b.n === 0) continue;
      const label = `${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}%`;
      console.log(
        `    ${padL(label, 10)}${padL(String(b.n), 8)}${padL(b.meanPredicted === null ? '—' : pct(b.meanPredicted), 12)}${padL(b.realised === null ? `n<${MIND.CALIBRATION_MIN_SAMPLES}` : pct(b.realised), 12)}`,
      );
    }
    console.log('');
  }

  console.log('  by grade   (win rate and HONEST R, i.e. the target that actually resolved)');
  console.log(`    ${pad('grade', 12)}${padL('n', 8)}${padL('win', 10)}${padL('avg R', 10)}${padL('mean p', 10)}`);
  for (const g of report.byGrade) {
    if (g.n === 0) continue;
    const p = report.predictedByGrade.find((x) => x.grade === g.grade);
    console.log(
      `    ${pad(g.grade, 12)}${padL(String(g.n), 8)}${padL(g.winRate === null ? `n<${LEDGER.MIN_SAMPLE_FOR_RATE}` : pct(g.winRate), 10)}${padL(g.avgR === null ? '—' : g.avgR.toFixed(2), 10)}${padL(p?.meanPredicted == null ? '—' : pct(p.meanPredicted), 10)}`,
    );
  }
  console.log('');

  // The M3.2 correction, made visible. This is the number the ledger's own
  // `rMultipleOf` would have reported for the same rows.
  const rs = resolved.map((s) => honestRMultiple(s)).filter((r): r is number => r !== null);
  if (rs.length > 0) {
    const meanHonest = rs.reduce((a, b) => a + b, 0) / rs.length;
    console.log(`  honest mean R over all resolved   ${meanHonest.toFixed(3)}`);
    console.log('  (the ledger\'s own avgR credits every winner with the FURTHEST target — M3.2 —');
    console.log('   so its figure is higher than this one. Both are shown so the gap is visible.)');
    console.log('');
  }

  console.log(`  weights                ${'shipped [TUNED] set, not fitted'}`);
  console.log(`  last refit             ${report.lastRefitAt === null ? 'never' : new Date(report.lastRefitAt).toISOString()}`);
  console.log('  ' + '='.repeat(74));
  console.log('');

  closeLedger();
}

main();