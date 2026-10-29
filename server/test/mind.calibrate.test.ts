import { describe, it, expect } from 'vitest';
import {
  brierScore,
  brierBaseRate,
  brierDecomposition,
  buildCalibrationReport,
  calibrationFootnote,
  honestRMultiple,
  reliabilityDiagram,
  isWin,
  WINS,
} from '../src/engine/mind/index.js';
import { LEDGER, MIND } from '../src/config.js';
import type { LedgerSignal, Outcome, TradePlan, Grade } from '../../shared/types';

const NOW = 1_700_000_000_000;

function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: 'BTCUSDT',
    side: 'bullish',
    entryLow: 99,
    entryHigh: 101,
    entryMid: 100,
    stop: 97.5,
    targets: [
      { label: 'R1', price: 102.5, rr: 1, netR: 0 },
      { label: 'R2', price: 105, rr: 2, netR: 0 },
      { label: 'R3', price: 107.5, rr: 3, netR: 0 },
    ],
    rr: 3,
    noRoom: false,
    riskPerUnit: 2.5,
    qty: null,
    riskAmount: null,
    rewardAmount: null,
    costs: { feeBps: 5, feeAmount: 0, fundingBps: 0, fundingAmount: 0, slippageBps: 5, slippageAmount: 0, totalBps: 10 },
    netR: null,
    ...over,
  };
}

/**
 * A resolved signal carrying a Mind probability.
 *
 * Note `plan.rr = 3` (the FURTHEST target) while the realised target is TP1 at
 * 1R. That mismatch is deliberate: it is exactly the inflation M3.2 describes,
 * and it is what `honestRMultiple` exists to correct.
 */
function signal(over: {
  outcome: Outcome;
  probability: number;
  grade?: Grade;
  targets?: number[];
  priceAtResolve?: number | null;
  entryZoneLow?: number;
  entryZoneHigh?: number;
  stop?: number;
} ): LedgerSignal {
  const riskPerUnit = over.stop !== undefined ? Math.abs(over.entryZoneHigh! - over.stop) : 2.5;
  return {
    id: `${over.outcome}-${over.probability}`,
    symbol: 'BTCUSDT',
    side: 'bullish',
    grade: over.grade ?? 'B',
    score: 60,
    createdAt: NOW - 3600_000,
    entryZoneLow: over.entryZoneLow ?? 99,
    entryZoneHigh: over.entryZoneHigh ?? 101,
    stop: over.stop ?? 97.5,
    // The frozen per-unit risk. M3.2 reads the R from this and the frozen
    // levels, so the ledger's R cannot depend on a nested optional object.
    riskPerUnit,
    targets: over.targets ?? [102.5, 105, 107.5],
    snapshot: {
      score: 60,
      grade: over.grade ?? 'B',
      side: 'bullish',
      components: {},
      checklist: [],
      regime: 'range',
      setup: null,
      plan: plan({ riskPerUnit, targets: over.targets?.map((p, i) => ({ label: `R${i + 1}`, price: p, rr: 1, netR: 0 })) }),
      deriv: null,
      sector: 'x',
      breadth: 'two-way',
      vwap: 100,
      newsNis: 0,
      newsDirection: 0,
      vetoes: [],
      mind: {
        probability: over.probability,
        netExpectedR: 1,
        regime: 'range',
        confidenceBand: 'medium',
        drivers: [],
        vetoCodes: [],
        rank: 0.1,
        features: {
          symbol: 'BTCUSDT',
          asOf: NOW,
          side: 'bullish',
          structure: {} as never,
          positioning: {} as never,
          catalyst: {} as never,
          regime: {} as never,
          context: {} as never,
          regimeLabel: 'range',
        },
      },
    },
    outcome: over.outcome,
    resolvedAt: NOW,
    mfeR: 1.2,
    maeR: -0.3,
    priceAtResolve: over.priceAtResolve ?? null,
    shadow: false,
    vetoReason: null,
    rule: 'PICK',
  } as LedgerSignal;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('outcome classification', () => {
  it('the three target outcomes count as wins, stop does not', () => {
    expect(isWin('TP1')).toBe(true);
    expect(isWin('TP2')).toBe(true);
    expect(isWin('TP3')).toBe(true);
    expect(isWin('STOP')).toBe(false);
    expect(isWin('EXPIRED')).toBe(false);
    expect(isWin('OPEN')).toBe(false);
    expect(WINS.has('TP1')).toBe(true);
  });
});

describe('Brier score', () => {
  it('a perfect forecaster scores 0', () => {
    expect(brierScore([{ p: 1, y: 1 }, { p: 0, y: 0 }])).toBe(0);
  });

  it('a forecaster that is always exactly wrong scores 1', () => {
    expect(brierScore([{ p: 0, y: 1 }, { p: 1, y: 0 }])).toBe(1);
  });

  it('a constant 0.5 scores 0.25 regardless of the outcome mix', () => {
    expect(brierScore([{ p: 0.5, y: 1 }])).toBe(0.25);
    expect(brierScore([{ p: 0.5, y: 0 }])).toBe(0.25);
  });

  it('returns null with nothing to score, never 0', () => {
    // 0 would mean "perfectly calibrated", which is the opposite of "no data".
    expect(brierScore([])).toBeNull();
  });

  it('ignores non-finite probabilities rather than propagating NaN', () => {
    expect(brierScore([{ p: NaN, y: 1 }, { p: 0, y: 0 }])).toBe(0);
  });
});

describe('the base-rate bar', () => {
  it('a constant equal to the observed rate is the score to beat', () => {
    const pairs = [
      ...Array.from({ length: 60 }, () => ({ p: 0.6, y: 1 as const })),
      ...Array.from({ length: 40 }, () => ({ p: 0.6, y: 0 as const })),
    ];
    // 60% of 100 won, so a constant 0.6 forecaster scores (0.4)² and (0.6)².
    const base = brierBaseRate(pairs)!;
    expect(base).toBeCloseTo(0.24, 3);
  });

  it('is null with no decided outcomes', () => {
    expect(brierBaseRate([])).toBeNull();
  });

  it('a perfectly calibrated model ties the bar; an overconfident one loses to it', () => {
    // Honest 0.6 forecasts on a 60/40 outcome set.
    const honest = Array.from({ length: 100 }, (_, i) => ({ p: 0.6, y: (i < 60 ? 1 : 0) as 0 | 1 }));
    expect(brierScore(honest)).toBeCloseTo(brierBaseRate(honest)!, 6);

    // Overconfident: says 0.95 on everything.
    const cocky = honest.map((x) => ({ p: 0.95, y: x.y }));
    expect(brierScore(cocky)!).toBeGreaterThan(brierBaseRate(cocky)!);
  });
});

describe('Brier decomposition', () => {
  /**
   * These three tests CORRECT a claim that was wrong in the implementation, in
   * the type, and in the test names. The old code asserted
   * `brier = reliability + outcomeVariance` and explained the textbook form as
   * broken. The textbook form (Murphy 1972/1973) is
   *
   *   brier = reliability − RESOLUTION + uncertainty
   *
   * and it is exact when the conditioning set is the set of distinct forecast
   * values. What actually broke it here was BINNING for the reliability diagram
   * — the within-bin terms of Stephenson, Coelho & Jolliffe (2008). So the
   * decomposition is now standard, and the binning loss is reported as a
   * measured `residual` rather than hidden inside a tolerance.
   */
  it('reliability − resolution + uncertainty reconstructs the score, up to the reported residual', () => {
    const pairs = Array.from({ length: 200 }, (_, i) => ({ p: 0.5 + (i % 5) * 0.05, y: (i % 3 === 0 ? 1 : 0) as 0 | 1 }));
    const b = brierScore(pairs)!;
    const d = brierDecomposition(pairs)!;
    const sum = d.reliability - d.resolution + d.uncertainty;
    // The shortfall IS the residual, exactly. That is the whole point of
    // reporting it: the reader can see the binning cost rather than infer it.
    expect(d.residual).toBeCloseTo(sum - b, 4);
    expect(Math.abs(d.residual)).toBeLessThan(0.005);
  });

  it('the identity is exact when every bucket holds one distinct probability', () => {
    // Five probabilities, each isolated in its own 0.2-wide bucket, so no bucket
    // has any within-bucket spread. This is Murphy's exact case, and it pins the
    // ALGEBRA rather than tolerating it.
    const pairs: Array<{ p: number; y: 0 | 1 }> = [];
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (let i = 0; i < 60; i++) pairs.push({ p, y: (i % 3 === 0 ? 1 : 0) as 0 | 1 });
    }
    const d = brierDecomposition(pairs, 5)!;
    expect(Math.abs(d.residual)).toBeLessThan(1e-3);
    expect(d.reliability - d.resolution + d.uncertainty).toBeCloseTo(brierScore(pairs)!, 3);

    // Put all five into ONE bucket and the within-bucket spread appears as a
    // residual. Same data, same score, different conditioning — which is exactly
    // why the residual has to be reported instead of assumed away.
    const coarse = brierDecomposition(pairs, 1)!;
    expect(Math.abs(coarse.residual)).toBeGreaterThan(1e-4);
  });

  it('the residual shrinks as bins get finer', () => {
    const pairs = Array.from({ length: 200 }, (_, i) => ({ p: 0.5 + (i % 5) * 0.05, y: (i % 3 === 0 ? 1 : 0) as 0 | 1 }));
    const coarse = Math.abs(brierDecomposition(pairs, 4)!.residual);
    const medium = Math.abs(brierDecomposition(pairs, 10)!.residual);
    const fine = Math.abs(brierDecomposition(pairs, 100)!.residual);
    expect(coarse).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(fine);
  });

  it('the two degenerate anchors satisfy the identity exactly', () => {
    // Perfect forecasts: reliability 0, resolution 0.
    const perfect = [{ p: 1, y: 1 as const }, { p: 0, y: 0 as const }];
    const pd = brierDecomposition(perfect)!;
    expect(pd.reliability - pd.resolution + pd.uncertainty).toBeCloseTo(brierScore(perfect)!, 6);
    expect(pd.reliability).toBe(0);
    expect(pd.residual).toBeCloseTo(0, 6);

    // A constant 0.5 on a balanced set: zero reliability, zero resolution.
    const constant = Array.from({ length: 100 }, (_, i) => ({ p: 0.5, y: (i < 50 ? 1 : 0) as 0 | 1 }));
    const cd = brierDecomposition(constant)!;
    expect(cd.reliability - cd.resolution + cd.uncertainty).toBeCloseTo(brierScore(constant)!, 6);
    expect(cd.resolution).toBe(0);
    // A constant forecast is the climatology, so it has exactly zero skill.
    expect(cd.brierSkill).toBeCloseTo(0, 6);
  });

  it('brier skill is zero for the base rate and positive for a calibrated forecaster', () => {
    // Five probability levels, each realised at exactly its own rate. That is
    // calibration by construction, so the only thing left to earn skill is
    // resolution.
    const levels = [0.3, 0.4, 0.5, 0.6, 0.7];
    const per = 400;
    const pairs: Array<{ p: number; y: 0 | 1 }> = [];
    for (const p of levels) {
      const wins = Math.round(p * per);
      for (let i = 0; i < per; i++) pairs.push({ p, y: (i < wins ? 1 : 0) as 0 | 1 });
    }
    const gd = brierDecomposition(pairs)!;
    expect(gd.reliability).toBeCloseTo(0, 6);
    expect(gd.resolution).toBeGreaterThan(0);
    expect(gd.brierSkill).toBeGreaterThan(0);
    // The forecaster spreads; a constant one does not, and earns nothing.
    const flat = Array.from({ length: 1000 }, (_, i) => ({ p: 0.5, y: (i < 500 ? 1 : 0) as 0 | 1 }));
    expect(brierDecomposition(flat)!.brierSkill).toBeCloseTo(0, 6);
    expect(brierDecomposition(flat)!.resolution).toBeCloseTo(0, 6);
  });

  it('resolution is reported and it SUBTRACTS', () => {
    // Outcomes must actually VARY across probability buckets for resolution to
    // exist. A fixture where every bucket realises the same rate has zero
    // resolution, and pretending otherwise would test nothing.
    const sigs = Array.from({ length: 200 }, (_, i) => ({
      p: i % 10 < 6 ? 0.9 : 0.3,
      y: (i % 10 < 6 ? 1 : 0) as 0 | 1,
    }));
    const d = brierDecomposition(sigs)!;
    expect(d.resolution).toBeGreaterThan(0);
    expect(d.uncertainty).toBeGreaterThan(0);
    // Adding resolution instead of subtracting it overshoots the score by 2*RES.
    const minus = d.reliability - d.resolution + d.uncertainty;
    const plus = d.reliability + d.resolution + d.uncertainty;
    expect(plus - minus).toBeCloseTo(2 * d.resolution, 3);
    expect(plus).toBeGreaterThan(minus);
  });

  it('resolution is ZERO when every bucket realises the same rate', () => {
    // The counterfactual that makes the previous test meaningful: identical
    // outcome rates in every bucket means the forecast separated nothing, no
    // matter how confident it sounded.
    const pairs = Array.from({ length: 200 }, (_, i) => ({
      p: 0.5 + (i % 5) * 0.05,
      y: (i % 3 === 0 ? 1 : 0) as 0 | 1,
    }));
    expect(brierDecomposition(pairs)!.resolution).toBe(0);
  });

  it('resolution and forecast spread are different quantities', () => {
    // The old implementation reported `mean((p − base)²)` under the name
    // "resolution". That is forecast SPREAD — what we said, not what happened.
    // Murphy's resolution is built from realised rates. A forecaster can have
    // large spread and zero resolution, so conflating them hides the failure.
    const levels = [0.3, 0.4, 0.5, 0.6, 0.7];
    const per = 400;
    const pairs: Array<{ p: number; y: 0 | 1 }> = [];
    for (const p of levels) {
      for (let i = 0; i < per; i++) pairs.push({ p, y: 0 as 0 | 1 });
    }
    const d = brierDecomposition(pairs)!;
    // Outcomes never happen, so nothing is discriminated...
    expect(d.resolution).toBe(0);
    // ...but the forecasts still spread widely.
    expect(d.forecastSpread).toBeGreaterThan(0.01);
    expect(d.brierSkill).toBeLessThanOrEqual(0);
  });

  it('a constant forecaster has zero resolution', () => {
    const pairs = Array.from({ length: 100 }, (_, i) => ({ p: 0.5, y: (i < 50 ? 1 : 0) as 0 | 1 }));
    expect(brierDecomposition(pairs)!.resolution).toBe(0);
  });

  it('uncertainty is the base rate variance', () => {
    const pairs = [
      ...Array.from({ length: 50 }, () => ({ p: 0.7, y: 1 as const })),
      ...Array.from({ length: 50 }, () => ({ p: 0.7, y: 0 as const })),
    ];
    expect(brierDecomposition(pairs)!.uncertainty).toBeCloseTo(0.25, 3);
  });

  it('is null with no pairs', () => {
    expect(brierDecomposition([])).toBeNull();
  });
});

describe('reliability diagram', () => {
  it('is empty-safe and always returns the full bucket count', () => {
    const d = reliabilityDiagram([]);
    expect(d).toHaveLength(MIND.CALIBRATION_BUCKETS);
    expect(d.every((b) => b.n === 0)).toBe(true);
  });

  it('suppresses the realised rate below the sample floor', () => {
    // 3 observations in one bucket: a rate, but not a trustworthy one.
    const pairs = Array.from({ length: 3 }, () => ({ p: 0.85, y: 1 as const }));
    const bucket = reliabilityDiagram(pairs).find((b) => b.lo === 0.8)!;
    expect(bucket.n).toBe(3);
    expect(bucket.realised).toBeNull();
    expect(bucket.meanPredicted).toBeCloseTo(0.85, 3);
  });

  it('reports a realised rate once the bucket clears the floor', () => {
    const n = LEDGER.MIN_SAMPLE_FOR_RATE + 5;
    const pairs = Array.from({ length: n }, (_, i) => ({ p: 0.85, y: (i < 20 ? 1 : 0) as 0 | 1 }));
    const bucket = reliabilityDiagram(pairs).find((b) => b.lo === 0.8)!;
    expect(bucket.realised).toBeCloseTo(20 / n, 3);
  });

  it('puts a probability of exactly 1 in the last bucket, not out of range', () => {
    const pairs = Array.from({ length: 40 }, () => ({ p: 1, y: 1 as const }));
    const d = reliabilityDiagram(pairs);
    expect(d[d.length - 1].n).toBe(40);
    expect(d.slice(0, -1).every((b) => b.n === 0)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('honest R — the M3.2 correction', () => {
  it('a stop is exactly -1', () => {
    expect(honestRMultiple(signal({ outcome: 'STOP', probability: 0.6 }))).toBe(-1);
  });

  it('TP1 credits 1R even when the plan quotes the furthest target as 3R', () => {
    // This is the whole point: the plan's rr is 3, the realised outcome is TP1.
    const r = honestRMultiple(signal({ outcome: 'TP1', probability: 0.6 }))!;
    expect(r).toBeCloseTo(1, 2);
    expect(r).not.toBe(3);
  });

  it('TP2 credits the middle target and TP3 the furthest', () => {
    const tp2 = honestRMultiple(signal({ outcome: 'TP2', probability: 0.6 }))!;
    const tp3 = honestRMultiple(signal({ outcome: 'TP3', probability: 0.6 }))!;
    expect(tp2).toBeGreaterThan(1);
    expect(tp3).toBeGreaterThan(tp2);
  });

  it('an expiry is marked to the resolving close', () => {
    const r = honestRMultiple(
      signal({ outcome: 'EXPIRED', probability: 0.6, priceAtResolve: 100 }),
    )!;
    // Entry mid 100, no move, so flat.
    expect(Math.abs(r)).toBeLessThan(0.01);
  });

  it('returns null while a signal is still open', () => {
    expect(honestRMultiple(signal({ outcome: 'OPEN', probability: 0.6 }))).toBeNull();
  });

  it('returns null rather than guessing when risk is unmeasurable', () => {
    const s = signal({ outcome: 'TP1', probability: 0.6 });
    s.snapshot.plan = null;
    s.riskPerUnit = 0;
    s.entryZoneLow = 100;
    s.entryZoneHigh = 100;
    s.stop = 100;
    expect(honestRMultiple(s)).toBeNull();
  });

  it('a bearish signal has the R sign flipped', () => {
    const s = signal({ outcome: 'STOP', probability: 0.6 });
    s.side = 'bearish';
    expect(honestRMultiple(s)).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the calibration report', () => {
  /** A set large enough that the report is not suppressed. */
  function population(n: number, winEvery: number, probability: number): LedgerSignal[] {
    return Array.from({ length: n }, (_, i) =>
      signal({ outcome: i % winEvery === 0 ? 'TP1' : 'STOP', probability }),
    );
  }

  it('suppresses every claim below the sample floor and says why', () => {
    const r = buildCalibrationReport(population(10, 2, 0.6), NOW);
    expect(r.suppressed).toBe(true);
    expect(r.brier).toBeNull();
    expect(r.decomposition).toBeNull();
    expect(r.suppressReason).toMatch(/resolved signals/);
  });

  it('excludes signals frozen before the Mind layer existed, rather than assuming 50%', () => {
    const legacy = population(MIND.CALIBRATION_MIN_SAMPLES + 20, 2, 0.5);
    for (const s of legacy) delete s.snapshot.mind;
    const r = buildCalibrationReport(legacy, NOW);
    expect(r.n).toBe(0);
    expect(r.suppressed).toBe(true);
  });

  it('a perfectly-calibrated model with no resolution does NOT claim to beat the bar', () => {
    // 60% of signals win; the model says 0.6 on every one. That is perfectly
    // calibrated and completely uninformative: its Brier equals the
    // base-rate constant's exactly. `beatsBaseRate` must stay false.
    //
    // The first draft of this test asserted the opposite ("well calibrated ⇒
    // beats the bar"). That is wrong, and the fix matters: a model that merely
    // echoes the base rate has learned nothing, and saying it "beats chance"
    // would be the exact overclaim this layer exists to avoid.
    const n = MIND.CALIBRATION_MIN_SAMPLES + 40;
    const sigs = Array.from({ length: n }, (_, i) =>
      signal({ outcome: i % 10 < 6 ? 'TP1' : 'STOP', probability: 0.6 }),
    );
    const r = buildCalibrationReport(sigs, NOW);
    expect(r.suppressed).toBe(false);
    expect(r.baseRate).toBeCloseTo(0.6, 2);
    expect(r.brier).toBeCloseTo(r.brierBaseRate!, 3);
    expect(r.brierDelta).toBe(0);
    expect(r.beatsBaseRate).toBe(false);
  });

  it('a calibrated model WITH resolution does beat the bar', () => {
    // Same 60/40 outcome mix, but the model separates: 0.9 on the winners and
    // 0.3 on the losers. That is both calibrated and resolving, so it must beat
    // the constant-forecast bar by a meaningful margin.
    const n = MIND.CALIBRATION_MIN_SAMPLES + 40;
    const sigs = Array.from({ length: n }, (_, i) =>
      signal({
        outcome: i % 10 < 6 ? 'TP1' : 'STOP',
        probability: i % 10 < 6 ? 0.9 : 0.3,
      }),
    );
const r = buildCalibrationReport(sigs, NOW);
    expect(r.brierDelta!).toBeGreaterThan(0.01);
    expect(r.beatsBaseRate).toBe(true);
    // Murphy resolution: realised rates sit at 1.0 (p=0.9 bucket) and 0.0 (p=0.3
    // bucket) against a 0.6 base rate, so
    //   0.6*(1.0-0.6)^2 + 0.4*(0.0-0.6)^2 = 0.096 + 0.144 = 0.24.
    expect(r.decomposition!.resolution).toBeCloseTo(0.24, 2);
    // Forecast spread is a DIFFERENT number and is reported separately:
    //   0.6*(0.9-0.6)^2 + 0.4*(0.3-0.6)^2 = 0.054 + 0.036 = 0.09.
    // The old code returned 0.09 from a field called "resolution"; it was spread.
    expect(r.decomposition!.forecastSpread).toBeCloseTo(0.09, 2);
    // Predicting 0.9 where the realised rate is 1.0 is mild overconfidence, and
    // reliability says so rather than hiding it.
    expect(r.decomposition!.reliability).toBeGreaterThan(0);
    expect(r.decomposition!.reliability).toBeLessThan(r.decomposition!.resolution);
  });

  it('a coin-flip model on a 60/40 market does NOT beat the bar', () => {
    const n = MIND.CALIBRATION_MIN_SAMPLES + 40;
    const sigs = Array.from({ length: n }, (_, i) =>
      signal({ outcome: i % 10 < 6 ? 'TP1' : 'STOP', probability: 0.5 }),
    );
    const r = buildCalibrationReport(sigs, NOW);
    expect(r.brier!).toBeGreaterThan(r.brierBaseRate!);
    expect(r.beatsBaseRate).toBe(false);
  });

  it('an overconfident model is penalised for it', () => {
    const n = MIND.CALIBRATION_MIN_SAMPLES + 40;
    const sigs = Array.from({ length: n }, (_, i) =>
      signal({ outcome: i % 10 < 6 ? 'TP1' : 'STOP', probability: 0.95 }),
    );
    const r = buildCalibrationReport(sigs, NOW);
    expect(r.brierDelta!).toBeLessThan(0);
    expect(r.beatsBaseRate).toBe(false);
  });

  it('records the refit date, or null while the shipped weights are in use', () => {
    const sigs = population(MIND.CALIBRATION_MIN_SAMPLES + 5, 2, 0.6);
    expect(buildCalibrationReport(sigs, NOW).lastRefitAt).toBeNull();
    expect(buildCalibrationReport(sigs, NOW, NOW - 86_400_000).lastRefitAt).toBe(NOW - 86_400_000);
  });

  it('suppresses a grade win rate below the sample floor', () => {
    // 3 grade-A signals is not a grade-A win rate.
    const sigs = [
      ...Array.from({ length: 3 }, () =>
        signal({ outcome: 'TP1', probability: 0.6, grade: 'A' }),
      ),
      ...population(MIND.CALIBRATION_MIN_SAMPLES, 2, 0.6),
    ];
    const r = buildCalibrationReport(sigs, NOW);
    const a = r.byGrade.find((g) => g.grade === 'A')!;
    expect(a.n).toBe(3);
    expect(a.winRate).toBeNull();
  });

  it('uses honest R in the per-grade average, not the inflated plan rr', () => {
    const sigs = Array.from({ length: LEDGER.MIN_SAMPLE_FOR_RATE + 5 }, () =>
      signal({ outcome: 'TP1', probability: 0.6 }),
    );
    const r = buildCalibrationReport(sigs, NOW);
    const b = r.byGrade.find((g) => g.grade === 'B')!;
    // Every win is a TP1 at 1R, so the honest average is 1 — not the plan's 3.
    expect(b.avgR).toBeCloseTo(1, 1);
  });

  it('always reports the base rate it used, whatever the sample size', () => {
    const r = buildCalibrationReport(population(10, 2, 0.6), NOW);
    expect(r.baseRate).toBeCloseTo(0.5, 2);
  });
});

describe('calibration footnote', () => {
  it('states what we said and what we got', () => {
    const n = MIND.CALIBRATION_MIN_SAMPLES + 40;
    const sigs = Array.from({ length: n }, (_, i) =>
      signal({ outcome: i % 10 < 6 ? 'TP1' : 'STOP', probability: 0.6 }),
    );
    const r = buildCalibrationReport(sigs, NOW);
    const note = calibrationFootnote(r, 'B', 0.62)!;
    expect(note).toMatch(/Grade B/);
    expect(note).toMatch(/said 60%/);
    expect(note).toMatch(/realised 60%/);
    expect(note).toMatch(/reads 62%/);
  });

  it('is null rather than a number when the sample is too small', () => {
    const sigs = Array.from({ length: 3 }, () =>
      signal({ outcome: 'TP1', probability: 0.6, grade: 'A' }),
    );
    const r = buildCalibrationReport(sigs, NOW);
    expect(calibrationFootnote(r, 'A', 0.6)).toBeNull();
  });

  it('never presents a binary signal — the probability is always a rate', () => {
    const n = MIND.CALIBRATION_MIN_SAMPLES + 40;
    const sigs = Array.from({ length: n }, (_, i) =>
      signal({ outcome: i % 10 < 6 ? 'TP1' : 'STOP', probability: 0.6 }),
    );
    const note = calibrationFootnote(r0(sigs), 'B', 0.6)!;
    expect(note).not.toMatch(/95%/);
    expect(note).toMatch(/%/);
  });
});

function r0(sigs: LedgerSignal[]) {
  return buildCalibrationReport(sigs, NOW);
}