import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Isolate this suite's database BEFORE the store module is imported. The store
 * reads ORDERFLOW_DB at module load, so the variable has to be set first.
 */
const TEST_DB = resolve(__dirname, '../../data/test-ledger-stats.db');
process.env.ORDERFLOW_DB = TEST_DB;
beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${TEST_DB}${suffix}`;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

const { freezeSignal, markResolved, ledgerStats } = await import('../src/ledger/store.js');

import type { SignalSnapshot } from '../../shared/types.js';

/**
 * The ledger's REPORTED statistics — the M3.2 and M1.6 fixes, end to end.
 *
 * `ledger.stats.test.ts` proves the functions are right. This proves the
 * store actually USES them: a statistic that is correct in isolation and
 * wired to the wrong thing is the failure mode this repo keeps hitting.
 *
 * The numbers that were wrong:
 *
 *   M3.2  `avgR 3.50` and `profitFactor 9.15` on 337 winners that each banked
 *         ONE R at the nearest target.
 *   M1.6  `byVeto` with 102 keys for one policy decision.
 *
 * Every row is created in `beforeAll` so the assertions do not depend on the
 * order the tests happen to run in.
 */

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();

/**
 * A plan whose `rr` is the FURTHEST target (3R) while TP1 is one R.
 *
 * This is the M3.2 trap: a ledger that reads `plan.rr` reports 3R for a trade
 * that took profit at 1R.
 */
const SNAPSHOT: SignalSnapshot = {
  score: 62.5,
  grade: 'B',
  side: 'bullish',
  components: {
    structure: 20, orderFlow: 12, momentum: 10, positioning: 8,
    newsEvents: 5, macroRegime: 5, tradability: 3,
  },
  checklist: [],
  regime: 'range',
  setup: null,
  plan: {
    symbol: 'TESTUSDT', side: 'bullish',
    entryLow: 99, entryHigh: 101, entryMid: 100,
    stop: 98,
    targets: [
      { label: 'R1', price: 102, rr: 1, netR: 0 },
      { label: 'R2', price: 104, rr: 2, netR: 0 },
      { label: 'R3', price: 106, rr: 3, netR: 0 },
    ],
    rr: 3, noRoom: false, riskPerUnit: 2,
    qty: null, riskAmount: null, rewardAmount: null,
    costs: { feeBps: 10, feeAmount: null, fundingBps: 0, fundingAmount: null, slippageBps: 5, slippageAmount: null, totalBps: 15 },
    netR: null,
  },
  deriv: null,
  sector: 'Test',
  breadth: 'two-way',
  vwap: 99,
  newsNis: 0,
  newsDirection: 0,
  vetoes: [],
};

const N_TP1 = 40;
const N_STOP = 40;
const N_SHADOW_MOVE_14 = 20;
const N_SHADOW_MOVE_30 = 20;
const N_SHADOW_GRADE_C = 5;

function freeze(
  symbol: string,
  over: { shadow?: boolean; vetoReason?: string | null; score?: number } = {},
): string {
  const shadow = over.shadow ?? true;
  const id = freezeSignal(
    {
      symbol, side: 'bullish', grade: shadow ? 'C' : 'B', score: over.score ?? 62.5,
      shadow,
      vetoReason: over.vetoReason ?? null,
      rule: 'PICK', entryLow: 99, entryHigh: 101, stop: 98,
      targets: [102, 104, 106], riskPerUnit: 2, snapshot: SNAPSHOT,
    },
    NOW,
  );
  expect(id).not.toBeNull();
  return id as string;
}

function resolveAs(id: string, outcome: 'TP1' | 'TP2' | 'TP3' | 'STOP'): void {
  markResolved(
    id,
    {
      outcome,
      index: 3,
      price: outcome === 'STOP' ? 98 : outcome === 'TP1' ? 102 : outcome === 'TP2' ? 104 : 106,
      mfeR: 3, maeR: -0.3,
      rMultiple: outcome === 'STOP' ? -1 : outcome === 'TP1' ? 1 : outcome === 'TP2' ? 2 : 3,
      ambiguous: false,
      note: null,
    },
    NOW + 600_000,
  );
}

beforeAll(() => {
  // Real trades.
  for (let i = 0; i < N_TP1; i++) resolveAs(freeze(`ZZR${RUN}${i}`, { shadow: false }), 'TP1');
  for (let i = 0; i < N_STOP; i++) resolveAs(freeze(`ZZL${RUN}${i}`, { shadow: false }), 'STOP');
  resolveAs(freeze(`ZZT2${RUN}`, { shadow: false }), 'TP2');
  resolveAs(freeze(`ZZT3${RUN}`, { shadow: false }), 'TP3');

  // Shadow trades, blocked by the SAME policy at two different percentages.
  for (let i = 0; i < N_SHADOW_MOVE_14; i++) {
    resolveAs(freeze(`ZZV1${RUN}${i}`, { shadow: true, vetoReason: 'already moved 14.2% today — event risk' }), 'TP1');
  }
  for (let i = 0; i < N_SHADOW_MOVE_30; i++) {
    resolveAs(freeze(`ZZV2${RUN}${i}`, { shadow: true, vetoReason: 'already moved 30.2% today — event risk' }), 'TP1');
  }
  // Shadow trades with no veto at all: a grade-C setup.
  for (let i = 0; i < N_SHADOW_GRADE_C; i++) {
    resolveAs(freeze(`ZZC${RUN}${i}`, { shadow: true, vetoReason: null }), 'TP1');
  }
});

describe('the ledger reports the R that was actually realised', () => {
  it('credits TP1 at one R, not the plan\'s furthest three R', () => {
    const stats = ledgerStats('all');
    const n = N_TP1 + N_STOP + 2 + N_SHADOW_MOVE_14 + N_SHADOW_MOVE_30 + N_SHADOW_GRADE_C;
    // Winners: 40 TP1 at 1R, one TP2 at 2R, one TP3 at 3R, 45 shadow TP1 at 1R.
    // Losers: 40 stops at -1R.
    const sum = N_TP1 + 2 + 3 + (N_SHADOW_MOVE_14 + N_SHADOW_MOVE_30 + N_SHADOW_GRADE_C) - N_STOP;
    expect(stats.resolved).toBe(n);
    expect(stats.avgR).toBeCloseTo(sum / n, 2);
    // The old accounting (every winner at the plan's 3R) would have read ~1.74.
    expect(stats.avgR).toBeLessThan(1);
  });

  it('the profit factor is computed from the realised R, not the plan\'s', () => {
    const stats = ledgerStats('all');
    const grossWin = N_TP1 + 2 + 3 + (N_SHADOW_MOVE_14 + N_SHADOW_MOVE_30 + N_SHADOW_GRADE_C);
    expect(stats.profitFactor).toBeCloseTo(grossWin / N_STOP, 2);
    // The old accounting would have read 261/40 = 6.53.
    expect(stats.profitFactor).toBeLessThan(3);
  });

  it('a TP2 and a TP3 are credited their own targets, not the nearest', () => {
    // 40 TP1 at 1R and one TP2 at 2R would be indistinguishable if every
    // winner were credited 1R. The mean only lands on the right number when
    // the TP2 and TP3 are credited 2R and 3R.
    const stats = ledgerStats('all');
    const n = stats.resolved;
    const sum = N_TP1 + 2 + 3 + (N_SHADOW_MOVE_14 + N_SHADOW_MOVE_30 + N_SHADOW_GRADE_C) - N_STOP;
    expect(stats.avgR).toBeCloseTo(sum / n, 2);
  });
});

describe('the ledger groups vetoes by KIND', () => {
  it('the same rule with a different number is ONE group, not two', () => {
    const stats = ledgerStats('all');
    const keys = Object.keys(stats.byVeto);
    // The two reasons collapse into one kind.
    expect(keys).toContain('EVENT_RISK_MOVE');
    expect(keys).not.toContain('already moved 14.2% today — event risk');
    expect(stats.byVeto.EVENT_RISK_MOVE.n).toBe(N_SHADOW_MOVE_14 + N_SHADOW_MOVE_30);
    // And the number of categories stays small, rather than one per message.
    expect(keys.length).toBeLessThanOrEqual(4);
  });

  it('a shadow signal with no veto is its own kind, not a silent bucket', () => {
    const stats = ledgerStats('all');
    expect(stats.byVeto.GRADE_C.n).toBe(N_SHADOW_GRADE_C);
  });

  it('a real trade is grouped as "real"', () => {
    const stats = ledgerStats('all');
    expect(stats.byVeto.real.n).toBe(N_TP1 + N_STOP + 2);
  });
});

describe('the ledger reports the calibration ladder honestly', () => {
  it('isPredictive follows the three-state verdict, and never guesses', () => {
    const stats = ledgerStats('all');
    const expected =
      stats.monotonicity.verdict === 'MONOTONE' ? true
      : stats.monotonicity.verdict === 'NOT_MONOTONE' ? false
      : null;
    expect(stats.isPredictive).toBe(expected);
    expect(stats.monotonicity.reason.length).toBeGreaterThan(20);
  });
});
