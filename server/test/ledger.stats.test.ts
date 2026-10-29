import { describe, it, expect } from 'vitest';
import { realisedR, resolveOutcome, TARGET_WINS } from '../src/ledger/resolve.js';
import { testMonotonicity, spearman, pava, isotonicSlope } from '../src/ledger/monotonicity.js';
import { vetoKindOf, VETO_KINDS, VETO_KIND_LABEL } from '../src/engine/vetoKind.js';
import { evaluateVetoes } from '../src/engine/conviction.js';
import { LEDGER } from '../src/config.js';
import type { LedgerSignal, Outcome, SignalSnapshot } from '../../shared/types.js';

/**
 * The ledger's reported statistics — the M3.2, M1.5 and M1.6 fixes.
 *
 * These three all produced numbers that LOOKED fine:
 *
 *   M3.2  every winner was credited the FURTHEST target's R, so `avgR 3.50`
 *         and `profitFactor 9.15` described 337 trades that each banked one R.
 *   M1.5  the calibration check was `topAvg > bottomAvg` — no null hypothesis,
 *         no interval — and it reported `isPredictive: true` on a ladder that
 *         read 63.41 / 36.14 / 62.30 / 44.19.
 *   M1.6  the veto breakdown keyed on the RENDERED reason, so one policy
 *         decision became 102 categories, every one below the sample floor.
 */

const T0 = 1_800_000_000_000;
const BAR = 5 * 60_000;

// ─── A signal factory ─────────────────────────────────────────────────────────

function snapshot(over: { plan?: unknown } = {}): SignalSnapshot {
  const plan = over.plan === undefined
    ? {
        symbol: 'TESTUSDT', side: 'bullish' as const,
        entryLow: 99, entryHigh: 101, entryMid: 100,
        stop: 98, targets: [{ label: 'R1', price: 102, rr: 1 }, { label: 'R2', price: 104, rr: 2 }, { label: 'R3', price: 106, rr: 3 }],
        rr: 3, noRoom: false, riskPerUnit: 2,
        qty: null, riskAmount: null, rewardAmount: null,
        costs: { feeBps: 10, feeAmount: null, fundingBps: 0, fundingAmount: null, slippageBps: 5, slippageAmount: null, totalBps: 15 },
        netR: null,
      }
    : over.plan;
  return {
    score: 60, grade: 'B', side: 'bullish',
    components: {} as never, checklist: [], regime: 'range',
    setup: null, plan: plan as never, deriv: null,
    sector: 'Test', breadth: 'two-way', vwap: 100,
    newsNis: 0, newsDirection: 0, vetoes: [],
  };
}

function signal(over: {
  outcome?: Outcome;
  side?: 'bullish' | 'bearish';
  targets?: number[];
  priceAtResolve?: number | null;
  riskPerUnit?: number;
  plan?: unknown;
  entryZoneLow?: number;
  entryZoneHigh?: number;
  stop?: number;
  vetoReason?: string | null;
  shadow?: boolean;
  score?: number;
  grade?: 'A' | 'B' | 'C' | 'Pass' | 'NO TRADE';
} = {}): LedgerSignal {
  return {
    id: 'S1', symbol: 'TESTUSDT', side: over.side ?? 'bullish',
    grade: over.grade ?? 'B', score: over.score ?? 60,
    createdAt: T0,
    entryZoneLow: over.entryZoneLow ?? 99,
    entryZoneHigh: over.entryZoneHigh ?? 101,
    stop: over.stop ?? 98,
    targets: over.targets ?? [102, 104, 106],
    riskPerUnit: over.riskPerUnit ?? 2,
    snapshot: snapshot({ plan: over.plan }),
    outcome: over.outcome ?? 'OPEN',
    resolvedAt: T0 + 10 * BAR,
    mfeR: 1, maeR: -0.2,
    priceAtResolve: over.priceAtResolve ?? null,
    shadow: over.shadow ?? false,
    vetoReason: over.vetoReason ?? null,
    rule: 'PICK',
  };
}

// ─── M3.2: the R actually realised ────────────────────────────────────────────

describe('M3.2 — the R a trade actually realised', () => {
  it('a TP1 win is credited the NEAREST target, not the plan\'s furthest R', () => {
    // The plan quotes rr = 3 (the furthest target). The trade took TP1 at
    // 102, with an entry mid of 100 and a risk of 2 — one R.
    const r = realisedR(signal({ outcome: 'TP1' }));
    expect(r).toBeCloseTo(1, 6);
    expect(r).not.toBe(3);
  });

  it('TP2 and TP3 are credited their own targets', () => {
    expect(realisedR(signal({ outcome: 'TP2' }))).toBeCloseTo(2, 6);
    expect(realisedR(signal({ outcome: 'TP3' }))).toBeCloseTo(3, 6);
  });

  it('a stop is exactly -1 R', () => {
    expect(realisedR(signal({ outcome: 'STOP' }))).toBe(-1);
  });

  it('an expiry is marked to the resolving close', () => {
    // Entry mid 100, close 101, risk 2.
    expect(realisedR(signal({ outcome: 'EXPIRED', priceAtResolve: 101 }))).toBeCloseTo(0.5, 6);
  });

  it('an open signal has no realised R, and never a zero', () => {
    expect(realisedR(signal({ outcome: 'OPEN' }))).toBeNull();
  });

  it('a signal with no measurable risk has no R, and never a zero', () => {
    const s = signal({ outcome: 'TP1', riskPerUnit: 0, plan: null, entryZoneLow: 100, entryZoneHigh: 100, stop: 100 });
    expect(realisedR(s)).toBeNull();
  });

  it('a short credits the R with the sign flipped', () => {
    const s = signal({ outcome: 'TP1', side: 'bearish', targets: [98, 96, 94] });
    // Entry 100, TP1 at 98, risk 2 -> 1 R in the trade's direction.
    expect(realisedR(s)).toBeCloseTo(1, 6);
  });

  it('agrees with the resolver that produced the outcome', () => {
    // The strongest possible check: the ledger's R and the resolver's R are
    // the same number, because the resolver measured it and the ledger
    // recomputes it from the frozen levels.
    const resolved = resolveOutcome({
      side: 'bullish',
      entry: 100,
      stop: 98,
      targets: [102, 104, 106],
      riskPerUnit: 2,
      candles: [{ t: T0, h: 102.5, l: 99.5, c: 102 }],
      createdAt: T0,
      now: T0 + BAR,
    });
    expect(resolved.outcome).toBe('TP1');
    expect(resolved.rMultiple).toBeCloseTo(1, 6);

    const fromLedger = realisedR(signal({ outcome: resolved.outcome }));
    expect(fromLedger).toBeCloseTo(resolved.rMultiple as number, 6);
  });

  it('exports ONE definition of a win, shared with the ledger', () => {
    expect([...TARGET_WINS].sort()).toEqual(['TP1', 'TP2', 'TP3']);
  });
});

// ─── M1.5: monotonicity ───────────────────────────────────────────────────────

const OPTS = {
  minBucketN: 30,
  minBuckets: LEDGER.MONOTONICITY_MIN_BUCKETS,
  resamples: 500,
  permutations: 500,
  alpha: LEDGER.MONOTONICITY_ALPHA,
  seed: LEDGER.MONOTONICITY_SEED,
};

function bucket(lo: number, hi: number, winRate: number, n = 100) {
  return { lo, hi, n, winRate };
}

describe('M1.5 — the calibration ladder is tested, not eyeballed', () => {
  it('a genuinely monotone ladder is MONOTONE', () => {
    const r = testMonotonicity(
      [bucket(0, 20, 0.3), bucket(20, 35, 0.45), bucket(35, 50, 0.6), bucket(50, 65, 0.75)],
      OPTS,
    );
    expect(r.verdict).toBe('MONOTONE');
    expect(r.rho).toBeCloseTo(1, 6);
    expect(r.rhoCi![0]).toBeGreaterThan(0);
    expect(r.permutationP!).toBeLessThan(OPTS.alpha);
    expect(r.violations).toBe(0);
  });

  it('a genuinely INVERTED ladder is NOT_MONOTONE', () => {
    const r = testMonotonicity(
      [bucket(0, 20, 0.8), bucket(20, 35, 0.6), bucket(35, 50, 0.45), bucket(50, 65, 0.3)],
      OPTS,
    );
    expect(r.verdict).toBe('NOT_MONOTONE');
    expect(r.rho).toBeCloseTo(-1, 6);
    expect(r.rhoCi![1]).toBeLessThan(0);
  });

  it('the ladder the ledger actually has is NOT monotone, and the old check called it predictive', () => {
    // The real numbers, read from `/api/ledger` on 17 Oct 2026.
    const ladder = [bucket(0, 20, 0.6341), bucket(20, 35, 0.3614), bucket(35, 50, 0.623), bucket(50, 65, 0.4419)];

    // The OLD check: mean of the top half > mean of the bottom half.
    const bottomAvg = (ladder[0].winRate! + ladder[1].winRate!) / 2;
    const topAvg = (ladder[2].winRate! + ladder[3].winRate!) / 2;
    expect(topAvg > bottomAvg).toBe(true);

    // The NEW check says the truth.
    const r = testMonotonicity(ladder, OPTS);
    expect(r.verdict).not.toBe('MONOTONE');
    expect(r.violations).toBeGreaterThan(0);
  });

  it('a ladder with no association is INSUFFICIENT_EVIDENCE, not "predictive"', () => {
    // The win rate wanders: no ordering to find.
    const r = testMonotonicity(
      [bucket(0, 20, 0.5), bucket(20, 35, 0.52), bucket(35, 50, 0.48), bucket(50, 65, 0.5)],
      OPTS,
    );
    expect(r.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.rhoCi![0]).toBeLessThan(0);
    expect(r.rhoCi![1]).toBeGreaterThan(0);
  });

  it('a perfectly ORDERED ladder with a negligible effect is still only "unproven"', () => {
    // The ordering is perfect (rho = 1) but the whole ladder moves the win
    // rate by half a point. The bootstrap inside each bucket widens the
    // interval enough that the honest verdict is "not distinguishable from
    // noise" — which is the answer a trader needs.
    const r = testMonotonicity(
      [bucket(0, 20, 0.5), bucket(20, 35, 0.505), bucket(35, 50, 0.51), bucket(50, 65, 0.515)],
      OPTS,
    );
    expect(r.rho).toBeCloseTo(1, 6);
    expect(r.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.spread).toBeCloseTo(0.015, 4);
  });

  it('too few populated buckets is INSUFFICIENT_EVIDENCE, with the reason in words', () => {
    const r = testMonotonicity([bucket(0, 20, 0.3), bucket(20, 35, 0.6)], OPTS);
    expect(r.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.buckets).toBe(2);
    expect(r.reason).toContain('3 are needed to test monotonicity');
  });

  it('a bucket below the sample floor does not speak', () => {
    const r = testMonotonicity(
      [bucket(0, 20, 0.3, 200), bucket(20, 35, 0.9, 5), bucket(35, 50, 0.6, 200)],
      OPTS,
    );
    expect(r.buckets).toBe(2);
    expect(r.verdict).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('is deterministic: the same ladder prints the same numbers twice', () => {
    const ladder = [bucket(0, 20, 0.3), bucket(20, 35, 0.45), bucket(35, 50, 0.6), bucket(50, 65, 0.75)];
    const a = testMonotonicity(ladder, OPTS);
    const b = testMonotonicity(ladder, OPTS);
    expect(a).toEqual(b);
  });

  it('the verdict carries a reason in words, never a bare boolean', () => {
    const r = testMonotonicity(
      [bucket(0, 20, 0.3), bucket(20, 35, 0.45), bucket(35, 50, 0.6)],
      OPTS,
    );
    expect(r.reason.length).toBeGreaterThan(20);
    expect(r.reason).toContain('Spearman');
  });
});

describe('M1.5 — the statistics themselves', () => {
  it('Spearman is rank-based: a monotone but non-linear ladder scores 1', () => {
    expect(spearman([1, 2, 3, 4], [0.1, 0.2, 0.4, 0.9])).toBeCloseTo(1, 6);
  });

  it('Spearman handles ties with average ranks', () => {
    // ys has a tie, so a naive rank would give the wrong correlation.
    const r = spearman([1, 2, 3, 4], [0.5, 0.5, 0.9, 0.1]);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeLessThan(1);
  });

  it('the isotonic fit is non-decreasing by construction', () => {
    const fitted = pava([0.6, 0.2, 0.9, 0.1], [10, 10, 10, 10]);
    expect(fitted).not.toBeNull();
    for (let i = 1; i < fitted!.length; i++) {
      expect(fitted![i]).toBeGreaterThanOrEqual(fitted![i - 1] - 1e-12);
    }
  });

  it('the isotonic slope is never negative — it measures the SIZE of the trend', () => {
    const slope = isotonicSlope([0, 20, 40], [0.8, 0.2, 0.1], [100, 100, 100]);
    expect(slope).not.toBeNull();
    expect(slope!).toBeGreaterThanOrEqual(0);
  });
});

// ─── M1.6: veto kinds ─────────────────────────────────────────────────────────

describe('M1.6 — vetoes are grouped by KIND, not by the rendered string', () => {
  it('a null reason is a grade-C shadow, not an unknown veto', () => {
    expect(vetoKindOf(null)).toBe('GRADE_C');
    expect(vetoKindOf('')).toBe('GRADE_C');
  });

  it('an unrecognised reason is UNKNOWN — counted, never silently dropped', () => {
    expect(vetoKindOf('something the engine has never said')).toBe('UNKNOWN');
  });

  it('every kind has a human label', () => {
    for (const k of VETO_KINDS) {
      expect(VETO_KIND_LABEL[k]).toBeTruthy();
    }
  });

  it('the message the engine actually renders maps to the right kind', () => {
    // These are the REAL messages, produced by `evaluateVetoes` — not
    // hand-written approximations. If the engine changes a message, this
    // fails, which is the point: the classifier cannot drift from the source.
    const NOW = T0;
    const HOUR = 3600_000;
    const MIN = 60_000;

    const base = {
      symbol: 'TEST',
      side: 'bullish' as const,
      now: NOW,
      candles: [] as never[],
      news: [] as never[],
      events: [] as never[],
      unlocks: [] as never[],
      tradability: undefined as never,
      deriv: null as never,
    };

    const macro = evaluateVetoes({
      ...base,
      events: [{ id: 'fomc', title: 'FOMC statement', t: NOW + 10 * MIN, blackout: true, kind: 'FOMC' } as never],
    });
    expect(macro.length).toBeGreaterThan(0);
    expect(vetoKindOf(macro[0])).toBe('MACRO_BLACKOUT');

    const hack = evaluateVetoes({
      ...base,
      news: [{
        id: 'n1', headline: 'exchange hacked', source: 'x', publishedAt: NOW - 2 * HOUR,
        nis: 80, direction: -1, tags: ['HACK_EXCHANGE_MAJOR'], severityClass: 'CRITICAL', ageMinutes: 120,
      } as never],
    });
    expect(hack.length).toBeGreaterThan(0);
    expect(vetoKindOf(hack[0])).toBe('SECURITY_EVENT');

    const unlock = evaluateVetoes({
      ...base,
      unlocks: [{ token: 'TEST', date: new Date(NOW + 10 * HOUR).toISOString(), pct: 5, cliff: true, category: 'test', unverified: true }],
    });
    expect(unlock.length).toBeGreaterThan(0);
    expect(vetoKindOf(unlock[0])).toBe('TOKEN_UNLOCK');

    const depth = evaluateVetoes({
      ...base,
      tradability: { bidUsd: 100, askUsd: 100, spreadBps: 1 } as never,
    });
    expect(vetoKindOf(depth[0])).toBe('DEPTH');

    const spread = evaluateVetoes({
      ...base,
      tradability: { bidUsd: 500_000, askUsd: 500_000, spreadBps: 25 } as never,
    });
    expect(vetoKindOf(spread[0])).toBe('SPREAD');
  });

  it('the same rule with a different NUMBER is the same kind', () => {
    // This is the whole point: "already moved 14.2%" and "already moved 30.2%"
    // are the same policy decision.
    expect(vetoKindOf('already moved 14.2% today — event risk')).toBe('EVENT_RISK_MOVE');
    expect(vetoKindOf('already moved 30.2% today — event risk')).toBe('EVENT_RISK_MOVE');
    expect(vetoKindOf('already moved 14.2% today — event risk')).toBe(
      vetoKindOf('already moved 30.2% today — event risk'),
    );
  });

  it('a data-integrity block is its own kind, because it says nothing about the market', () => {
    expect(vetoKindOf('price stream is unavailable — no structural decision without a live price')).toBe('DATA_HEALTH');
    expect(vetoKindOf('macro calendar is unavailable — an unavailable calendar cannot clear a blackout (unknown != clear)')).toBe('DATA_HEALTH');
    expect(vetoKindOf('news feed unavailable — the catalyst context is unverified, and an empty feed is not "no news"')).toBe('DATA_HEALTH');
    expect(vetoKindOf('degraded: derivatives unavailable')).toBe('DATA_HEALTH');
  });
});
