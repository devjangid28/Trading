import { describe, expect, it } from 'vitest';
import type { Candle } from '../../shared/types.js';
import {
  computeHeikinAshi,
  parseBookTicker,
  parseRestKline,
  parseTicker24h,
  parseTrade,
  parseWsKline,
} from '../../src/lib/binance.js';
import { sessionOpen, visibleRangeStats } from '../../src/lib/chartStats.js';
import {
  CHART_SETTINGS_KEY,
  DEFAULT_CHART_SETTINGS,
  loadChartSettings,
  makeIndicator,
  sanitizeChartSettings,
  saveChartSettings,
} from '../../src/charts/settings.js';

const candle = (overrides: Partial<Candle> = {}): Candle => ({
  t: 1_700_000_000_000,
  o: 100,
  h: 110,
  l: 90,
  c: 105,
  v: 10,
  qv: 1_000,
  takerBuyBase: 6,
  takerBuyQuote: 600,
  closed: true,
  ...overrides,
});

describe('Binance payload parsing', () => {
  it('maps a REST kline tuple without inventing missing fields', () => {
    const parsed = parseRestKline([
      1_700_000_000_000,
      '100.5',
      '110.25',
      '99.75',
      '108.0',
      '12.5',
      1_700_000_899_999,
      '1350.0',
      42,
      '7.5',
      '810.0',
      '0',
    ], 1_700_001_000_000);
    expect(parsed).toEqual({
      t: 1_700_000_000_000,
      o: 100.5,
      h: 110.25,
      l: 99.75,
      c: 108,
      v: 12.5,
      closed: true,
      qv: 1_350,
      trades: 42,
      takerBuyBase: 7.5,
      takerBuyQuote: 810,
    });
  });

  it('marks the still-forming REST candle as open', () => {
    expect(parseRestKline([
      1_700_000_000_000, '1', '2', '0.5', '1.5', '3', 1_700_000_899_999, '4', 1, '1', '1', '0',
    ], 1_700_000_500_000)?.closed).toBe(false);
  });

  it('rejects malformed rows and non-finite prices', () => {
    expect(parseRestKline(null)).toBeNull();
    expect(parseRestKline([1, 'oops', 2, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBeNull();
  });

  it('maps a websocket kline and honours the x closed flag', () => {
    const parsed = parseWsKline({
      t: 1_700_000_000_000,
      o: '100',
      h: '110',
      l: '90',
      c: '105',
      v: '10',
      q: '1000',
      n: 12,
      V: '6',
      Q: '600',
      x: true,
    });
    expect(parsed).toMatchObject({
      t: 1_700_000_000_000,
      o: 100,
      h: 110,
      l: 90,
      c: 105,
      v: 10,
      qv: 1_000,
      trades: 12,
      takerBuyBase: 6,
      takerBuyQuote: 600,
      closed: true,
    });
  });

  it('maps trades, book tickers and 24h tickers', () => {
    expect(parseTrade({ t: 9, T: 1_700_000_000_000, p: '101.5', q: '2', m: true })).toEqual({
      id: 9,
      t: 1_700_000_000_000,
      price: 101.5,
      qty: 2,
      side: 'sell',
    });
    expect(parseBookTicker({ b: '100.1', a: '100.2' })).toMatchObject({ bid: 100.1, ask: 100.2 });
    expect(parseTicker24h({
      symbol: 'BTCUSDT',
      lastPrice: '80626.01',
      priceChangePercent: '1.25',
      bidPrice: '80626.00',
      askPrice: '80626.02',
      quoteVolume: '123456789',
    })).toMatchObject({
      symbol: 'BTCUSDT',
      lastPrice: 80_626.01,
      priceChangePercent: 1.25,
      bidPrice: 80_626,
      askPrice: 80_626.02,
      quoteVolume: 123_456_789,
    });
  });
});

describe('Heikin Ashi conversion', () => {
  it('uses the first candle midpoint and then the previous HA open/close', () => {
    const input = [
      candle({ t: 1, o: 100, h: 110, l: 90, c: 105 }),
      candle({ t: 2, o: 105, h: 120, l: 100, c: 115 }),
    ];
    const output = computeHeikinAshi(input);
    expect(output[0]).toMatchObject({ o: 102.5, c: 101.25, h: 110, l: 90 });
    expect(output[1]).toMatchObject({
      o: 101.875,
      c: 110,
      h: 120,
      l: 100,
    });
  });

  it('preserves timestamps, volume and closed flags', () => {
    const input = [candle({ t: 7, closed: false, v: 99 })];
    expect(computeHeikinAshi(input)[0]).toMatchObject({ t: 7, v: 99, closed: false });
  });

  it('returns an empty array for no candles', () => {
    expect(computeHeikinAshi([])).toEqual([]);
  });
});

describe('visible range statistics', () => {
  const bars = [
    candle({
      t: 1,
      o: 100,
      h: 110,
      l: 90,
      c: 105,
      v: 10,
      qv: 1_000,
      takerBuyBase: 6,
      takerBuyQuote: 600,
    }),
    candle({
      t: 2,
      o: 105,
      h: 120,
      l: 100,
      c: 115,
      v: 20,
      qv: 2_000,
      takerBuyBase: 8,
      takerBuyQuote: 800,
    }),
  ];

  it('computes delta, CVD and point of control for the full range', () => {
    const stats = visibleRangeStats(bars, 0, 1, 12);
    expect(stats.bars).toBe(2);
    expect(stats.volumeQty).toBe(30);
    expect(stats.deltaQty).toBe(-2);
    expect(stats.cvdUsd).toBe(-200);
    expect(stats.poc).toBe(101.25);
  });

  it('limits the statistics to the requested visible slice', () => {
    const stats = visibleRangeStats(bars, 1, 1, 12);
    expect(stats.bars).toBe(1);
    expect(stats.volumeQty).toBe(20);
    expect(stats.deltaQty).toBe(-4);
    expect(stats.cvdUsd).toBe(-400);
    expect(stats.poc).toBeCloseTo(100.833, 3);
  });

  it('returns a dash when taker fields are absent rather than a made-up zero', () => {
    const stats = visibleRangeStats([
      { t: 1, o: 100, h: 101, l: 99, c: 100, v: 5, closed: true },
    ]);
    expect(stats.deltaQty).toBeNull();
    expect(stats.cvdUsd).toBeNull();
    expect(stats.volumeQty).toBe(5);
  });

  it('handles an empty range', () => {
    expect(visibleRangeStats([])).toEqual({
      volumeQty: 0,
      deltaQty: null,
      cvdUsd: null,
      poc: null,
      bars: 0,
    });
  });
});

describe('session windows', () => {
  it('uses UTC London and New York windows', () => {
    expect(sessionOpen(Date.UTC(2026, 0, 5, 8, 0), 'london')).toBe(true);
    expect(sessionOpen(Date.UTC(2026, 0, 5, 16, 30), 'london')).toBe(false);
    expect(sessionOpen(Date.UTC(2026, 0, 5, 13, 30), 'newyork')).toBe(true);
    expect(sessionOpen(Date.UTC(2026, 0, 5, 20, 0), 'newyork')).toBe(false);
  });
});

describe('chart settings', () => {
  it('sanitises persisted settings and deduplicates indicators', () => {
    const settings = sanitizeChartSettings({
      symbol: 'ethusdt',
      interval: '2m',
      chartType: 'area',
      scale: 'log',
      indicators: [
        { kind: 'EMA', params: [9, -1, 21], visible: false },
        { kind: 'EMA', params: [50] },
        { kind: 'NOPE', params: [1] },
      ],
      sessions: { london: false },
      sidebarOpen: false,
      sidebarTab: 'news',
    });
    expect(settings.symbol).toBe('ETHUSDT');
    expect(settings.interval).toBe(DEFAULT_CHART_SETTINGS.interval);
    expect(settings.chartType).toBe('area');
    expect(settings.scale).toBe('log');
    expect(settings.indicators).toHaveLength(1);
    expect(settings.indicators[0]).toMatchObject({ kind: 'EMA', visible: false, params: [9, 21] });
    expect(settings.sessions).toEqual({ london: false, newyork: true });
    expect(settings.sidebarOpen).toBe(false);
    expect(settings.sidebarTab).toBe('news');
  });

  it('falls back to the defaults for corrupt storage', () => {
    const storage = {
      getItem: () => '{not json',
      setItem: () => undefined,
    };
    expect(loadChartSettings(storage)).toEqual(DEFAULT_CHART_SETTINGS);
  });

  it('round-trips through storage and uses the documented key', () => {
    let storedKey = '';
    let stored = '';
    const storage = {
      getItem: () => stored,
      setItem: (key: string, value: string) => { storedKey = key; stored = value; },
    };
    const settings = sanitizeChartSettings({ symbol: 'SOLUSDT', interval: '1h' });
    saveChartSettings(settings, storage);
    expect(storedKey).toBe(CHART_SETTINGS_KEY);
    expect(loadChartSettings(storage)).toEqual(settings);
  });

  it('creates catalog indicators with their default periods', () => {
    expect(makeIndicator('EMA')).toMatchObject({ id: 'ema', kind: 'EMA', params: [21, 50], visible: true });
    expect(makeIndicator('MACD').params).toEqual([12, 26, 9]);
  });
});
