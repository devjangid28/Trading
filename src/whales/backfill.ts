import type { TerminalTrade } from '../../shared/types';
import { fetchAggTrades } from '../lib/binance';

/**
 * History backfill for the whale tape. The live WebSocket only carries trades
 * from the moment it opens; the reference view needs ~120 minutes of history
 * so the shield / band / net panels are meaningful on a fresh load.
 *
 * Backfill uses Binance REST `/api/v3/aggTrades`, paginating with `fromId`.
 * AggTrade ids are the SAME id space as the `@aggTrade` WS stream, so the
 * backfilled tape and the live tape merge without duplicates.
 */

export const BACKFILL_MINUTES = 120;
export const BACKFILL_MAX_PAGES = 24;

export interface BackfillResult {
  trades: TerminalTrade[];
  earliest: number | null;
  latest: number | null;
}

export function aggTradeToTerminal(trade: {
  id: number;
  t: number;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
  firstId: number;
  lastId: number;
}): TerminalTrade {
  return {
    id: trade.id,
    t: trade.t,
    price: trade.price,
    qty: trade.qty,
    usd: trade.price * trade.qty,
    side: trade.side,
    count: Math.max(1, trade.lastId - trade.firstId + 1),
  };
}

export async function backfillTrades(
  symbol: string,
  opts: { minutes?: number; signal?: AbortSignal } = {},
): Promise<BackfillResult> {
  const now = Date.now();
  const minutes = Math.max(1, opts.minutes ?? BACKFILL_MINUTES);
  const startTime = now - minutes * 60_000;
  const raw = await fetchAggTrades(symbol, { startTime, endTime: now, signal: opts.signal });
  const trades = raw.map(aggTradeToTerminal);
  const earliest = trades.length ? Math.min(...trades.map((t) => t.t)) : null;
  const latest = trades.length ? Math.max(...trades.map((t) => t.t)) : null;
  return { trades, earliest, latest };
}

/**
 * Merge two id-sorted tapes, deduplicating on the aggregate trade id. The
 * result stays sorted by id (which is also chronological).
 */
export function mergeTrades(a: readonly TerminalTrade[], b: readonly TerminalTrade[]): TerminalTrade[] {
  const out: TerminalTrade[] = [];
  const seen = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const ta = i < a.length ? a[i] : null;
    const tb = j < b.length ? b[j] : null;
    const take = ta && tb ? (ta.id <= tb.id ? ta : tb) : (ta ?? tb);
    if (take === null) break;
    if (take === ta) i += 1;
    else j += 1;
    if (!seen.has(take.id)) {
      seen.add(take.id);
      out.push(take);
    }
  }
  return out;
}
