import { describe, expect, it } from 'vitest';
import type { Candle, TerminalTrade } from '../../shared/types.js';
import {
  buildTerminalBook, normalizeTerminalSymbol, parseTerminalInterval,
} from '../src/terminal/data.js';
import {
  appendBookFrame, mergeLiveCandle, mergeTrades, nearestWalls, tapeStats,
  wallReading, type BookFrame,
} from '../../src/terminal/math.js';
import type { AggTrade, SpotDepth } from '../src/data/binance.js';

const depth: SpotDepth = {
  lastUpdateId: 42,
  bids: [['100', '2'], ['99', '3']],
  asks: [['101', '1'], ['102', '4']],
};

const tape: AggTrade[] = [
  { a: 2, p: '101', q: '0.5', T: 2_000, m: false },
  { a: 1, p: '100', q: '1', T: 1_000, m: true },
  { a: 2, p: '101', q: '0.5', T: 2_000, m: false },
];

function frame(
  asOf: number,
  bids: [number, number][],
  asks: [number, number][] = [[100.5, 100]],
): BookFrame {
  return {
    asOf,
    lastUpdateId: asOf,
    mid: 100,
    bestBid: 99.9,
    bestAsk: 100.1,
    bidUsd: bids.reduce((s, [p, u]) => s + p * u, 0),
    askUsd: asks.reduce((s, [p, u]) => s + p * u, 0),
    bids: bids.map(([price, usd]) => ({ price, usd })),
    asks: asks.map(([price, usd]) => ({ price, usd })),
  };
}

describe('terminal symbols and intervals', () => {
  it('accepts only an uppercase USDT spot shape', () => {
    expect(normalizeTerminalSymbol(' btcusdt ')).toBe('BTCUSDT');
    expect(normalizeTerminalSymbol('BTC-USDT')).toBeNull();
    expect(normalizeTerminalSymbol('BTCUSDT/../../x')).toBeNull();
    expect(normalizeTerminalSymbol(undefined)).toBeNull();
  });

  it('accepts the terminal windows and rejects engine-only intervals', () => {
    expect(parseTerminalInterval('1m')).toBe('1m');
    expect(parseTerminalInterval('1d')).toBe('1d');
    expect(parseTerminalInterval('3m')).toBeNull();
    expect(parseTerminalInterval(undefined)).toBeNull();
  });
});

describe('terminal book aggregation', () => {
  it('keeps every level, computes top-of-book stats and maps the tape side', () => {
    const book = buildTerminalBook('BTCUSDT', depth, tape, {
      asOf: 10, pollMs: 2_000,
    });
    expect(book.lastUpdateId).toBe(42);
    expect(book.bestBid).toBe(100);
    expect(book.bestAsk).toBe(101);
    expect(book.mid).toBe(100.5);
    expect(book.spreadBps).toBeCloseTo(99.5025, 3);
    expect(book.bids.map((l) => l.price)).toEqual([100, 99]);
    expect(book.asks.map((l) => l.price)).toEqual([101, 102]);
    expect(book.bidUsd).toBe(497);
    expect(book.askUsd).toBe(509);
    expect(book.imbalance).toBeCloseTo(-6 / 503, 8);
    expect(book.trades).toHaveLength(2);
    expect(book.trades[0]).toMatchObject({ id: 1, side: 'sell', price: 100 });
    expect(book.trades[1]).toMatchObject({ id: 2, side: 'buy', price: 101 });
    expect(book.tradesAvailable).toBe(true);
    expect(book.pollMs).toBe(2_000);
  });

  it('reports a failed tape without discarding the book', () => {
    const book = buildTerminalBook('BTCUSDT', depth, [], { tradesError: 'HTTP 500' });
    expect(book.tradesAvailable).toBe(false);
    expect(book.tradeError).toBe('HTTP 500');
    expect(book.bids).toHaveLength(2);
  });

  it('refuses to invent a book when one side is empty', () => {
    expect(() => buildTerminalBook('BTCUSDT', { ...depth, bids: [] }, [])).toThrow(/empty order book/);
  });
});

describe('terminal chart and history merges', () => {
  const base: Candle = {
    t: 60_000, o: 100, h: 102, l: 99, c: 101, v: 10, qv: 1_000, closed: true,
  };

  it('starts a new forming candle when the live tick crosses the interval', () => {
    const next = mergeLiveCandle([base], 105, '1m', 120_000 + 5_000);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      t: 120_000, o: 105, h: 105, l: 105, c: 105, v: 0, closed: false,
    });
  });

  it('extends the current forming candle without changing its open or volume', () => {
    const current = { ...base, t: 120_000, closed: false };
    const next = mergeLiveCandle([current], 98, '1m', 120_000 + 9_000);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      t: 120_000, o: 100, h: 102, l: 98, c: 98, v: 10, closed: false,
    });
  });

  it('ignores an out-of-order bucket and a missing tick', () => {
    const current = { ...base, t: 180_000 };
    expect(mergeLiveCandle([current], 99, '1m', 120_000)).toBeInstanceOf(Array);
    expect(mergeLiveCandle([current], 99, '1m', 120_000)[0].t).toBe(180_000);
    expect(mergeLiveCandle([current], null, '1m', 120_000)).toHaveLength(1);
  });

  it('dedupes sampled books by update id and caps history', () => {
    const one = frame(1, [[99, 10]]);
    const two = frame(2, [[99, 11]]);
    expect(appendBookFrame([one], one)).toHaveLength(1);
    expect(appendBookFrame([one], two, 2)).toEqual([one, two]);
    expect(appendBookFrame([one, two], frame(3, [[99, 12]]), 2).map((f) => f.asOf)).toEqual([2, 3]);
  });

  it('merges tape polls by id in time order', () => {
    const a: TerminalTrade = { id: 1, t: 1, price: 100, qty: 1, usd: 100, side: 'buy' };
    const b: TerminalTrade = { id: 2, t: 2, price: 101, qty: 1, usd: 101, side: 'sell' };
    expect(mergeTrades([a], [b]).map((t) => t.id)).toEqual([1, 2]);
    expect(mergeTrades([a], [{ ...a, price: 102 }])[0].price).toBe(102);
  });
});

describe('terminal wall reading', () => {
  it('names an exceptional near-touch level and counts a pull', () => {
    const frames = [
      frame(1_000, [[99.5, 900], [99.6, 100], [99.7, 100], [99.8, 100]]),
      frame(2_000, [[99.6, 100], [99.7, 100], [99.8, 100]]),
      frame(3_000, [[99.5, 1_000], [99.6, 100], [99.7, 100], [99.8, 100]]),
    ];
    const wall = wallReading(frames, 3, 0.005);
    expect(wall).toMatchObject({
      side: 'bid', price: 99.5, usd: 1_000, pulls: 1,
    });
    expect(wall?.multiple).toBeGreaterThan(8);
  });

  it('reports standing since capture when the level never left', () => {
    const frames = [
      frame(1_000, [[99.5, 1_000], [99.6, 100], [99.7, 100], [99.8, 100]]),
      frame(2_000, [[99.5, 1_000], [99.6, 100], [99.7, 100], [99.8, 100]]),
      frame(3_000, [[99.5, 1_000], [99.6, 100], [99.7, 100], [99.8, 100]]),
    ];
    const wall = wallReading(frames, 3, 0.005);
    expect(wall?.standingSinceStart).toBe(true);
    expect(wall?.standingMs).toBe(2_000);
  });

  it('refuses to call an evenly sized book a wall', () => {
    const frames = [
      frame(1_000, [[99.5, 100], [99.6, 100], [99.7, 100], [99.8, 100]]),
    ];
    expect(wallReading(frames, 3, 0.005)).toBeNull();
  });
});

describe('terminal nearest walls and tape stats', () => {
  it('names the largest near-touch level on each side and its standing time', () => {
    const frames = [
      frame(1_000, [[99.5, 900], [99.6, 100], [99.7, 100]], [[100.5, 100], [100.6, 100]]),
      frame(2_000, [[99.5, 1_000], [99.6, 100], [99.7, 100]], [[100.5, 800], [100.6, 100]]),
      frame(3_000, [[99.5, 1_000], [99.6, 100], [99.7, 100]], [[100.5, 800], [100.6, 100]]),
    ];
    const walls = nearestWalls(frames, 0.01, 20);
    expect(walls.bid).toMatchObject({ price: 99.5, usd: 1_000, standingMs: 2_000 });
    expect(walls.ask).toMatchObject({ price: 100.5, usd: 800, standingMs: 1_000 });
    expect(walls.bid?.distanceBps).toBe(50);
    expect(walls.ask?.distanceBps).toBe(50);
  });

  it('measures CVD, the forming candle delta and POC from captured trades only', () => {
    const trades: TerminalTrade[] = [
      { id: 1, t: 30_000, price: 100, qty: 2, usd: 200, side: 'buy' },
      { id: 2, t: 61_000, price: 101, qty: 1, usd: 101, side: 'sell' },
      { id: 3, t: 62_000, price: 101, qty: 3, usd: 303, side: 'buy' },
    ];
    const stats = tapeStats(trades, 100, 60_000, 65_000);
    expect(stats.cvdUsd).toBe(402);
    expect(stats.candleDeltaQty).toBe(2);
    expect(stats.poc).toBeCloseTo(101, 2);
    expect(stats.capturedTrades).toBe(3);
  });
});
