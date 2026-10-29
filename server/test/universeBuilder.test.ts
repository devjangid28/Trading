import { describe, it, expect } from 'vitest';
import { selectUniverse } from '../src/data/universeBuilder.js';
import type { ExchangeSymbol, Ticker24h } from '../src/data/binance.js';
import type { UniverseEntry } from '../src/data/universe.js';

/**
 * The universe bug the diagnostic found was a PAIR-RESOLUTION bug, not a
 * threshold bug: the old scanner stripped `(USDT|FDUSD|BUSD)$` from a ticker
 * symbol and kept the first match, so a base whose alphabetically-first pair
 * was the deprecated BUSD/FDUSD book had its volume test applied to the wrong,
 * thin series. DOTBUSD sorts before DOTUSDT, so DOT was measured against the
 * dead BUSD market and dropped.
 *
 * These tests pin down the replacement: resolve `${base}USDT` explicitly and
 * ignore every other quote leg entirely.
 */

function sym(symbol: string, base: string, quote: string, status = 'TRADING'): ExchangeSymbol {
  return { symbol, base, quote, status };
}

function tick(symbol: string, quoteVolume: number, lastPrice = 1, changePct = 0): Ticker24h {
  return {
    symbol,
    lastPrice,
    openPrice: lastPrice,
    priceChangePercent: changePct,
    quoteVolume,
    highPrice: lastPrice,
    lowPrice: lastPrice,
  };
}

const META = new Map<string, UniverseEntry>([
  ['DOT', { base: 'DOT', name: 'Polkadot', sector: 'Interoperability', betaGroup: 'l1', tags: [] }],
]);

const OPTS = { minVolumeUsd: 5_000_000, maxPairs: 200 } as const;

describe('selectUniverse pair resolution', () => {
  it('keeps DOT when DOTBUSD appears before DOTUSDT (the original bug)', () => {
    const symbols = [
      sym('DOTBUSD', 'DOT', 'BUSD'),
      sym('DOTUSDT', 'DOT', 'USDT'),
    ];
    const tickers = [
      // BUSD volume is tiny AND the ticker comes first; neither may matter.
      tick('DOTBUSD', 120_000),
      tick('DOTUSDT', 40_000_000),
    ];

    const { entries, excluded } = selectUniverse({ symbols, tickers, ...OPTS });
    const dot = entries.find((e) => e.base === 'DOT');

    expect(dot).toBeDefined();
    expect(dot!.pair).toBe('DOTUSDT');
    expect(dot!.quote).toBe('USDT');
    expect(dot!.ticker.quoteVolume).toBe(40_000_000);
    // BUSD was never even a candidate, so it is not reported as excluded.
    expect(excluded.find((e) => e.pair === 'DOTBUSD')).toBeUndefined();
  });

  it('never measures a base against a BUSD/FDUSD book', () => {
    // DOTUSDT is liquid; DOTBUSD is not. If the builder ever keyed by base and
    // took the first, this would drop DOT.
    const { entries } = selectUniverse({
      symbols: [sym('DOTBUSD', 'DOT', 'BUSD'), sym('DOTUSDT', 'DOT', 'USDT')],
      tickers: [tick('DOTBUSD', 0), tick('DOTUSDT', 9_000_000)],
      ...OPTS,
    });
    expect(entries.map((e) => e.base)).toEqual(['DOT']);
  });

  it('falls back to USDC only when no USDT market exists, and labels it', () => {
    const { entries } = selectUniverse({
      symbols: [sym('XYZUSDC', 'XYZ', 'USDC')],
      tickers: [tick('XYZUSDC', 8_000_000)],
      ...OPTS,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].pair).toBe('XYZUSDC');
    expect(entries[0].quote).toBe('USDC');
  });

  it('prefers USDT over USDC when both exist', () => {
    const { entries } = selectUniverse({
      symbols: [sym('ABCUSDC', 'ABC', 'USDC'), sym('ABCUSDT', 'ABC', 'USDT')],
      tickers: [tick('ABCUSDC', 50_000_000), tick('ABCUSDT', 8_000_000)],
      ...OPTS,
    });
    expect(entries[0].pair).toBe('ABCUSDT');
    expect(entries[0].quote).toBe('USDT');
  });
});

describe('selectUniverse exclusions', () => {
  it('drops stablecoins, wrapped duplicates and leveraged tokens', () => {
    const symbols = [
      sym('USDTUSDT', 'USDT', 'USDT'),
      sym('WBTCUSDT', 'WBTC', 'USDT'),
      sym('BTCUSDT', 'BTC', 'USDT'),
      sym('BTCUPUSDT', 'BTCUP', 'USDT'),
      sym('BTCDOWNUSDT', 'BTCDOWN', 'USDT'),
      sym('SOLBULLUSDT', 'SOLBULL', 'USDT'),
    ];
    const tickers = [
      tick('USDTUSDT', 9_000_000_000),
      tick('WBTCUSDT', 30_000_000),
      tick('BTCUSDT', 900_000_000),
      tick('BTCUPUSDT', 20_000_000),
      tick('BTCDOWNUSDT', 20_000_000),
      tick('SOLBULLUSDT', 20_000_000),
    ];

    const { entries, excluded } = selectUniverse({ symbols, tickers, ...OPTS });
    expect(entries.map((e) => e.base)).toEqual(['BTC']);
    const reasons = new Map(excluded.map((e) => [e.base, e.reason]));
    expect(reasons.get('USDT')).toBe('stablecoin');
    expect(reasons.get('WBTC')).toBe('wrapped/bridged duplicate');
    expect(reasons.get('BTCUP')).toBe('leveraged token');
    expect(reasons.get('BTCDOWN')).toBe('leveraged token');
    expect(reasons.get('SOLBULL')).toBe('leveraged token');
  });

  it('keeps real coins whose names merely END in UP (JUP, PUMP)', () => {
    const symbols = [
      sym('BTCUSDT', 'BTC', 'USDT'),
      sym('JUPUSDT', 'JUP', 'USDT'),
      sym('PUMPUSDT', 'PUMP', 'USDT'),
    ];
    const tickers = [
      tick('BTCUSDT', 900_000_000),
      tick('JUPUSDT', 30_000_000),
      tick('PUMPUSDT', 45_000_000),
    ];
    const { entries } = selectUniverse({ symbols, tickers, ...OPTS });
    expect(entries.map((e) => e.base).sort()).toEqual(['BTC', 'JUP', 'PUMP']);
  });

  it('ignores pairs whose status is not TRADING', () => {
    const { entries } = selectUniverse({
      symbols: [sym('HALTUSDT', 'HALT', 'USDT', 'BREAK'), sym('OKUSDT', 'OK', 'USDT')],
      tickers: [tick('HALTUSDT', 100_000_000), tick('OKUSDT', 6_000_000)],
      ...OPTS,
    });
    expect(entries.map((e) => e.base)).toEqual(['OK']);
  });
});

describe('selectUniverse thresholds and caps', () => {
  it('applies the volume floor exactly', () => {
    const { entries } = selectUniverse({
      symbols: [sym('AUSDT', 'A', 'USDT'), sym('BUSDT', 'B', 'USDT')],
      tickers: [tick('AUSDT', 4_999_999), tick('BUSDT', 5_000_000)],
      ...OPTS,
    });
    expect(entries.map((e) => e.base)).toEqual(['B']);
  });

  it('reports counts at the documented thresholds', () => {
    const { volumeCounts } = selectUniverse({
      symbols: [
        sym('AUSDT', 'A', 'USDT'), sym('BUSDT', 'B', 'USDT'),
        sym('CUSDT', 'C', 'USDT'), sym('DUSDT', 'D', 'USDT'),
      ],
      tickers: [
        tick('AUSDT', 1_500_000), tick('BUSDT', 3_000_000),
        tick('CUSDT', 8_000_000), tick('DUSDT', 30_000_000),
      ],
      ...OPTS,
      thresholds: [1_000_000, 2_000_000, 5_000_000, 20_000_000],
    });
    expect(volumeCounts['$1M']).toBe(4);
    expect(volumeCounts['$2M']).toBe(3);
    expect(volumeCounts['$5M']).toBe(2);
    expect(volumeCounts['$20M']).toBe(1);
  });

  it('caps the universe by volume, highest first', () => {
    const symbols = ['A', 'B', 'C', 'D'].map((b) => sym(`${b}USDT`, b, 'USDT'));
    const tickers = [
      tick('AUSDT', 10_000_000), tick('BUSDT', 40_000_000),
      tick('CUSDT', 20_000_000), tick('DUSDT', 30_000_000),
    ];
    const { entries } = selectUniverse({ symbols, tickers, minVolumeUsd: 5_000_000, maxPairs: 2 });
    expect(entries.map((e) => e.base)).toEqual(['B', 'D']);
  });
});

describe('selectUniverse metadata', () => {
  it('uses metadata when present and sector "Other" when not', () => {
    const { entries } = selectUniverse({
      symbols: [sym('DOTUSDT', 'DOT', 'USDT'), sym('ZZZUSDT', 'ZZZ', 'USDT')],
      tickers: [tick('DOTUSDT', 20_000_000), tick('ZZZUSDT', 6_000_000)],
      ...OPTS,
      metadata: META,
    });
    const dot = entries.find((e) => e.base === 'DOT')!;
    const zzz = entries.find((e) => e.base === 'ZZZ')!;

    expect(dot.name).toBe('Polkadot');
    expect(dot.sector).toBe('Interoperability');
    expect(dot.hasMetadata).toBe(true);

    expect(zzz.name).toBe('ZZZ');
    expect(zzz.sector).toBe('Other');
    expect(zzz.hasMetadata).toBe(false);
  });
});

describe('selectUniverse completeness (the 14 dropped coins)', () => {
  it('includes every liquid coin that the BUSD-first bug used to drop', () => {
    // These are the coins the diagnostic listed as dropped despite trading
    // above the volume floor on their USDT pair.
    const dropped = [
      'DOT', 'NEAR', 'UNI', 'AAVE', 'FIL', 'ICP', 'LINK', 'ATOM',
      'ETC', 'APT', 'ARB', 'OP', 'INJ', 'SUI',
    ];

    const symbols: ExchangeSymbol[] = [];
    const tickers: Ticker24h[] = [];
    for (const base of dropped) {
      // The deprecated BUSD market sorts first and is illiquid.
      symbols.push(sym(`${base}BUSD`, base, 'BUSD'));
      tickers.push(tick(`${base}BUSD`, 250_000));
      symbols.push(sym(`${base}USDT`, base, 'USDT'));
      tickers.push(tick(`${base}USDT`, 12_000_000 + dropped.indexOf(base) * 1_000_000));
    }

    const { entries } = selectUniverse({ symbols, tickers, ...OPTS });
    const bases = new Set(entries.map((e) => e.base));
    for (const base of dropped) {
      expect(bases.has(base), `${base} should be in the universe`).toBe(true);
    }
    expect(entries).toHaveLength(dropped.length);
    // And every resolved pair is the USDT market, never BUSD.
    expect(entries.every((e) => e.pair.endsWith('USDT'))).toBe(true);
  });
});
