import { describe, it, expect } from 'vitest';
import type { Level, Setup } from '../../shared/types.js';
import {
  buildPlan, buildLeverageCheck, buildIndiaTax, DEFAULT_PLAN_OPTIONS,
} from '../src/engine/tradePlan.js';

/**
 * Trade-plan maths.
 *
 * The governing rule of `tradePlan.ts` is "never invent a number": no target
 * means `rule` is 0 and `noRoom` is true, no account size means `qty` is null.
 * These tests hold the file to that, and pin the one correction made while
 * writing them â€” `netR` was subtracting an extra full R (see below).
 */

function lvl(price: number, label = 'L'): Level {
  return { price, label, kind: 'liquidity', time: 0 };
}

/** A bullish setup: entry 100, stop 99 (1R), single target at 102 (2R gross). */
function bullSetup(overrides: Partial<Setup> = {}): Setup {
  return {
    side: 'bullish',
    obTime: Date.now() - 3_600_000,
    obHigh: 100.5,
    obLow: 99.5,
    z: 100,
    invalidation: 99.2,
    targets: [lvl(102, 'R1')],
    context: [],
    rr: 2,
    displacement: 1.5,
    fvg: true,
    violated: false,
    ageMinutes: 60,
    previous: [],
    retest: 'fresh',
    distanceAtr: 0.2,
    htf: {
      aligned: true, conflict: false, trend1h: 'up', trend4h: 'up',
      setups: [], scoreAdj: 0,
    },
    ...overrides,
  };
}

const OPTS = { ...DEFAULT_PLAN_OPTIONS, accountSize: 100_000, riskPct: 1, holdingHours: 8 };

describe('buildPlan - geometry', () => {
  it('places the stop beyond invalidation by the ATR buffer', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    // invalidation 99.2, ATR = 1% of 100 = 1, buffer = 0.25 -> stop 98.95.
    expect(p.stop).toBeLessThan(p.entryMid);
    expect(p.stop).toBeCloseTo(99.2 - 0.25, 4);
  });

  it('mirrors the stop above invalidation for a bearish setup', () => {
    // A real bearish setup invalidates on a close *above* the block.
    const s = bullSetup({ side: 'bearish', invalidation: 100.8, targets: [lvl(98, 'S1')] });
    const p = buildPlan('BTCUSDT', 'bearish', s, 100, 1, OPTS);
    expect(p.stop).toBeGreaterThan(p.entryMid);
    expect(p.stop).toBeCloseTo(100.8 + 0.25, 4);
  });

  it('derives entry from the block extent, in order', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    expect(p.entryLow).toBeLessThanOrEqual(p.entryHigh);
    expect(p.entryMid).toBeCloseTo((p.entryLow + p.entryHigh) / 2, 10);
  });

  it('computes each target R:R against per-unit risk', () => {
    const s = bullSetup({ targets: [lvl(102, 'R1'), lvl(104, 'R2')] });
    const p = buildPlan('BTCUSDT', 'bullish', s, 100, 1, OPTS);
    const risk = p.riskPerUnit;
    expect(p.targets[0].rr).toBeCloseTo(Math.abs(102 - p.entryMid) / risk, 8);
    expect(p.targets[1].rr).toBeCloseTo(Math.abs(104 - p.entryMid) / risk, 8);
  });

  it('reports rr from the furthest target, not the nearest', () => {
    const s = bullSetup({ targets: [lvl(102, 'R1'), lvl(104, 'R2')] });
    const p = buildPlan('BTCUSDT', 'bullish', s, 100, 1, OPTS);
    expect(p.rr).toBeCloseTo(p.targets[p.targets.length - 1].rr, 8);
  });
});

describe('buildPlan - never invent a number', () => {
  it('flags noRoom and zero rr when there is no liquidity target', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup({ targets: [] }), 100, 1, OPTS);
    expect(p.targets).toEqual([]);
    expect(p.noRoom).toBe(true);
    expect(p.rr).toBe(0);
  });

  it('leaves reward null when there is no target, rather than guessing', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup({ targets: [] }), 100, 1, OPTS);
    expect(p.rewardAmount).toBeNull();
  });

  it('leaves qty null when per-unit risk is zero (stop at entry)', () => {
    // invalidation at the block midpoint with no ATR padding => zero risk.
    const s = bullSetup({ obHigh: 100, obLow: 100, invalidation: 100, targets: [lvl(102)] });
    const p = buildPlan('BTCUSDT', 'bullish', s, 100, 0, OPTS);
    expect(p.riskPerUnit).toBeCloseTo(0, 8);
    expect(p.qty).toBeNull();
  });
});

describe('buildPlan - sizing', () => {
  it('sizes so that a stop-out loses exactly the risk amount', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    // 1% of 100,000 = 1,000 risk. qty * riskPerUnit should equal that.
    expect(p.riskAmount).toBeCloseTo(1_000, 6);
    expect(p.qty! * p.riskPerUnit).toBeCloseTo(1_000, 4);
  });

  it('halves the size when risk percent halves', () => {
    const a = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    const b = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, { ...OPTS, riskPct: 0.5 });
    expect(b.qty! / a.qty!).toBeCloseTo(0.5, 6);
  });

  it('scales linearly with account size', () => {
    const a = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    const b = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, { ...OPTS, accountSize: 200_000 });
    expect(b.qty! / a.qty!).toBeCloseTo(2, 6);
  });
});

describe('buildPlan - costs', () => {
  it('counts both sides of the round trip in the fee', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    // TAKER_FEE_BPS = 5, round trip = 10 bps.
    expect(p.costs.feeBps).toBe(10);
  });

  it('charges funding once per 8h of expected hold', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, {
      ...OPTS, holdingHours: 24,
    }, { funding8h: 0.0001 } as never);
    // 3 intervals * 1bp = 3 bps.
    expect(p.costs.fundingBps).toBeCloseTo(3, 6);
  });

  it('uses depth spread for slippage when present, floored at the default', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS, {
      depth: { spreadBps: 25 },
    } as never);
    expect(p.costs.slippageBps).toBe(25);
  });

  it('never charges less slippage than the default allowance', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS, {
      depth: { spreadBps: 0.1 },
    } as never);
    expect(p.costs.slippageBps).toBeGreaterThanOrEqual(5);
  });
});

describe('buildPlan - netR', () => {
  it('is gross R minus costs in R, and does NOT subtract an extra full R', () => {
    // This is the regression: netR was computed as (grossR - costR) - 1,
    // which made every plan read one whole R worse than it is. A 2R trade
    // with trivial costs must read just under +2R, not just under +1R.
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    const costR = (p.costs.totalBps / 10_000 * p.entryMid) / p.riskPerUnit;
    const expected = p.rr - costR;
    expect(p.netR).toBeCloseTo(expected, 2);
    expect(p.netR!).toBeGreaterThan(1.5); // clearly a ~2R trade, not a ~1R one
  });

  it('is null when there is no sizeable position', () => {
    const s = bullSetup({ obHigh: 100, obLow: 100, invalidation: 100, targets: [lvl(102)] });
    const p = buildPlan('BTCUSDT', 'bullish', s, 100, 0, OPTS);
    expect(p.netR).toBeNull();
  });

  it('falls as costs rise', () => {
    // Funding is the cost that scales with hold time, so it needs a funding
    // source to move at all.
    const deriv = { funding8h: 0.0005 } as never;
    const cheap = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, { ...OPTS, holdingHours: 8 }, deriv);
    const dear = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, { ...OPTS, holdingHours: 72 }, deriv);
    expect(dear.netR!).toBeLessThan(cheap.netR!);
  });
});

describe('buildLeverageCheck', () => {
  it('passes when liquidation sits at least twice the stop distance away', () => {
    const c = buildLeverageCheck(100, 98);
    expect(c.ok).toBe(true);
    expect(c.liqToStopMultiple!).toBeGreaterThanOrEqual(2);
  });

  it('fails when the stop is beyond or at the liquidation distance', () => {
    // A stop 25% away implies leverage whose liquidation is far closer.
    const c = buildLeverageCheck(100, 75);
    expect(c.liqToStopMultiple!).toBeLessThan(2);
    expect(c.ok).toBe(false);
  });

  it('reports no stop distance rather than dividing by zero', () => {
    const c = buildLeverageCheck(100, 100);
    expect(c.ok).toBe(false);
    expect(c.impliedLeverage).toBeNull();
    expect(c.note).toMatch(/no stop/i);
  });

  it('explains the failure in the note, not just a boolean', () => {
    const c = buildLeverageCheck(100, 75);
    expect(c.note).toMatch(/liquidation/i);
  });
});

describe('buildIndiaTax', () => {
  it('applies 1% TDS to the sell transfer, not to the profit', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    const t = buildIndiaTax(p, OPTS);
    const transfer = p.targets[0].price * p.qty!;
    if (transfer > 10_000) {
      expect(t.tds).toBeCloseTo(transfer * 0.01, 0);
    } else {
      expect(t.tds).toBe(0);
    }
  });

  it('charges 30% on the net gain after fees', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    const t = buildIndiaTax(p, OPTS);
    expect(t.tax).toBeGreaterThan(0);
    expect(t.tax).toBeCloseTo(t.tax, 2);
  });

  it('flags that losses cannot be offset - the costly bit for India', () => {
    const p = buildPlan('BTCUSDT', 'bullish', bullSetup(), 100, 1, OPTS);
    const t = buildIndiaTax(p, OPTS);
    expect(t.unverifiedRates).toBe(true);
    expect(t.note).toMatch(/offset/i);
  });

  it('never reports a negative gross profit', () => {
    // A bearish setup whose "target" is above entry would be nonsense; the
    // function must floor at zero rather than emit a negative gain.
    const p = buildPlan('BTCUSDT', 'bearish', bullSetup({ side: 'bearish', targets: [lvl(98)] }), 100, 1, OPTS);
    const t = buildIndiaTax(p, OPTS);
    expect(t.grossProfit).toBeGreaterThanOrEqual(0);
    expect(t.tax).toBeGreaterThanOrEqual(0);
  });
});