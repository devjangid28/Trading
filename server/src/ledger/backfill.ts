import type { Candle } from '../../../shared/types.js';
import { LEDGER } from '../config.js';
import { fetchKlines } from '../data/binance.js';
import { openSignals, markResolved, touchChecked, recordGap } from './store.js';
import { resolveOutcome } from './resolve.js';
import { resolveOpenSignals } from './worker.js';

/**
 * Restart recovery.
 *
 * The ledger is only as good as the candles it saw. If the process is stopped —
 * laptop sleeps, a crash, a deploy — the in-memory candles are gone and the
 * next resolve would skip straight to "what does price look like now", missing
 * the stop or target that fired in between. A signal that resolved while we
 * were down would be recorded as still open, and worse, MFE/MAE would be
 * understated.
 *
 * So on startup we do three things:
 *   1. Work out the oldest un-resolved signal.
 *   2. Pull enough REST klines to cover every minute since it was created.
 *   3. Log the gap in the DB so downtime is visible rather than invisible.
 */

const FIVE_MIN = 5 * 60_000;

export interface BackfillReport {
  openSignals: number;
  oldestSignalAgeMs: number | null;
  candlesFetched: number;
  candlesCoveredFrom: number | null;
  resolved: number;
  gaps: { from: number; to: number; minutes: number }[];
  /** True when the gap was larger than one candle and had to be backfilled. */
  hadGap: boolean;
}

/**
 * Binance caps a klines request at 1000 rows and silently truncates above that
 * rather than erroring, so a long downtime needs paginated requests.
 */
async function fetchSince(symbol: string, fromTs: number, now: number): Promise<Candle[]> {
  // The ledger stores the base asset ("ADA"); Binance needs the pair ("ADAUSDT").
  const pair = symbol.endsWith('USDT') ? symbol : `${symbol}USDT`;

  const needed = Math.ceil((now - fromTs) / FIVE_MIN) + 30;
  if (needed <= 1000) {
    return fetchKlines(pair, '5m', Math.min(1000, Math.max(60, needed)));
  }

  const out: Candle[] = [];
  let cursor = fromTs;
  // Backwards in pages of 1000 until we cover the window.
  for (let page = 0; page < 4 && now - cursor > 0; page++) {
    const end = Math.min(now, cursor + 1000 * FIVE_MIN);
    const chunk = await fetchKlines(pair, '5m', 1000);
    const fresh = chunk.filter((c) => c.t >= cursor && c.t <= end);
    out.push(...fresh);
    const earliest = chunk.length ? chunk[0].t : cursor;
    if (earliest >= cursor) break; // no further history available
    cursor = earliest - FIVE_MIN;
    if (fresh.length === 0 && page > 0) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

export async function backfillOnStartup(now = Date.now()): Promise<BackfillReport> {
  const open = openSignals();
  const report: BackfillReport = {
    openSignals: open.length,
    oldestSignalAgeMs: null,
    candlesFetched: 0,
    candlesCoveredFrom: null,
    resolved: 0,
    gaps: [],
    hadGap: false,
  };

  if (!open.length) return report;

  const oldest = Math.min(...open.map((r) => r.created_at));
  report.oldestSignalAgeMs = now - oldest;

  // Anything older than a candle interval means we missed closed candles.
  if (now - oldest > FIVE_MIN * 2) report.hadGap = true;

  const bySymbol = new Map<string, typeof open>();
  for (const row of open) {
    const arr = bySymbol.get(row.symbol);
    if (arr) arr.push(row);
    else bySymbol.set(row.symbol, [row]);
  }

  for (const [symbol, rows] of bySymbol) {
    const symbolOldest = Math.min(...rows.map((r) => r.created_at));
    let candles: Candle[] = [];
    try {
      candles = (await fetchSince(symbol, symbolOldest - FIVE_MIN, now)).filter((c) => c.closed);
    } catch (err) {
      // One symbol failing must not stop the rest of the recovery, but it must
      // be visible — a silent catch here is what made this report 0 candles
      // with no explanation.
      console.warn(`[ledger] backfill failed for ${symbol}: ${(err as Error).message}`);
      continue;
    }
    report.candlesFetched += candles.length;
    if (candles.length) {
      const from = candles[0].t;
      report.candlesCoveredFrom = report.candlesCoveredFrom === null
        ? from
        : Math.min(report.candlesCoveredFrom, from);

      // Detect and record any hole in the candle series.
      for (let i = 1; i < candles.length; i++) {
        const gap = candles[i].t - candles[i - 1].t;
        if (gap > FIVE_MIN * 1.5) {
          const minutes = Math.round(gap / 60_000);
          report.gaps.push({ from: candles[i - 1].t, to: candles[i].t, minutes });
          recordGap(symbol, candles[i - 1].t, candles[i].t, minutes);
        }
      }
    }

    const bars = candles.map((c) => ({ h: c.h, l: c.l, c: c.c, t: c.t }));
    for (const row of rows) {
      const res = resolveOutcome({
        side: row.side,
        entry: (row.entry_low + row.entry_high) / 2,
        stop: row.stop,
        targets: row.targets,
        riskPerUnit: row.risk_per_unit,
        candles: bars,
        createdAt: row.created_at,
        now,
      });
      if (res.outcome === 'OPEN') {
        touchChecked(row.id, now, res.index + 1);
      } else {
        markResolved(row.id, res, now);
        report.resolved++;
      }
    }
  }

  return report;
}

/** Normal periodic resolve, used by the running worker. */
export const resolveNow = resolveOpenSignals;

export { LEDGER };
