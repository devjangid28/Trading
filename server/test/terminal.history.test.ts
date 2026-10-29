import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  TerminalBook, TerminalHistory, TerminalHistoryFrame,
} from '../../shared/types.js';
import {
  compactDepth, historyWindow, parseTerminalSpan, selectEvenly, tradeBucketMs,
} from '../src/terminal/history.js';
import {
  frameFromHistory, mergeBookFrames, type BookFrame,
} from '../../src/terminal/math.js';
import { cellAt, frameRowTotals } from '../../src/terminal/heatmap.js';

type Store = typeof import('../src/terminal/historyStore.js');

let dir = '';
let store: Store;
const originalDb = process.env.TERMINAL_DB;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orderflow-terminal-'));
  process.env.TERMINAL_DB = join(dir, 'history.db');
  store = await import('../src/terminal/historyStore.js');
});

afterAll(() => {
  store?.closeTerminalHistory();
  if (originalDb === undefined) delete process.env.TERMINAL_DB;
  else process.env.TERMINAL_DB = originalDb;
  rmSync(dir, { recursive: true, force: true });
});

function book(asOf: number, mid = 100, id = asOf): TerminalBook {
  return {
    symbol: 'BTCUSDT',
    asOf,
    lastUpdateId: id,
    bestBid: mid - 0.01,
    bestAsk: mid + 0.01,
    mid,
    spreadBps: 2,
    bidUsd: 8_000,
    askUsd: 9_000,
    imbalance: -0.05,
    bids: [
      { price: mid - 0.01, usd: 2_000, qty: 20 },
      { price: mid - 0.05, usd: 2_500, qty: 25 },
      { price: mid - 0.10, usd: 3_500, qty: 35 },
    ],
    asks: [
      { price: mid + 0.01, usd: 2_200, qty: 22 },
      { price: mid + 0.05, usd: 2_800, qty: 28 },
      { price: mid + 0.10, usd: 4_000, qty: 40 },
    ],
    trades: [
      {
        id, t: asOf, price: mid, qty: 0.5, usd: mid * 0.5, side: 'buy',
      },
    ],
    tradesAvailable: true,
    pollMs: 3_000,
    wallMultiple: 4,
    wallPeerLevels: 6,
    wallNearPct: 0.006,
  };
}

describe('compact captured depth', () => {
  it('sums levels into symmetric bins without moving them across the mid', () => {
    const lattice = compactDepth(book(1), 10, 0.005);
    expect(lattice.bids).toHaveLength(5);
    expect(lattice.asks).toHaveLength(5);
    expect(lattice.bids[0]).toBeCloseTo(4_500, 6);
    expect(lattice.bids[1]).toBeCloseTo(3_500, 6);
    expect(lattice.asks[0]).toBeCloseTo(5_000, 6);
    expect(lattice.asks[1]).toBeCloseTo(4_000, 6);
    expect(lattice.bids.reduce((sum, usd) => sum + usd, 0)).toBe(8_000);
    expect(lattice.asks.reduce((sum, usd) => sum + usd, 0)).toBe(9_000);
  });

  it('rejects invalid snapshots instead of inventing liquidity', () => {
    const lattice = compactDepth({ mid: 0, bids: [], asks: [] });
    expect(lattice.bids.every((usd) => usd === 0)).toBe(true);
    expect(lattice.asks.every((usd) => usd === 0)).toBe(true);
  });

  it('parses only the supported spans and clamps the window to retention', () => {
    expect(parseTerminalSpan('15m')).toBe('15m');
    expect(parseTerminalSpan('3m')).toBeNull();
    expect(parseTerminalSpan(undefined)).toBeNull();
    const now = 10_000_000;
    expect(historyWindow('1m', now, 3_600_000)).toEqual({
      from: now - 60_000, to: now, spanMs: 60_000,
    });
    expect(historyWindow('4h', now, 3_600_000).from).toBe(now - 3_600_000);
  });

  it('keeps the newest sample when downsampling and picks honest trade buckets', () => {
    expect(selectEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)).toEqual([0, 2, 5, 7, 9]);
    expect(selectEvenly([0, 1, 2], 1)).toEqual([2]);
    expect(tradeBucketMs(900_000)).toBe(1_000);
    expect(tradeBucketMs(86_400_000)).toBe(60_000);
  });
});

describe('history lattice rendering', () => {
  const historyFrame: TerminalHistoryFrame = {
    asOf: 1_000,
    lastUpdateId: 7,
    mid: 100,
    bestBid: 99.9,
    bestAsk: 100.1,
    bidUsd: 300,
    askUsd: 400,
    binBps: 100,
    rangePct: 0.05,
    bids: [100, 200, 0, 0, 0],
    asks: [300, 100, 0, 0, 0],
  };

  it('spreads a recorded bin over every row it covers and keeps its total', () => {
    const frame = frameFromHistory(historyFrame);
    const totals = frameRowTotals(frame, 97, 103, 60);
    const bidSum = [...totals.bid].reduce((sum, usd) => sum + usd, 0);
    const askSum = [...totals.ask].reduce((sum, usd) => sum + usd, 0);
    expect(bidSum).toBeCloseTo(300, 5);
    expect(askSum).toBeCloseTo(400, 5);
    expect([...totals.bid].filter((usd) => usd > 0).length).toBeGreaterThan(1);
  });

  it('returns the recorded bin when a cell overlaps it', () => {
    const frame = frameFromHistory(historyFrame);
    const cell = cellAt([frame], 1_000, 34, 97, 103, 60);
    expect(cell?.frame.source).toBe('history');
    expect(cell?.levels).toEqual([]);
    expect(cell?.bidUsd).toBeGreaterThan(0);
    expect(cell?.bidBins).toBe(1);
  });

  it('prefers the full live frame when timestamps collide', () => {
    const historical = frameFromHistory(historyFrame);
    const live: BookFrame = {
      ...historical, source: 'live', bids: [{ price: 99.5, usd: 1 }], asks: [], lattice: undefined,
    };
    const merged = mergeBookFrames([historical], [live]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('live');
  });
});

describe('sqlite history store', () => {
  const base = Date.now() - 10 * 60_000;

  it('round-trips captured frames and trades', () => {
    for (let i = 0; i < 120; i++) {
      const asOf = base + i * 1_000;
      store.recordTerminalBook({
        ...book(asOf, 100 + i * 0.01),
        trades: [{
          id: i + 1,
          t: asOf,
          price: 100 + i * 0.01,
          qty: 0.5,
          usd: 50,
          side: i % 2 ? 'buy' : 'sell',
        }],
      });
    }
    const all = store.readTerminalHistory('BTCUSDT', base, base + 200_000, 900);
    expect(all.frameCount).toBe(120);
    expect(all.frames).toHaveLength(120);
    expect(all.truncated).toBe(false);
    expect(all.trades).toHaveLength(120);
    expect(all.trades[0]).toMatchObject({ id: 1, side: 'sell', usd: 50 });
    expect(all.frames[0].bids.reduce((sum, usd) => sum + usd, 0)).toBeCloseTo(8_000, 3);
    expect(all.frames[119].mid).toBeCloseTo(101.19, 4);
  });

  it('downsamples evenly, keeps the newest frame and reports truncation', () => {
    const history = store.readTerminalHistory('BTCUSDT', base, base + 200_000, 60);
    expect(history.frames).toHaveLength(60);
    expect(history.truncated).toBe(true);
    expect(history.frames[0].asOf).toBe(base);
    expect(history.frames[history.frames.length - 1].asOf).toBe(base + 119_000);
  });

  it('returns only the newest frame when asked for one', () => {
    const history = store.readTerminalHistory('BTCUSDT', base, base + 200_000, 1);
    expect(history.frames).toHaveLength(1);
    expect(history.frames[0].asOf).toBe(base + 119_000);
  });

  it('prunes frames and trades older than retention', () => {
    const now = Date.now();
    store.recordTerminalBook({
      ...book(now - 30 * 3_600_000),
      trades: [{
        id: 99_999, t: now - 30 * 3_600_000, price: 100, qty: 1, usd: 100, side: 'buy',
      }],
    });
    const removed = store.pruneTerminalHistory(now);
    expect(removed).toBeGreaterThanOrEqual(2);
    const old = store.readTerminalHistory('BTCUSDT', now - 33 * 3_600_000, now);
    expect(old.frames.some((frame) => frame.asOf < now - 27 * 3_600_000)).toBe(false);
    const current = store.readTerminalHistory('BTCUSDT', base, base + 200_000);
    expect(current.frameCount).toBe(120);
  });
});
