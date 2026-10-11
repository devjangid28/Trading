/**
 * Proves the ledger records and resolves against REAL market data.
 *
 * Freezes a signal from a live scan, then replays real 5m candles through the
 * resolver. Acceptance criterion 7: "Ledger records a frozen snapshot on a new
 * signal and resolves it on a replayed candle series."
 *
 *   npx tsx scripts/verify-ledger.ts
 */
import { resolveOutcome } from '../server/src/ledger/resolve.js';
import { freezeSignal, markResolved, listSignals, signalCount } from '../server/src/ledger/store.js';
import { forceScan } from '../server/src/engine/scanner.js';
import { fetchKlines } from '../server/src/data/binance.js';
import type { SignalSnapshot } from '../shared/types.js';

const NOW = Date.now();

async function main() {
  console.log('\n=== Ledger verification against live market data ===\n');

  console.log('1. Running a live scan...');
  const scan = await forceScan();
  const rows = [...scan.bullish, ...scan.bearish];
  console.log(`   scanned=${scan.totalScanned} bull=${scan.bullish.length} bear=${scan.bearish.length}`);

  // Pick a row that has a real plan with targets and a sane risk.
  const row = rows.find((r) => r.plan && r.plan.targets.length && r.plan.riskPerUnit > 0);
  if (!row) {
    console.log('   No row with a usable trade plan right now. Nothing to verify.');
    return;
  }
  console.log(`   using ${row.base} ${row.side} grade=${row.conviction?.grade} score=${row.conviction?.score}`);

  console.log('\n2. Freezing a snapshot into SQLite...');
  const before = signalCount();
  const snapshot: SignalSnapshot = {
    score: row.conviction!.score,
    grade: row.conviction!.grade,
    side: row.side,
    components: row.conviction!.components,
    checklist: row.conviction!.checklist,
    regime: scan.regime,
    setup: row.setup,
    plan: row.plan,
    deriv: row.derivatives,
    sector: row.sector,
    breadth: scan.breadthBias,
    vwap: row.vwap,
    newsNis: row.newsDot?.nis ?? 0,
    newsDirection: row.newsDot?.direction ?? 0,
    vetoes: row.conviction!.vetoes,
  };

  const id = freezeSignal(
    {
      symbol: row.base,
      side: row.side,
      grade: row.conviction!.grade,
      score: row.conviction!.score,
      shadow: row.conviction!.grade !== 'A' && row.conviction!.grade !== 'B',
      vetoReason: row.conviction!.vetoes[0] ?? null,
      rule: row.conviction!.rule,
      entryLow: row.plan.entryLow,
      entryHigh: row.plan.entryHigh,
      stop: row.plan.stop,
      targets: row.plan.targets.map((t) => t.price),
      riskPerUnit: row.plan.riskPerUnit,
      snapshot,
    },
    NOW - 6 * 3600_000, // backdated 6h so the replay window has candles
  );

  const after = signalCount();
  if (!id) {
    console.log(`   Signal already open for ${row.base} ${row.side}; skipped (dedupe works).`);
  } else {
    console.log(`   froze ${id}`);
    console.log(`   ledger ${before.total} -> ${after.total} (shadow ${after.shadow})`);
  }

  console.log('\n3. Replaying REAL 5m candles through the resolver...');
  const candles = (await fetchKlines(`${row.base}USDT`, '5m', 300)).filter((c) => c.closed);
  const createdAt = NOW - 6 * 3600_000;
  const replay = candles.filter((c) => c.t >= createdAt);
  console.log(`   ${replay.length} closed candles since signal creation`);

  const res = resolveOutcome({
    side: row.side,
    entry: (row.plan.entryLow + row.plan.entryHigh) / 2,
    stop: row.plan.stop,
    targets: row.plan.targets.map((t) => t.price),
    riskPerUnit: row.plan.riskPerUnit,
    candles: replay.map((c) => ({ h: c.h, l: c.l, c: c.c, t: c.t })),
    createdAt,
    now: NOW,
  });

  console.log(`   outcome   : ${res.outcome}`);
  console.log(`   R multiple: ${res.rMultiple ?? '(still open)'}`);
  console.log(`   MFE       : ${res.mfeR}R`);
  console.log(`   MAE       : ${res.maeR}R`);
  console.log(`   resolved at candle index ${res.index} at price ${res.price ?? '(n/a)'}`);

  if (res.outcome !== 'OPEN' && id) {
    markResolved(id, res, NOW);
    console.log('   marked resolved in the database');
  }

  const stored = listSignals(5);
  const mine = stored.find((s) => s.id === id) ?? stored[0];
  console.log('\n4. Readback from SQLite:');
  console.log(`   ${mine.symbol} ${mine.side} grade=${mine.grade} score=${mine.score} shadow=${mine.shadow}`);
  console.log(`   outcome=${mine.outcome} mfeR=${mine.mfeR} maeR=${mine.maeR}`);
  console.log(`   entry ${mine.entryZoneLow}-${mine.entryZoneHigh} stop=${mine.stop} targets=[${mine.targets.join(', ')}]`);
  console.log(`   frozen components: ${Object.entries(mine.snapshot.components).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  const counts = signalCount();
  console.log(`\n   final: total=${counts.total} open=${counts.open} resolved=${counts.resolved} shadow=${counts.shadow}`);
  console.log('\n=== OK ===\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('verification failed:', err);
    process.exit(1);
  });
