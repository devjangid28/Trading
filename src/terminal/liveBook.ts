import type {
  TerminalBook, TerminalBookLevel, TerminalTrade,
} from '../../shared/types';

/** One Binance spot diff-depth payload, kept as strings until it is applied. */
export interface DepthUpdate {
  U: number;
  u: number;
  b: [string, string][];
  a?: [string, string][];
}

export interface DepthBook {
  bids: Map<number, number>;
  asks: Map<number, number>;
  lastUpdateId: number;
}

export type DepthApply = 'applied' | 'ignored' | 'gap';

export function seedDepth(book: TerminalBook): DepthBook {
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  for (const level of book.bids) {
    bids.set(level.price, level.qty ?? level.usd / level.price);
  }
  for (const level of book.asks) {
    asks.set(level.price, level.qty ?? level.usd / level.price);
  }
  return { bids, asks, lastUpdateId: book.lastUpdateId };
}

/**
 * Apply a Binance diff-depth update in place.
 *
 * `gap` is returned before any mutation when the first update id skips past the
 * snapshot. The caller must fetch a fresh snapshot - merging through a sequence
 * hole would render a book that never existed.
 */
export function applyDepthUpdate(state: DepthBook, update: DepthUpdate): DepthApply {
  if (!Number.isFinite(update.U) || !Number.isFinite(update.u)) return 'ignored';
  if (update.u <= state.lastUpdateId) return 'ignored';
  if (update.U > state.lastUpdateId + 1) return 'gap';
  for (const [rawPrice, rawQty] of update.b) {
    const price = Number(rawPrice);
    const qty = Number(rawQty);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty < 0) continue;
    if (qty === 0) state.bids.delete(price);
    else state.bids.set(price, qty);
  }
  for (const [rawPrice, rawQty] of update.a ?? []) {
    const price = Number(rawPrice);
    const qty = Number(rawQty);
    if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty < 0) continue;
    if (qty === 0) state.asks.delete(price);
    else state.asks.set(price, qty);
  }
  state.lastUpdateId = update.u;
  return 'applied';
}

export function depthSide(
  levels: Map<number, number>,
  side: 'bid' | 'ask',
  limit: number,
): TerminalBookLevel[] {
  const prices = [...levels.keys()].sort((a, b) => side === 'bid' ? b - a : a - b);
  const out: TerminalBookLevel[] = [];
  for (const price of prices) {
    if (out.length >= limit) break;
    const qty = levels.get(price) ?? 0;
    if (!(qty > 0)) continue;
    out.push({ price, qty, usd: Math.round(price * qty) });
  }
  return out;
}

export function bookFromDepth(
  base: TerminalBook,
  depth: DepthBook,
  asOf: number,
  pollMs = 1_000,
): TerminalBook | null {
  const bids = depthSide(depth.bids, 'bid', 1_000);
  const asks = depthSide(depth.asks, 'ask', 1_000);
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const bidUsd = bids.reduce((sum, level) => sum + level.usd, 0);
  const askUsd = asks.reduce((sum, level) => sum + level.usd, 0);
  return {
    ...base,
    asOf,
    lastUpdateId: depth.lastUpdateId,
    bestBid,
    bestAsk,
    mid,
    spreadBps: mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0,
    bidUsd,
    askUsd,
    imbalance: bidUsd + askUsd > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0,
    bids,
    asks,
    pollMs,
  };
}

export function parseAggTrade(message: {
  a?: number; p?: string; q?: string; T?: number; m?: boolean;
}): TerminalTrade | null {
  if (!Number.isFinite(message.a) || !Number.isFinite(message.T)) return null;
  const price = Number(message.p);
  const qty = Number(message.q);
  if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) return null;
  return {
    id: message.a as number,
    t: message.T as number,
    price,
    qty,
    usd: Math.round(price * qty),
    side: message.m ? 'sell' : 'buy',
  };
}
