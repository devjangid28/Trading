import { describe, it, expect } from 'vitest';
import { buildButterfly, extremes, edgeLabel, HALF_BUCKETS } from '../src/engine/butterfly.js';
import type { AssetRow } from '../../shared/types.js';

/**
 * The butterfly chart is the one place the UI claims something about the WHOLE
 * universe rather than about the top rows, so the bucketing has to be exactly
 * right: a mis-bucketed histogram would assert breadth that the market does
 * not have.
 */

function row(changePct: number, id = 'X'): AssetRow {
  return { base: id, changePct } as AssetRow;
}

function rowsFrom(pcts: number[]): AssetRow[] {
  return pcts.map((p, i) => row(p, `C${i}`));
}

describe('buildButterfly', () => {
  it('returns an empty but well-formed shape for no rows', () => {
    const bf = buildButterfly([]);
    expect(bf.n).toBe(0);
    expect(bf.skew).toBeNull();
    expect(bf.top).toBe(0);
    expect(bf.bottom).toBe(0);
    expect(bf.buckets).toHaveLength(HALF_BUCKETS * 2);
  });

  it('produces one bucket per move, so counts always sum to n', () => {
    const bf = buildButterfly(rowsFrom([-6, -1.5, 0, 0.4, 2.5, 7]));
    const bucketed = bf.buckets.reduce((a, x) => a + x.total, 0);
    expect(bucketed).toBe(bf.n);
  });

  it('never drops a move below -1%, whatever the magnitude', () => {
    // This is the regression test for the off-by-three in the bucket origin
    // that silently discarded half the universe from the chart.
    for (const pct of [-40, -9.9, -5.1, -1.1, -0.1, 0.1, 1.1, 5.1, 9.9, 40]) {
      const bf = buildButterfly(rowsFrom([pct]));
      expect(bf.buckets.reduce((a, x) => a + x.total, 0)).toBe(1);
    }
  });

  it('keeps bullish + bearish + flat equal to total in every bucket', () => {
    const bf = buildButterfly(rowsFrom([-3, -1, 0, 0, 1, 4]));
    for (const bk of bf.buckets) {
      expect(bk.bullish + bk.bearish + bk.flat).toBe(bk.total);
    }
  });

  it('splits gains left of the spine and losses right', () => {
    const bf = buildButterfly(rowsFrom([-1, -2, 1, 3]));
    // Every bullish count sits in a bucket whose lower edge is >= 0.
    for (const bk of bf.buckets) {
      if (bk.bullish > 0) expect(bk.from).toBeGreaterThanOrEqual(0);
      if (bk.bearish > 0) expect(bk.from).toBeLessThan(0);
    }
  });

  it('counts an exact 0% as flat, on neither side', () => {
    const bf = buildButterfly(rowsFrom([0, 0]));
    expect(bf.flat).toBe(2);
    expect(bf.bullish).toBe(0);
    expect(bf.bearish).toBe(0);
  });

  it('puts flat rows in the spine bucket only', () => {
    const bf = buildButterfly(rowsFrom([0, 0]));
    const spine = bf.buckets.find((b) => b.from === 0);
    expect(spine?.flat).toBe(2);
    expect(spine?.bullish).toBe(0);
    expect(spine?.bearish).toBe(0);
  });

  it('clamps a huge move into the open-ended outermost bucket', () => {
    const bf = buildButterfly(rowsFrom([500, -500]));
    // +500 clamps right (last bucket), -500 clamps left (first bucket). They
    // are different buckets; neither is the spine.
    const last = bf.buckets[bf.buckets.length - 1];
    const firstB = bf.buckets[0];
    expect(last.bullish).toBe(1);
    expect(last.from).toBe(5);
    expect(Number.isFinite(last.to)).toBe(false);
    expect(firstB.bearish).toBe(1);
    expect(firstB.from).toBe(-Infinity);
    // The open end is the LOWER edge on the left and the UPPER edge on the
    // right, so only one side of each outermost bucket is infinite.
    expect(firstB.to).toBe(-5);
    expect(Number.isFinite(firstB.from)).toBe(false);
  });

  it('buckets by the documented edges', () => {
    const bf = buildButterfly(rowsFrom([-5.5, -3, -2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3, 5.5]));
    const edges = bf.buckets.map((b) => b.from);
    expect(edges).toEqual([-Infinity, -5, -3, -2, -1, 0, 1, 2, 3, 5]);
  });

  it('places a -5 exactly in the -5 bucket, not the open one', () => {
    const bf = buildButterfly(rowsFrom([-5]));
    const i = bf.buckets.findIndex((b) => b.from === -Infinity);
    expect(bf.buckets[i].bearish).toBe(0);
    const j = bf.buckets.findIndex((b) => b.from === -5);
    expect(bf.buckets[j].bearish).toBe(1);
  });

  it('reports skew of +1 for an all-gain universe', () => {
    expect(buildButterfly(rowsFrom([1, 2, 3])).skew).toBe(1);
  });

  it('reports skew of -1 for an all-loss universe', () => {
    expect(buildButterfly(rowsFrom([-1, -2])).skew).toBe(-1);
  });

  it('reports zero skew for a symmetric universe', () => {
    expect(buildButterfly(rowsFrom([-2, -1, 1, 2])).skew).toBe(0);
  });

  it('reports null skew when everything is flat', () => {
    // movers === 0, so there is no direction to be skewed towards.
    expect(buildButterfly(rowsFrom([0, 0, 0])).skew).toBeNull();
  });

  it('tracks the strongest gain and loss', () => {
    const bf = buildButterfly(rowsFrom([-4, 1, 9, 2]));
    expect(bf.top).toBe(9);
    expect(bf.bottom).toBe(-4);
  });

  it('ignores non-finite changes rather than bucketing them as zero', () => {
    const bf = buildButterfly(rowsFrom([1, NaN, 2]));
    expect(bf.n).toBe(2);
  });

  it('flags a concentrated distribution', () => {
    // Everything in one bucket means a single spike, not breadth.
    expect(buildButterfly(rowsFrom([1, 1.1, 0.9, 1.2, -0.1])).concentrated).toBe(true);
  });

  it('does not flag a spread-out distribution', () => {
    const spread = rowsFrom([1, 2, 3, 4, 5, -1, -2, -3, -4, -5]);
    expect(buildButterfly(spread).concentrated).toBe(false);
  });

  it('handles a half-width other than the default', () => {
    const bf = buildButterfly(rowsFrom([-1, 1]), 3);
    expect(bf.buckets).toHaveLength(6);
    expect(bf.half).toBe(3);
  });
});

describe('extremes', () => {
  it('splits at or beyond the threshold, in both directions', () => {
    const rows = rowsFrom([-6, -3, 1, 4, 7]);
    const { up, down } = extremes(rows, 5);
    expect(up.map((r) => r.changePct)).toEqual([7]);
    expect(down.map((r) => r.changePct)).toEqual([-6]);
  });

  it('sorts strongest-first on each side', () => {
    const { up, down } = extremes(rowsFrom([6, 9, 8, -5, -7, -6]), 5);
    expect(up.map((r) => r.changePct)).toEqual([9, 8, 6]);
    expect(down.map((r) => r.changePct)).toEqual([-7, -6, -5]);
  });

  it('is inclusive at the threshold itself', () => {
    const { up } = extremes(rowsFrom([5]), 5);
    expect(up).toHaveLength(1);
  });
});

describe('edgeLabel', () => {
  it('renders the spine as a bare zero', () => {
    expect(edgeLabel(0)).toBe('0');
  });

  it('signs positive and negative edges', () => {
    expect(edgeLabel(2)).toBe('+2%');
    expect(edgeLabel(-2)).toBe('−2%');
  });

  it('describes the open-ended bucket as "5%+" on both sides', () => {
    // "Infinity" in a UI label is the kind of thing that ships and is noticed.
    expect(edgeLabel(Infinity)).toBe('5%+');
    expect(edgeLabel(-Infinity)).toBe('5%+');
  });
});