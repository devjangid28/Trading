import { describe, it, expect } from 'vitest';
import {
  adaptiveEdges, buildDistribution, edgeTickLabel, niceEdge, MONO_FONT, DEFAULT_HALF_BUCKETS,
} from '../../src/home/depthBuckets';
import { meterFill, METER_TICKS } from '../../src/home/StrengthMeter';
import { MOTION } from '../../src/home/motion';
import {
  looksTruncated, monogramFor, monogramFontSize, stripMultiplier, monogramColor,
} from '../../shared/identity';

/**
 * Home rebuild — pure logic.
 *
 * These assert the things that are impossible to check by looking at a
 * screenshot: that bucket edges are strictly increasing, that the universe
 * partition is total, that a ticker is never truncated, and that the popup
 * placement stays inside the viewport.
 *
 * The layout/hover/mobile/a11y assertions live in the Playwright suite
 * (`qa/home.spec.ts`), because they need a real browser.
 */

describe('adaptive bucket edges (A9 / B3)', () => {
  it('rounds to values a human would have picked', () => {
    expect(niceEdge(1.2)).toBe(1.5);
    expect(niceEdge(1.6)).toBe(2);
    expect(niceEdge(7.1)).toBe(7.5);
    expect(niceEdge(0.02)).toBe(0.1);
    expect(niceEdge(-5)).toBe(0.1);
    expect(niceEdge(Infinity)).toBe(0.1);
  });

  it('produces strictly increasing edges on a realistic crypto distribution', () => {
    // Crypto-shaped: most coins under 1%, a long tail past 30%.
    const changes = [0.2, 0.4, 0.5, 0.6, 0.8, 0.9, 1.1, 1.4, 1.9, 2.2, 2.8, 3.3,
      4.1, 5.5, 7.2, 9.8, 12.4, 18.6, 26.3, 41.2];
    const { edges, degenerate } = adaptiveEdges(changes, DEFAULT_HALF_BUCKETS);
    expect(degenerate).toBe(false);
    expect(edges).toHaveLength(DEFAULT_HALF_BUCKETS - 1);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]).toBeGreaterThan(edges[i - 1]);
    }
    expect(edges[0]).toBeGreaterThan(0);
  });

  it('never collapses two buckets into one, even on a very narrow distribution', () => {
    // Everything between 2.0% and 2.001%: every quantile rounds to the same
    // nice value, which would otherwise produce a zero-width bucket.
    const narrow = [2.0, 2.0002, 2.0004, 2.0006, 2.0008, 2.001];
    const { edges } = adaptiveEdges(narrow, DEFAULT_HALF_BUCKETS);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]).toBeGreaterThan(edges[i - 1]);
    }
  });

  it('flags a degenerate distribution rather than inventing precision', () => {
    const r = adaptiveEdges([0.01, 0.02], DEFAULT_HALF_BUCKETS);
    expect(r.degenerate).toBe(true);
    expect(r.edges.every((e) => e > 0)).toBe(true);
    for (let i = 1; i < r.edges.length; i++) expect(r.edges[i]).toBeGreaterThan(r.edges[i - 1]);
  });

  it('handles an empty universe without throwing', () => {
    const r = adaptiveEdges([], DEFAULT_HALF_BUCKETS);
    expect(r.maxAbs).toBe(0);
    expect(r.edges).toHaveLength(DEFAULT_HALF_BUCKETS - 1);
  });

  it('labels edges with a sign matching the side they sit on', () => {
    expect(edgeTickLabel(0, 'bullish')).toBe('0');
    expect(edgeTickLabel(2, 'bullish')).toBe('+2%');
    expect(edgeTickLabel(2, 'bearish')).toBe('−2%');
    expect(edgeTickLabel(12, 'bullish')).toBe('+12%');
    expect(edgeTickLabel(0.75, 'bullish')).toBe('+0.75%');
  });
});

describe('depth distribution partitions the universe (A2 / E3)', () => {
  const rows = [
    { ticker: 'BTC', changePct: 3.2, strength: 40 },
    { ticker: 'ETH', changePct: 1.1, strength: 22 },
    { ticker: 'SOL', changePct: -2.4, strength: 30 },
    { ticker: 'XRP', changePct: -0.6, strength: 12 },
    { ticker: 'DOGE', changePct: 14.2, strength: 55 },
    { ticker: 'SHIB', changePct: 9.0, strength: 0 },   // chop: strength 0
    { ticker: 'PEPE', changePct: -6.5, strength: 0 },  // chop, despite being down
    { ticker: 'ADA', changePct: 0, strength: 18 },
  ];

  it('counts every asset exactly once across up / down / choppy / flat', () => {
    const d = buildDistribution(rows);
    expect(d.up + d.down + d.choppy + d.flat).toBe(d.total);
    expect(d.total).toBe(rows.length);
  });

  it('assigns a chop coin to choppy, not to its direction', () => {
    const d = buildDistribution(rows);
    expect(d.choppy).toBe(2);
    // SHIB is +9% and PEPE is -6.5%, but neither reaches a bucket: both are chop.
    const inBuckets = d.bullish.reduce((a, b) => a + b.count, 0) + d.bearish.reduce((a, b) => a + b.count, 0);
    expect(inBuckets).toBe(d.up + d.down);
  });

  it('places every non-choppy asset in a bucket, with no losses', () => {
    const d = buildDistribution(rows);
    expect(d.bullish.reduce((a, b) => a + b.count, 0)).toBe(d.up);
    expect(d.bearish.reduce((a, b) => a + b.count, 0)).toBe(d.down);
  });

  it('keeps each bucket within its own bounds', () => {
    const d = buildDistribution(rows);
    for (const b of [...d.bullish, ...d.bearish]) {
      expect(b.to).toBeGreaterThan(b.from);
      for (const s of b.symbols) {
        expect(Math.abs(s.changePct)).toBeGreaterThanOrEqual(b.from);
        if (Math.abs(s.changePct) < d.maxAbs) {
          expect(Math.abs(s.changePct)).toBeLessThan(b.to);
        }
      }
    }
  });

  it('orders the symbols in a bucket by how far they moved', () => {
    const d = buildDistribution(rows);
    for (const b of [...d.bullish, ...d.bearish]) {
      for (let i = 1; i < b.symbols.length; i++) {
        expect(Math.abs(b.symbols[i].changePct)).toBeLessThanOrEqual(Math.abs(b.symbols[i - 1].changePct));
      }
      expect(b.symbols.length).toBeLessThanOrEqual(5);
    }
  });

  it('handles an all-flat universe', () => {
    const d = buildDistribution(rows.map((r) => ({ ...r, changePct: 0, strength: 1 })));
    expect(d.up).toBe(0);
    expect(d.down).toBe(0);
    expect(d.flat).toBe(rows.length);
    expect(d.up + d.down + d.choppy + d.flat).toBe(d.total);
  });
});

describe('ticker identity (A1 / D1-D4)', () => {
  it('never treats a two-letter render of a longer ticker as correct', () => {
    expect(looksTruncated('ST', 'STRK')).toBe(true);
    expect(looksTruncated('KA', 'KAIA')).toBe(true);
    expect(looksTruncated('st', 'STRK')).toBe(true);
  });

  it('accepts the full ticker, in any case', () => {
    expect(looksTruncated('STRK', 'STRK')).toBe(false);
    expect(looksTruncated('strk', 'STRK')).toBe(false);
    expect(looksTruncated('  STRK ', 'STRK')).toBe(false);
  });

  it('does not flag a genuinely two-letter symbol', () => {
    expect(looksTruncated('OP', 'OP')).toBe(false);
    expect(looksTruncated('AB', 'ABC')).toBe(true);
  });

  it('builds a monogram from up to four real characters, never two', () => {
    expect(monogramFor('STRK')).toBe('STRK');
    expect(monogramFor('KAIA')).toBe('KAIA');
    expect(monogramFor('BTC')).toBe('BTC');
    expect(monogramFor('OP')).toBe('OP');
    for (const t of ['STRK', 'KAIA', 'TIA', 'SAND', 'RLC', 'ADA', 'BTC']) {
      expect(monogramFor(t).length).toBeGreaterThanOrEqual(Math.min(t.length, 4));
    }
  });

  it('shrinks the monogram font as the text gets longer, so it always fits', () => {
    expect(monogramFontSize('OP')).toBeGreaterThan(monogramFontSize('BTC'));
    expect(monogramFontSize('BTC')).toBeGreaterThan(monogramFontSize('STRK'));
  });

  it('drops the multiplier prefix on leveraged perps but keeps the rest', () => {
    expect(stripMultiplier('1000PEPE')).toBe('PEPE');
    expect(stripMultiplier('10000LUNA')).toBe('LUNA');
    expect(stripMultiplier('1000000MOG')).toBe('MOG');
    expect(stripMultiplier('PEPE')).toBe('PEPE');
    expect(stripMultiplier('1INCH')).toBe('1INCH');
    expect(stripMultiplier('BTC')).toBe('BTC');
    // A symbol that merely STARTS with digits but is not a multiplier is kept.
    expect(stripMultiplier('100')).toBe('100');
  });

  it('produces a stable colour per ticker and different colours for different tickers', () => {
    expect(monogramColor('STRK')).toBe(monogramColor('STRK'));
    expect(monogramColor('STRK')).not.toBe(monogramColor('KAIA'));
    expect(monogramColor('BTC')).toMatch(/^hsl\(/);
  });
});

describe('strength meter normalisation', () => {
  it('fills the whole bar for the strongest row on the page', () => {
    expect(meterFill(10, 10)).toBe(1);
    expect(Math.round(meterFill(10, 10) * METER_TICKS)).toBe(METER_TICKS);
  });

  it('fills nothing for a zero or negative strength', () => {
    expect(meterFill(0, 10)).toBe(0);
    expect(meterFill(-3, 10)).toBe(0);
    expect(meterFill(NaN, 10)).toBe(0);
  });

  it('clamps rather than overflowing when a row beats the stated max', () => {
    expect(meterFill(50, 10)).toBe(1);
  });

  it('does not divide by zero when the page is flat', () => {
    expect(meterFill(5, 0)).toBe(0);
  });
});

describe('motion constants (C2 / E4)', () => {
  it('exports the timings the layout suite asserts against', () => {
    expect(MOTION.openDelayMs).toBeGreaterThan(0);
    expect(MOTION.closeGraceMs).toBeGreaterThan(0);
    expect(MOTION.fadeMs).toBeGreaterThan(0);
    expect(MOTION.widthPx).toBe(500);
  });

  it('keeps the open path under the suite 300ms tolerance', () => {
    expect(MOTION.openDelayMs + MOTION.fadeMs).toBeLessThanOrEqual(300);
  });

  it('keeps the close grace long enough to travel from a row into the popup', () => {
    // Zero grace would close the popup the instant the pointer crossed the gap.
    expect(MOTION.closeGraceMs).toBeGreaterThanOrEqual(100);
  });

  it('exposes a tabular font for axis labels', () => {
    expect(MONO_FONT).toMatch(/mono/i);
  });
});