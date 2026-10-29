import type { Candle } from '../../../shared/types';
import { fixtureKeyLoose, loadFixtures, lookup, type ReplayIndex } from './fixtures.js';

/**
 * Build a replayable universe out of the recorded fixtures.
 *
 * Reads them back through the same URL the app would have requested, so there
 * is exactly one definition of "what a BTCUSDT 5m kline response looks like".
 */

export interface MockDataset {
  candlesBySymbol: Map<string, Candle[]>;
  priceBySymbol: Map<string, number>;
  changeBySymbol: Map<string, number>;
  /** Symbols that have at least one recorded series, sorted. */
  symbols: string[];
  /** Per-timeframe coverage, for the boot report. */
  coverage: Record<string, number>;
}

const TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;

function rowsFrom(entry: { body: string } | null | undefined): unknown[] | null {
  if (!entry) return null;
  try {
    const j = JSON.parse(entry.body) as unknown;
    if (Array.isArray(j)) return j;
    if (j && typeof j === 'object' && Array.isArray((j as { data?: unknown }).data)) {
      return (j as { data: unknown[] }).data;
    }
  } catch {
    return null;
  }
  return null;
}

export function buildDataset(index: ReplayIndex): MockDataset {
  const candlesBySymbol = new Map<string, Candle[]>();
  const priceBySymbol = new Map<string, number>();
  const changeBySymbol = new Map<string, number>();
  const coverage: Record<string, number> = {};

  for (const tf of TIMEFRAMES) coverage[tf] = 0;

  for (const e of index.entries) {
    if (!e.path.includes('/klines')) continue;
    const rows = rowsFrom(e);
    if (!rows || !Array.isArray(rows)) continue;
    const symbol = new URL(e.url).searchParams.get('symbol');
    const tf = new URL(e.url).searchParams.get('interval');
    if (!symbol) continue;
    if (tf) coverage[tf] = (coverage[tf] ?? 0) + 1;
    if (tf !== '5m') continue;

    const candles: Candle[] = rows
      .map((r) => {
        const k = r as string[];
        return {
          t: Number(k[0]),
          o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]),
          v: Number(k[5]),
          qv: Number(k[7]),
          trades: Number(k[8]),
          takerBuyBase: Number(k[9]),
          takerBuyQuote: Number(k[10]),
          closed: true,
        };
      })
      .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0);

    if (candles.length) {
      const existing = candlesBySymbol.get(symbol) ?? [];
      const byTime = new Map(existing.map((c) => [c.t, c]));
      for (const c of candles) byTime.set(c.t, c);
      candlesBySymbol.set(symbol, [...byTime.values()].sort((a, b) => a.t - b.t));
    }
  }

  // 24h tickers give every symbol a price and a daily change, so the board has
  // breadth instead of a handful of names.
  const tickers = index.entries.find((e) => e.path.includes('ticker/24hr'));
  const trows = rowsFrom(tickers);
  if (trows) {
    for (const r of trows as Record<string, string>[]) {
      if (!r.symbol || !Number.isFinite(Number(r.lastPrice))) continue;
      priceBySymbol.set(r.symbol, Number(r.lastPrice));
      changeBySymbol.set(r.symbol, Number(r.priceChangePercent) || 0);
    }
  }

  // Fall back to the last close for anything the ticker fixture missed.
  for (const [symbol, candles] of candlesBySymbol) {
    if (!priceBySymbol.has(symbol)) {
      priceBySymbol.set(symbol, candles[candles.length - 1].c);
      changeBySymbol.set(symbol, 0);
    }
  }

  const symbols = [...candlesBySymbol.keys()].sort();
  return { candlesBySymbol, priceBySymbol, changeBySymbol, symbols, coverage };
}

export { loadFixtures, lookup, fixtureKeyLoose };

/**
 * Symbols the fixture set actually covers.
 *
 * Set once at boot in mock mode so the scanner can restrict itself to them.
 * Without this the scan fires a request per tracked pair, ~36 of which cannot
 * possibly be served, and logs a refusal for each on every boot: the log becomes
 * noise and the first scan takes far longer than the work it is doing.
 *
 * Null outside mock mode, which means "no restriction".
 */
let allowed: Set<string> | null = null;

export function setFixtureSymbols(symbols: string[]): void {
  allowed = new Set(symbols);
}

export function fixtureSymbols(): Set<string> | null {
  return allowed;
}

/** True when mock mode has restricted the universe and this base is not in it. */
export function excludedInMock(base: string): boolean {
  return allowed !== null && !allowed.has(`${base}USDT`);
}
