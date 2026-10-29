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
    // A candle that OPENS above TP1 (low 105) and reaches 106.
    //
    // A resting SELL limit at 104 is filled when the market trades at or
    // through 104 — including when the market GAPS through it. The order does
    // not get to sit unfilled because the price never "traded at exactly 104";
    // it is filled at the open, at a BETTER price than 104.
    //
    // The previous expectation here was TP2, on the reasoning that "price gapped
    // past 104 — it never filled there". That reasoning was mechanically wrong,
    // and it was expensive: a take-profit the market gapped through was never
    // credited at all, so the trade ran on and EXPIRED. On the live ledger
    // that produced 28 expired rows carrying 28.6% of the entire ledger's R.
    const tp2 = resolveOutcome({
      ...base,
      targets: [104, 106],
      candles: [bar(0, 106.5, 105, 106)],
    });
    expect(tp2.outcome).toBe('TP1');
    expect(tp2.price).toBe(104);

    const tp3 = resolveOutcome({
      ...base,
      targets: [104, 106, 108],
      candles: [bar(0, 108.5, 107, 108)],
    });
    expect(tp3.outcome).toBe('TP1');
    expect(tp3.price).toBe(104);
  });

  it('credits a target the market gapped through, at the target price', () => {
    // The candle is ENTIRELY beyond TP1: it opened at 105 and never traded
    // inside 104. The order still filled.
    const gapped = resolveOutcome({
      ...base,
      targets: [104],
      candles: [bar(0, 106.5, 105, 106)],
    });
    expect(gapped.outcome).toBe('TP1');
    expect(gapped.price).toBe(104);
    expect(gapped.rMultiple).toBeCloseTo(2, 6);
  });

  it('fills a stop that the market gapped THROUGH at the gap, not at the stop', () => {
    // The candle opened below the stop (98) and stayed there. The stop was
    // filled at the open, which is worse than the stop price.
    const gapped = resolveOutcome({
      ...base,
      candles: [{ t: T0, h: 99, l: 95, c: 95.5, o: 96 }],
    });
    expect(gapped.outcome).toBe('STOP');
    expect(gapped.price).toBe(96);
    expect(gapped.rMultiple).toBeCloseTo(-2, 6);
    expect(gapped.note).toContain('gapped through the stop');
  });

  it('fills a stop at the stop price when the candle did not gap', () => {
    const clean = resolveOutcome({
      ...base,
      candles: [{ t: T0, h: 100.5, l: 97.5, c: 97.8, o: 100.4 }],
    });
    expect(clean.outcome).toBe('STOP');
    expect(clean.price).toBe(98);
    expect(clean.rMultiple).toBeCloseTo(-1, 6);
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

describe('resolveOutcome: the trade\'s life', () => {
  it('does not resolve a trade with a candle from after its life ended', () => {
    // The trade has 24 hours (LEDGER.EXPIRY_HOURS). A candle 40 hours later
    // that reaches the target must NOT resolve the trade — the strategy gave
    // it 24 hours, and giving it 40 is a different strategy.
    const late = T0 + 40 * 60 * 60_000;
    const r = resolveOutcome({
      ...base,
      candles: [
        bar(0, 100.5, 99.5, 100),
        { t: late, h: 105, l: 100, c: 104 },
      ],
      now: late + 60_000,
    });
    expect(r.outcome).toBe('EXPIRED');
    expect(r.rMultiple).not.toBe(2);
  });

  it('the expiry mark is the close at the end of the life, not the last close seen', () => {
    // The last candle in the array is well past the life and at a very
    // different price. The mark must be the close at the 24-hour boundary.
    const lifeEnd = T0 + LEDGER.EXPIRY_HOURS * 3600_000;
    const bars = 24 * 12; // one 5m bar per 5 minutes over 24 hours
    const candles = Array.from({ length: bars + 24 }, (_, i) => ({
      t: T0 + i * BAR, h: 100.5, l: 99.5, c: 100,
    }));
    // The candle right at the boundary closes at 101; the ones after close at 90.
    candles[bars - 1] = { t: T0 + (bars - 1) * BAR, h: 101.5, l: 99.5, c: 101, o: 100 };
    for (let i = bars; i < candles.length; i++) {
      candles[i] = { t: T0 + i * BAR, h: 100, l: 89, c: 90, o: 95 };
    }
    const r = resolveOutcome({
      ...base,
      candles,
      now: lifeEnd + 60 * 60_000,
    });
    expect(r.outcome).toBe('EXPIRED');
    // (101 - 100) / 2 = 0.5 R — the close at the boundary, not the 90 print.
    expect(r.rMultiple).toBeCloseTo(0.5, 6);
    expect(r.price).toBe(101);
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
