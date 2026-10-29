import { describe, it, expect } from 'vitest';
import { rankCandidates, scoreCandidate, idFor, type Candidate } from '../src/engine/mind/index.js';
import { buildFeatureVector, measured, absent } from '../src/engine/mind/index.js';
import { MIND } from '../src/config.js';
import type { Candle, FeatureVector, TradePlan, MindSignal } from '../../shared/types';

const FIVE_MIN = 5 * 60_000;
const BASE = 1_700_000_000_000;
const AS_OF = BASE + 60 * FIVE_MIN;

function series(count: number, base: number): Candle[] {
  return Array.from({ length: count }, (_, n) => {
    const o = 100 + n;
    return { t: base + n * FIVE_MIN, o, h: o + 2, l: o - 2, c: o + 1, v: 1000, closed: true };
  });
}

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
    costs: { feeBps: 5, feeAmount: 0, fundingBps: 0, fundingAmount: 0, slippageBps: 5, slippageAmount: 0, totalBps: 10 },
    netR: null,
    ...over,
  };
}

function vectorFor(symbol: string, over: Partial<FeatureVector> = {}): FeatureVector {
  const base = buildFeatureVector({
    symbol,
    side: 'bullish',
    asOf: AS_OF,
    candles: series(60, BASE),
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
      retest: 'retested-held',
      strength: measured(70, AS_OF),
      vwapDistFrac: measured(0.02, 0),
      displacementX: measured(2, AS_OF),
      choppiness: measured(0.3, AS_OF),
      ...over.structure,
    },
    positioning: {
      ...base.positioning,
      cvdSlope: measured(1, 0),
      fundingZ: measured(-0.5, 0),
      crowdedAgainst: measured(0, 0),
      ...over.positioning,
    },
    catalyst: {
      ...base.catalyst,
      newsDirection: 1,
      maxNis4h: measured(60, AS_OF),
      routineDominates: measured(0, AS_OF),
      reversalRisk: measured(0.1, AS_OF),
      ...over.catalyst,
    },
    regime: { ...base.regime, breadthRatio: measured(0.7, AS_OF), macroBlackoutMin: measured(600, AS_OF), ...over.regime },
    context: {
      ...base.context,
      eventRisk: measured(0.03, AS_OF),
      convictionMissingFrac: measured(0, AS_OF),
      ...over.context,
    },
  };
}

function candidate(symbol: string, over: Partial<Candidate> = {}): Candidate {
  // `symbol` is the pair; the base is what the board keys on. Stripping the
  // quote suffix here mirrors what the scanner does with real rows.
  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  return {
    base,
    symbol,
    side: 'bullish',
    features: vectorFor(symbol),
    regime: 'trending-bull',
    plan: plan(),
    ...over,
  };
}

const BASE_INPUT = { observedWinRate: 0.5347, resolvedSamples: 505 };

describe('ranking order', () => {
  it('sorts by rank, descending', () => {
    const b = rankCandidates([candidate('AAA'), candidate('BBB'), candidate('CCC')], BASE_INPUT, AS_OF);
    const ranks = b.signals.map((s) => s.rank);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]);
    }
  });

  it('actionable signals always sort above every non-actionable one', () => {
    const b = rankCandidates(
      [
        candidate('VETOED', {
          features: vectorFor('VETOED', {
            regime: { macroBlackoutMin: measured(5, AS_OF) } as Partial<FeatureVector['regime']>,
          }),
        }),
        candidate('GOOD'),
      ],
      BASE_INPUT,
      AS_OF,
    );
    const actionableIdx = b.signals.findIndex((s) => s.actionable);
    const vetoedIdx = b.signals.findIndex((s) => !s.actionable);
    if (actionableIdx !== -1 && vetoedIdx !== -1) {
      expect(actionableIdx).toBeLessThan(vetoedIdx);
    }
    // And the vetoed one is never actionable, whatever its rank.
    expect(b.signals[vetoedIdx].actionable).toBe(false);
  });

  it('is a total order — two identical scans give an identical board', () => {
    const input = [candidate('CCC'), candidate('AAA'), candidate('BBB')];
    const a = rankCandidates(input, BASE_INPUT, AS_OF);
    const b = rankCandidates([candidate('AAA'), candidate('BBB'), candidate('CCC')], BASE_INPUT, AS_OF);
    // Same set, different input order: the output order must not depend on it.
    expect(a.signals.map((s) => s.symbol)).toEqual(b.signals.map((s) => s.symbol));
  });

  it('a higher net R outranks a lower one at the same probability', () => {
    const b = rankCandidates(
      [
        candidate('SMALL', { plan: plan({ rr: 1, targets: [{ label: 'R1', price: 102.5, rr: 1, netR: 0 }] }) }),
        candidate('BIG', { plan: plan({ rr: 4, targets: [{ label: 'R1', price: 110, rr: 4, netR: 0 }] }) }),
      ],
      BASE_INPUT,
      AS_OF,
    );
    expect(b.signals[0].symbol).toBe('BIG');
  });

  it('not by raw strength — a strong setup with no room ranks zero', () => {
    const b = rankCandidates(
      [
        candidate('NOROOM', { plan: plan({ noRoom: true, rr: 0, targets: [] }) }),
        candidate('ROOM'),
      ],
      BASE_INPUT,
      AS_OF,
    );
    expect(b.signals.find((s) => s.symbol === 'NOROOM')!.rank).toBe(0);
    expect(b.signals[0].symbol).toBe('ROOM');
  });
});

describe('board bookkeeping', () => {
  it('counts bands, actionable and vetoed', () => {
    const b = rankCandidates([candidate('AAA'), candidate('BBB')], BASE_INPUT, AS_OF);
    expect(b.bands.high + b.bands.medium + b.bands.low).toBe(b.signals.length);
    expect(b.bands.actionable).toBe(b.actionable.length);
    expect(b.bands.vetoed).toBeLessThanOrEqual(b.signals.length);
  });

  it('counts veto reasons, most frequent first', () => {
    const b = rankCandidates(
      [
        candidate('A', { features: vectorFor('A', { regime: { macroBlackoutMin: measured(1, AS_OF) } as Partial<FeatureVector['regime']> }) }),
        candidate('B', { features: vectorFor('B', { regime: { macroBlackoutMin: measured(1, AS_OF) } as Partial<FeatureVector['regime']> }) }),
        candidate('C', {
          features: vectorFor('C', { catalyst: { ...vectorFor('C').catalyst, routineDominates: measured(1, AS_OF) } }),
        }),
      ],
      BASE_INPUT,
      AS_OF,
    );
    expect(b.vetoCounts[0].code).toBe('macro-blackout');
    expect(b.vetoCounts[0].n).toBe(2);
  });

  it('every signal carries an id, an asOf and the resolved base rate', () => {
    const b = rankCandidates([candidate('AAA')], BASE_INPUT, AS_OF);
    const s: MindSignal = b.signals[0];
    expect(s.id).toBe('AAA:bullish');
    expect(s.asOf).toBe(AS_OF);
    expect(b.base.source).toBe('ledger');
    expect(b.base.rate).toBeCloseTo(0.5347, 4);
  });

  it('uses ONE base rate for the whole board, so rows are comparable', () => {
    const b = rankCandidates([candidate('AAA'), candidate('BBB'), candidate('CCC')], BASE_INPUT, AS_OF);
    // Same anchor for every row: the probabilities differ only by feature push.
    expect(b.base.samples).toBe(505);
  });

  it('falls back to the prior and says so when the ledger is thin', () => {
    const b = rankCandidates([candidate('AAA')], { observedWinRate: null, resolvedSamples: 0 }, AS_OF);
    expect(b.base.source).toBe('prior');
    expect(b.base.rate).toBe(0.5);
  });

  it('an empty candidate list is an empty board, not a crash', () => {
    const b = rankCandidates([], BASE_INPUT, AS_OF);
    expect(b.signals).toHaveLength(0);
    expect(b.actionable).toHaveLength(0);
    expect(b.bands.high).toBe(0);
  });
});

describe('identity and lookup keys', () => {
  it('keys signals by BASE while reporting the pair', () => {
    // The board addresses rows by base (`APT`); the signal must be reportable as
    // the tradeable pair (`APTUSDT`). Keying the map by pair made every scanner
    // lookup miss and every row came back `mind: null` — found against a booted
    // mock server, not by a test, because both names typecheck fine.
    const b = rankCandidates([candidate('APTUSDT')], BASE_INPUT, AS_OF);
    expect(b.signals[0].id).toBe('APT:bullish');
    expect(b.signals[0].symbol).toBe('APTUSDT');
  });

  it('the scanner key and the signal id agree for a base that differs from the pair', () => {
    const b = rankCandidates([candidate('APTUSDT')], BASE_INPUT, AS_OF);
    expect(b.signals[0].id).toBe(idFor('APT', 'bullish'));
  });
});

describe('probability is never a binary signal', () => {
  it('no signal is ever reported as 1 or 0 unless vetoed', () => {
    const b = rankCandidates([candidate('AAA'), candidate('BBB')], BASE_INPUT, AS_OF);
    for (const s of b.signals) {
      if (s.vetoes.length > 0) {
        expect(s.probability).toBe(0);
      } else {
        expect(s.probability).toBeGreaterThan(0);
        expect(s.probability).toBeLessThan(1);
      }
    }
  });

  it('every non-vetoed signal carries a band and a net R', () => {
    const b = rankCandidates([candidate('AAA')], BASE_INPUT, AS_OF);
    const s = b.signals[0];
    expect(['high', 'medium', 'low']).toContain(s.confidenceBand);
    expect(Number.isFinite(s.netExpectedR)).toBe(true);
  });

  it('the band boundaries come from config, not magic numbers in the UI', () => {
    expect(MIND.BAND_HIGH).toBeGreaterThan(MIND.BAND_LOW);
    const s = scoreCandidate({
      features: vectorFor('AAA'),
      regime: 'trending-bull',
      plan: plan(),
      base: { rate: 0.99, samples: 1000, source: 'ledger' },
      id: 'band',
    });
    expect(s.confidenceBand).toBe('high');
  });
});

describe('actionability is a conjunction, never a single condition', () => {
  it('probability alone is not enough — net R must clear too', () => {
    // A very high probability with a plan whose costs exceed its reward.
    const b = rankCandidates(
      [
        candidate('THIN', {
          plan: plan({
            rr: 0.2,
            targets: [{ label: 'R1', price: 100.5, rr: 0.2, netR: 0 }],
            riskPerUnit: 1,
            entryMid: 100,
            costs: { feeBps: 5, feeAmount: 0, fundingBps: 0, fundingAmount: 0, slippageBps: 5, slippageAmount: 0, totalBps: 300 },
          }),
        }),
      ],
      { observedWinRate: 0.8, resolvedSamples: 1000 },
      AS_OF,
    );
    const s = b.signals[0];
    expect(s.probability).toBeGreaterThan(MIND.ACTIONABLE_MIN_PROBABILITY);
    expect(s.netExpectedR).toBeLessThan(MIND.ACTIONABLE_MIN_NET_R);
    expect(s.actionable).toBe(false);
  });
});