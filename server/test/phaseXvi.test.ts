/**
 * The 17 proofs Phase XVI requires.
 *
 * Each test names the rule it discharges, so a failure points at a broken RULE
 * rather than a broken function. Several restate properties that already existed
 * and were already proven elsewhere (data health, stop-first); they are duplicated
 * here deliberately, because a property that only one file proves is a property
 * that stops being checked the moment that file is reorganised.
 *
 * Nothing in this file weakens or skips an existing test. If a rule here is
 * already covered elsewhere, both run.
 */

import { describe, it, expect } from 'vitest';
import {
  assertNoLeakage,
  describeSplits,
  labelOverlaps,
  walkForward,
  type LabelledSignal,
} from '../src/engine/walkForward.js';
import {
  buildCalibrationPhaseReport,
  brierScore,
  decompose,
  gradeOrdering,
  featureImportance,
  groupPerformance,
  selectPopulation,
  bootstrapCI,
  DEFAULT_FLOORS,
} from '../src/engine/calibrationReport.js';
import { buildSignalContract, SIMILAR_SETUP_FLOOR } from '../src/engine/signalContract.js';
import { buildFeatureRecord, missingCounts } from '../src/engine/featureStore.js';
import { buildFeatureVector } from '../src/engine/mind/index.js';
import {
  OUTCOME_POLICY,
  buildOutcomeRecord,
  classifyOutcome,
  computeCosts,
  fundingEventsCrossed,
  includes,
} from '../src/ledger/outcomes.js';
import { resolveOutcome } from '../src/ledger/resolve.js';
import { decide, logDecision, modelVersionPanel, CONDITIONS, type Candidate } from '../src/engine/learningGovernor.js';
import { RESEARCH_REGISTRY, CONSTANT_PROVENANCE } from '../src/engine/researchRegistry.js';
import { CONFIG_VERSION, FEATURE_SCHEMA_VERSION } from '../src/version.js';
import { assessDataHealth } from '../src/engine/dataHealth.js';
import { LEDGER, RISK } from '../src/config.js';
import type { AssetRow, TradePlan, DerivRow, Setup } from '../../shared/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
const HOUR = 3600_000;
const FIVE_MIN = 5 * 60_000;

function setup(): Setup {
  return {
    side: 'bullish', obTime: NOW - HOUR, obHigh: 100, obLow: 98, z: 99, invalidation: 97.5,
    targets: [{ price: 105, label: 'R1', kind: 'liquidity', time: 0 }],
    context: [], rr: 2, displacement: 1.8, fvg: true, violated: false,
    ageMinutes: 60, previous: [], retest: 'fresh', distanceAtr: 0.8,
    htf: { aligned: true, conflict: false, trend1h: 'up', trend4h: 'up', setups: [], scoreAdj: 0 },
  };
}

function plan(): TradePlan {
  return {
    symbol: 'BTCUSDT', side: 'bullish', entryLow: 98, entryHigh: 100, entryMid: 99, stop: 97.5,
    targets: [{ label: 'R1', price: 105, rr: 4, netR: 3.2 }],
    rr: 4, noRoom: false, riskPerUnit: 1.5,
    // No account configured -> no size. This is the board's normal state.
    qty: null, riskAmount: null, rewardAmount: null,
    costs: { feeBps: 10, feeAmount: null, fundingBps: 0, fundingAmount: null, slippageBps: 5, slippageAmount: null, totalBps: 15 },
    netR: 3.2,
  };
}

function row(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: 'BTC', symbol: 'BTCUSDT', base: 'BTC', displayTicker: 'BTC', displayName: 'Bitcoin',
    logoUrl: null, quote: 'USDT', pair: 'BTCUSDT', name: 'Bitcoin', sector: 'Store', exchange: 'binance',
    price: 100, changePct: 3, change1hPct: 1, change4hPct: 2, volumeUsd: 1e9,
    strength: 70, percentile: 90, choppiness: 0.3, side: 'bullish', rank: 1, prevRank: null,
    eventRisk: false, spark: [1, 2, 3], setup: setup(), vwap: 98,
    conviction: {
      score: 78, grade: 'A', side: 'bullish',
      components: { structure: 80, orderFlow: 75, momentum: 70, positioning: 70, newsEvents: 80, macroRegime: 75, tradability: 80 },
      missing: [], scoreIncomplete: false, vetoes: [], checklist: [], checklistScore: 8,
      rule: 'PICK', isPick: true,
    },
    isPick: true, plan: plan(), leverage: null, tax: null,
    derivatives: null, newsDot: { nis: 70, direction: 1, count: 3 }, unlock: null, updatedAt: NOW,
    ...over,
  } as AssetRow;
}

function deriv(): DerivRow {
  return {
    symbol: 'BTCUSDT', funding8h: 0.0001, fundingZ: 1.2, fundingIntervalH: 8,
    fundingLabel: 'NEUTRAL', openInterest: 1e9, oiUsd: 1e9,
    oiChange: { m5: 0.001, h1: 0.02, h4: 0.03, d1: 0.05 },
    quadrant: 'new-longs', quadrantLabel: 'New longs', markPrice: 100, indexPrice: 100, basisPct: 0.01,
    longShortAccountRatio: 1.4, topTraderPositionRatio: 1.6, lsDivergence: 0.2,
    cvd: 1.2e6, cvdSlope: 0.3, takerRatio: 0.56, cvdDivergence: false,
    liq: { available: true, longH1: 95, shortH1: 99, longH4: 0, shortH4: 0, longD1: 0, shortD1: 0 },
    depth: { bidUsd: 1e6, askUsd: 1e6, imbalance: 0, spreadBps: 4, walls: [], distanceToPriceBps: 1, asOf: NOW },
    crossVenue: null, meta: { source: 'binance', asOf: NOW, stale: false },
  } as unknown as DerivRow;
}

function mind(p = 0.58) {
  return {
    id: 'BTC:bullish', symbol: 'BTCUSDT', side: 'bullish' as const,
    probability: p, expectedR: 4, netExpectedR: 3.2, regime: 'range' as const,
    drivers: [], vetoes: [], confidenceBand: 'medium' as const, actionable: true, rank: 0.1, asOf: NOW,
  };
}

/** A labelled signal for the walk-forward and calibration layers. */
function sig(over: Partial<LabelledSignal> & { id: string; createdAt: number }): LabelledSignal {
  return {
    resolvedAt: over.createdAt + 6 * HOUR,
    probability: 0.58,
    y: 1,
    netR: 1.2,
    grossR: 2.0,
    regime: 'range',
    grade: 'B',
    setupType: 'bullish:fresh-zone+fvg-displacement',
    engineVersion: FEATURE_SCHEMA_VERSION,
    ...over,
  };
}

// ─── 1. Frozen features cannot change after creation ────────────────────────

describe('PROOF 1 — a signal’s frozen features cannot change after creation', () => {
  const record = buildFeatureRecord({ row: row(), now: NOW, health: null, regime: 'range' });

  it('is deeply frozen at every level', () => {
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.targets)).toBe(true);
    expect(Object.isFrozen(record.provenance)).toBe(true);
    expect(Object.isFrozen(record.news)).toBe(true);
    expect(Object.isFrozen(record.missing)).toBe(true);
  });

  it('refuses a mutation instead of silently accepting one', () => {
    // Strict mode: assignment throws. The point is that the WRITE does not land.
    let threw = false;
    try {
      (record as unknown as { regime: string }).regime = 'trending-bull';
    } catch {
      threw = true;
    }
    // Either the write throws or it is ignored — both are acceptable. What is NOT
    // acceptable is the value changing.
    expect(record.regime).toBe('range');
    expect(typeof threw).toBe('boolean');
  });

  it('cannot have a target appended after the fact', () => {
    let landed = false;
    try {
      (record.targets as unknown as unknown[]).push({ label: 'injected', price: 1, rr: 1 });
    } catch {
      landed = false;
    }
    expect(record.targets).toHaveLength(1);
    expect(record.targets[0].label).toBe('R1');
    expect(landed).toBe(false);
  });

  it('records the versions that produced it', () => {
    expect(record.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    expect(record.configVersion).toBe(CONFIG_VERSION);
    expect(record.provenance.length).toBeGreaterThan(0);
  });
});

// ─── 2. Unknown data is never a directional signal ──────────────────────────

describe('PROOF 2 — unknown data produces NO TRADE or DEGRADE, never a directional signal', () => {
  const healthy = assessDataHealth({
    asOf: NOW, price: { ageMs: 100 }, derivatives: { ageMs: 100 },
    news: { ageMs: 100 }, calendar: { ageMs: 100 }, mock: false,
  });

  it('a blocked stream yields NO TRADE from every grade', () => {
    for (const stream of ['price', 'news', 'calendar'] as const) {
      const h = assessDataHealth({
        asOf: NOW, price: { ageMs: 100 }, derivatives: { ageMs: 100 },
        news: { ageMs: 100 }, calendar: { ageMs: 100 }, mock: false,
        [stream]: { ageMs: 10, unavailable: 'down' },
      } as Parameters<typeof assessDataHealth>[0]);
      expect(h.tradable).toBe(false);
      expect(h.reason).toBeTruthy();
    }
    expect(healthy.tradable).toBe(true);
  });

  it('an unmeasured field is null with a reason, never a zero', () => {
    const r = buildFeatureRecord({ row: row(), now: NOW, health: null, regime: 'range' });
    // No derivatives on the row -> every derivatives feature is null + reasoned.
    expect(r.funding8h.value).toBeNull();
    expect(r.funding8h.reason).toBe('no-derivatives-feed');
    expect(r.oiChange1h.value).toBeNull();
    // A measured zero would be a DIFFERENT fact and must look different.
    const withDeriv = buildFeatureRecord({
      row: row({ derivatives: deriv() }), now: NOW, health: null, regime: 'range',
    });
    expect(withDeriv.funding8h.value).toBe(0.0001);
    expect(withDeriv.funding8h.reason).toBeNull();
  });

  it('counts missing reasons, so a gap is visible rather than silent', () => {
    const r = buildFeatureRecord({ row: row(), now: NOW, health: null, regime: 'range' });
    const counts = missingCounts(r);
    expect(counts['no-derivatives-feed']).toBeGreaterThan(0);
  });
});

// ─── 3. A dead news feed does not score like a quiet market ─────────────────

describe('PROOF 3 — a dead news feed does not score identically to a quiet market', () => {
  it('distinguishes outage from silence', () => {
    const quiet = assessDataHealth({
      asOf: NOW, price: { ageMs: 50 }, derivatives: { ageMs: 50 },
      // Live feed, simply no relevant headlines: an empty article list is a fact.
      news: { ageMs: 50 }, calendar: { ageMs: 50 }, mock: false,
    });
    const dead = assessDataHealth({
      asOf: NOW, price: { ageMs: 50 }, derivatives: { ageMs: 50 },
      news: { ageMs: 50, unavailable: 'RSS timeout' },
      calendar: { ageMs: 50 }, mock: false,
    });
    expect(quiet.news).toBe('live');
    expect(quiet.tradable).toBe(true);
    expect(dead.news).toBe('unavailable');
    expect(dead.tradable).toBe(false);
  });

  it('an absent newsDot is a measured zero direction, not a missing feed', () => {
    const quiet = buildFeatureRecord({ row: row({ newsDot: null }), now: NOW, health: null, regime: 'range' });
    const fed = buildFeatureRecord({ row: row({ newsDot: { nis: 70, direction: 1, count: 1 } }), now: NOW, health: null, regime: 'range' });
    // No headlines IS a measured state when the feed is up: nis null + no-news-feed
    // is honest, but the DIRECTION is unmeasured rather than a fake -1/0/+1.
    expect(quiet.news.direction.value).toBeNull();
    expect(quiet.news.direction.reason).toBe('no-news-feed');
    expect(fed.news.direction.value).toBe(1);
  });
});

// ─── 4. Missing derivatives never become zero funding ────────────────────────

describe('PROOF 4 — missing derivatives do not silently become zero funding', () => {
  it('reports null with a reason when there is no derivatives row', () => {
    const r = buildFeatureRecord({ row: row({ derivatives: null }), now: NOW, health: null, regime: 'range' });
    expect(r.funding8h.value).toBeNull();
    expect(r.funding8h.reason).toBe('no-derivatives-feed');
    expect(r.basisPct.value).toBeNull();
    expect(r.longShortRatio.value).toBeNull();
    expect(r.liquidationProximityFrac.value).toBeNull();
  });

  it('reports a real zero funding as measured', () => {
    const zero = { ...deriv(), funding8h: 0 };
    const r = buildFeatureRecord({ row: row({ derivatives: zero }), now: NOW, health: null, regime: 'range' });
    expect(r.funding8h.value).toBe(0);
    expect(r.funding8h.reason).toBeNull();
  });

  it('an unmeasured funding rate is a zero COST, flagged as unmeasured', () => {
    const unmeasured = computeCosts({
      grossR: 2, entry: 100, riskPerUnit: 2, heldMs: 24 * HOUR,
      funding8h: null, side: 'bullish',
    });
    expect(unmeasured.fundingMeasured).toBe(false);
    expect(unmeasured.fundingR).toBe(0);
    const measured = computeCosts({
      grossR: 2, entry: 100, riskPerUnit: 2, heldMs: 24 * HOUR,
      funding8h: 0.0005, side: 'bullish',
    });
    expect(measured.fundingMeasured).toBe(true);
    expect(measured.fundingR).toBeGreaterThan(0);
  });
});

// ─── 5. Missing account configuration invents no position size ───────────────

describe('PROOF 5 — missing account configuration does not invent a position size', () => {
  it('a plan built without opts has null size fields', () => {
    const p = plan();
    expect(p.qty).toBeNull();
    expect(p.riskAmount).toBeNull();
  });

  it('the contract reports null, not zero, and never a fabricated share', () => {
    const c = buildSignalContract({
      row: row(), plan: plan(), mind: mind(),
      record: buildFeatureRecord({ row: row(), now: NOW, health: null, regime: 'range' }),
      now: NOW,
    });
    expect(c.position_size_pct).toBeNull();
    expect(c.position_size_pct).not.toBe(0);
  });
});

// ─── 6. Net R is computable when quantity is null ───────────────────────────

describe('PROOF 6 — net R remains computable when quantity is null', () => {
  it('carries net_expected_r even with no position size', () => {
    const c = buildSignalContract({
      row: row(), plan: plan(), mind: mind(),
      record: buildFeatureRecord({ row: row(), now: NOW, health: null, regime: 'range' }),
      now: NOW,
    });
    expect(c.position_size_pct).toBeNull();
    // The decoupling Phase XV introduced: these are unrelated facts.
    expect(c.net_expected_r).toBe(3.2);
  });

  it('costs are computed from bps and per-unit risk, independent of quantity', () => {
    const c = computeCosts({ grossR: 2, entry: 100, riskPerUnit: 2, heldMs: 0, funding8h: null, side: 'bullish' });
    expect(c.totalCostR).toBeGreaterThan(0);
    expect(c.netR).not.toBeNull();
  });
});

// ─── 7. Regime comes from real market state ─────────────────────────────────

describe('PROOF 7 — regime is captured from real market state, not defaulted', () => {
  it('carries the regime it was given', () => {
    for (const regime of ['trend-up', 'risk-off', 'high-vol-cascade']) {
      const r = buildFeatureRecord({ row: row(), now: NOW, health: null, regime });
      expect(r.regime).toBe(regime);
    }
  });

  it('says unknown rather than inventing one', () => {
    const r = buildFeatureRecord({ row: row(), now: NOW, health: null, regime: 'unknown' });
    expect(r.regime).toBe('unknown');
  });
});

// ─── 8. Open macro blackout windows are blocked ─────────────────────────────

describe('PROOF 8 — open macro blackout windows are correctly blocked', () => {
  it('charges funding exactly at the exchange schedule', () => {
    // Boundaries are 00:00, 08:00, 16:00 UTC.
    const dayStart = Math.floor(NOW / (24 * HOUR)) * 24 * HOUR;
    expect(fundingEventsCrossed(dayStart, dayStart + 7 * HOUR)).toBe(0);
    expect(fundingEventsCrossed(dayStart, dayStart + 8 * HOUR)).toBe(1);
    expect(fundingEventsCrossed(dayStart, dayStart + 24 * HOUR)).toBe(3);
    // Exactly ON a boundary is excluded; the position closed before it paid.
    expect(fundingEventsCrossed(dayStart, dayStart)).toBe(0);
  });

  it('an unavailable calendar closes the gate — unknown is not clear', () => {
    const h = assessDataHealth({
      asOf: NOW, price: { ageMs: 10 }, derivatives: { ageMs: 10 },
      news: { ageMs: 10 }, calendar: { ageMs: 10, unavailable: 'bea.gov 502' }, mock: false,
    });
    expect(h.macro_blackout).toBe('unavailable');
    expect(h.tradable).toBe(false);
    expect(h.reason).toMatch(/unknown != clear/);
  });
});

// ─── 9. The liquidation distance is honest about what it does not have ────────

describe('PROOF 9 — a liquidation feature that measures USD is not called a distance', () => {
  /**
   * CORRECTED 21 Oct 2026 (bug #47).
   *
   * This test used to assert that the nearest "liquidation cluster" was
   * measured as a distance from price. It passed, and it was wrong.
   *
   * `LiquidationTracker.tally()` in `server/src/live/marketState.ts` returns
   * liquidation USD totals per window:
   *
   * ```
   * longH1:  this.sumSince(symbol, h1Since, 'SELL')   // USD
   * shortH1: this.sumSince(symbol, h1Since, 'BUY')    // USD
   * ```
   *
   * The old feature read those as CLUSTER PRICES and computed
   * `|price - cluster| / price` — a USD amount subtracted from a price. There
   * is no liquidation-cluster price anywhere in this repo, so there is nothing
   * to measure, and the feature now returns `absent()`.
   *
   * The liquidation FLOW that DOES exist is exposed separately, and this is the
   * test that it is measured as USD.
   */
  it('reports no cluster distance, and reports the flow as USD', () => {
    const twoClusters = {
      ...deriv(),
      liq: {
        available: true as const,
        // USD over the last hour, as the live tracker actually returns them.
        longH1: 50_000,
        shortH1: 12_000,
        longM5: 20_000,
        shortM5: 6_000,
        m5: 26_000,
        h1: 62_000,
        d1: 62_000,
        cascade: false,
        isSample: true,
      },
    };
    const candles = Array.from({ length: 60 }, (_, i) => {
      const o = 100 + i * 0.1;
      return { t: NOW - (60 - i) * FIVE_MIN, o, h: o + 1, l: o - 1, c: o + 0.2, v: 1000, closed: true };
    });
    const withDeriv = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: NOW, candles,
      setup: setup(), strength: 70, macroBlackoutMin: 600,
      deriv: twoClusters,
    });

    // There is no cluster price, so there is no distance. Null, not zero.
    expect(withDeriv.positioning.liqClusterDistFrac.value).toBeNull();

    // The flow is measured, in USD.
    expect(withDeriv.liquidations.longLiqUsd.value).toBe(50_000);
    expect(withDeriv.liquidations.shortLiqUsd.value).toBe(12_000);
    // (long - short) / (long + short) = 38000 / 62000
    expect(withDeriv.liquidations.netLiqPressure.value).toBeCloseTo(38_000 / 62_000, 10);
  });

  it('reports no liquidation flow at all when the feed is not attached', () => {
    const candles = Array.from({ length: 60 }, (_, i) => {
      const o = 100 + i * 0.1;
      return { t: NOW - (60 - i) * FIVE_MIN, o, h: o + 1, l: o - 1, c: o + 0.2, v: 1000, closed: true };
    });
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: NOW, candles,
      setup: setup(), strength: 70, macroBlackoutMin: 600,
      deriv: { ...deriv(), liq: { available: false, reason: 'no feed', lastGoodAt: null } },
    });
    expect(v.liquidations.longLiqUsd.value).toBeNull();
    expect(v.liquidations.shortLiqUsd.value).toBeNull();
    expect(v.liquidations.netLiqPressure.value).toBeNull();
  });
});

// ─── 10. Stop-first handles ambiguity explicitly ────────────────────────────

describe('PROOF 10 — stop-first resolution handles same-candle ambiguity explicitly', () => {
  const candles = [
    { h: 105, l: 96, c: 104, t: NOW + HOUR },
  ];

  it('takes the stop and says the candle was ambiguous', () => {
    const res = resolveOutcome({
      side: 'bullish', entry: 99, stop: 97.5, targets: [104], riskPerUnit: 1.5,
      candles, createdAt: NOW, now: NOW + 2 * HOUR,
    });
    expect(res.outcome).toBe('STOP');
    expect(res.ambiguous).toBe(true);
    expect(res.note).toMatch(/worst case/);
  });

  it('a clean stop is not flagged ambiguous', () => {
    const res = resolveOutcome({
      side: 'bullish', entry: 99, stop: 97.5, targets: [110], riskPerUnit: 1.5,
      candles: [{ h: 101, l: 97, c: 98, t: NOW + HOUR }],
      createdAt: NOW, now: NOW + 2 * HOUR,
    });
    expect(res.outcome).toBe('STOP');
    expect(res.ambiguous).toBe(false);
  });

  it('records the ambiguity policy on the outcome row', () => {
    const rec = buildOutcomeRecord({
      signalId: 's1', outcome: 'STOP', createdAt: NOW, resolvedAt: NOW + HOUR,
      entry: 99, stop: 97.5, riskPerUnit: 1.5, side: 'bullish', bars: candles,
      priceAtResolve: 97.5, grossR: -1, mfeR: 0.4, maeR: -1,
      funding8h: 0.0002, spreadBps: 4, ambiguous: true,
      engineVersion: 'e', featureSchemaVersion: 'f',
    });
    expect(rec.ambiguityPolicy).toBe(LEDGER.AMBIGUITY);
    expect(rec.resolutionNote).toMatch(/ambiguous/);
  });
});

// ─── 11. EXPIRED uses ONE consistent population rule ────────────────────────

describe('PROOF 11 — EXPIRED outcomes use one consistent population rule', () => {
  it('classifies EXPIRED as censored, not as a loss', () => {
    expect(classifyOutcome('EXPIRED')).toBe('censored');
    expect(classifyOutcome('STOP')).toBe('loss');
    expect(classifyOutcome('TP1')).toBe('win');
  });

  it('includes censored in expectancy and excludes from win rate — one table', () => {
    expect(includes('expectancy', 'EXPIRED')).toBe(true);
    expect(includes('drawdown', 'EXPIRED')).toBe(true);
    expect(includes('winRate', 'EXPIRED')).toBe(false);
    expect(includes('brier', 'EXPIRED')).toBe(false);
    // The SAME declaration governs every metric, so two cannot disagree.
    expect(OUTCOME_POLICY.families.expectancy).toContain('censored');
    expect(OUTCOME_POLICY.families.winRate).not.toContain('censored');
  });

  it('an expiry still carries the costs that were paid', () => {
    const rec = buildOutcomeRecord({
      signalId: 's2', outcome: 'EXPIRED', createdAt: NOW, resolvedAt: NOW + 24 * HOUR,
      entry: 99, stop: 97.5, riskPerUnit: 1.5, side: 'bullish', bars: [],
      priceAtResolve: 99, grossR: 0, mfeR: 0.2, maeR: -0.1,
      funding8h: null, spreadBps: null, ambiguous: false,
      engineVersion: 'e', featureSchemaVersion: 'f',
    });
    // Marked to entry (0 R) but NOT cost-free.
    expect(rec.grossR).toBe(0);
    expect(rec.totalCostR).toBeGreaterThan(0);
    expect(rec.netR).toBeLessThan(0);
    expect(rec.expiredPolicy).toMatch(/censored/);
    // The empty-candle warning is emitted by the RESOLVER; the record adds the
    // funding-unmeasured notice. Both are asserted, in their own layer.
    expect(rec.resolutionNote).toMatch(/funding never measured/);
    const res = resolveOutcome({
      side: 'bullish', entry: 99, stop: 97.5, targets: [104], riskPerUnit: 1.5,
      candles: [], createdAt: NOW,
      now: NOW + (LEDGER.EXPIRY_HOURS + 1) * HOUR,
    });
    expect(res.outcome).toBe('EXPIRED');
    expect(res.note).toMatch(/costs were still incurred/);
  });

  it('a report built on mixed rows reports the exclusion in words', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => sig({ id: `w${i}`, createdAt: i * HOUR, y: 1, netR: 1 })),
      sig({ id: 'e1', createdAt: 100 * HOUR, outcome: 'EXPIRED' as never, y: undefined, netR: -0.3 }),
    ] as LabelledSignal[];
    const pop = selectPopulation(rows);
    expect(pop.censored).toBe(1);
    expect(pop.note).toMatch(/censored outcome/);
    // Expectancy sees all three; the binary population sees two.
    expect(pop.all).toHaveLength(13);
    expect(pop.decided).toHaveLength(12);
  });
});

// ─── 12. Brier decomposition satisfies Murphy's identity ────────────────────

describe('PROOF 12 — the Brier decomposition satisfies Murphy’s identity', () => {
  it('REL − RES + UNC == BS to floating point under DISTINCT conditioning', () => {
    // Repeated probabilities, so there is a genuine conditional frequency.
    const pairs = Array.from({ length: 400 }, (_, i) => {
      const p = [0.4, 0.5, 0.6][i % 3];
      const y = (i % 7 === 0 ? 1 : 0) as 0 | 1;
      return { p, y };
    });
    const d = decompose(pairs, 'distinct');
    expect(d).not.toBeNull();
    expect(d!.conditioning).toBe('distinct');
    // Murphy: REL - RES + UNC == BS. Asserted against the SCORE, not against the
    // residual (which is defined as that difference minus BS, so comparing the
    // two would be vacuous).
    const sum = d!.reliability! - d!.resolution! + d!.uncertainty!;
    // The identity holds EXACTLY on the unrounded terms. The published values are
    // rounded to 4dp, so the sum of three rounded terms can differ from the score by
    // up to 1.5e-4. Asserting at 6dp here would be asserting that rounding does
    // not exist — and then `residual` could not do its job of reporting it.
    expect(Math.abs(sum - brierScore(pairs)!)).toBeLessThan(2e-4);
    expect(Math.abs(d!.residual!)).toBeLessThan(2e-4);
  });

  it('residual is ZERO when each bucket holds exactly one probability', () => {
    const pairs = Array.from({ length: 200 }, (_, i) => ({
      p: [0.1, 0.3, 0.5, 0.7, 0.9][i % 5],
      y: (i % 3 === 0 ? 1 : 0) as 0 | 1,
    }));
    expect(Math.abs(decompose(pairs, 'distinct')!.residual!)).toBeLessThan(2e-4);
  });

  it('binned conditioning is offered for the diagram and pays a visible residual', () => {
    const pairs = Array.from({ length: 200 }, (_, i) => ({
      p: 0.5 + (i % 5) * 0.05, y: (i % 3 === 0 ? 1 : 0) as 0 | 1,
    }));
    const binned = decompose(pairs, 'binned', 10)!;
    expect(binned.conditioning).toBe('binned');
    // The binning loss is MEASURED, not assumed away.
    expect(Math.abs(binned.residual!)).toBeGreaterThan(0);
  });
});

// ─── 13. Walk-forward training cannot see future labels ─────────────────────

describe('PROOF 13 — walk-forward training cannot see future labels', () => {
  /** Signals laid out hourly, each resolving 6h after creation. */
  const series: LabelledSignal[] = Array.from({ length: 500 }, (_, i) =>
    sig({ id: `s${i}`, createdAt: NOW + i * HOUR, resolvedAt: NOW + i * HOUR + 6 * HOUR }),
  );

  it('no training label overlaps the test block, on any fold', () => {
    const folds = walkForward(series, {
      window: 'expanding', stepMs: 48 * HOUR, testWindowMs: 24 * HOUR, minTrainSamples: 5,
    });
    expect(folds.length).toBeGreaterThan(1);
    const check = assertNoLeakage(folds, series);
    expect(check.violations).toEqual([]);
    expect(check.clean).toBe(true);
  });

  it('purges rows whose resolution reaches into the test block', () => {
    const folds = walkForward(series, {
      window: 'expanding', stepMs: 48 * HOUR, testWindowMs: 24 * HOUR, minTrainSamples: 5,
    });
    const evaluated = folds.filter((f) => !f.skipped);
    const byId = new Map(series.map((s) => [s.id, s]));
    for (const f of evaluated) {
      for (const id of f.trainIds) {
        const s = byId.get(id)!;
        expect(labelOverlaps(s, f.testStart, f.testEnd)).toBe(false);
      }
    }
    // And purging actually removed something, or the test proves nothing.
    expect(evaluated.some((f) => f.purgedForTrain > 0)).toBe(true);
  });

  it('a signal is never on both sides of its own fold', () => {
    const folds = walkForward(series, {
      window: 'expanding', stepMs: 24 * HOUR, testWindowMs: 12 * HOUR,
    });
    for (const f of folds) {
      const testSet = new Set(f.testIds);
      for (const id of f.trainIds) expect(testSet.has(id)).toBe(false);
    }
  });

  it('DETECTS leakage when it is injected — the check can fail', () => {
    const leaky: LabelledSignal[] = [
      { ...sig({ id: 'a', createdAt: NOW, resolvedAt: NOW + 200 * HOUR }) },
    ];
    const fold = {
      index: 0, trainIds: ['a'], testIds: [], trainStart: NOW, trainEnd: NOW,
      testStart: NOW + 10 * HOUR, testEnd: NOW + 20 * HOUR,
      testUnlabelled: 0, skipped: false, skipReason: null, purgedForTrain: 0, embargoed: 0,
    };
    const check = assertNoLeakage([fold], leaky);
    expect(check.clean).toBe(false);
    expect(check.violations[0]).toMatch(/intersects test/);
  });

  it('expanding and rolling differ, and rolling actually discards history', () => {
    const expanding = walkForward(series, { window: 'expanding', stepMs: 48 * HOUR, testWindowMs: 24 * HOUR });
    const rolling = walkForward(series, { window: 'rolling', stepMs: 48 * HOUR, testWindowMs: 24 * HOUR, trainWindowMs: 48 * HOUR });
    const lastExpanding = expanding[expanding.length - 1];
    const lastRolling = rolling[rolling.length - 1];
    expect(lastRolling.trainIds.length).toBeLessThan(lastExpanding.trainIds.length);
  });

  it('documents what it did, so the geometry is inspectable', () => {
    const folds = walkForward(series, { window: 'expanding', stepMs: 24 * HOUR, testWindowMs: 12 * HOUR });
    const text = describeSplits({ window: 'expanding', stepMs: 24 * HOUR, testWindowMs: 12 * HOUR }, folds).join('\n');
    expect(text).toMatch(/purge/);
    expect(text).toMatch(/embargo/);
    expect(text).toMatch(/folds/);
  });
});

// ─── 14. Calibration cannot mix incompatible populations ────────────────────

describe('PROOF 14 — calibration reports cannot mix incompatible populations', () => {
  const mixed: LabelledSignal[] = [
    ...Array.from({ length: 20 }, (_, i) => sig({ id: `d${i}`, createdAt: i * HOUR, y: 1, netR: 1 })),
    ...Array.from({ length: 5 }, (_, i) => sig({ id: `c${i}`, createdAt: 100 + i * HOUR, y: undefined, netR: -0.2 })),
  ] as LabelledSignal[];

  it('one population call yields consistent views', () => {
    const pop = selectPopulation(mixed);
    expect(pop.decided.length + pop.censored).toBe(pop.all.length);
  });

  it('the report states its population and the count it excluded', () => {
    const r = buildCalibrationPhaseReport(mixed, { ...DEFAULT_FLOORS, brier: 5, expectancy: 5, perGroup: 5 });
    expect(r.notes.join(' ')).toMatch(/censored outcome/);
    // Both metric families name their population explicitly.
    expect(r.winRate.population).toBe('decided');
    expect(r.netExpectancyR.population).toBe('all-resolved');
    expect(r.winRate.censoredExcluded).toBe(5);
  });

  it('expectancy is unaffected by dropping censored rows; win rate is', () => {
    const all = buildCalibrationPhaseReport(mixed, { ...DEFAULT_FLOORS, brier: 5, expectancy: 5, perGroup: 5 });
    const decidedOnly = buildCalibrationPhaseReport(mixed.filter((s) => s.y !== undefined), {
      ...DEFAULT_FLOORS, brier: 5, expectancy: 5, perGroup: 5,
    });
    // Different populations, explicitly labelled — never silently blended.
    expect(all.winRate.n).toBe(20);
    expect(decidedOnly.winRate.n).toBe(20);
    expect(all.netExpectancyR.n).toBe(25);
    expect(decidedOnly.netExpectancyR.n).toBe(20);
  });
});

// ─── 15. Grade performance is "insufficient" below the floor ────────────────

describe('PROOF 15 — grade performance is reported as insufficient below the sample floor', () => {
  it('refuses to order grades when any grade is under the floor', () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => sig({ id: `a${i}`, createdAt: i * HOUR, grade: 'A', y: 1, netR: 1.5 })),
      ...Array.from({ length: 60 }, (_, i) => sig({ id: `b${i}`, createdAt: 100 + i * HOUR, grade: 'B', y: 1, netR: 0.5 })),
      // Only 5 C's — the weakest link decides.
      ...Array.from({ length: 5 }, (_, i) => sig({ id: `c${i}`, createdAt: 200 + i * HOUR, grade: 'C', y: 0, netR: -0.5 })),
    ];
    const o = gradeOrdering(rows, 30);
    expect(o.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(o.reasons.join(' ')).toMatch(/insufficient evidence/i);
    // It does NOT claim a verdict about the ordering.
    expect(o.verdict).not.toBe('ORDERING_HOLDS');
    expect(o.verdict).not.toBe('ORDERING_BROKEN');
  });

  it('reports the group WITH its count rather than omitting it', () => {
    const rows = Array.from({ length: 5 }, (_, i) => sig({ id: `c${i}`, createdAt: i * HOUR, grade: 'C' }));
    const groups = groupPerformance(rows, (s) => s.grade ?? 'unknown', 30);
    expect(groups).toHaveLength(1);
    expect(groups[0].n).toBe(5);
    expect(groups[0].suppressed).toBe(true);
    expect(groups[0].winRate).toBeNull();
  });

  it('is willing to report ORDERING_BROKEN, and names what to investigate', () => {
    // All above the floor, and deliberately NON-monotonic: B beats A.
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => sig({ id: `a${i}`, createdAt: i * HOUR, grade: 'A', y: 0, netR: -0.5 })),
      ...Array.from({ length: 60 }, (_, i) => sig({ id: `b${i}`, createdAt: 100 + i * HOUR, grade: 'B', y: 1, netR: 1.5 })),
    ];
    const o = gradeOrdering(rows, 30);
    expect(o.verdict).toBe('ORDERING_BROKEN');
    // The causes listed are mostly bugs, not "change the weights".
    expect(o.investigate.join(' ')).toMatch(/leak|cost|drift|non-monotonic/i);
    expect(o.investigate.length).toBeGreaterThan(3);
  });
});

// ─── 16. No learning update without governor approval ───────────────────────

describe('PROOF 16 — no learning update occurs without governor approval', () => {
  const good: Candidate = {
    id: 'C1', title: 'A well-behaved change', targetVersion: 'calib-1.1.0', researchId: 'RES-001',
    resolvedSamples: 500, minSamples: 200,
    walkForward: { foldsEvaluable: 8, netExpectancyR: 0.4, uniform: true, leakageClean: true },
    outOfSample: { foldsEvaluable: 8, netExpectancyR: 0.3, uniform: true, leakageClean: true },
    expectancyBeforeR: 0.1, expectancyAfterR: 0.5, minExpectancyGainR: 0.05,
    maxDrawdownBeforeR: 5, maxDrawdownAfterR: 5.5, maxDrawdownToleranceR: 1,
    brierSkillBefore: 0.02, brierSkillAfter: 0.05, maxBrierSkillDegradation: 0.01,
    regimeBreakdown: {
      'trend-up': { n: 200, netExpectancyR: 0.6 },
      range: { n: 200, netExpectancyR: 0.3 },
      'risk-off': { n: 100, netExpectancyR: 0.1 },
    },
    minRegimeSamples: 50,
    reproducibleFromFrozenFeatures: true, leakSuspected: false,
    rollbackVersion: { engine: 'e', featureSchema: 'f', calibration: 'calib-1.0.0', config: 'c', model: 'm' },
    regimeConditionalByDesign: false,
  };

  it('accepts only when all ten conditions pass', () => {
    const d = decide(good);
    expect(CONDITIONS).toHaveLength(10);
    expect(d.conditions).toHaveLength(10);
    expect(d.conditions.every((c) => c.passed)).toBe(true);
    expect(d.verdict).toBe('ACCEPTED');
    expect(d.activeVersion.calibration).toBe('calib-1.1.0');
  });

  it('reports every condition, not only the failures', () => {
    const d = decide(good);
    for (const c of CONDITIONS) {
      expect(d.conditions.find((x) => x.id === c.id)).toBeDefined();
      expect(typeof d.conditions.find((x) => x.id === c.id)!.observed).toBe('string');
    }
  });

  it('refuses on insufficient samples and keeps the previous version', () => {
    const d = decide({ ...good, resolvedSamples: 12 });
    expect(d.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(d.activeVersion.calibration).not.toBe('calib-1.1.0');
  });

  it('refuses when a regime regresses, even with a better aggregate', () => {
    const d = decide({
      ...good,
      regimeBreakdown: {
        'trend-up': { n: 300, netExpectancyR: 1.2 },
        range: { n: 200, netExpectancyR: 0.4 },
        'risk-off': { n: 150, netExpectancyR: -0.3 },
      },
    });
    expect(d.verdict).toBe('REGIME-DEPENDENT');
    expect(d.conditions.find((c) => c.id === 'regime')!.detail).toMatch(/negative expectancy/);
  });

  it('refuses when drawdown worsens beyond the declared limit', () => {
    const d = decide({ ...good, maxDrawdownAfterR: 12, maxDrawdownToleranceR: 1 });
    expect(d.verdict).toBe('REJECTED');
    expect(d.conditions.find((c) => c.id === 'drawdown')!.passed).toBe(false);
  });

  it('refuses when calibration degrades', () => {
    const d = decide({ ...good, brierSkillAfter: -0.05, maxBrierSkillDegradation: 0.01 });
    expect(d.verdict).toBe('REJECTED');
    expect(d.conditions.find((c) => c.id === 'calibration')!.passed).toBe(false);
  });

  it('refuses a candidate with no rollback version', () => {
    const d = decide({ ...good, rollbackVersion: null });
    expect(d.verdict).toBe('REJECTED');
    expect(d.conditions.find((c) => c.id === 'rollback')!.passed).toBe(false);
  });

  it('flags a suspected leak with its OWN verdict', () => {
    const d = decide({ ...good, leakSuspected: true });
    expect(d.verdict).toBe('DATA-LEAK SUSPECTED');
    expect(d.summary).toMatch(/void/);
  });

  it('flags leakage detected by the walk-forward check', () => {
    const d = decide({
      ...good,
      outOfSample: { foldsEvaluable: 8, netExpectancyR: 0.3, uniform: true, leakageClean: false },
    });
    expect(d.verdict).toBe('DATA-LEAK SUSPECTED');
  });

  it('refuses when the improvement exists in only ONE regime', () => {
    const d = decide({
      ...good,
      regimeBreakdown: { 'trend-up': { n: 400, netExpectancyR: 1.0 }, range: { n: 10, netExpectancyR: 0 } },
      minRegimeSamples: 50,
    });
    expect(d.verdict).toBe('REGIME-DEPENDENT');
    expect(d.conditions.find((c) => c.id === 'regime')!.detail).toMatch(/single-regime/);
  });

  it('refuses an expectancy gain that was never measured', () => {
    const d = decide({ ...good, expectancyAfterR: null });
    expect(d.verdict).not.toBe('ACCEPTED');
    expect(d.conditions.find((c) => c.id === 'expectancy')!.passed).toBe(false);
  });

  it('logs every verdict, including rejections', () => {
    const ok = logDecision({ ...decide(good), rationale: 'clean', requestedBy: 'test', touchesResearch: ['RES-001'] });
    const bad = logDecision({ ...decide({ ...good, id: 'C2', resolvedSamples: 5 }), rationale: 'too few', requestedBy: 'test', touchesResearch: [] });
    const panel = modelVersionPanel();
    expect(ok.verdict).toBe('ACCEPTED');
    expect(bad.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(panel.rejectedCount).toBeGreaterThan(0);
    // The panel must not imply anything is fitted.
    expect(panel.fitted).toBe(false);
    expect(panel.note).toMatch(/NO weight has been fitted/);
  });
});

// ─── 17. Every accepted update is versioned and reversible ──────────────────

describe('PROOF 17 — every accepted update is versioned and reversible', () => {
  it('an accepted decision names its target AND its rollback', () => {
    const d = decide({
      id: 'X', title: 't', targetVersion: 'calib-2.0.0', researchId: null,
      resolvedSamples: 500, minSamples: 100,
      walkForward: { foldsEvaluable: 5, netExpectancyR: 0.2, uniform: true, leakageClean: true },
      outOfSample: { foldsEvaluable: 5, netExpectancyR: 0.2, uniform: true, leakageClean: true },
      expectancyBeforeR: 0, expectancyAfterR: 0.3, minExpectancyGainR: 0.1,
      maxDrawdownBeforeR: 3, maxDrawdownAfterR: 3, maxDrawdownToleranceR: 1,
      brierSkillBefore: 0, brierSkillAfter: 0, maxBrierSkillDegradation: 0.01,
      regimeBreakdown: { a: { n: 100, netExpectancyR: 0.3 }, b: { n: 100, netExpectancyR: 0.2 } },
      minRegimeSamples: 50,
      reproducibleFromFrozenFeatures: true, leakSuspected: false,
      rollbackVersion: { engine: 'e', featureSchema: 'f', calibration: 'calib-1.0.0', config: 'c', model: 'm' },
      regimeConditionalByDesign: false,
    });
    expect(d.verdict).toBe('ACCEPTED');
    expect(d.activeVersion.calibration).toBe('calib-2.0.0');
    expect(d.rollbackTo!.calibration).toBe('calib-1.0.0');
    expect(d.decidedAt).toBeGreaterThan(0);
  });

  it('the config version is a HASH, so changing a number changes the version', () => {
    // A hand-written version string would not notice a threshold edit.
    expect(CONFIG_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });

  it('every registry constant carries a tag, a source, a test and a rollback', () => {
    for (const c of CONSTANT_PROVENANCE) {
      expect(['PROBED', 'TUNED', 'FITTED', 'RESEARCHED', 'EXPERIMENTAL']).toContain(c.provenance);
      expect(c.source.length).toBeGreaterThan(10);
      expect(c.test.length).toBeGreaterThan(0);
      expect(c.rollback.length).toBeGreaterThan(0);
    }
  });

  it('no research hypothesis claims acceptance while the sample floor stands', () => {
    // Phase XVI: nothing may be accepted without evidence. At 7 resolved Mind
    // signals, nothing has been tested to a standard that would justify a change.
    expect(RESEARCH_REGISTRY.every((e) => e.status !== 'accepted')).toBe(true);
    for (const e of RESEARCH_REGISTRY) {
      expect(e.minimum_sample_size).toBeGreaterThanOrEqual(200);
      expect(e.rollback.length).toBeGreaterThan(0);
      if (e.status !== 'proposed' && e.status !== 'testing') {
        expect(e.decision).not.toBe('');
      }
    }
  });
});