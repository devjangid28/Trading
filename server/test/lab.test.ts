/**
 * The Engine Lab's backend proofs.
 *
 * Six things are proved here, and each one is a rule the brief stated:
 *
 *   1. The paper broker fills at the NEXT candle's open, with slippage, the
 *      taker fee and funding — not at the signal price.
 *   2. An ambiguous candle resolves STOP FIRST, and a gap through a level
 *      fills at the open.
 *   3. The risk gate stops a trade before any adapter sees it.
 *   4. The calibration panel reports coverage WITH the hit rate, and refuses
 *      to quote a rate below the sample floor.
 *   5. A review says "variance, no fault" when there was no fault.
 *   6. The learning loop refuses to fit on a single trade, refuses to promote
 *      a challenger that does not clearly beat the champion, and the drift
 *      monitor degrades to shadow-only.
 *
 * Plus: the testnet adapter is OFF by default, and the real-money executor
 * refuses everything.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const TEST_DB = resolve(process.cwd(), 'data/test-lab.db');

import {
  PaperBroker,
  BinanceTestnetAdapter,
  LiveExecutor,
  fundingEventsCrossed,
  applySlippage,
  slippageBps,
  type OrderIntent,
  type PaperOrder,
} from '../src/engine/lab/executor.js';
import { assessRisk, dailyLossHalted, dailyLossLimitUsd, type RiskState } from '../src/engine/lab/risk.js';
import { wilsonInterval, tierRows, reliabilityRows, calibrationReport, brier, logLoss } from '../src/engine/lab/calibration.js';
import { classifyTrade } from '../src/engine/lab/reviews.js';
import {
  retrainGate,
  promotionVerdict,
  driftMonitor,
  beyondPaperCriteria,
  nextVersion,
  type ModelEvaluation,
} from '../src/engine/lab/learning.js';
import { LAB, MIND } from '../src/config.js';

const FIVE_MIN = 5 * 60_000;
const HOUR = 60 * 60_000;
const NOW = 1_700_000_000_000;

function candle(t: number, o: number, h: number, l: number, c: number) {
  return { t, o, h, l, c, v: 1000, closed: true };
}

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    signalId: 'sig-1',
    symbol: 'BTCUSDT',
    side: 'bullish',
    plannedEntry: 100,
    stop: 98,
    targets: [104, 108],
    equityUsd: 100_000,
    riskPct: 0.005,
    decidedAt: NOW,
    sector: 'L1',
    pWin: 0.62,
    funding8h: null,
    ...overrides,
  };
}

// ─── 1. The paper broker ─────────────────────────────────────────────────────

describe('PROOF 1 — the paper fill is a real fill', () => {
  it('fills at the NEXT candle open, not at the signal price', async () => {
    const broker = new PaperBroker();
    const submitted = broker.submit(intent());
    expect(submitted.ok).toBe(true);
    const order = broker.get(submitted.orderId!);
    expect(order!.status).toBe('PENDING');
    expect(order!.entryPrice).toBeNull();

    // The next candle opens at 101, well away from the planned 100.
    broker.onCandleClose(candle(NOW + FIVE_MIN, 101, 101.5, 100.5, 101.2));

    const filled = broker.get(submitted.orderId!)!;
    expect(filled.status).toBe('OPEN');
    // The RAW reference is the candle open.
    expect(filled.referenceEntry).toBe(101);
    // The price actually paid is worse than the reference, by the slippage.
    expect(filled.entryPrice!).toBeGreaterThan(101);
    expect(filled.entryPrice!).toBeCloseTo(101 * (1 + slippageBps() / 10_000), 8);
  });

  it('charges the taker fee on the fill', () => {
    const broker = new PaperBroker();
    const id = broker.submit(intent())!.orderId!;
    broker.onCandleClose(candle(NOW + FIVE_MIN, 101, 101.5, 100.5, 101.2));
    const order = broker.get(id)!;
    const notional = order.entryPrice! * order.qty;
    expect(order.feeUsd).toBeCloseTo(notional * (LAB_PAPER_TAKER_FEE / 10_000), 8);
  });

  it('charges funding for every 8-hour boundary the trade crosses', () => {
    // Explicit UTC, so the test does not depend on the phase of NOW.
    const midnight = Date.UTC(2026, 0, 1, 0, 0, 0);
    const at = (h: number, day = 1) => Date.UTC(2026, 0, day, h, 0, 0);
    // 00:00 to 09:00 crosses the 08:00 boundary: one event.
    expect(fundingEventsCrossed(midnight, at(9))).toBe(1);
    // A trade entirely inside one window crosses none.
    expect(fundingEventsCrossed(at(1), at(2))).toBe(0);
    // A trade from 07:00 to 09:00 crosses one.
    expect(fundingEventsCrossed(at(7), at(9))).toBe(1);
    // A trade that straddles midnight crosses the 00:00 boundary.
    expect(fundingEventsCrossed(at(23), at(1, 2))).toBe(1);
  });

  it('pays funding on a long when the rate is positive', () => {
    const broker = new PaperBroker();
    const id = broker.submit(intent({ funding8h: 0.0003 }))!.orderId!;
    broker.onCandleClose(candle(NOW + FIVE_MIN, 101, 101.5, 100.5, 101.2));
    // Walk past the expiry so the position closes, and across at least one
    // 8-hour funding boundary on the way.
    const end = NOW + (LAB.POSITION_EXPIRY_HOURS + 1) * HOUR;
    for (let t = NOW + 2 * FIVE_MIN; t <= end; t += FIVE_MIN) {
      broker.onCandleClose(candle(t, 101, 101.5, 100.5, 101.2));
    }
    const order = broker.get(id)!;
    expect(order.status).toBe('CLOSED');
    expect(order.fundingUsd).toBeGreaterThan(0);
  });

  it('resolves an ambiguous candle STOP FIRST', () => {
    const broker = new PaperBroker();
    const id = broker.submit(intent())!.orderId!;
    broker.onCandleClose(candle(NOW + FIVE_MIN, 100, 100.5, 99.5, 100.2));
    // One candle covers BOTH the stop (98) and the target (104).
    broker.onCandleClose(candle(NOW + 2 * FIVE_MIN, 100, 105, 97, 101));
    const order = broker.get(id)!;
    expect(order.status).toBe('CLOSED');
    expect(order.closeReason).toBe('STOP');
    expect(order.ambiguous).toBe(true);
  });

  it('fills a gap through the stop at the OPEN, which is worse than the stop', () => {
    const broker = new PaperBroker();
    const id = broker.submit(intent())!.orderId!;
    broker.onCandleClose(candle(NOW + FIVE_MIN, 100, 100.5, 99.5, 100.2));
    // The candle GAPS down through the stop: it opens at 95.
    broker.onCandleClose(candle(NOW + 2 * FIVE_MIN, 95, 96, 94, 95.5));
    const order = broker.get(id)!;
    expect(order.closeReason).toBe('STOP');
    // The reference exit is the open, not the stop price.
    expect(order.referenceExit).toBe(95);
    expect(order.referenceExit!).toBeLessThan(98);
  });

  it('fills a gap through a target at the OPEN, which is better than the target', () => {
    const broker = new PaperBroker();
    const id = broker.submit(intent())!.orderId!;
    broker.onCandleClose(candle(NOW + FIVE_MIN, 100, 100.5, 99.5, 100.2));
    // The candle GAPS up through TP1: it opens at 106.
    broker.onCandleClose(candle(NOW + 2 * FIVE_MIN, 106, 107, 105.5, 106.5));
    const order = broker.get(id)!;
    expect(order.closeReason).toBe('TARGET');
    expect(order.referenceExit).toBe(106);
    expect(order.referenceExit!).toBeGreaterThan(104);
  });

  it('expires a position that hits neither level', () => {
    const broker = new PaperBroker();
    const id = broker.submit(intent())!.orderId!;
    broker.onCandleClose(candle(NOW + FIVE_MIN, 100, 100.5, 99.5, 100.2));
    // Walk forward past the expiry.
    const end = NOW + (LAB.POSITION_EXPIRY_HOURS + 1) * HOUR;
    for (let t = NOW + 2 * FIVE_MIN; t <= end; t += FIVE_MIN) {
      broker.onCandleClose(candle(t, 100, 100.4, 99.6, 100));
    }
    const order = broker.get(id)!;
    expect(order.status).toBe('CLOSED');
    expect(order.closeReason).toBe('EXPIRED');
  });

  it('never reports a gross R that ignores the costs', () => {
    const broker = new PaperBroker();
    const id = broker.submit(intent())!.orderId!;
    broker.onCandleClose(candle(NOW + FIVE_MIN, 100, 100.5, 99.5, 100.2));
    broker.onCandleClose(candle(NOW + 2 * FIVE_MIN, 100, 105, 99.8, 104.5));
    const order = broker.get(id)!;
    const r = PaperBroker.realisedR(order);
    expect(r.grossR).not.toBeNull();
    expect(r.netR).not.toBeNull();
    // The net is worse than the gross, because the costs are real.
    expect(r.netR!).toBeLessThan(r.grossR!);
    expect(r.costR!).toBeGreaterThan(0);
  });

  it('applies slippage always in the direction that hurts', () => {
    expect(applySlippage(100, 'bullish', 5)).toBeGreaterThan(100);
    expect(applySlippage(100, 'bearish', 5)).toBeLessThan(100);
  });
});

// The fee constant is mirrored here so the test does not depend on the import
// order of a value that the config owns.
const LAB_PAPER_TAKER_FEE = 5;

// ─── 2. The risk gate ────────────────────────────────────────────────────────

describe('PROOF 2 — the risk gate stops a trade before any adapter sees it', () => {
  const base: RiskState = {
    killSwitch: false,
    realisedPnlUsdToday: 0,
    realisedNetRToday: 0,
    equityUsd: 100_000,
    openPositions: [],
    macroBlackoutMin: 600,
    shadowOnly: false,
  };

  it('stops everything when the kill switch is on', () => {
    const d = assessRisk({ ...base, killSwitch: true }, intent());
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe('KILL_SWITCH');
  });

  it('halts for the day when the realised loss reaches the limit', () => {
    const limit = dailyLossLimitUsd(100_000);
    expect(limit).toBeCloseTo(100_000 * (LAB.MAX_DAILY_LOSS_PCT / 100), 6);
    const at = assessRisk({ ...base, realisedPnlUsdToday: -limit }, intent());
    expect(at.allowed).toBe(false);
    expect(at.rule).toBe('DAILY_LOSS_HALT');
    // One cent above the loss is NOT a halt.
    const under = assessRisk({ ...base, realisedPnlUsdToday: -limit + 1 }, intent());
    expect(under.allowed).toBe(true);
  });

  it('records the halt with a reason in words', () => {
    const h = dailyLossHalted({ ...base, realisedPnlUsdToday: -10_000 });
    expect(h.halted).toBe(true);
    expect(h.reason).toBeTruthy();
    expect(h.reason!.length).toBeGreaterThan(20);
  });

  it('blocks inside a macro blackout', () => {
    const d = assessRisk({ ...base, macroBlackoutMin: -5 }, intent());
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe('MACRO_BLACKOUT');
  });

  it('blocks in shadow-only mode', () => {
    const d = assessRisk({ ...base, shadowOnly: true }, intent());
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe('SHADOW_ONLY');
  });

  it('blocks when too many positions are already open', () => {
    const opens = Array.from({ length: LAB.MAX_CONCURRENT_POSITIONS }, (_, i) => ({
      symbol: `X${i}USDT`,
      side: 'bullish' as const,
      sector: 'L2',
      riskUsd: 100,
    }));
    const d = assessRisk({ ...base, openPositions: opens }, intent());
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe('MAX_CONCURRENT_POSITIONS');
  });

  it('blocks a trade that risks more than the per-trade limit', () => {
    const d = assessRisk({ ...base }, intent({ riskPct: 0.05 }));
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe('MAX_RISK_PER_TRADE');
  });

  it('blocks a trade that would breach the sector exposure limit', () => {
    const opens = Array.from({ length: 2 }, (_, i) => ({
      symbol: `X${i}USDT`,
      side: 'bullish' as const,
      sector: 'L1',
      riskUsd: 15_000,
    }));
    const d = assessRisk({ ...base, openPositions: opens }, intent({ sector: 'L1' }));
    expect(d.allowed).toBe(false);
    expect(d.rule).toBe('MAX_SECTOR_EXPOSURE');
  });

  it('allows a trade that clears every limit', () => {
    const d = assessRisk({ ...base }, intent());
    expect(d.allowed).toBe(true);
    expect(d.rule).toBeNull();
    expect(d.reason.length).toBeGreaterThan(10);
  });
});

// ─── 3. Calibration ──────────────────────────────────────────────────────────

describe('PROOF 3 — coverage and hit rate are always reported together', () => {
  it('computes a Wilson interval that stays inside [0,1]', () => {
    const ci = wilsonInterval(30, 30, LAB.WILSON_Z)!;
    expect(ci[0]).toBeGreaterThan(0);
    // The raw Wilson upper bound for a perfect record is marginally above 1
    // (1.0004 for n=30), so it is presented clamped at 1. The INFORMATIVE half
    // is the lower bound, and it is far below 1: 30 out of 30 is not proof.
    expect(ci[1]).toBeLessThanOrEqual(1);
    expect(ci[0]).toBeLessThan(0.9);
    // A 50% record on 100 has an interval around 50%. The interval is a
    // PROPORTION here (0-1); the tier table converts it to a percentage.
    const mid = wilsonInterval(50, 100, LAB.WILSON_Z)!;
    expect(mid[0]).toBeLessThan(0.5);
    expect(mid[1]).toBeGreaterThan(0.5);
    expect(mid[0]).toBeGreaterThan(0.39);
    expect(mid[1]).toBeLessThan(0.61);
  });

  it('returns no interval when there are no observations', () => {
    expect(wilsonInterval(0, 0, LAB.WILSON_Z)).toBeNull();
  });

  it('quotes the hit rate only above the sample floor, and says why below it', () => {
    const trades = Array.from({ length: 10 }, (_, i) => ({
      p: 0.95,
      y: 1 as const,
      netR: 1,
      cluster: `S${i}`,
    }));
    const tiers = tierRows(trades);
    const top = tiers[tiers.length - 1];
    expect(top.n).toBe(10);
    // Below the floor: no rate, and the reason says how many and what floor.
    expect(top.hitRatePct).toBeNull();
    expect(top.reason).toContain('10');
    expect(top.reason).toContain(String(LAB.TIER_MIN_TRADES));
    // The COVERAGE is still reported: it is not a rate.
    expect(top.coveragePct).toBeCloseTo(100, 4);
  });

  it('quotes the hit rate WITH the coverage when the tier is big enough', () => {
    const trades = Array.from({ length: LAB.TIER_MIN_TRADES + 10 }, (_, i) => ({
      p: 0.95,
      y: (i % 10 === 0 ? 0 : 1) as 0 | 1,
      netR: 1,
      cluster: `S${i}`,
    }));
    const tiers = tierRows(trades);
    const top = tiers[tiers.length - 1];
    expect(top.hitRatePct).not.toBeNull();
    expect(top.hitRateCi).not.toBeNull();
    expect(top.coveragePct).toBeCloseTo(100, 4);
  });

  it('reports every configured threshold', () => {
    const tiers = tierRows([]);
    expect(tiers.map((t) => t.threshold)).toEqual([...LAB.TIER_THRESHOLDS]);
    for (const t of tiers) {
      expect(t.hitRatePct).toBeNull();
      expect(t.reason).toBeTruthy();
    }
  });

  it('computes the Brier score and the log loss', () => {
    expect(brier([{ p: 1, y: 1 }])).toBe(0);
    expect(brier([{ p: 0, y: 1 }])).toBe(1);
    expect(brier([])).toBeNull();
    expect(logLoss([])).toBeNull();
    expect(logLoss([{ p: 0.5, y: 1 }])).toBeCloseTo(Math.log(2), 10);
  });

  it('says "no evidence" rather than "uncalibrated" when there is nothing to score', () => {
    const rep = calibrationReport([]);
    expect(rep.n).toBe(0);
    expect(rep.brier).toBeNull();
    expect(rep.verdict).toContain('absence of evidence');
  });

  it('excludes censored trades from the decided population and counts them', () => {
    const rep = calibrationReport([
      { p: 0.7, y: 1, netR: 1, cluster: 'A' },
      { p: 0.3, y: 0, netR: -1, cluster: 'A' },
      { p: 0.5, y: null, netR: 0.2, cluster: 'B' },
    ]);
    expect(rep.n).toBe(2);
    expect(rep.censored).toBe(1);
  });

  it('produces a reliability table with a gap per populated bucket', () => {
    const rows = reliabilityRows([
      { p: 0.05, y: 0 },
      { p: 0.95, y: 1 },
    ]);
    const populated = rows.filter((r) => r.n > 0);
    expect(populated.length).toBe(2);
    for (const r of populated) {
      expect(r.gap).not.toBeNull();
    }
  });
});

// ─── 4. The reviews ──────────────────────────────────────────────────────────

describe('PROOF 4 — "variance, no fault" is a verdict', () => {
  const baseEvidence = {
    predictedPWin: 0.62,
    outcome: 0 as 0 | 1 | null,
    outcomeLabel: 'STOP',
    grossR: -1,
    netR: -1.2,
    costR: 0.2,
    features: null,
    newsDuringTrade: null,
    regimeAtEntry: 'quiet',
    regimeAtExit: 'quiet',
    mfeR: 0.4,
    maeR: -1.05,
    coverage: { measured: 50, total: 52 },
  };

  it('calls a clean loss variance, and says no change', () => {
    const v = classifyTrade(baseEvidence);
    expect(v.failureClass).toBe('variance');
    expect(v.noFault).toBe(true);
    expect(v.note.toLowerCase()).toContain('variance');
  });

  it('calls a win "no fault, no change"', () => {
    const v = classifyTrade({ ...baseEvidence, outcome: 1, outcomeLabel: 'TP1', grossR: 1, netR: 0.8 });
    expect(v.failureClass).toBe('no-fault-no-change');
    expect(v.noFault).toBe(true);
  });

  it('calls an expiry a censored observation, not a failure', () => {
    const v = classifyTrade({ ...baseEvidence, outcome: null, outcomeLabel: 'EXPIRED', grossR: 0.2, netR: 0 });
    expect(v.failureClass).toBe('variance');
    expect(v.note).toContain('CENSORED');
    expect(v.noFault).toBe(true);
  });

  it('calls a headline that landed during the trade a news shock', () => {
    const v = classifyTrade({ ...baseEvidence, newsDuringTrade: { nis: 80, publishedAt: NOW } });
    expect(v.failureClass).toBe('news-shock');
    expect(v.noFault).toBe(false);
  });

  it('calls a thin feature vector a data problem', () => {
    const v = classifyTrade({ ...baseEvidence, coverage: { measured: 10, total: 52 } });
    expect(v.failureClass).toBe('data-problem');
    expect(v.note).toContain('must not train');
  });

  it('calls a winner eaten by costs a cost drag', () => {
    const v = classifyTrade({ ...baseEvidence, grossR: 0.5, netR: -0.1 });
    expect(v.failureClass).toBe('cost-drag');
  });

  it('calls a regime change a regime misread', () => {
    const v = classifyTrade({ ...baseEvidence, regimeAtExit: 'risk-off' });
    expect(v.failureClass).toBe('regime-misread');
  });
});

// ─── 5. The learning loop ────────────────────────────────────────────────────

describe('PROOF 5 — the learning loop does not learn from one trade', () => {
  it('refuses a retrain until a full batch has arrived', () => {
    const gate = retrainGate(LAB.RETRAIN_BATCH_SIZE - 1, 500);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('noise');
    const ok = retrainGate(LAB.RETRAIN_BATCH_SIZE, 500);
    expect(ok.allowed).toBe(true);
  });

  it('refuses a retrain until there are enough rows to fit', () => {
    const gate = retrainGate(100, LAB.RETRAIN_MIN_ROWS - 1);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('floor');
  });

  it('will not promote a challenger whose intervals overlap the champion', () => {
    const champion: ModelEvaluation = {
      folds: [],
      oosTrades: 200,
      oosBrier: 0.2,
      oosBrierBaseRate: 0.25,
      oosLogLoss: 0.6,
      oosExpectancyR: 0.1,
      oosExpectancyCi: [0.01, 0.19],
      oosBrierCi: [0.18, 0.22],
      baseRate: 0.55,
    };
    const challenger: ModelEvaluation = {
      ...champion,
      oosExpectancyR: 0.12,
      oosExpectancyCi: [0.0, 0.24],
      oosBrierCi: [0.17, 0.23],
    };
    const v = promotionVerdict(champion, challenger);
    expect(v.promote).toBe(false);
    expect(v.reason).toContain('overlap');
  });

  it('promotes a challenger that beats the champion on BOTH with non-overlapping CIs', () => {
    const champion: ModelEvaluation = {
      folds: [],
      oosTrades: 200,
      oosBrier: 0.2,
      oosBrierBaseRate: 0.25,
      oosLogLoss: 0.6,
      oosExpectancyR: 0.1,
      oosExpectancyCi: [0.01, 0.19],
      oosBrierCi: [0.18, 0.22],
      baseRate: 0.55,
    };
    const challenger: ModelEvaluation = {
      ...champion,
      oosTrades: 200,
      oosExpectancyR: 0.3,
      oosExpectancyCi: [0.22, 0.38],
      oosBrierCi: [0.14, 0.17],
    };
    const v = promotionVerdict(champion, challenger);
    expect(v.promote).toBe(true);
    expect(v.reason).toContain('non-overlapping');
  });

  it('will not promote a challenger with too few out-of-sample trades', () => {
    const champion: ModelEvaluation = {
      folds: [],
      oosTrades: 200,
      oosBrier: 0.2,
      oosBrierBaseRate: 0.25,
      oosLogLoss: 0.6,
      oosExpectancyR: 0.1,
      oosExpectancyCi: [0.01, 0.19],
      oosBrierCi: [0.18, 0.22],
      baseRate: 0.55,
    };
    const challenger: ModelEvaluation = { ...champion, oosTrades: 5, oosExpectancyCi: [0.5, 0.9], oosBrierCi: [0.01, 0.02] };
    const v = promotionVerdict(champion, challenger);
    expect(v.promote).toBe(false);
    expect(v.blockedBy.join(' ')).toContain('out-of-sample');
  });

  it('never promotes itself beyond paper and testnet', () => {
    const c = beyondPaperCriteria({
      days: 365,
      paperTrades: 1000,
      expectancyCiLowerBound: 0.5,
      calibrationWithinTolerance: true,
      driftGreen: true,
    });
    expect(c.met).toBe(false);
    expect(c.blockedBy.join(' ')).toContain('manual approval');
  });

  it('names everything that is still missing before paper and testnet', () => {
    const c = beyondPaperCriteria({
      days: 3,
      paperTrades: 10,
      expectancyCiLowerBound: null,
      calibrationWithinTolerance: null,
      driftGreen: null,
    });
    expect(c.met).toBe(false);
    const joined = c.blockedBy.join(' ');
    expect(joined).toContain('days of paper trading');
    expect(joined).toContain('paper trades');
    expect(joined).toContain('confidence interval');
    expect(joined).toContain('calibration');
    expect(joined).toContain('drift monitor');
  });

  it('degrades to shadow-only when the live window drifts from validation', () => {
    const d = driftMonitor({
      liveTrades: Array.from({ length: LAB.DRIFT_WINDOW }, (_, i) => ({
        p: 0.8,
        y: 0 as 0 | 1,
        netR: -0.2,
        cluster: `S${i}`,
      })),
      validationBrier: 0.2,
      validationExpectancyR: 0.1,
    });
    expect(d.state).toBe('DEGRADED');
    expect(d.shadowOnlyForced).toBe(true);
    expect(d.reason.length).toBeGreaterThan(20);
  });

  it('says UNKNOWN, not GREEN, when there is not enough live evidence', () => {
    const d = driftMonitor({
      liveTrades: [{ p: 0.8, y: 1, netR: 1, cluster: 'A' }],
      validationBrier: 0.2,
      validationExpectancyR: 0.1,
    });
    expect(d.state).toBe('UNKNOWN');
    expect(d.shadowOnlyForced).toBe(false);
    expect(d.reason.toLowerCase()).toContain('not enough to tell');
  });

  it('stays GREEN when the live window is inside the validation envelope', () => {
    const d = driftMonitor({
      liveTrades: Array.from({ length: LAB.DRIFT_WINDOW }, (_, i) => ({
        p: 0.55,
        y: 1 as 0 | 1,
        netR: 0.1,
        cluster: `S${i}`,
      })),
      validationBrier: 0.24,
      validationExpectancyR: 0.1,
    });
    expect(d.state).toBe('GREEN');
    expect(d.shadowOnlyForced).toBe(false);
  });

  it('versions the models in order', () => {
    expect(nextVersion([])).toBe('lab-1.0.0');
    expect(nextVersion([
      { version: 'lab-1.0.0' } as never,
      { version: 'lab-1.2.3' } as never,
    ])).toBe('lab-1.3.0');
  });
});

// ─── 6. The executors ────────────────────────────────────────────────────────

describe('PROOF 6 — real money is not built and the testnet is off by default', () => {
  it('the testnet adapter is unavailable by default, and says why', () => {
    const a = new BinanceTestnetAdapter();
    const v = a.available();
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('OFF by default');
  });

  it('the testnet adapter never exposes the key', () => {
    const a = new BinanceTestnetAdapter();
    expect(JSON.stringify(a)).not.toContain('API_KEY');
    expect(a.configured()).toBe(false);
  });

  it('the real-money executor refuses everything and says what it would take', async () => {
    const live = new LiveExecutor();
    const v = live.available();
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('NOT BUILT');
    expect(v.reason).toContain('90');
    expect(v.reason).toContain('300');
    expect(v.reason).toContain('approval');
    const o = await live.open();
    expect(o.ok).toBe(false);
    expect(o.fill).toBeNull();
  });

  it('the paper broker is always available', () => {
    expect(new PaperBroker().available().ok).toBe(true);
  });
});

// ─── 7. The Lab's own store ──────────────────────────────────────────────────

describe('PROOF 7 — the Lab store keeps its own evidence', () => {
  beforeEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB, { force: true });
    for (const suffix of ['-wal', '-shm']) {
      const f = `${TEST_DB}${suffix}`;
      if (existsSync(f)) rmSync(f, { force: true });
    }
    process.env.ORDERFLOW_LAB_DB = TEST_DB;
  });

  it('stores a review, and the first write wins', async () => {
    const store = await import('../src/engine/lab/store.js');
    const review = {
      id: 'r1',
      signalId: 's1',
      positionId: 'p1',
      symbol: 'BTCUSDT',
      side: 'bullish' as const,
      openedAt: NOW,
      closedAt: NOW + HOUR,
      predictedPWin: 0.6,
      outcome: 0 as 0 | 1 | null,
      outcomeLabel: 'STOP',
      grossR: -1,
      netR: -1.2,
      costR: 0.2,
      failureClass: 'variance' as const,
      failureNote: 'No fault found.',
      noFault: true,
      featureSnapshot: null,
      snapshotUrl: null,
      createdAt: NOW,
    };
    store.saveReview(review);
    store.saveReview({ ...review, failureNote: 'A DIFFERENT note.' });
    const rows = store.listReviews();
    expect(rows).toHaveLength(1);
    expect(rows[0].failureNote).toBe('No fault found.');
    store.closeLab();
  });

  it('stores a model version with its weights', async () => {
    const store = await import('../src/engine/lab/store.js');
    store.saveModel({
      version: 'lab-1.0.0',
      role: 'CHAMPION',
      createdAt: NOW,
      trainedAt: NOW,
      trainedOnTrades: 100,
      featureSchema: 'lab-features-v1',
      fit: { lambda: 1 },
      model: { weights: [1, 2, 3] },
      oosExpectancyR: 0.1,
      oosBrier: 0.2,
      oosLogLoss: 0.6,
      oosTrades: 50,
      verdict: 'First champion.',
    });
    const models = store.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].version).toBe('lab-1.0.0');
    expect(store.modelInRole('CHAMPION')?.version).toBe('lab-1.0.0');
    store.closeLab();
  });
});

// The Mind actionability gate and the tier thresholds are two different things,
// and the Lab never lets one stand in for the other.
describe('PROOF 8 — the reporting thresholds and the decision thresholds are different numbers', () => {
  it('the tier thresholds are the ones the brief named', () => {
    expect([...LAB.TIER_THRESHOLDS]).toEqual([0.6, 0.7, 0.8, 0.9]);
  });

  it('the actionability gate is the Mind layer\'s, not a tier', () => {
    expect(MIND.ACTIONABLE_MIN_PROBABILITY).not.toBe(LAB.TIER_THRESHOLDS[0]);
  });
});

// A PaperOrder type is exported so the tests can build one without a broker.
export type { PaperOrder };
