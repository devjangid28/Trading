import type { AssetRow, Candle, SignalSnapshot } from '../../../shared/types';
import { LEDGER } from '../config.js';
import {
  freezeSignal, markResolved, openSignals, resolveOutcome, touchChecked, signalCount,
} from './store.js';
import { fetchKlines } from '../data/binance.js';

/**
 * The ledger worker.
 *
 * Two jobs:
 *   1. After each scan, freeze a signal for anything worth tracking.
 *   2. After each 5m candle close, resolve open signals.
 *
 * Which coins get recorded is the important decision. Recording only A/B would
 * produce almost nothing, because A/B rarely fires. So:
 *
 *   real   — grade A or B. These are the trades the system would actually take.
 *   shadow — grade C, and EVERY vetoed coin. These are tracked as if taken.
 *
 * The shadow set is a controlled experiment on the vetoes. The 14% event-risk
 * veto fired on LUMIA (+38%) and STRK (+19%) in one session. If those coins
 * kept running, the veto was too strict. If they reversed, it earned its keep.
 * Only the ledger can answer that, and only if those coins are recorded.
 */

export interface FreezeReport {
  frozen: number;
  skippedExisting: number;
  real: number;
  shadow: number;
}

const MAX_FREEZE_PER_SCAN = 12;

export function freezeFromScan(rows: AssetRow[], now = Date.now()): FreezeReport {
  const report: FreezeReport = { frozen: 0, skippedExisting: 0, real: 0, shadow: 0 };

  // Real signals first: A then B.
  const real = [
    ...rows.filter((r) => r.conviction?.grade === 'A'),
    ...rows.filter((r) => r.conviction?.grade === 'B'),
  ];

  // Shadows: grade C, then every vetoed coin (whatever its grade).
  const shadow = [
    ...rows.filter((r) => r.conviction?.grade === 'C'),
    ...rows.filter((r) => (r.conviction?.vetoes.length ?? 0) > 0),
  ];

  // De-duplicate: a vetoed A already appears in `real`.
  const seen = new Set<string>();
  const ordered = [...real, ...shadow].filter((r) => {
    const key = `${r.base}_${r.side}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let budget = MAX_FREEZE_PER_SCAN;
  for (const row of ordered) {
    if (budget <= 0) break;
    const c = row.conviction;
    const plan = row.plan;
    if (!c || !plan || !row.setup) continue;
    if (plan.riskPerUnit <= 0) continue;

    // No real targets means no measurable outcome, so nothing to learn from it.
    const targets = plan.targets.map((t) => t.price).filter((p) => Number.isFinite(p) && p > 0);
    if (!targets.length && !c.vetoes.length) continue;

    const isShadow = !(c.grade === 'A' || c.grade === 'B');
    const snapshot: SignalSnapshot = {
      score: c.score,
      grade: c.grade,
      side: row.side,
      components: c.components,
      checklist: c.checklist,
      regime: (row as unknown as { regime?: SignalSnapshot['regime'] }).regime ?? 'range',
      setup: row.setup,
      plan,
      deriv: row.derivatives,
      sector: row.sector,
      breadth: 'two-way',
      vwap: row.vwap,
      newsNis: row.newsDot?.nis ?? 0,
      newsDirection: row.newsDot?.direction ?? 0,
      vetoes: c.vetoes,
    };

    const id = freezeSignal(
      {
        symbol: row.base,
        side: row.side,
        grade: c.grade,
        score: c.score,
        shadow: isShadow,
        vetoReason: c.vetoes[0] ?? null,
        rule: c.rule,
        entryLow: plan.entryLow,
        entryHigh: plan.entryHigh,
        stop: plan.stop,
        targets,
        riskPerUnit: plan.riskPerUnit,
        snapshot,
      },
      now,
    );

    if (id) {
      report.frozen++;
      budget--;
      if (isShadow) report.shadow++; else report.real++;
    } else {
      report.skippedExisting++;
    }
  }

  return report;
}

export interface ResolveReport {
  checked: number;
  resolved: number;
  outcomes: Record<string, number>;
}

/**
 * Resolve every open signal against the candles since it was created.
 *
 * Re-fetches a bounded window per symbol rather than per signal, so N open
 * signals on the same coin cost one request.
 */
export async function resolveOpenSignals(now = Date.now()): Promise<ResolveReport> {
  const report: ResolveReport = { checked: 0, resolved: 0, outcomes: {} };
  const open = openSignals();
  if (!open.length) return report;

  const bySymbol = new Map<string, typeof open>();
  for (const row of open) {
    const arr = bySymbol.get(row.symbol);
    if (arr) arr.push(row); else bySymbol.set(row.symbol, [row]);
  }

  const earliest = Math.min(...open.map((r) => r.created_at));
  // 5m candles covering the age of the oldest open signal, capped at 1000 rows
  // because the endpoint silently truncates above that.
  const wantedCandles = Math.min(1000, Math.max(120, Math.ceil((now - earliest) / (5 * 60_000)) + 20));

  for (const [symbol, rows] of bySymbol) {
    let candles: Candle[] = [];
    try {
      candles = await fetchKlines(`${symbol}USDT`, '5m', wantedCandles);
    } catch {
      continue;
    }
    const bars = candles.filter((c) => c.closed);

    for (const row of rows) {
      report.checked++;
      const res = resolveOutcome({
        side: row.side,
        entry: (row.entry_low + row.entry_high) / 2,
        stop: row.stop,
        targets: row.targets,
        riskPerUnit: row.risk_per_unit,
        candles: bars.map((c) => ({ h: c.h, l: c.l, c: c.c, t: c.t })),
        createdAt: row.created_at,
        now,
      });

      if (res.outcome === 'OPEN') {
        touchChecked(row.id, now, res.index + 1);
        continue;
      }

      markResolved(row.id, res, now);
      report.resolved++;
      report.outcomes[res.outcome] = (report.outcomes[res.outcome] ?? 0) + 1;
    }
  }

  return report;
}

let workerTimer: ReturnType<typeof setInterval> | null = null;

/** Start the resolver. Runs every 5 minutes, offset to just after a close. */
export function startLedgerWorker(onLog?: (r: ResolveReport) => void): void {
  if (workerTimer) return;
  const run = () => {
    resolveOpenSignals()
      .then((r) => {
        if (r.resolved > 0) onLog?.(r);
      })
      .catch((err) => console.error('[ledger] resolve failed:', (err as Error).message));
  };
  workerTimer = setInterval(run, 5 * 60_000);
  // Give the first scan a moment to populate before the first resolve.
  setTimeout(run, 20_000);
}

export function stopLedgerWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

export { signalCount, LEDGER };
