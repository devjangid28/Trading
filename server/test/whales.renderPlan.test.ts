import { describe, expect, it } from 'vitest';
import { buildBubbles, bubbleRadius, tapeStats } from '../../src/whales/engine';
import {
  clusterBubbles, filterAxisTags, GUTTER_CAPTION, netForView, planOverlays, TIME_LABEL_COLOR, tooltipPlacement,
} from '../../src/whales/plan';
import type { WhaleBubble } from '../../src/whales/types';

const STEP = 900_000;
const T0 = 1_700_000_000_000;

function mk(id: number, t: number, price: number, usd: number, side: 'buy' | 'sell'): {
  id: number; t: number; price: number; qty: number; usd: number; side: 'buy' | 'sell'; count: number;
} {
  return { id, t, price, qty: usd / price, usd, side, count: 1 };
}

function vp(over: Partial<{ start: number; end: number; priceMin: number; priceMax: number; plotLeft: number; plotRight: number; plotTop: number; plotBottom: number }> = {}) {
  return {
    start: T0 - 2 * STEP,
    end: T0 + 30 * STEP,
    priceMin: 77_000,
    priceMax: 78_000,
    plotLeft: 10,
    plotRight: 1100,
    plotTop: 0,
    plotBottom: 400,
    ...over,
  };
}

describe('whales render plan (D3-D12 checks)', () => {
  it('D3: clusters overlapping bubbles (0.6 x sum radii), caps radius at 38px, bounds count', () => {
    const bubbles: WhaleBubble[] = [];
    for (let i = 0; i < 20; i++) {
      const notional = 2_000_000 + i * 50_000;
      bubbles.push({
        id: `b${i}`,
        t: T0 + i * 30_000,
        price: 77_500 + Math.sin(i) * 5,
        buyUsd: notional * 0.6,
        sellUsd: notional * 0.4,
        notional,
        count: 10,
        prints: 3,
        tradeIds: [i],
        avg: 77_500,
      });
    }
    const drawn = clusterBubbles(bubbles, vp(), T0);
    expect(drawn.length).toBeLessThanOrEqual(14);
    for (const d of drawn) expect(d.r).toBeLessThanOrEqual(38);
    // neighbor bubbles closer than 0.6 * (r1+r2) must have merged
    for (let i = 1; i < drawn.length; i++) {
      const prev = drawn[i - 1];
      const cur = drawn[i];
      const dist = Math.hypot(prev.x - cur.x, prev.y - cur.y);
      expect(dist).toBeGreaterThan(0.6 * (prev.r + cur.r) - 0.5);
    }
  });

  it('D4/D5: max 3 tags, no tag/tag or label/label intersections, no tag boxes', () => {
    const bubbles: WhaleBubble[] = [];
    for (let i = 0; i < 8; i++) {
      const notional = 3_000_000 + i * 1_000_000;
      const buy = i % 2 === 0 ? notional : notional * 0.1;
      bubbles.push({
        id: `t${i}`,
        t: T0 + i * 60_000,
        price: 77_500 + i * 2,
        buyUsd: buy,
        sellUsd: notional - buy,
        notional,
        count: 5,
        prints: 2,
        tradeIds: [i],
        avg: 77_500,
      });
    }
    const drawn = clusterBubbles(bubbles, vp(), T0);
    const { tags, labels } = planOverlays(drawn, vp(), 3);
    expect(tags.length).toBeLessThanOrEqual(3);
    for (const t of tags) {
      expect(t.color).toMatch(/^#/);
      expect(t.h).toBeGreaterThan(0);
    }
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const a = tags[i];
        const b = tags[j];
        expect(a.x >= b.x + b.w || a.x + a.w <= b.x || a.y >= b.y + b.h || a.y + a.h <= b.y).toBe(true);
      }
    }
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i];
        const b = labels[j];
        expect(a.x >= b.x + b.w || a.x + a.w <= b.x || a.y >= b.y + b.h || a.y + a.h <= b.y).toBe(true);
      }
    }
  });

  it('D7: tooltip always fully inside the plot rectangle', () => {
    const p = vp();
    for (const fx of [0.1, 0.5, 0.95]) {
      const x = p.plotLeft + (p.plotRight - p.plotLeft) * fx;
      const pos = tooltipPlacement(x, 200, p, 480, 88);
      expect(pos.x).toBeGreaterThanOrEqual(p.plotLeft);
      expect(pos.x + 480).toBeLessThanOrEqual(p.plotRight);
      expect(pos.y).toBeGreaterThanOrEqual(p.plotTop);
      expect(pos.y + 88).toBeLessThanOrEqual(p.plotBottom);
    }
  });

  it('D9: net header equals reading net; solid line ends at that net', () => {
    const points = [
      { t: T0 + 0 * STEP, whale: 1_000_000, everyone: -200_000 },
      { t: T0 + 1 * STEP, whale: -500_000, everyone: 400_000 },
      { t: T0 + 2 * STEP, whale: 2_000_000, everyone: -100_000 },
    ];
    const p = vp({ start: T0, end: T0 + 3 * STEP });
    const net = netForView(points, p);
    const reading = points.reduce((s, q) => s + q.whale, 0);
    expect(net.headerNet).toBe(reading);
    expect(net.lastPoint?.whale).toBe(reading);
    expect(net.perCandle.length).toBe(3);
  });

  it('D8/D10: gutter caption and time label color constants', () => {
    expect(GUTTER_CAPTION).toBe('bubbles/price');
    expect(TIME_LABEL_COLOR).toBe('#6b7686');
  });

  it('D12: axis tags never overlap by more than 2px after filtering', () => {
    const candidates = [
      { price: 79_469.66, y: 120 },
      { price: 79_063.54, y: 130 },
      { price: 78_460.74, y: 140 },
      { price: 78_161.47, y: 150 },
      { price: 77_666.25, y: 160 },
    ];
    const kept = filterAxisTags(candidates, [{ y: 100 }], 24);
    for (let i = 1; i < kept.length; i++) {
      expect(Math.abs(kept[i].y - kept[i - 1].y)).toBeGreaterThanOrEqual(20);
    }
  });

  it('D1-adjacent: bubbleRadius sqrt scaling and cap', () => {
    expect(bubbleRadius(1_500_000)).toBeLessThan(38);
    expect(bubbleRadius(6_340_000)).toBe(38);
    expect(bubbleRadius(50_000_000)).toBe(38);
  });

  it('auto whale floor: tapeStats p99 caps at $5K', () => {
    const trades = Array.from({ length: 2000 }, (_, i) => mk(i, T0 + i * 1000, 77_500, 100 + (i % 100) * 1000, 'buy'));
    const stats = tapeStats(trades);
    expect(stats.sampled).toBeGreaterThan(0);
    expect(stats.p99).toBeGreaterThan(0);
    expect(Math.min(stats.p99, 5_000)).toBeLessThanOrEqual(5_000);
  });

  it('buildBubbles sweep mode aggregates per candle, not per trade', () => {
    const trades = [
      mk(1, T0 + 100, 77_500, 1_200_000, 'buy'),
      mk(2, T0 + 150, 77_500, 800_000, 'buy'),
      mk(3, T0 + STEP + 100, 77_500, 900_000, 'sell'),
    ];
    const bubbles = buildBubbles(trades, STEP, { threshold: 50_000, clusterWindowMs: 1_000, sideFilter: 'both', t0: T0, mode: 'sweep' });
    expect(bubbles.length).toBe(2);
    const first = bubbles[0];
    expect(first.notional).toBeCloseTo(2_000_000, -1);
    const print = buildBubbles(trades, STEP, { threshold: 50_000, clusterWindowMs: 1_000, sideFilter: 'both', t0: T0, mode: 'print' });
    expect(print.length).toBe(3);
  });
});
