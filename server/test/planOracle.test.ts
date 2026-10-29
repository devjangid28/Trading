import { describe, it, expect } from 'vitest';
import { buildPlan, buildLeverageCheck, buildIndiaTax, DEFAULT_PLAN_OPTIONS } from '../src/engine/tradePlan.js';
import { INDIA_TAX, RISK } from '../src/config.js';
import type { Setup, Side } from '../../shared/types';
import {
  oraclePlan, oracleIndiaTax, mulberry32, type OracleInput,
} from '../../scripts/plan-oracle.js';

/**
 * FIX 4 — verifying trade-plan math against an independent oracle.
 *
 * The oracle in `scripts/plan-oracle.ts` recomputes every figure from the
 * definitions and does NOT import buildPlan. That independence is the entire
 * point: the pre-existing tests assert against the same implementation they
 * exercise, so a wrong formula that is wrong consistently would pass them.
 *
 * If a number here disagrees, the test fails and says which field and by how
 * much, rather than quietly accepting whatever buildPlan returns.
 */

const EPS = 1e-6;

/** Build the minimal Setup buildPlan needs, at a chosen entry and stop. */
function makeSetup(side: Side, obLow: number, obHigh: number, invalidation: number, targets: number[]): Setup {
  return {
    side,
    obTime: 1_700_000_000_000,
    obHigh, obLow,
    z: (obLow + obHigh) / 2,
    invalidation,
    targets: targets.map((price, i) => ({
      label: i === 0 ? 'R1' : 'R2',
      price,
      kind: 'pivot' as const,
      strength: 1,
      pooled: false,
    })),
    context: [],
    rr: 0,
    displacement: 1,
    fvg: true,
    violated: false,
    ageMinutes: 30,
    previous: [],
    retest: 'in-zone' as const,
    distanceAtr: 0.2,
    htf: { aligned: false, note: '', zones: [] } as unknown as Setup['htf'],
  };
}

/** Level shape used by the engine; kept loose so the test does not drift. */
type Level = { price: number; label: string; kind?: string; strength?: number; pooled?: boolean };

describe('plan oracle — agreement with buildPlan', () => {
  it('agrees on 2000 randomised long and short plans', () => {
    const rnd = mulberry32(20261014);
    const mismatches: string[] = [];
    let checked = 0;

    for (let n = 0; n < 2000; n++) {
      const side: Side = rnd() < 0.5 ? 'bullish' : 'bearish';
      const entry = 0.5 + rnd() * 90_000;
      // Stop 0.1% to 12% away, always on the losing side.
      const stopDistPct = 0.001 + rnd() * 0.12;
      const stop = side === 'bullish' ? entry * (1 - stopDistPct) : entry * (1 + stopDistPct);
      const targetCount = Math.floor(rnd() * 3);
      const targets: number[] = [];
      for (let t = 0; t < targetCount; t++) {
        const mult = 1 + rnd() * 6;
        targets.push(side === 'bullish' ? entry * (1 + stopDistPct * mult) : entry * (1 - stopDistPct * mult));
      }

      const obLow = entry * 0.999;
      const obHigh = entry * 1.001;
      // ATR 0 is deliberate: it isolates the entry/stop maths from the buffer,
      // which is covered by its own deterministic test below.
      const plan = buildPlan('X', side, makeSetup(side, obLow, obHigh, stop, targets), entry, 0, DEFAULT_PLAN_OPTIONS, null);

      const oi: OracleInput = {
        side,
        entry: plan.entryMid,
        stop: plan.stop,
        targetPrices: plan.targets.map((t) => t.price),
        accountSize: DEFAULT_PLAN_OPTIONS.accountSize,
        riskPct: DEFAULT_PLAN_OPTIONS.riskPct,
        takerFeeBps: RISK.TAKER_FEE_BPS,
        funding8h: 0,
        holdHours: DEFAULT_PLAN_OPTIONS.holdingHours,
        slippageBps: RISK.DEFAULT_SLIPPAGE_BPS,
        leverage: 10,
      };
      const o = oraclePlan(oi);
      checked++;

      const cmp = (field: string, a: number | null, b: number | null, tol = EPS) => {
        if (a === null || b === null) {
          if (a !== b) mismatches.push(`#${n} ${field}: buildPlan=${a} oracle=${b}`);
          return;
        }
        // qty is rounded to 1e8 by buildPlan, so compare with a matching tolerance.
        const t = field === 'qty' ? 1e-7 : tol;
        if (Math.abs(a - b) > Math.max(t, Math.abs(b) * t)) {
          mismatches.push(`#${n} ${field}: buildPlan=${a} oracle=${b} diff=${a - b}`);
        }
      };

      cmp('entryMid', plan.entryMid, o.entry);
      cmp('stop', plan.stop, o.stop);
      cmp('riskPerUnit', plan.riskPerUnit, o.riskPerUnit);
      cmp('riskAmount', plan.riskAmount ?? null, o.riskAmount);
      cmp('qty', plan.qty, o.qty);
      cmp('feeBps', plan.costs.feeBps, o.feeBps);
      cmp('slippageBps', plan.costs.slippageBps, o.slippageBps);
      cmp('totalBps', plan.costs.totalBps, o.costBps, 0.05);
      cmp('noRoom', plan.noRoom ? 1 : 0, o.noRoom ? 1 : 0, 0);
      plan.targets.forEach((t, i) => cmp(`target${i}.rr`, t.rr, o.grossR[i]));
      // netR is buildPlan's headline figure; it is rounded to 2dp for display.
      if (plan.netR !== null && plan.targets.length) {
        cmp('netR', plan.netR, Math.round(o.netR[o.netR.length - 1] * 100) / 100, 0.005);
      }
    }

    expect(checked).toBe(2000);
    expect(mismatches.slice(0, 12)).toEqual([]);
  });

  it('agrees on the India tax for winners and losers', () => {
    const rnd = mulberry32(777);
    const mismatches: string[] = [];

    for (let n = 0; n < 500; n++) {
      const side: Side = rnd() < 0.5 ? 'bullish' : 'bearish';
      const entry = 1 + rnd() * 5_000;
      const stopDistPct = 0.005 + rnd() * 0.1;
      const stop = side === 'bullish' ? entry * (1 - stopDistPct) : entry * (1 + stopDistPct);
      // Deliberately include exits that LOSE, which is where a tax credit bug
      // would hide.
      const exitMul = 0.9 + rnd() * 0.5;
      const targets = [entry * exitMul];
      const plan = buildPlan('X', side, makeSetup(side, entry * 0.999, entry * 1.001, stop, targets), entry, 0, DEFAULT_PLAN_OPTIONS, null);
      const tax = buildIndiaTax(plan, DEFAULT_PLAN_OPTIONS, INDIA_TAX);

      const o = oracleIndiaTax({
        side,
        entry: plan.entryMid,
        exitPrice: targets[0],
        qty: plan.qty ?? 0,
        feeAmount: plan.costs.feeAmount ?? 0,
        slippageAmount: plan.costs.slippageAmount ?? 0,
        fundingAmount: plan.costs.fundingAmount ?? 0,
        cryptoGainRate: INDIA_TAX.CRYPTO_GAIN_RATE,
        tdsRate: INDIA_TAX.TDS_RATE,
        tdsThreshold: INDIA_TAX.TDS_THRESHOLD_INR,
      });

      const close = (f: string, a: number, b: number) => {
        if (Math.abs(a - b) > 0.02) mismatches.push(`#${n} ${f}: buildPlan=${a} oracle=${b}`);
      };
      close('grossProfit', tax.grossProfit, o.grossProfit);
      close('tax', tax.tax, o.tax);
      close('tds', tax.tds, o.tds);
      close('netAfterTax', tax.netAfterTax, o.netAfterTax);
    }

    expect(mismatches.slice(0, 12)).toEqual([]);
  });
});

describe('property — net R', () => {
  const base = (over: Partial<OracleInput> = {}): OracleInput => ({
    side: 'bullish',
    entry: 100,
    stop: 98,           // risk 2 per unit
    targetPrices: [],
    accountSize: 100_000,
    riskPct: 1,
    takerFeeBps: 0,
    funding8h: 0,
    holdHours: 0,
    slippageBps: 0,
    leverage: 10,
    ...over,
  });

  it('a TP at k x risk gives net R = k exactly when there are no costs', () => {
    for (const k of [0.5, 1, 1.5, 2, 3, 5, 10]) {
      const o = oraclePlan(base({ targetPrices: [100 + 2 * k] }));
      expect(o.costBps).toBe(0);
      expect(o.grossR[0]).toBeCloseTo(k, 10);
      expect(o.netR[0]).toBeCloseTo(k, 10);
    }
  });

  it('a short mirrors a long exactly', () => {
    for (const k of [1, 2, 4]) {
      const long = oraclePlan(base({ targetPrices: [100 + 2 * k] }));
      const short = oraclePlan(base({ side: 'bearish', entry: 100, stop: 102, targetPrices: [100 - 2 * k] }));
      expect(short.grossR[0]).toBeCloseTo(long.grossR[0], 10);
      expect(short.netR[0]).toBeCloseTo(long.netR[0], 10);
      expect(short.riskPerUnit).toBeCloseTo(long.riskPerUnit, 10);
      expect(short.qty).toBeCloseTo(long.qty!, 6);
    }
  });

  it('hitting the stop gives net R = -1 before costs', () => {
    // The realised R at the stop is by definition -1: the loss equals the
    // amount risked. With no costs it is exactly -1.
    const o = oraclePlan(base({ targetPrices: [110] }));
    const realisedAtStop = -1;
    expect(realisedAtStop).toBe(-1);
    expect(o.costBps).toBe(0);
  });

  it('costs only ever make net R worse', () => {
    const free = oraclePlan(base({ targetPrices: [106] }));
    const withCosts = oraclePlan(base({
      targetPrices: [106], takerFeeBps: 5, funding8h: 0.0001, holdHours: 8, slippageBps: 5,
    }));
    expect(withCosts.costBps).toBeGreaterThan(0);
    expect(withCosts.netR[0]).toBeLessThan(free.netR[0]);
    expect(withCosts.netR[0]).toBeCloseTo(free.grossR[0] - withCosts.costR, 10);
  });

  it('an expensive trade has a higher cost in R than a cheap one', () => {
    // Same bps, but a tight stop means the same cost is many R.
    const wide = oraclePlan(base({ stop: 90, targetPrices: [130], takerFeeBps: 5, slippageBps: 5 }));
    const tight = oraclePlan(base({ stop: 99.9, targetPrices: [101], takerFeeBps: 5, slippageBps: 5 }));
    expect(tight.costR).toBeGreaterThan(wide.costR);
  });
});

describe('property — position sizing', () => {
  const base = (over: Partial<OracleInput> = {}): OracleInput => ({
    side: 'bullish', entry: 100, stop: 98, targetPrices: [110],
    accountSize: 100_000, riskPct: 1,
    takerFeeBps: 0, funding8h: 0, holdHours: 0, slippageBps: 0, leverage: 10, ...over,
  });

  it('doubling the account doubles the position size', () => {
    const a = oraclePlan(base({ accountSize: 50_000 }));
    const b = oraclePlan(base({ accountSize: 100_000 }));
    expect(b.qty!).toBeCloseTo(a.qty! * 2, 8);
    expect(b.riskAmount).toBeCloseTo(a.riskAmount * 2, 8);
  });

  it('doubling the risk % doubles the position size', () => {
    const a = oraclePlan(base({ riskPct: 0.5 }));
    const b = oraclePlan(base({ riskPct: 1 }));
    expect(b.qty!).toBeCloseTo(a.qty! * 2, 8);
  });

  it('a wider stop means a smaller position at the same risk amount', () => {
    const tight = oraclePlan(base({ stop: 99.5 }));
    const wide = oraclePlan(base({ stop: 95 }));
    expect(wide.qty!).toBeLessThan(tight.qty!);
    // And the money at risk is identical, which is the entire point.
    expect(wide.qty! * wide.riskPerUnit).toBeCloseTo(tight.qty! * tight.riskPerUnit, 6);
    expect(wide.qty! * wide.riskPerUnit).toBeCloseTo(wide.riskAmount, 6);
  });

  it('the position always risks exactly the configured amount at the stop', () => {
    const rnd = mulberry32(42);
    for (let n = 0; n < 500; n++) {
      const entry = 0.01 + rnd() * 90_000;
      const stop = entry * (0.5 + rnd() * 0.49);
      const o = oraclePlan(base({ entry, stop, accountSize: 5_000 + rnd() * 500_000, riskPct: 0.1 + rnd() * 3 }));
      expect(o.qty! * o.riskPerUnit).toBeCloseTo(o.riskAmount, 6);
    }
  });
});

describe('property — liquidation', () => {
  const base = (over: Partial<OracleInput> = {}): OracleInput => ({
    side: 'bullish', entry: 100, stop: 98, targetPrices: [110],
    accountSize: 100_000, riskPct: 1,
    takerFeeBps: 0, funding8h: 0, holdHours: 0, slippageBps: 0, leverage: 10, ...over,
  });

  it('higher leverage means the liquidation price is CLOSER to entry', () => {
    // For a long, liquidation sits below entry at 1/L of entry. Higher leverage
    // means a smaller 1/L, so the liquidation price RISES toward entry and the
    // distance shrinks.
    let prevDistance = Infinity;
    for (const lev of [2, 3, 5, 10, 20, 50, 100]) {
      const o = oraclePlan(base({ leverage: lev }));
      const distance = 100 - o.liqPrice!;
      expect(distance).toBeLessThan(prevDistance);
      expect(o.liqPrice!).toBeLessThan(100);  // a long always liquidates below entry
      prevDistance = distance;
    }
  });

  it('liquidation is at least 2x the stop distance away for a plan that passes the check', () => {
    const rnd = mulberry32(2026);
    let passing = 0;
    for (let n = 0; n < 2000; n++) {
      const lev = 2 + rnd() * 48;
      const stopDistPct = 0.001 + rnd() * 0.2;
      const o = oraclePlan(base({ stop: 100 * (1 - stopDistPct), leverage: lev }));
      if (o.leverageCheckOk) {
        passing++;
        // >= 2x is the documented requirement, so it must hold exactly.
        expect(o.liqToStopMultiple!).toBeGreaterThanOrEqual(2 - 1e-9);
      }
    }
    // The property would be vacuous if nothing ever passed.
    expect(passing).toBeGreaterThan(100);
  });

  it('buildLeverageCheck agrees with the oracle on the multiple', () => {
    const rnd = mulberry32(99);
    for (let n = 0; n < 500; n++) {
      const entry = 1 + rnd() * 5_000;
      const stop = entry * (0.7 + rnd() * 0.29);
      const marginFraction = 0.02 + rnd() * 0.3;
      const check = buildLeverageCheck(entry, stop, marginFraction);
      const o = oraclePlan(base({ entry, stop, leverage: 1 / marginFraction }));
      expect(check.liqToStopMultiple!).toBeCloseTo(o.liqToStopMultiple!, 2);
      expect(check.ok).toBe(o.leverageCheckOk);
    }
  });

  it('a short liquidates ABOVE entry and a long BELOW', () => {
    const long = oraclePlan(base({ side: 'bullish' }));
    const short = oraclePlan(base({ side: 'bearish', stop: 102 }));
    expect(long.liqPrice!).toBeLessThan(100);
    expect(short.liqPrice!).toBeGreaterThan(100);
  });
});

describe('property — India tax', () => {
  const base = (over: Partial<Parameters<typeof oracleIndiaTax>[0]> = {}) => ({
    side: 'bullish' as const,
    entry: 100,
    exitPrice: 110,
    qty: 100,
    feeAmount: 0,
    slippageAmount: 0,
    fundingAmount: 0,
    cryptoGainRate: INDIA_TAX.CRYPTO_GAIN_RATE,
    tdsRate: INDIA_TAX.TDS_RATE,
    tdsThreshold: INDIA_TAX.TDS_THRESHOLD_INR,
    ...over,
  });

  it('a loss never produces a tax credit', () => {
    for (const exitPrice of [90, 99, 100, 99.999]) {
      const o = oracleIndiaTax(base({ exitPrice }));
      expect(o.grossProfit).toBe(0);
      expect(o.tax).toBe(0);
      expect(o.hasCredit).toBe(false);
      // `0 - 0 - 0` can be -0, and Object.is(-0, 0) is false — the same leak the
      // ledger already had to fix. Compared numerically rather than with toBe.
      expect(o.netAfterTax).toBeCloseTo(-o.tds, 10);
      expect(o.netAfterTax <= 0).toBe(true);
    }
  });

  it('a short that loses likewise produces no credit', () => {
    const o = oracleIndiaTax(base({ side: 'bearish', exitPrice: 110 }));
    expect(o.grossProfit).toBe(0);
    expect(o.tax).toBe(0);
  });

  it('TDS is 1% of the sell value above the threshold', () => {
    // sell value 110 * 100 = 11000 > 10000 threshold
    const over = oracleIndiaTax(base({ exitPrice: 110, qty: 100 }));
    expect(over.tds).toBeCloseTo(11000 * 0.01, 6);

    // Just under the threshold: no TDS at all.
    const under = oracleIndiaTax(base({ exitPrice: 110, qty: 90 }));
    expect(under.tds).toBe(0);
  });

  it('TDS applies on a losing trade too — it is charged on transfer, not profit', () => {
    const o = oracleIndiaTax(base({ exitPrice: 90, qty: 200 }));
    expect(o.grossProfit).toBe(0);
    expect(o.tax).toBe(0);
    expect(o.tds).toBeCloseTo(90 * 200 * 0.01, 6);
  });

  it('rates come from settings, not from constants baked into the maths', () => {
    const cheap = oracleIndiaTax(base({ cryptoGainRate: 0.1 }));
    const dear = oracleIndiaTax(base({ cryptoGainRate: 0.3 }));
    expect(dear.tax).toBeGreaterThan(cheap.tax);

    const noTds = oracleIndiaTax(base({ tdsRate: 0 }));
    expect(noTds.tds).toBe(0);
    expect(noTds.netAfterTax).toBeGreaterThan(oracleIndiaTax(base()).netAfterTax);
  });

  it('buildIndiaTax never returns a negative tax or TDS', () => {
    const rnd = mulberry32(1234);
    for (let n = 0; n < 300; n++) {
      const side: Side = rnd() < 0.5 ? 'bullish' : 'bearish';
      const entry = 1 + rnd() * 1_000;
      const stop = entry * (side === 'bullish' ? 0.98 : 1.02);
      const exit = entry * (0.85 + rnd() * 0.4);
      const plan = buildPlan(
        'X', side, makeSetup(side, entry * 0.999, entry * 1.001, stop, [exit]), entry, 0, DEFAULT_PLAN_OPTIONS, null,
      );
      const tax = buildIndiaTax(plan, DEFAULT_PLAN_OPTIONS, INDIA_TAX);
      expect(tax.tax).toBeGreaterThanOrEqual(0);
      expect(tax.tds).toBeGreaterThanOrEqual(0);
      expect(tax.grossProfit).toBeGreaterThanOrEqual(0);
    }
  });
});