import { describe, expect, it } from 'vitest';
import type { TerminalTrade } from '../../shared/types.js';
import { appendBookFrame, type BookFrame, type SideWall } from '../../src/terminal/math.js';
import {
  autoTapeThresholdUsd, bubblePoints, bubbleRadius, cellAt, frameAt, frameIndexAt, heatColor, heatIntensity,
  liquidityScaleForFrame, nextLiquidityScale, nicePriceTicks, plainPrice, priceToY, rowIndexForPrice,
  sparseIntensity, sparseThresholds, tooltipPosition, volumeBuckets, wallAt, xToTime, yToPrice,
} from '../../src/terminal/heatmap.js';
import { buildMockHeatmap, MOCK_RECORD_MS } from '../../src/terminal/mockHeatmap.js';
import { userLines } from '../../src/terminal/levels.js';
import {
  DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings, SETTINGS_KEY,
} from '../../src/terminal/settings.js';

function frame(asOf: number, bids: [number, number][], asks: [number, number][] = []): BookFrame {
  return {
    asOf,
    lastUpdateId: asOf,
    mid: 100,
    bestBid: 99.5,
    bestAsk: 100.5,
    bidUsd: bids.reduce((sum, [, usd]) => sum + usd, 0),
    askUsd: asks.reduce((sum, [, usd]) => sum + usd, 0),
    bids: bids.map(([price, usd]) => ({ price, usd })),
    asks: asks.map(([price, usd]) => ({ price, usd })),
  };
}

const trade = (id: number, t: number, price: number, qty: number, side: 'buy' | 'sell'): TerminalTrade => ({
  id, t, price, qty, usd: price * qty, side,
});

describe('heatmap historical lookup', () => {
  const frames = [
    frame(1_000, [[100.1, 100], [99.9, 200]], [[100.2, 150]]),
    frame(2_000, [[100.0, 300]], [[100.3, 50]]),
    frame(3_000, [[99.0, 400]], []),
  ];

  it('selects the latest sample at or before the pointer time', () => {
    expect(frameIndexAt(frames, 0)).toBe(-1);
    expect(frameIndexAt(frames, 1_000)).toBe(0);
    expect(frameIndexAt(frames, 1_500)).toBe(0);
    expect(frameIndexAt(frames, 2_000)).toBe(1);
    expect(frameIndexAt(frames, 99_000)).toBe(2);
    expect(frameAt(frames, 500)).toBeNull();
    expect(frameAt(frames, 1_900)?.lastUpdateId).toBe(1_000);
  });

  it('reads the exact rendered price row and never snaps to a nearby level', () => {
    const hit = cellAt(frames, 1_100, rowIndexForPrice(100.1, 80, 120, 4), 80, 120, 4);
    expect(hit?.frame.asOf).toBe(1_000);
    expect(hit?.levels.map((entry) => entry.level.usd)).toEqual([150, 100]);
    expect(hit?.levels.map((entry) => entry.side)).toEqual(['ask', 'bid']);

    const empty = cellAt(frames, 1_100, rowIndexForPrice(90, 80, 120, 4), 80, 120, 4);
    expect(empty).not.toBeNull();
    expect(empty?.levels).toEqual([]);
  });

  it('returns no cell before the captured window', () => {
    expect(cellAt(frames, 0, 0, 80, 120, 20)).toBeNull();
  });
});

describe('heatmap geometry', () => {
  it('maps time and price in both directions', () => {
    expect(xToTime(100, 1_000, 2_000, 100, 200)).toBe(1_000);
    expect(xToTime(300, 1_000, 2_000, 100, 200)).toBe(2_000);
    expect(priceToY(120, 80, 120, 10, 200)).toBe(10);
    expect(priceToY(80, 80, 120, 10, 200)).toBe(210);
    expect(yToPrice(210, 80, 120, 10, 200)).toBe(80);
    expect(yToPrice(10, 80, 120, 10, 200)).toBe(120);
  });

  it('flips a tooltip away from the viewport edges', () => {
    expect(tooltipPosition(20, 20, 200, 100, 900, 500)).toEqual({ left: 34, top: 34 });
    expect(tooltipPosition(880, 480, 200, 100, 900, 500)).toEqual({ left: 666, top: 366 });
  });
});

describe('trade bubbles and volume', () => {
  const trades = [
    trade(1, 1_000, 100, 1, 'buy'),
    trade(2, 2_000, 100.1, 0.5, 'sell'),
    trade(3, 11_000, 101, 2, 'buy'),
    trade(4, 40_000, 99, 1, 'sell'),
  ];

  it('draws individual prints in trades mode', () => {
    const points = bubblePoints(trades, 0, 60_000, 'trades', 'auto', 0, 90, 110, 20);
    expect(points).toHaveLength(4);
    expect(points[0]).toMatchObject({ price: 100, usd: 100, side: 'buy', aggregated: false });
  });

  it('aggregates steps by time and price bucket', () => {
    const points = bubblePoints(trades, 0, 60_000, 'steps', '10s', 0, 90, 110, 1);
    const first = points[0];
    expect(first.count).toBe(2);
    expect(first.usd).toBeCloseTo(150.05, 6);
    expect(first.qty).toBe(1.5);
    expect(first.price).toBeCloseTo(100.033333, 5);
    expect(first.side).toBe('buy');
    expect(points).toHaveLength(3);
  });

  it('honours the minimum trade filter and off mode', () => {
    expect(bubblePoints(trades, 0, 60_000, 'trades', 'auto', 150, 90, 110, 20).map((p) => p.count)).toEqual([1]);
    expect(bubblePoints(trades, 0, 60_000, 'off', 'auto', 0, 90, 110, 20)).toEqual([]);
  });

  it('keeps bubble area proportional to notional and independent of viewport', () => {
    const small = bubbleRadius(1_000, 10_000, 1);
    const large = bubbleRadius(4_000, 10_000, 1);
    const scaled = bubbleRadius(4_000, 10_000, 1.5);
    expect(large).toBeGreaterThan(small);
    expect(scaled).toBeGreaterThan(large);
    expect(bubbleRadius(1e12, 10_000, 1)).toBe(32);
  });

  it('splits volume into buy/sell buckets without losing notional', () => {
    const buckets = volumeBuckets(trades, 0, 60_000, 3);
    expect(buckets).toHaveLength(3);
    expect(buckets.reduce((sum, b) => sum + b.total, 0)).toBeCloseTo(451.05, 6);
    expect(buckets.reduce((sum, b) => sum + b.buy, 0)).toBeCloseTo(302, 6);
    expect(buckets.reduce((sum, b) => sum + b.sell, 0)).toBeCloseTo(149.05, 6);
  });

  it('uses step bubbles before five minutes and individual prints at the live edge', () => {
    const now = 1_000_000;
    const list: TerminalTrade[] = [
      trade(1, now - 6 * 60_000, 100, 10, 'buy'),
      trade(2, now - 30_000, 100, 2, 'buy'),
      trade(3, now - 20_000, 100, 1, 'sell'),
    ];
    const points = bubblePoints(list, now - 15 * 60_000, now, 'auto', '10s', 0, 90, 110, 20);
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ usd: 1_000, aggregated: true, side: 'buy' });
    expect(points[1]).toMatchObject({ count: 1, aggregated: false, buyUsd: 200 });
    expect(points[2]).toMatchObject({ count: 1, aggregated: false, sellUsd: 100 });
  });
});

describe('sparse rendering helpers', () => {
  it('formats prices without grouping commas and produces bounded nice ticks', () => {
    expect(plainPrice(80_629.05, 2)).toBe('80629.05');
    expect(plainPrice(Number.NaN)).toBe('\u2014');
    const ticks = nicePriceTicks(80_000, 81_000, 6);
    expect(ticks.step).toBeGreaterThan(0);
    expect(ticks.values.length).toBeGreaterThan(2);
    expect(ticks.values[0]).toBeGreaterThanOrEqual(80_000);
    expect(ticks.values[ticks.values.length - 1]).toBeLessThanOrEqual(81_000);
  });

  it('derives row thresholds from rendered totals and suppresses the bottom band', () => {
    const frames = [
      frame(1_000, [[99, 2_000], [98, 8_000]]),
      frame(2_000, [[99, 4_000], [98, 12_000]]),
    ];
    const thresholds = sparseThresholds(frames, 97, 101, 8, 0);
    expect(thresholds.cells).toBeGreaterThan(0);
    expect(thresholds.med).toBeGreaterThan(thresholds.low);
    expect(thresholds.high).toBeGreaterThanOrEqual(thresholds.med);
    expect(sparseIntensity(thresholds.low - 1, thresholds)).toBe(0);
    expect(sparseIntensity(thresholds.max * 2, thresholds)).toBeGreaterThan(0.85);
  });

  it('floors the auto tape threshold at $5K and rounds it', () => {
    const prints = Array.from({ length: 20 }, (_, i) => trade(i + 1, i, 100, i + 1, 'buy'));
    const threshold = autoTapeThresholdUsd(prints);
    expect(threshold).toBeGreaterThanOrEqual(5_000);
    expect(threshold % 500).toBe(0);
    expect(autoTapeThresholdUsd([])).toBe(5_000);
  });
});

describe('mock composition', () => {
  it('builds a deterministic recorded strip and never marks it as history', () => {
    const now = 1_700_000_000_000;
    const a = buildMockHeatmap('BTCUSDT', 80_600, now);
    const b = buildMockHeatmap('BTCUSDT', 80_600, now);
    expect(a.recordStart).toBe(now - MOCK_RECORD_MS);
    expect(a.frames).toHaveLength(MOCK_RECORD_MS / 2_000 + 2);
    expect(a.frames[0].asOf).toBe(a.recordStart);
    expect(a.frames.every((frame) => frame.source === 'live')).toBe(true);
    expect(a.trades.some((tradeItem) => tradeItem.usd >= 250_000)).toBe(true);
    expect(a.highest).toBeGreaterThan(a.lowest);
    expect(autoTapeThresholdUsd(a.trades)).toBe(5_500);
    expect(b.frames[10].mid).toBe(a.frames[10].mid);
    expect(b.trades[10].usd).toBe(a.trades[10].usd);
  });

  it('labels a saved user level without pretending it is book liquidity', () => {
    const lines = userLines([80_600], 80_000, 81_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'user', price: 80_600, label: '\u2605 my level' });
  });

  it('includes the standing ask wall and the late pull/add lifecycle', () => {
    const now = 1_700_000_000_000;
    const data = buildMockHeatmap('BTCUSDT', 80_600, now);
    const first = data.frames[0];
    const last = data.frames[data.frames.length - 1];
    expect(first.asks.some((level) => level.usd === 250_000)).toBe(true);
    expect(last.asks.some((level) => level.usd === 343_700)).toBe(true);
    expect(last.asks.some((level) => level.usd === 403_000)).toBe(false);
    expect(last.bids.some((level) => level.usd === 186_000)).toBe(true);
  });
});

describe('walls, colors and stable scale', () => {
  const wall: SideWall = {
    side: 'bid', price: 99, usd: 2_000, distanceBps: 100, multiple: 4,
    peerLevels: 20, standingMs: 3_000, standingSinceStart: false, pulls: 0,
  };

  it('finds a wall only within the pointer tolerance', () => {
    expect(wallAt({ bid: wall, ask: null }, 99.01, 0.02)?.price).toBe(99);
    expect(wallAt({ bid: wall, ask: null }, 99.05, 0.02)).toBeNull();
  });

  it('keeps heat intensity bounded and honors contrast', () => {
    expect(heatIntensity(100, 100, 1)).toBeCloseTo(1, 6);
    expect(heatIntensity(100, 100, 0.5)).toBeCloseTo(0.5, 6);
    expect(heatIntensity(0, 100, 1)).toBe(0);
    expect(heatColor(0, 1)).toMatch(/^rgba\(/);
    expect(heatColor(1, 1)).toMatch(/^rgba\(/);
  });

  it('only moves the color scale when a change is real and settled', () => {
    expect(nextLiquidityScale(0, 100, 0)).toBe(100);
    expect(nextLiquidityScale(100, 110, 10_000)).toBe(100);
    expect(nextLiquidityScale(100, 140, 1_000)).toBe(100);
    expect(nextLiquidityScale(100, 140, 2_000)).toBe(140);
    expect(nextLiquidityScale(100, 40, 14_000)).toBe(100);
    expect(nextLiquidityScale(100, 40, 15_000)).toBe(40);
  });
});

describe('heat scaling and captured history', () => {
  it('scales the ramp against rendered row totals rather than single levels', () => {
    const book = frame(1_000, [[100, 100], [99, 50], [95, 100]], [[105, 200]]);
    expect(liquidityScaleForFrame(book, 90, 110, 2)).toBe(250);
    expect(liquidityScaleForFrame(book, 90, 110, 2, 250)).toBe(1);
  });

  it('keeps another timestamp for an unchanged update id but still dedupes exact samples', () => {
    const first = frame(1_000, [[100, 100]]);
    const list = [first];
    expect(appendBookFrame(list, first)).toBe(list);
    const second = { ...first, asOf: 2_000 };
    expect(appendBookFrame(list, second)).toEqual([first, second]);
    expect(appendBookFrame(list, second, 1)).toEqual([second]);
  });
});

describe('persisted heatmap settings', () => {
  it('sanitizes malformed stored values and duplicate columns', () => {
    const next = sanitizeSettings({
      span: '7m', range: '9', contrast: 'ultra', bubbles: 'nope', columns: ['book', 'book', 'nope', 'tape'],
      rowPx: 99, minTradeUsd: -5, minLiquidityUsd: 'x', bubbleScale: 9, opacity: 0, showVolume: false, stepMode: '7s',
    });
    expect(next.span).toBe(DEFAULT_SETTINGS.span);
    expect(next.range).toBe(DEFAULT_SETTINGS.range);
    expect(next.contrast).toBe(DEFAULT_SETTINGS.contrast);
    expect(next.bubbles).toBe(DEFAULT_SETTINGS.bubbles);
    expect(next.columns).toEqual(['book', 'tape']);
    expect(next.rowPx).toBe(6);
    expect(next.minTradeUsd).toBe(0);
    expect(next.minLiquidityUsd).toBe(0);
    expect(next.bubbleScale).toBe(3);
    expect(next.opacity).toBe(0.1);
    expect(next.showVolume).toBe(false);
    expect(next.stepMode).toBe(DEFAULT_SETTINGS.stepMode);
  });

  it('loads and saves through a storage-like object', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, span: '5m', columns: ['tape', 'book'] });
    saveSettings(settings, storage);
    expect(store.has(SETTINGS_KEY)).toBe(true);
    expect(loadSettings(storage)).toMatchObject({ span: '5m', columns: ['tape', 'book'] });
  });

  it('falls back safely when storage is absent or contains junk', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    const junk = { getItem: () => '{not json' };
    expect(loadSettings(junk)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings({ getItem: () => 'null' })).toEqual(DEFAULT_SETTINGS);
  });
});

