import { describe, it, expect } from 'vitest';
import { axisPct, niceTick, niceTicks, norm } from '../../src/components/chartMath';

/**
 * Chart math — pure logic.
 *
 * These are the numbers that decide where a candle body is drawn, so a silent
 * regression here is a chart that renders the wrong geometry rather than an
 * error. Every assertion below is hand-computed; none of them assert against
 * the implementation's own output.
 *
 * The rule these protect is the project's first one: an axis label that cannot
 * be computed must render as a dash, never as a number.
 */

describe('axisPct', () => {
  it('signs positive and negative values explicitly', () => {
    expect(axisPct(3.21)).toBe('+3.2%');
    expect(axisPct(-3.21)).toBe('−3.2%');
  });

  it('leaves zero unsigned rather than printing "+0.0"', () => {
    expect(axisPct(0)).toBe('0.0%');
  });

  it('uses one decimal below 10 and none at or above it', () => {
    expect(axisPct(9.94)).toBe('+9.9%');
    expect(axisPct(10)).toBe('+10%');
    expect(axisPct(123.4)).toBe('+123%');
  });

  it('renders a dash for a non-finite value instead of a number', () => {
    // This is the "never invent a number" rule applied to the axis: NaN, Infinity
    // and -Infinity must all read as unknown, never as "+NaN%" or "+Infinity%".
    expect(axisPct(NaN)).toBe('—');
    expect(axisPct(Infinity)).toBe('—');
    expect(axisPct(-Infinity)).toBe('—');
  });

  it('honours a custom suffix', () => {
    expect(axisPct(2.5, ' bps')).toBe('+2.5 bps');
  });
});

describe('niceTick', () => {
  it('rounds to the nearest 1/2/5 times the magnitude', () => {
    // Hand-computed: magnitude 10^-1, normalised 7 -> step 5 -> 0.5
    expect(niceTick(0.7)).toBeCloseTo(0.5, 10);
    // magnitude 1, normalised 3.4 -> step 2 (2 <= 3.4 < 5) -> 2
    expect(niceTick(3.4)).toBeCloseTo(2, 10);
    // magnitude 100, normalised 1.2 -> step 1 -> 100
    expect(niceTick(120)).toBeCloseTo(100, 10);
    // magnitude 100, normalised 2.6 -> step 2 -> 200
    expect(niceTick(260)).toBeCloseTo(200, 10);
  });

  it('preserves the magnitude across decades', () => {
    // magnitude 10^-3, normalised 3.4 -> step 2 -> 0.002
    expect(niceTick(0.0034)).toBeCloseTo(0.002, 12);
    // magnitude 10^3, normalised 3.4 -> step 2 -> 2000
    expect(niceTick(3400)).toBeCloseTo(2000, 10);
  });

  it('returns zero for zero rather than dividing by an undefined magnitude', () => {
    expect(niceTick(0)).toBe(0);
  });

  it('returns zero for non-finite input', () => {
    expect(niceTick(NaN)).toBe(0);
    expect(niceTick(Infinity)).toBe(0);
  });
});

describe('niceTicks', () => {
  it('returns strictly increasing ticks inside the range', () => {
    const ticks = niceTicks(100, 200, 5);
    expect(ticks.length).toBeGreaterThan(1);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    }
    expect(ticks[0]).toBeGreaterThanOrEqual(100);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(200);
  });

  it('never repeats a value when the range is narrow', () => {
    // 0.02 wide over 5 requested ticks would repeat "0.0, 0.0, 0.0" if the
    // implementation stepped by a rounded value instead of the real one.
    const ticks = niceTicks(1.0, 1.02, 5);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('returns an empty list for a degenerate range', () => {
    expect(niceTicks(100, 100, 5)).toEqual([]);
    expect(niceTicks(200, 100, 5)).toEqual([]);
  });

  it('returns an empty list for non-finite bounds', () => {
    expect(niceTicks(NaN, 100, 5)).toEqual([]);
    expect(niceTicks(0, Infinity, 5)).toEqual([]);
  });

  it('covers a negative range', () => {
    // raw step = (50 - -50) / 4 = 25 -> niceTick -> 20. Ticks start at the
    // first multiple of 20 at or above -50, which is -40. A tick series is not
    // required to land exactly on the bounds, so the assertion is that every
    // tick sits inside the range and the spacing is uniform.
    const ticks = niceTicks(-50, 50, 5);
    expect(ticks).toEqual([-40, -20, 0, 20, 40]);
    expect(ticks.every((t) => t >= -50 && t <= 50)).toBe(true);
  });
});

describe('norm', () => {
  it('maps the bounds to 0 and 1', () => {
    expect(norm(0, 0, 10)).toBe(0);
    expect(norm(10, 0, 10)).toBe(1);
    expect(norm(5, 0, 10)).toBe(0.5);
  });

  it('clamps outside the range instead of running off the plot', () => {
    // An unclamped value would draw a candle outside the chart area.
    expect(norm(-5, 0, 10)).toBe(0);
    expect(norm(50, 0, 10)).toBe(1);
  });

  it('returns the midpoint for a zero-width range', () => {
    // A flat series must not produce NaN, which would silently blank the chart.
    expect(norm(5, 5, 5)).toBe(0.5);
  });
});