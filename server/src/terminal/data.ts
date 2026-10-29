import type {
  TerminalBook, TerminalBookLevel, TerminalCandles, TerminalInterval, TerminalTrade,
} from '../../../shared/types.js';
import { TERMINAL_INTERVALS } from '../../../shared/types.js';
import { fetchAggTrades, fetchKlines, fetchSpotDepth, type AggTrade, type SpotDepth } from '../data/binance.js';
import { TERMINAL } from '../config.js';

const SYMBOL_RE = /^[A-Z0-9]{2,20}USDT$/;

/**
 * Symbols are accepted from a query string and then interpolated into a Binance
 * URL. Only the uppercase alphanumeric USDT shape the picker can produce is
 * allowed; anything else is rejected before a request is built.
 */
export function normalizeTerminalSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const symbol = raw.trim().toUpperCase();
  return SYMBOL_RE.test(symbol) ? symbol : null;
}

export function parseTerminalInterval(raw: unknown): TerminalInterval | null {
  if (typeof raw !== 'string') return null;
  return (TERMINAL_INTERVALS as readonly string[]).includes(raw)
    ? (raw as TerminalInterval)
    : null;
}

function levels(pairs: [string, string][]): TerminalBookLevel[] {
  const out: TerminalBookLevel[] = [];
  for (const [p, q] of pairs) {
    const price = Number(p);
    const qty = Number(q);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) continue;
    out.push({ price, qty, usd: Math.round(price * qty) });
  }
  return out;
}

function trades(raw: AggTrade[]): TerminalTrade[] {
  const seen = new Set<number>();
  const out: TerminalTrade[] = [];
  for (const t of raw) {
    if (seen.has(t.a)) continue;
    seen.add(t.a);
    const price = Number(t.p);
    const qty = Number(t.q);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) continue;
    out.push({
      id: t.a,
      t: t.T,
      price,
      qty,
      usd: Math.round(price * qty),
      // Buyer-maker means the taker sold into the bid.
      side: t.m ? 'sell' : 'buy',
    });
  }
  return out.sort((a, b) => a.t - b.t || a.id - b.id);
}

/**
 * Build the heatmap payload without doing any I/O, so the aggregation rules are
 * testable without a network fixture.
 */
export function buildTerminalBook(
  symbol: string,
  depth: SpotDepth,
  rawTrades: AggTrade[],
  options: {
    asOf?: number;
    tradesError?: string;
    pollMs?: number;
    wallMultiple?: number;
    wallPeerLevels?: number;
    wallNearPct?: number;
  } = {},
): TerminalBook {
  const bids = levels(depth.bids).sort((a, b) => b.price - a.price);
  const asks = levels(depth.asks).sort((a, b) => a.price - b.price);
  if (!bids.length || !asks.length) throw new Error(`empty order book for ${symbol}`);

  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const bidUsd = bids.reduce((sum, l) => sum + l.usd, 0);
  const askUsd = asks.reduce((sum, l) => sum + l.usd, 0);
  const total = bidUsd + askUsd;

  return {
    symbol,
    asOf: options.asOf ?? Date.now(),
    lastUpdateId: Number(depth.lastUpdateId) || 0,
    bestBid,
    bestAsk,
    mid,
    spreadBps: mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0,
    bidUsd,
    askUsd,
    imbalance: total > 0 ? (bidUsd - askUsd) / total : 0,
    bids,
    asks,
    trades: trades(rawTrades),
    tradesAvailable: options.tradesError === undefined,
    tradeError: options.tradesError,
    pollMs: options.pollMs ?? TERMINAL.SAMPLE_MS,
    wallMultiple: options.wallMultiple ?? TERMINAL.WALL_MULTIPLE,
    wallPeerLevels: options.wallPeerLevels ?? TERMINAL.WALL_PEER_LEVELS,
    wallNearPct: options.wallNearPct ?? TERMINAL.WALL_NEAR_PCT,
  };
}

export async function terminalBook(
  symbol: string,
  purpose: 'essential' | 'normal' | 'nonessential' = 'normal',
): Promise<TerminalBook> {
  const [depth, tape] = await Promise.all([
    fetchSpotDepth(symbol, TERMINAL.DEPTH_LIMIT, TERMINAL.BOOK_TTL_MS, purpose),
    fetchAggTrades(symbol, TERMINAL.TRADE_LIMIT, TERMINAL.TRADE_TTL_MS, purpose)
      .then((rows) => ({ rows, error: undefined }))
      .catch((err: Error) => ({ rows: [] as AggTrade[], error: err.message })),
  ]);

  return buildTerminalBook(symbol, depth, tape.rows, {
    tradesError: tape.error,
    pollMs: TERMINAL.SAMPLE_MS,
  });
}

export async function terminalCandles(
  symbol: string,
  interval: TerminalInterval,
  limit: number = TERMINAL.CHART_LIMIT,
): Promise<TerminalCandles> {
  const safeLimit = Math.min(500, Math.max(20, limit));
  const candles = await fetchKlines(
    symbol,
    interval,
    safeLimit,
    TERMINAL.CHART_TTL_MS,
  );
  return { symbol, interval, asOf: Date.now(), candles };
}
