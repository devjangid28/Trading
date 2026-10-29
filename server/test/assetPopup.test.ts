import { describe, it, expect } from 'vitest';
import type { Candle } from '../../shared/types';
import { resolveVwap } from '../../src/components/AssetPopup';
import {
  sessionStartIndex, sessionStartTime, sessionVwap,
} from '../src/engine/orderblock.js';
import { STRUCTURE } from '../src/config.js';

/**
 * The chart popup's VWAP.
 *
 * Symptom this pins: opening a signal card on the Signals tab (or a radar card)
 * rendered `VWAP n/a` and failed the popup's own "Price above VWAP" alignment
 * tick, while the board row for the same coin displayed the number correctly.
 *
 * Cause, and the part worth remembering: `AssetPopup` read VWAP from the board
 * row and nothing else, and the Signals and Radar tabs passed `row={null}`
 * because their row shapes were not `AssetRow` and would not typecheck. So the
 * fix is not "read from more places" - it is that the popup now has a source
 * that exists on every surface (`/api/asset/:id`), and the row is a fallback.
 *
 * A test that only asserted `resolveVwap(detail, row) === detail.vwap` would
 * pass against the old code, so these also assert the row-less case and the
 * no-data case: those are the two shapes the bug actually took.
 */

describe('resolveVwap', () => {
  it('draws the VWAP when there is no board row at all', () => {
    // The bug. Signals and Radar mounted the popup with row={null}; with the
    // row as the only source this was null, hence "n/a".
    expect(resolveVwap({ vwap: 101.5 }, null)).toBe(101.5);
  });

  it('prefers the fetched detail over the board row', () => {
    // The detail is computed over the candles the chart draws, so it is the
    // number the chart and the alignment check must agree with.
    expect(resolveVwap({ vwap: 101.5 }, { vwap: 99 })).toBe(101.5);
  });

  it('falls back to the row while the detail is still in flight', () => {
    expect(resolveVwap(null, { vwap: 99 })).toBe(99);
  });

  it('falls back to the row when the detail has no VWAP', () => {
    // A null VWAP is the engine saying "no volume in this window", which on a
    // live pair means the feed is broken - not that VWAP is zero. Either way
    // the row is still a real measurement and must win over the dash.
    expect(resolveVwap({ vwap: null }, { vwap: 99 })).toBe(99);
  });

  it('returns null rather than 0 when nothing measured it', () => {
    // Never invent a number. `0` would draw a VWAP line along the bottom of the
    // chart and make every "price above VWAP" check pass.
    expect(resolveVwap(null, null)).toBeNull();
    expect(resolveVwap({ vwap: null }, null)).toBeNull();
    expect(resolveVwap({ vwap: null }, { vwap: null })).toBeNull();
  });
});

const BAR = 5 * 60_000;

/** `n` closed candles, one bar apart, each with the given volume and price. */
function candles(n: number, price: number, vol = 1000): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    t: 1_700_000_000_000 + i * BAR,
    o: price, h: price, l: price, c: price, v: vol, closed: true,
  }));
}

describe('the session window', () => {
  it('is the trailing 24 hours of closed 5m candles', () => {
    // 289 bars covers the 288 x 5m = 24h span inclusive of both ends: the
    // session's opening candle and the bar in progress are both in the window.
    // If this changes, session VWAP, day change and day high/low all change
    // meaning together - which is the point of naming it.
    expect((STRUCTURE.SESSION_CANDLES - 1) * BAR).toBe(86_400_000);
  });

  it('includes exactly SESSION_CANDLES candles, not one fewer', () => {
    const series = candles(400, 100);
    const from = sessionStartIndex(series);
    expect(series.length - from).toBe(STRUCTURE.SESSION_CANDLES);
  });

  it('keeps the whole series when it is shorter than a session', () => {
    // A 30-candle series must read as "all of it", not as a negative index
    // that silently drops the oldest candles.
    const series = candles(30, 100);
    expect(sessionStartIndex(series)).toBe(0);
    expect(sessionStartTime(series)).toBe(series[0].t);
  });

  it('handles an empty series without throwing', () => {
    expect(sessionStartIndex([])).toBe(0);
    expect(sessionStartTime([])).toBe(0);
  });

  it('ignores volume from before the session when prices differ', () => {
    const series = candles(400, 100);
    // Make the oldest 111 candles absurdly expensive with huge volume.
    for (let i = 0; i < 111; i++) {
      series[i] = { ...series[i], o: 9000, h: 9000, l: 9000, c: 9000, v: 1_000_000 };
    }
    const inSession = sessionVwap(series, sessionStartTime(series));
    const allTime = sessionVwap(series, 0);
    // The session VWAP is 100 because none of the 9000s are inside the window;
    // the all-time VWAP is far above it because they are. If the window ever
    // slides by one candle the first number moves off 100.
    expect(inSession).toBeCloseTo(100, 6);
    expect(allTime!).toBeGreaterThan(100);
  });
});
