import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Isolate this suite's database BEFORE the store module is imported. The store
 * reads ORDERFLOW_DB at module load, so the variable has to be set first.
 *
 * Without this, these fake "ZZ*" signals land in the real ledger and pollute
 * the calibration statistics with rows that describe no real trade.
 */
const TEST_DB = resolve(__dirname, '../../data/test-ledger.db');
process.env.ORDERFLOW_DB = TEST_DB;
beforeAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${TEST_DB}${suffix}`;
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

const {
  freezeSignal, markResolved, openSignals, listSignals, signalCount,
  recordGap, recentGaps, gapSummary, DB_PATH,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = await import('../src/ledger/store.js');

import type { SignalSnapshot } from '../../shared/types.js';
import type { Grade } from '../src/config.js';

/**
 * Store integration.
 *
 * The unit tests cover the resolver policy; these cover the persistence. The
 * reason they exist: `markResolved` shipped once with 8 values against 7 SQL
 * placeholders and with `rMultiple` written into the `mfe_r` column. The error
 * only appeared at runtime as "column index out of range", and the silent
 * column mix-up would have understated MFE on every record. Neither is
 * catchable by reading the code — only by running it.
 */

// The store resolves its own path; use that rather than recomputing it here.
const DB = DB_PATH;

// Unique per run. Signal ids are `symbol_side_createdAt`, so a fixed symbol
// and a fixed timestamp collide with whatever a previous run left behind.
const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const SYM = (base: string) => `ZZ${base}${RUN}`;
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
    stop: 98, targets: [{ label: 'R1', price: 104, rr: 2 }],
    rr: 2, noRoom: false, riskPerUnit: 2,
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

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

function freeze(symbol: string, side: 'bullish' | 'bearish' = 'bullish', shadow = true): string | null {
  return freezeSignal(
    {
      symbol, side, grade: shadow ? 'C' : ('B' as Grade), score: 62.5,
      shadow, vetoReason: shadow ? 'already moved 20% today - event risk' : null,
      rule: 'PICK', entryLow: 99, entryHigh: 101, stop: 98,
      targets: [104], riskPerUnit: 2, snapshot: SNAPSHOT,
    },
    NOW,
  );
}

describe('ledger store persistence', () => {
  it('opens a fresh database and creates the schema', () => {
    // signalCount() forces the lazy open(), so the file exists afterwards.
    expect(signalCount().total).toBe(0);
    expect(existsSync(DB)).toBe(true);
  });

  it('round-trips a signal through the database', () => {
    const symbol = SYM('TEST');
    const id = freeze(symbol);
    expect(id).not.toBeNull();

    const stored = listSignals(50).find((s) => s.id === id);
    expect(stored).toBeDefined();
    expect(stored!.symbol).toBe(symbol);
    expect(stored!.outcome).toBe('OPEN');
    expect(stored!.shadow).toBe(true);
    expect(stored!.vetoReason).toContain('event risk');
    expect(stored!.targets).toEqual([104]);
    expect(stored!.snapshot.components.structure).toBe(20);
  });

  it('marks a signal resolved without a placeholder mismatch', () => {
    const id = freeze(SYM('RESOLVE'));
    expect(id).not.toBeNull();

    // Regression guard: this call previously threw "column index out of
    // range" (8 values, 7 placeholders) and wrote rMultiple into mfe_r.
    markResolved(
      id!,
      { outcome: 'TP1', index: 3, price: 104, mfeR: 2.4, maeR: -0.3, rMultiple: 2 },
      NOW + 600_000,
    );

    const stored = listSignals(50).find((s) => s.id === id)!;
    expect(stored.outcome).toBe('TP1');
    expect(stored.mfeR).toBe(2.4);
    expect(stored.maeR).toBe(-0.3);
    expect(stored.priceAtResolve).toBe(104);
    expect(stored.resolvedAt).toBe(NOW + 600_000);
  });

  it('preserves MFE and MAE as distinct values', () => {
    const id = freeze(SYM('MFE'));
    expect(id).not.toBeNull();
    markResolved(id!, { outcome: 'STOP', index: 5, price: 98, mfeR: 3.28, maeR: -3.67, rMultiple: -1 }, NOW);
    const s = listSignals(50).find((x) => x.id === id)!;
    // If rMultiple leaked into mfe_r this would read -1 instead of 3.28.
    expect(s.mfeR).toBe(3.28);
    expect(s.maeR).toBe(-3.67);
  });

  it('refuses a second open signal for the same symbol and side', () => {
    const symbol = SYM('DUP');
    const first = freeze(symbol);
    expect(first).not.toBeNull();
    expect(freeze(symbol)).toBeNull();
  });

  it('allows both sides of the same symbol', () => {
    const symbol = SYM('BOTH');
    expect(freeze(symbol, 'bullish')).not.toBeNull();
    expect(freeze(symbol, 'bearish')).not.toBeNull();
    const rows = openSignals().filter((r) => r.symbol === symbol);
    expect(rows.length).toBe(2);
  });

  it('records downtime gaps so they are visible rather than implicit', () => {
    recordGap(SYM('GAP'), NOW - 3_600_000, NOW, 60);
    const gaps = recentGaps(50);
    expect(gaps.length).toBeGreaterThan(0);
    const s = gapSummary();
    expect(s.count).toBeGreaterThan(0);
    expect(s.totalMinutes).toBeGreaterThanOrEqual(60);
    expect(s.lastAt).not.toBeNull();
  });

  it('counts shadow and real separately', () => {
    const c = signalCount();
    expect(c.total).toBe(c.open + c.resolved);
    expect(c.shadow).toBeGreaterThan(0);
  });
});
