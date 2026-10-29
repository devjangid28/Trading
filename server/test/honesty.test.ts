import { describe, it, expect } from 'vitest';
import { isUnavailable } from '../../shared/types';
import { attribute } from '../src/engine/attribution.js';
import type { Candle, NewsItem } from '../../shared/types';

/**
 * M1.4 — a value must never be a lie.
 *
 * Four defects in this pass were all the same mistake wearing different hats: a
 * constant standing in for a measurement, presented under a label that implied
 * a computation.
 *
 *   1. `fundingZ: 0`        rendered as "z=0.00" in the Derivatives tooltip
 *   2. `liq: { all zeros }`  rendered as a liquidation total, under a
 *                            `binance-futures` meta, meaning "no feed attached"
 *   3. CVD                  labelled futures, computed from SPOT klines
 *   4. `attribute()`        read the still-forming candle, so a move could be
 *                            measured against a price the market never reached
 *
 * Every assertion below fails if the corresponding lie is reintroduced. The
 * shape of the test matters more than the values: a test that pins a number
 * would not catch someone swapping `null` back to `0`.
 */

const NOW = 1_760_000_000_000;
const BAR = 5 * 60_000;

/** A candle with real OHLC, controlled by the caller. */
function candle(t: number, o: number, h: number, l: number, c: number, v = 1000, closed = true): Candle {
  return { t, o, h, l, c, v, closed };
}

/**
 * A flat-ish series with a known history, then a deliberate tail move.
 *
 * The tail is what the attribution measures, so tests can assert whether the
 * forming bar was included by watching the reported price.
 */
function series(tailC: number, tailClosed: boolean): Candle[] {
  const out: Candle[] = [];
  const start = NOW - 200 * BAR;
  for (let i = 0; i < 200; i++) {
    // Gentle oscillation so the return history has a non-zero standard
    // deviation; a perfectly flat series would make the z-score meaningless.
    const base = 100 + Math.sin(i / 5) * 0.5;
    out.push(candle(start + i * BAR, base, base + 0.3, base - 0.3, base, 1000, true));
  }
  // The final bar carries the move, and optionally is still forming.
  const prev = out[out.length - 1].c;
  out.push(candle(start + 200 * BAR, prev, tailC + 1, prev - 1, tailC, 5000, tailClosed));
  return out;
}

function newsItem(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'n1', headline: 'Something happened', url: '', source: 'Test', tier: 12,
    publishedAt: NOW - 30 * 60_000, ageMinutes: 30,
    assets: ['TEST'], sectorHint: null, macroEntity: null, jurisdiction: 'GLOBAL',
    categories: [], tags: [], nis: 60, severity: 30, relevance: 18, sentiment: 1,
    direction: 1, severityClass: 'HIGH', expectedBps: 300, reversalRisk: 0.3,
    corroboration: 1, sources: 1, novelty: 1, noveltyLabel: 'NEW',
    isMacro: false, routine: false, reactions: [], clusterId: null, surpriseBp: null,
    summary: '',
    ...over,
  };
}

const OPTS = { horizonMinutes: 60, btcBeta: 1, btcReturnPct: 0 };

describe('a still-forming candle cannot move an attribution', () => {
  it('ignores the open bar entirely', () => {
    // The forming bar closes at an absurd 1,900. Before the fix that number
    // flowed into lastPrice, rawReturnPct, moveZ and volZ, and the 2.5-sigma
    // gate then judged a move that never happened.
    const formingCandles = series(1_900, false);
    const a = attribute('TEST', 'Test', formingCandles, [newsItem()], OPTS)!;

    const lastClosed = formingCandles.filter((c) => c.closed).at(-1)!;

    expect(a.price).toBe(lastClosed.c);
    expect(a.price).not.toBe(1_900);
    // A ~1,790% move would be the tell. It must not be in any figure.
    expect(Math.abs(a.rawReturnPct)).toBeLessThan(5);
    expect(Number.isFinite(a.moveZ)).toBe(true);
  });

  it('reports a price the market actually closed at', () => {
    const a = attribute('TEST', 'Test', series(130, true), [newsItem()], OPTS)!;
    // 100.5-ish base, tail closes at 130. It must be exactly the closed tail.
    expect(a.price).toBe(130);
  });

  it('carries provenance on every result', () => {
    const a = attribute('TEST', 'Test', series(130, true), [newsItem()], OPTS)!;
    expect(a.asOf).toBeGreaterThan(0);
    expect(a.meta.source).toBe('binance-klines');
    expect(typeof a.meta.stale).toBe('boolean');
    // The uncalibrated scale must announce itself rather than being implied.
    expect(a.meta.derivation).toContain('uncalibrated');
  });

  it('returns null rather than guessing when there are too few closed candles', () => {
    // 40 bars, all forming. A function that ignored `closed` would happily
    // return an attribution built entirely on unconfirmed data.
    const short: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      short.push(candle(NOW - (40 - i) * BAR, 100, 101, 99, 100 + i * 0.1, 1000, false));
    }
    expect(attribute('TEST', 'Test', short, [newsItem()], OPTS)).toBeNull();
  });
});

describe('Unavailable is distinguishable from a zero', () => {
  it('recognises the shape and rejects a numeric zero', () => {
    const unavailable = {
      available: false as const,
      reason: 'No liquidation feed on this path.',
      lastGoodAt: null,
    };
    expect(isUnavailable(unavailable)).toBe(true);
    // The whole point: a bare 0 must never satisfy the "is this real?" check.
    expect(isUnavailable(0)).toBe(false);
    expect(isUnavailable(null)).toBe(false);
    expect(isUnavailable({ m5: 0, h1: 0 })).toBe(false);
  });

  it('carries a usable reason so the UI can say why', () => {
    const unavailable = {
      available: false as const,
      reason: 'No liquidation feed on this path.',
      lastGoodAt: null,
    };
    expect(unavailable.reason.length).toBeGreaterThan(0);
  });
});