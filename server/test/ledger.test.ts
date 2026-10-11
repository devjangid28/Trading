import { describe, it, expect } from 'vitest';
import { resolveOutcome } from '../src/ledger/resolve.js';
import { LEDGER } from '../src/config.js';

/**
 * The resolver is the piece that decides whether a recorded signal was right.
 * If it is optimistic, the ledger reports a win rate the market never paid.
 */

const T0 = 1_800_000_000_000;
const BAR = 5 * 60_000;

const bar = (i: number, h: number, l: number, c: number) => ({
  t: T0 + i * BAR, h, l, c,
});

const base = {
  side: 'bullish' as const,
  entry: 100,
  stop: 98,
  targets: [104, 108],
  riskPerUnit: 2,
  createdAt: T0,
  now: T0 + 10 * BAR,
};

describe('resolveOutcome: stop', () => {
  it('resolves STOP when a candle closes through the stop', () => {
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 100.5, 100, 100.2), bar(1, 100.3, 97.5, 97.8)],
    });
    expect(r.outcome).toBe('STOP');
    expect(r.rMultiple).toBe(-1);
    expect(r.price).toBe(98);
  });

  it('resolves STOP for a short when price rises through the stop', () => {
    const r = resolveOutcome({
      ...base,
      side: 'bearish',
      stop: 102,
      targets: [96, 92],
      candles: [bar(0, 100.2, 99.5, 100), bar(1, 102.5, 100.5, 102.2)],
    });
    expect(r.outcome).toBe('STOP');
  });

  it('stays OPEN while price is between the entry and the stop', () => {
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 101, 99, 100.5), bar(1, 101.5, 99.2, 101)],
      now: T0 + 2 * BAR,
    });
    expect(r.outcome).toBe('OPEN');
  });
});

describe('resolveOutcome: targets', () => {
  it('credits the NEAREST target touched, not the furthest', () => {
    // One candle whose high reaches R2. We must not assume R2 filled first.
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 109, 100, 101)],
    });
    expect(r.outcome).toBe('TP1');
    expect(r.price).toBe(104);
    expect(r.rMultiple).toBeCloseTo(2, 6); // (104-100)/2
  });

  it('maps TP1/TP2/TP3 by distance', () => {
    // A candle that OPENS above TP1 (low 105) and reaches 106 credits TP2,
    // because price never traded at 104.
    const tp2 = resolveOutcome({
      ...base,
      targets: [104, 106],
      candles: [bar(0, 106.5, 105, 106)],
    });
    expect(tp2.outcome).toBe('TP2');

    const tp3 = resolveOutcome({
      ...base,
      targets: [104, 106, 108],
      candles: [bar(0, 108.5, 107, 108)],
    });
    expect(tp3.outcome).toBe('TP3');
  });

  it('credits the NEAREST target when a candle trades through all of them', () => {
    // High 108.5 passes 104, 106 and 108. We book TP1 because that is what
    // fills first in a continuous market, not the furthest target.
    const r = resolveOutcome({
      ...base,
      targets: [104, 106, 108],
      candles: [bar(0, 108.5, 100, 101)],
    });
    expect(r.outcome).toBe('TP1');
    expect(r.price).toBe(104);
  });

  it('handles a short target below the entry', () => {
    const r = resolveOutcome({
      ...base,
      side: 'bearish',
      stop: 102,
      targets: [96],
      candles: [bar(0, 100, 95, 97)],
    });
    expect(r.outcome).toBe('TP1');
    expect(r.rMultiple).toBeCloseTo(2, 6); // (100-96)/2
  });
});

describe('resolveOutcome: stop-first ambiguity', () => {
  it('resolves STOP when one candle spans both the stop and a target', () => {
    // Range 96..105 contains stop 98 AND TP1 104. We cannot know the order,
    // so the conservative answer is STOP.
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 105, 96, 100)],
    });
    expect(r.outcome).toBe('STOP');
    expect(r.rMultiple).toBe(-1);
  });

  it('records the MFE anyway, so a bad-resolution candle is still visible', () => {
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 105, 96, 100)],
    });
    // 105 high is 5 above entry, risk 2 => 2.5R of favourable excursion,
    // even though we conservatively book it as a loss.
    expect(r.mfeR).toBeCloseTo(2.5, 6);
    expect(r.maeR).toBeCloseTo(-2, 6);
  });
});

describe('resolveOutcome: MFE and MAE in R', () => {
  it('tracks the best and worst excursion without resolving', () => {
    // Highs stay under TP1 (104) so this does not resolve; the excursions are
    // still accumulated.
    const r = resolveOutcome({
      ...base,
      candles: [
        bar(0, 103, 99, 102),
        bar(1, 103.5, 100, 101),
        bar(2, 102, 99.5, 100.5),
      ],
      now: T0 + 3 * BAR,
    });
    expect(r.outcome).toBe('OPEN');
    expect(r.mfeR).toBeCloseTo(1.75, 6); // (103.5-100)/2
    expect(r.maeR).toBeCloseTo(-0.5, 6);  // (100-99)/2, from the first bar
  });

  it('is zero when price never leaves the entry', () => {
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 100, 100, 100), bar(1, 100, 100, 100)],
      now: T0 + 2 * BAR,
    });
    expect(r.mfeR).toBe(0);
    expect(r.maeR).toBe(0);
  });

  it('records an adverse excursion when price dips even slightly below entry', () => {
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 100.2, 99.8, 100)],
      now: T0 + BAR,
    });
    expect(r.maeR).toBeCloseTo(-0.1, 6);
  });

  it('measures MAE for shorts as a negative excursion upward', () => {
    const r = resolveOutcome({
      ...base,
      side: 'bearish',
      stop: 105,
      targets: [95],
      candles: [bar(0, 101, 99, 100), bar(1, 102, 99.5, 101)],
      now: T0 + 2 * BAR,
    });
    expect(r.maeR).toBeLessThan(0);
  });
});

describe('resolveOutcome: expiry', () => {
  it('expires after the configured window', () => {
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 100.5, 99.5, 100)],
      now: T0 + LEDGER.EXPIRY_HOURS * 3600_000 + 60_000,
    });
    expect(r.outcome).toBe('EXPIRED');
  });

  it('does not expire early', () => {
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 100.5, 99.5, 100)],
      now: T0 + 12 * BAR,
    });
    expect(r.outcome).toBe('OPEN');
  });

  it('books the close-to-close move as the expired R', () => {
    const r = resolveOutcome({
      ...base,
      candles: [bar(0, 101, 99, 101)],
      now: T0 + LEDGER.EXPIRY_HOURS * 3600_000,
    });
    expect(r.outcome).toBe('EXPIRED');
    expect(r.rMultiple).toBeCloseTo(0.5, 6); // (101-100)/2
  });
});

describe('resolveOutcome: edge cases', () => {
  it('returns OPEN when riskPerUnit is zero', () => {
    const r = resolveOutcome({ ...base, riskPerUnit: 0, candles: [bar(0, 200, 1, 100)] });
    expect(r.outcome).toBe('OPEN');
  });

  it('ignores candles before the signal was created', () => {
    // The first bar opens 3 bars BEFORE createdAt, so its huge range must be
    // discarded entirely — otherwise a pre-signal spike would resolve the
    // trade before it was ever taken.
    const before = { t: T0 - 3 * BAR, h: 200, l: 1, c: 100 };
    const r = resolveOutcome({
      ...base,
      candles: [before, bar(5, 100.2, 99.9, 100)],
      now: T0 + 6 * BAR,
    });
    expect(r.outcome).toBe('OPEN');
    expect(r.mfeR).toBeLessThan(1);
  });

  it('handles a signal with no targets by running to expiry', () => {
    const r = resolveOutcome({
      ...base,
      targets: [],
      candles: [bar(0, 100.5, 99.5, 100)],
      now: T0 + LEDGER.EXPIRY_HOURS * 3600_000,
    });
    expect(r.outcome).toBe('EXPIRED');
  });

  it('handles an empty candle list', () => {
    const r = resolveOutcome({ ...base, candles: [], now: T0 + BAR });
    expect(r.outcome).toBe('OPEN');
    expect(r.mfeR).toBe(0);
  });
});
