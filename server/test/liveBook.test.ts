import { describe, expect, it } from 'vitest';
import type { TerminalBook } from '../../shared/types.js';
import {
  applyDepthUpdate, bookFromDepth, depthSide, parseAggTrade, seedDepth,
} from '../../src/terminal/liveBook.js';

const base: TerminalBook = {
  symbol: 'BTCUSDT',
  asOf: 1_000,
  lastUpdateId: 100,
  bestBid: 100,
  bestAsk: 101,
  mid: 100.5,
  spreadBps: 99.5,
  bidUsd: 200,
  askUsd: 101,
  imbalance: 0,
  bids: [
    { price: 100, qty: 2, usd: 200 },
    { price: 99, qty: 1, usd: 99 },
  ],
  asks: [
    { price: 101, qty: 1, usd: 101 },
  ],
  trades: [],
  tradesAvailable: true,
  pollMs: 3_000,
  wallMultiple: 3,
  wallPeerLevels: 20,
  wallNearPct: 0.005,
};

describe('Binance diff-depth application', () => {
  it('seeds quantity maps from a REST snapshot', () => {
    const depth = seedDepth(base);
    expect(depth.lastUpdateId).toBe(100);
    expect(depth.bids.get(100)).toBe(2);
    expect(depth.asks.get(101)).toBe(1);
  });

  it('applies only the first continuous update and then ignores old ones', () => {
    const depth = seedDepth(base);
    expect(applyDepthUpdate(depth, { U: 101, u: 105, b: [['100', '3'], ['98', '4']], a: [['101', '0']] })).toBe('applied');
    expect(depth.bids.get(100)).toBe(3);
    expect(depth.bids.get(98)).toBe(4);
    expect(depth.asks.has(101)).toBe(false);
    expect(depth.lastUpdateId).toBe(105);
    expect(applyDepthUpdate(depth, { U: 95, u: 105, b: [['100', '9']] })).toBe('ignored');
    expect(depth.bids.get(100)).toBe(3);
  });

  it('refuses to merge through a sequence hole', () => {
    const depth = seedDepth(base);
    expect(applyDepthUpdate(depth, { U: 103, u: 104, b: [['100', '9']] })).toBe('gap');
    expect(depth.lastUpdateId).toBe(100);
    expect(depth.bids.get(100)).toBe(2);
  });

  it('sorts, caps and prices the depth into a book', () => {
    const depth = seedDepth(base);
    applyDepthUpdate(depth, {
      U: 101, u: 102,
      b: [['100', '5'], ['99.5', '2']], a: [['101', '0'], ['102', '3'], ['101.5', '1']],
    });
    const next = bookFromDepth(base, depth, 2_000, 1_000);
    expect(next?.bids.map((l) => l.price)).toEqual([100, 99.5, 99]);
    expect(next?.asks.map((l) => l.price)).toEqual([101.5, 102]);
    expect(next?.bestBid).toBe(100);
    expect(next?.bestAsk).toBe(101.5);
    expect(next?.pollMs).toBe(1_000);
    expect(next?.lastUpdateId).toBe(102);
    expect(depthSide(depth.bids, 'bid', 1)).toHaveLength(1);
  });

  it('parses aggTrade aggressor and notional', () => {
    expect(parseAggTrade({ a: 9, p: '100.5', q: '2', T: 5_000, m: false })).toMatchObject({
      id: 9, price: 100.5, qty: 2, usd: 201, side: 'buy',
    });
    expect(parseAggTrade({ a: 9, p: '100.5', q: '2', T: 5_000, m: true })?.side).toBe('sell');
    expect(parseAggTrade({ a: 9, p: 'nope', q: '2', T: 5_000, m: false })).toBeNull();
  });
});
