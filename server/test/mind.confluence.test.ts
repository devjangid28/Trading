import { describe, it, expect } from 'vitest';
import {
  logistic,
  logit,
  resolveBaseRate,
  scoreCandidate,
  hardVetoes,
  expectedR,
  kellyRank,
  type BaseRate,
} from '../src/engine/mind/index.js';
import { buildFeatureVector, measured, absent } from '../src/engine/mind/index.js';
import { CONVICTION, MIND } from '../src/config.js';
import type {
  Candle,
  FeatureVector,
  Setup,
  TradePlan,
  TradeCosts,
  MindRegime,
} from '../../shared/types';

const FIVE_MIN = 5 * 60_000;

function series(count: number, base: number): Candle[] {
  return Array.from({ length: count }, (_, n) => {
    const o = 100 + n;
    return {
      t: base + n * FIVE_MIN,
      o,
      h: o + 2,
      l: o - 2,
      c: o + 1,
      v: 1000,
      qv: 1000 * o,
      closed: true,
    };
  });
}

const BASE = 1_700_000_000_000;
const AS_OF = BASE + 60 * FIVE_MIN;

function setup(over: Partial<Setup> = {}): Setup {
  return {
    side: 'bullish',
    obTime: BASE,
    obHigh: 100,
    obLow: 98,
    z: 99,
    invalidation: 97.5,
    targets: [{ price: 104, label: 'R1', kind: 'liquidity', time: 0 }],
    context: [],
    rr: 2,
    displacement: 1.2,
    fvg: true,
    violated: false,
    ageMinutes: 30,
    previous: [],
    retest: 'approaching',
    distanceAtr: 0.8,
    htf: { aligned: true, conflict: false, trend1h: 'up', trend4h: 'up', setups: [], scoreAdj: 0 },
    ...over,
  };
}

const COSTS: TradeCosts = {
  feeBps: 5,
  feeAmount: 0,
  fundingBps: 0,
  fundingAmount: 0,
  slippageBps: 5,
  slippageAmount: 0,
  totalBps: 10,
};

function plan(over: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: 'BTCUSDT',
    side: 'bullish',
    entryLow: 99,
    entryHigh: 101,
    entryMid: 100,
    stop: 97.5,
    targets: [{ label: 'R1', price: 105, rr: 2, netR: 0 }],
    rr: 2,
    noRoom: false,
    riskPerUnit: 2.5,
    qty: null,
    riskAmount: null,
    rewardAmount: null,
    costs: COSTS,
    netR: null,
    ...over,
  };
}

/** A vector with everything measured and aligned, so tests isolate one variable. */
function goodVector(over: Partial<FeatureVector> = {}): FeatureVector {
  const base = buildFeatureVector({
    symbol: 'BTCUSDT',
    side: 'bullish',
    asOf: AS_OF,
    candles: series(60, BASE),
    setup: setup(),
    strength: 70,
    macroBlackoutMin: 600,
  });
  return {
    ...base,
    ...over,
    structure: {
      ...base.structure,
      htf15m: measured(1, 0),
      htf1h: measured(1, 0),
      htf4h: measured(1, 0),
      strength: measured(70, AS_OF),
      choppiness: measured(0.3, AS_OF),
      displacementX: measured(2, AS_OF),
      ...over.structure,
    },
    positioning: {
      ...base.positioning,
      cvdSlope: measured(1, 0),
      crowdedAgainst: measured(0, 0),
      fundingZ: measured(-0.5, 0),
      ...over.positioning,
    },
    catalyst: {
      ...base.catalyst,
      newsDirection: 1,
      routineDominates: measured(0, AS_OF),
      maxNis4h: measured(60, AS_OF),
      reversalRisk: measured(0.1, AS_OF),
      ...over.catalyst,
    },
    regime: { ...base.regime, breadthRatio: measured(0.7, AS_OF), ...over.regime },
    context: {
      ...base.context,
      convictionMissingFrac: measured(0, AS_OF),
      eventRisk: measured(0.03, AS_OF),
      ...over.context,
    },
  };
}

const LEDGER_RATE: BaseRate = { rate: 0.5347, samples: 505, source: 'ledger' };

/**
 * A vector where every group scores zero, so the logistic's only input is the
 * anchor. Built field-by-field rather than by overriding a good vector, because
 * the first attempt at this overrode `catalyst`/`structure`/`context` and left
 * `positioning.cvdSlope` and `regime.breadthRatio` pushing — which is how a test
 * meant to prove "no push" ended up proving a 0.08 push.
 */
function neutralVector(): FeatureVector {
  const v = goodVector();
  return {
    ...v,
    regime: 'quiet' as never, // overwritten below; kept out of the type union
    structure: {
      hasSetup: measured(0, AS_OF),
      obAgeMin: absent(),
      displacementX: absent(),
      hasFvg: absent(),
      fvgInsideHtfOb: absent(),
      htf15m: absent(),
      htf1h: absent(),
      htf4h: absent(),
      liqPoolDistFrac: absent(),
      vwapDistFrac: absent(),
      choppiness: absent(),
      retest: 'none',
      strength: measured(50, AS_OF),
    },
    positioning: {
      fundingZ: absent(),
      oiChange1h: absent(),
      oiChange4h: absent(),
      oiChange24h: absent(),
      longShortRatio: absent(),
      cvdSlope: absent(),
      liqClusterDistFrac: absent(),
      basisPct: absent(),
      crowdedAgainst: absent(),
    },
    catalyst: {
      maxNis4h: absent(),
      attributionCoveragePct: absent(),
      routineDominates: absent(),
      reversalRisk: absent(),
      newsDirection: null,
    },
    regime: { ...v.regime, breadthRatio: absent(), sectorRelativeStrength: absent() },
    context: {
      hourUtc: absent(),
      session: null,
      atrPercentile: absent(),
      eventRisk: measured(0.01, AS_OF),
      convictionMissingFrac: measured(0, AS_OF),
    },
  } as FeatureVector;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('logistic and logit', () => {
  it('round-trips', () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(logistic(logit(p))).toBeCloseTo(p, 6);
    }
  });

  it('is finite at the extremes rather than Infinity', () => {
    expect(Number.isFinite(logistic(1000))).toBe(true);
    expect(Number.isFinite(logistic(-1000))).toBe(true);
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
  });

  it('logistic(0) is exactly a half', () => {
    expect(logistic(0)).toBe(0.5);
  });
});

describe('base-rate anchoring — the load-bearing decision', () => {
  it('with no feature push at all, the probability IS the base rate', () => {
    const out = scoreCandidate({
      features: neutralVector(),
      regime: 'quiet',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'n',
    });
    expect(out.probability).toBeCloseTo(LEDGER_RATE.rate, 2);
  });

  it('the anchor is not 50% — it is the ledger rate', () => {
    const out = scoreCandidate({
      features: neutralVector(),
      regime: 'quiet',
      plan: plan(),
      base: { rate: 0.7, samples: 900, source: 'ledger' },
      id: 'n2',
    });
    expect(out.probability).not.toBeCloseTo(0.5, 1);
    expect(out.probability).toBeCloseTo(0.7, 2);
  });

  it('resolveBaseRate trusts the ledger above the sample floor', () => {
    const b = resolveBaseRate(0.5347, 505);
    expect(b.source).toBe('ledger');
    expect(b.rate).toBe(0.5347);
  });

  it('resolveBaseRate blends toward the prior below the floor', () => {
    const b = resolveBaseRate(0.9, 5);
    expect(b.source).toBe('prior');
    expect(b.rate).toBeGreaterThan(0.5);
    expect(b.rate).toBeLessThan(0.9);
  });

  it('resolveBaseRate falls back to the prior when nothing was observed', () => {
    const b = resolveBaseRate(null, 0);
    expect(b.source).toBe('prior');
    expect(b.rate).toBe(0.5);
  });

  it('never returns a rate outside (0,1) even for nonsense input', () => {
    expect(resolveBaseRate(1.5, 1000).rate).toBeLessThan(1);
    expect(resolveBaseRate(-0.5, 1000).rate).toBeGreaterThan(0);
  });
});

describe('aligned features push above the base rate, opposed push below', () => {
  it('a fully aligned setup scores above the base rate', () => {
    const out = scoreCandidate({
      features: goodVector(),
      regime: 'trending-bull',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'a',
    });
    expect(out.probability).toBeGreaterThan(LEDGER_RATE.rate);
  });

  it('opposed features score below the base rate', () => {
    const opposed = goodVector({
      side: 'bullish',
      structure: {
        retest: 'violated',
        htf15m: measured(-1, 0),
        htf1h: measured(-1, 0),
        htf4h: measured(-1, 0),
        strength: measured(60, AS_OF),
        vwapDistFrac: measured(-0.05, 0),
      } as Partial<FeatureVector['structure']>,
      catalyst: {
        newsDirection: -1,
        routineDominates: absent(),
        maxNis4h: absent(),
        reversalRisk: absent(),
      } as Partial<FeatureVector['catalyst']>,
    });
    const out = scoreCandidate({
      features: opposed,
      regime: 'trending-bear',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'b',
    });
    expect(out.probability).toBeLessThan(LEDGER_RATE.rate);
  });

  it('never leaves the unit interval', () => {
    for (const regime of ['trending-bull', 'trending-bear', 'high-vol-cascade', 'quiet', 'range'] as MindRegime[]) {
      const out = scoreCandidate({
        features: goodVector(),
        regime,
        plan: plan(),
        base: LEDGER_RATE,
        id: 'c',
      });
      expect(out.probability).toBeGreaterThanOrEqual(0);
      expect(out.probability).toBeLessThanOrEqual(1);
    }
  });

  it('reuses the conviction weights rather than inventing its own', () => {
    const out = scoreCandidate({
      features: goodVector(),
      regime: 'trending-bull',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'd',
    });
    expect(Object.keys(out.groupScores).sort()).toEqual(
      ['macroRegime', 'newsEvents', 'orderFlow', 'positioning', 'structure', 'tradability'].sort(),
    );
    expect(CONVICTION.WEIGHTS.structure).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('hard vetoes force NO TRADE, not a penalty', () => {
  it('a veto zeroes the probability outright', () => {
    const v = goodVector({
      regime: { ...goodVector().regime, macroBlackoutMin: measured(5, AS_OF) },
    });
    const out = scoreCandidate({
      features: v,
      regime: 'quiet',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'v1',
    });
    expect(out.probability).toBe(0);
    expect(out.netExpectedR).toBe(0);
    expect(out.actionable).toBe(false);
    expect(out.vetoes.map((x) => x.code)).toContain('macro-blackout');
  });

  it('a veto cannot be out-scored by a perfect setup', () => {
    const v = goodVector({
      regime: { ...goodVector().regime, macroBlackoutMin: measured(5, AS_OF) },
    });
    const out = scoreCandidate({
      features: v,
      regime: 'trending-bull',
      plan: plan({ rr: 10 }),
      base: { rate: 0.9, samples: 1000, source: 'ledger' },
      id: 'v2',
    });
    expect(out.probability).toBe(0);
  });

  it('funding crowded against the side vetoes', () => {
    const v = goodVector({
      positioning: { ...goodVector().positioning, crowdedAgainst: measured(1, 0) },
    });
    const out = hardVetoes({ features: v, regime: 'quiet' });
    expect(out.map((x) => x.code)).toContain('funding-crowded-against');
  });

  it('routine commentary dominating attribution vetoes', () => {
    const v = goodVector({
      catalyst: { ...goodVector().catalyst, routineDominates: measured(1, AS_OF) },
    });
    const out = hardVetoes({ features: v, regime: 'quiet' });
    expect(out.map((x) => x.code)).toContain('routine-commentary');
  });

  it('event risk vetoes at the configured line', () => {
    const v = goodVector({
      context: { ...goodVector().context, eventRisk: measured(MIND.VETO_EVENT_RISK + 0.01, AS_OF) },
    });
    expect(hardVetoes({ features: v, regime: 'quiet' }).map((x) => x.code)).toContain('event-risk');
  });

  it('just under the event-risk line does not veto', () => {
    const v = goodVector({
      context: { ...goodVector().context, eventRisk: measured(MIND.VETO_EVENT_RISK - 0.01, AS_OF) },
    });
    expect(hardVetoes({ features: v, regime: 'quiet' }).map((x) => x.code)).not.toContain('event-risk');
  });

  it('zero strength vetoes — that is the engine own chop rule, mirrored', () => {
    const v = goodVector({
      structure: { ...goodVector().structure, strength: measured(0, AS_OF) },
    });
    expect(hardVetoes({ features: v, regime: 'quiet' }).map((x) => x.code)).toContain('no-strength');
  });

  it('a fresh setup in a cascade vetoes, because a fresh zone needs a trend', () => {
    const v = goodVector({ structure: { ...goodVector().structure, retest: 'fresh' } });
    const out = hardVetoes({ features: v, regime: 'high-vol-cascade' });
    expect(out.map((x) => x.code)).toContain('regime-requires-trend');
  });

  it('a retested zone in a cascade is not vetoed by that rule', () => {
    const v = goodVector({ structure: { ...goodVector().structure, retest: 'retested-held' } });
    const out = hardVetoes({ features: v, regime: 'high-vol-cascade' });
    expect(out.map((x) => x.code)).not.toContain('regime-requires-trend');
  });

  it('every veto carries a rule and a human reason', () => {
    const v = goodVector({
      regime: { ...goodVector().regime, macroBlackoutMin: measured(5, AS_OF) },
    });
    for (const veto of hardVetoes({ features: v, regime: 'quiet' })) {
      expect(veto.rule).toBeTruthy();
      expect(veto.reason.length).toBeGreaterThan(10);
    }
  });

  it('an unmeasured feature cannot trigger its veto', () => {
    const v = goodVector({
      regime: { ...goodVector().regime, macroBlackoutMin: absent() },
      catalyst: { ...goodVector().catalyst, routineDominates: absent() },
    });
    const codes = hardVetoes({ features: v, regime: 'quiet' }).map((x) => x.code);
    expect(codes).not.toContain('macro-blackout');
    expect(codes).not.toContain('routine-commentary');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('expected R', () => {
  it('subtracts the plan cost from the gross R', () => {
    const r = expectedR(plan({ rr: 2, entryMid: 100, riskPerUnit: 2.5, costs: COSTS }));
    // 10bps on a 100 entry against 2.5 of risk = 0.04 R
    expect(r.grossR).toBe(2);
    expect(r.netR).toBeCloseTo(1.96, 3);
    expect(r.noRoom).toBe(false);
  });

  it('no liquidity target means no R, never an invented multiple', () => {
    const r = expectedR(plan({ noRoom: true, rr: 0, targets: [] }));
    expect(r.grossR).toBe(0);
    expect(r.netR).toBe(0);
    expect(r.noRoom).toBe(true);
  });

  it('a null plan is no room, not a crash', () => {
    expect(expectedR(null)).toEqual({ grossR: 0, netR: 0, noRoom: true });
  });

  it('a plan with no room is never actionable however good the setup looks', () => {
    const out = scoreCandidate({
      features: goodVector(),
      regime: 'trending-bull',
      plan: plan({ noRoom: true, rr: 0, targets: [] }),
      base: LEDGER_RATE,
      id: 'nr',
    });
    expect(out.actionable).toBe(false);
  });

  it('net R goes negative when costs exceed the reward', () => {
    const r = expectedR(
      plan({
        rr: 0.5,
        entryMid: 100,
        riskPerUnit: 1,
        costs: { ...COSTS, totalBps: 400 },
      }),
    );
    // 400bps on 100 against 1 of risk = 4 R of cost against 0.5 R of reward.
    expect(r.netR).toBeLessThan(0);
  });
});

describe('kelly ranking', () => {
  it('is positive only when there is positive edge', () => {
    expect(kellyRank(0.6, 2)).toBeGreaterThan(0);
    // p=0.5, netR=1: win 0.5, lose 0.5 — exactly break-even, so zero.
    expect(kellyRank(0.5, 1)).toBe(0);
    // p=0.4, netR=1: win 0.4, lose 0.6 — genuinely negative expectancy.
    expect(kellyRank(0.4, 1)).toBe(0);
    // p=0.4, netR=2: win 0.8, lose 0.6 — positive, so NOT zero. Written down
    // because the first draft of this test asserted the opposite and was wrong.
    expect(kellyRank(0.4, 2)).toBeGreaterThan(0);
  });

  it('is zero, not negative, for no edge — a board should not sort worst-first', () => {
    expect(kellyRank(0.3, -1)).toBe(0);
    expect(kellyRank(0, 5)).toBe(0);
  });

  it('handles nonsense without producing NaN', () => {
    expect(kellyRank(NaN, 2)).toBe(0);
    expect(kellyRank(0.6, Infinity)).toBe(0);
  });

it('is a fraction of the linear Kelly optimum', () => {
  // f* = (p*m - (1-p)) / m, scaled by KELLY_FRACTION. Finite for every m > 0.
  const p = 0.4;
  const netR = 2;
  const f = (p * netR - (1 - p)) / netR;
  expect(kellyRank(p, netR)).toBeCloseTo(f * MIND.KELLY_FRACTION, 3);
  expect(kellyRank(p, netR)).toBeLessThan(f);
});

it('reduces to 2p-1 at a fair 1:1 payoff', () => {
  // The identity that makes the linear form recognisable as Kelly at all.
  const p = 0.62;
  expect(kellyRank(p, 1)).toBeCloseTo((2 * p - 1) * MIND.KELLY_FRACTION, 3);
});

it('does NOT saturate when p*netR exceeds 1', () => {
  // The bug this replaced: the logarithmic form gives NaN for p*m > 1, and
  // clamping it made every good setup tie at the ceiling — four signals on a
  // real mock board all ranked 3.4539. Distinct edge must mean distinct rank.
  const a = kellyRank(0.54, 2.35);
  const b = kellyRank(0.54, 3.56);
  expect(Number.isFinite(a)).toBe(true);
  expect(Number.isFinite(b)).toBe(true);
  expect(b).not.toBe(a);
  expect(b).toBeGreaterThan(a);
});

it('rank stays bounded and never exceeds the probability', () => {
  for (const p of [0.5, 0.6, 0.8, 0.95]) {
    for (const m of [0.5, 1, 2, 5, 20]) {
      expect(kellyRank(p, m)).toBeLessThanOrEqual(p);
    }
  }
});
});

describe('drivers', () => {
  it('reports at most three, largest first, each with a reason', () => {
    const out = scoreCandidate({
      features: goodVector(),
      regime: 'trending-bull',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'dr',
    });
    expect(out.drivers.length).toBeLessThanOrEqual(3);
    for (const d of out.drivers) {
      expect(d.feature).toBeTruthy();
      expect(d.reason.length).toBeGreaterThan(5);
      expect(Number.isFinite(d.contribution)).toBe(true);
    }
  });

  it('orders drivers by absolute contribution', () => {
    const out = scoreCandidate({
      features: goodVector(),
      regime: 'trending-bull',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'dr2',
    });
    const mags = out.drivers.map((d) => Math.abs(d.contribution));
    for (let i = 1; i < mags.length; i++) expect(mags[i]).toBeLessThanOrEqual(mags[i - 1]);
  });

  it('a cascade regime is visible either as a driver or as a veto — never silently', () => {
    const out = scoreCandidate({
      features: goodVector({ structure: { ...goodVector().structure, retest: 'fresh' } }),
      regime: 'high-vol-cascade',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'dr3',
    });
    // A cascade drags the score hard, but macroRegime carries weight 10 against
    // structure's 25, so it is not guaranteed a top-3 driver slot. What must
    // hold is that the regime is not invisible: either it is in the drivers, or
    // it forced a veto that the UI shows separately.
    const named = out.drivers.some((d) => d.feature === 'regime' || d.feature.includes('regime'));
    const vetoed = out.vetoes.some((x) => x.rule === 'regime');
    expect(named || vetoed).toBe(true);
  });

  it('the cascade score is strictly below the quiet score for the same vector', () => {
    // `retested-held` deliberately: an `approaching` zone needs a trend, and both
    // `quiet` and `high-vol-cascade` veto that — so using it here would have made
    // both scores 0 and the comparison vacuous.
    const v = goodVector({ structure: { ...goodVector().structure, retest: 'retested-held' } });
    const quiet = scoreCandidate({ features: v, regime: 'quiet', plan: plan(), base: LEDGER_RATE, id: 'q' });
    const cascade = scoreCandidate({
      features: v,
      regime: 'high-vol-cascade',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'c',
    });
    expect(quiet.vetoes).toHaveLength(0);
    expect(cascade.probability).toBeLessThan(quiet.probability);
    expect(cascade.groupScores.macroRegime).toBeLessThan(quiet.groupScores.macroRegime);
  });

  it('both quiet and cascade veto an approaching zone, because a fresh zone needs a trend', () => {
    const v = goodVector({ structure: { ...goodVector().structure, retest: 'approaching' } });
    for (const regime of ['quiet', 'high-vol-cascade'] as MindRegime[]) {
      const out = scoreCandidate({ features: v, regime, plan: plan(), base: LEDGER_RATE, id: 'ar' });
      expect(out.vetoes.map((x) => x.code)).toContain('regime-requires-trend');
    }
  });
});

describe('confidence bands and the actionability gate', () => {
  it('a vetoed setup is low band whatever its features say', () => {
    const v = goodVector({
      regime: { ...goodVector().regime, macroBlackoutMin: measured(1, AS_OF) },
    });
    const out = scoreCandidate({ features: v, regime: 'quiet', plan: plan(), base: LEDGER_RATE, id: 'cb' });
    expect(out.confidenceBand).toBe('low');
  });

  it('actionable requires probability, net R and no veto together', () => {
    const out = scoreCandidate({
      features: goodVector(),
      regime: 'trending-bull',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'act',
    });
    const ok =
      out.probability >= MIND.ACTIONABLE_MIN_PROBABILITY &&
      out.netExpectedR > MIND.ACTIONABLE_MIN_NET_R &&
      out.vetoes.length === 0;
    expect(out.actionable).toBe(ok);
  });
});

describe('the India path is automatically lower confidence', () => {
  it('a sparse vector scores no higher than an equivalent measured one', () => {
    const measuredFull = scoreCandidate({
      features: goodVector(),
      regime: 'trending-bull',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'in1',
    });
    const sparse = scoreCandidate({
      features: buildFeatureVector({
        symbol: 'RELIANCE',
        side: 'bullish',
        asOf: AS_OF,
        candles: series(60, BASE),
        setup: setup(),
        strength: 70,
        macroBlackoutMin: 600,
      }),
      regime: 'trending-bull',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'in2',
    });
    expect(sparse.probability).toBeLessThanOrEqual(measuredFull.probability);
  });

  it('missing components are surfaced as a driver, not silently absorbed', () => {
    const sparse = scoreCandidate({
      features: buildFeatureVector({
        symbol: 'RELIANCE',
        side: 'bullish',
        asOf: AS_OF,
        candles: series(60, BASE),
        setup: setup(),
        strength: 70,
      }),
      regime: 'quiet',
      plan: plan(),
      base: LEDGER_RATE,
      id: 'in3',
    });
    expect(sparse.drivers.some((d) => d.feature.includes('coverage') || d.feature.includes('MissingFrac'))).toBe(true);
  });
});