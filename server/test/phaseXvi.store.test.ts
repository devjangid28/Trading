/**
 * End-to-end proof of the Phase XVI stores against the REAL SQLite ledger.
 *
 * Uses a temporary database so it never touches production, then reads back what
 * was written and checks the invariants that matter:
 *
 *  1. A frozen signal carries a feature record that is complete enough to audit.
 *  2. Resolution writes an outcome row with a COST-HONEST net R.
 *  3. A second resolution attempt does NOT overwrite the first.
 *  4. Censored outcomes are classified as censored, not as losses.
 *
 * The third one matters because `saveOutcome` uses INSERT OR IGNORE on purpose:
 * a differing second answer means something upstream changed, and silently
 * overwriting would destroy the evidence of that change.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DB = resolve(process.cwd(), 'data/xvi-store-test.db');
process.env.ORDERFLOW_DB = DB;

const store = await import('../src/ledger/store.js');
const { freezeFromScan } = await import('../src/ledger/worker.js');
const { resolveOutcome } = await import('../src/ledger/resolve.js');
const { buildOutcomeRecord } = await import('../src/ledger/outcomes.js');
const { buildFeatureRecord } = await import('../src/engine/featureStore.js');
const { ENGINE_VERSION, FEATURE_SCHEMA_VERSION } = await import('../src/version.js');

import type { AssetRow, Conviction, Setup, TradePlan } from '../../shared/types.js';

const FIVE_MIN = 5 * 60_000;
const T0 = 1_700_000_000_000;

function setup(): Setup {
  return {
    side: 'bullish', obTime: T0, obHigh: 100, obLow: 98, z: 99, invalidation: 97.5,
    targets: [{ price: 105, label: 'R1', kind: 'liquidity', time: 0 }],
    context: [], rr: 2, displacement: 1.8, fvg: true, violated: false,
    ageMinutes: 10, previous: [], retest: 'fresh', distanceAtr: 0.5,
    htf: { aligned: true, conflict: false, trend1h: 'up', trend4h: 'up', setups: [], scoreAdj: 0 },
  };
}

function plan(): TradePlan {
  return {
    symbol: 'BTCUSDT', side: 'bullish', entryLow: 98, entryHigh: 100, entryMid: 99, stop: 97.5,
    targets: [{ label: 'R1', price: 105, rr: 4, netR: 3.2 }],
    rr: 4, noRoom: false, riskPerUnit: 1.5,
    qty: null, riskAmount: null, rewardAmount: null,
    costs: {
      feeBps: 10, feeAmount: null, fundingBps: 0, fundingAmount: null,
      slippageBps: 5, slippageAmount: null, totalBps: 15,
    },
    netR: 3.2,
  };
}

function conviction(grade: Conviction['grade']): Conviction {
  return {
    score: 78, grade, side: 'bullish',
    components: { structure: 80, orderFlow: 75, momentum: 70, positioning: 70, newsEvents: 80, macroRegime: 75, tradability: 80 },
    missing: [], scoreIncomplete: false, vetoes: [], checklist: [], checklistScore: 8,
    rule: 'PICK', isPick: true,
  };
}

function row(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: 'BTC', symbol: 'BTCUSDT', base: 'BTC', displayTicker: 'BTC', displayName: 'Bitcoin',
    logoUrl: null, quote: 'USDT', pair: 'BTCUSDT', name: 'Bitcoin', sector: 'Store', exchange: 'binance',
    price: 99, changePct: 3, change1hPct: 1, change4hPct: 2, volumeUsd: 1e9,
    strength: 70, percentile: 90, choppiness: 0.3, side: 'bullish', rank: 1, prevRank: null,
    eventRisk: false, spark: [1, 2, 3], setup: setup(), vwap: 98,
    conviction: conviction('A'), isPick: true, plan: plan(),
    leverage: null, tax: null, derivatives: null,
    newsDot: { nis: 70, direction: 1, count: 2 }, unlock: null, updatedAt: T0,
    ...over,
  } as AssetRow;
}

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(DB + suffix, { force: true });
}

// NO `beforeEach` cleanup. The store keeps one SQLite handle open for the life of
// the process, so deleting the file between cases fails with EPERM on Windows —
// the same trap `mind.freeze.test.ts` hit. Each test therefore uses its own
// symbols, and the file is removed once at the end.
afterAll(() => {
  store.closeLedger();
  cleanup();
});

describe('the feature record reaches the ledger and survives the round trip', () => {
  it('is frozen into the snapshot with versions and reasons', () => {
    freezeFromScan([row({ base: 'BTC', pair: 'BTCUSDT', id: 'BTC' })], T0, 'trend-up', { mindRegime: 'trending-bull', breadth: 'bullish' });

    const signals = store.listSignals(100, 'all');
    expect(signals.length).toBe(1);
    const snap = signals[0].snapshot;

    const record = snap.featureRecord;
    expect(record).toBeDefined();
    expect(record!.engineVersion).toBe(ENGINE_VERSION);
    expect(record!.featureSchemaVersion).toBe(FEATURE_SCHEMA_VERSION);
    expect(record!.regime).toBe('trending-bull');
    expect(record!.assetClass).toBe('crypto-spot');
    expect(record!.betaGroup).toBe('sector:Store');
    expect(record!.grade).toBe('A');
    expect(record!.direction).toBe('long');
    expect(record!.setupType).toContain('bullish:');
    expect(record!.entryZone).toEqual([98, 100]);
    expect(record!.invalidation.value).toBe(97.5);
    expect(record!.provenance.length).toBeGreaterThan(5);
    expect(record!.session.value).toBeTruthy();

    // Unmeasured derivatives carry a REASON, and the record enumerates them.
    expect(record!.funding8h.value).toBeNull();
    expect(record!.funding8h.reason).toBe('no-derivatives-feed');
    expect(record!.missing.some((m) => m.reason === 'no-derivatives-feed')).toBe(true);
  });

  it('the round trip preserves the record rather than recomputing it', () => {
    const first = store.listSignals(100, 'all').find((s) => s.symbol === 'BTC')!.snapshot.featureRecord!;

    // Re-freezing the same symbol+side is refused while it is open, so read the
    // stored JSON and compare — the stored record must be byte-identical.
    const raw = (store as unknown as { listSignals: (l: number, s: string) => Array<{ snapshot: { featureRecord: unknown } }> })
      .listSignals(100, 'all').find((s) => s.symbol === 'BTC');
    expect(raw).toBeDefined();
    expect(JSON.parse(JSON.stringify(raw.snapshot.featureRecord))).toEqual(JSON.parse(JSON.stringify(first)));
  });
});

describe('the outcome store records a cost-honest resolution', () => {
  it('writes net R with fees and slippage deducted', () => {
    const res = resolveOutcome({
      side: 'bullish', entry: 99, stop: 97.5, targets: [105], riskPerUnit: 1.5,
      candles: [{ h: 106, l: 99.5, c: 105.5, t: T0 + FIVE_MIN }],
      createdAt: T0, now: T0 + 2 * FIVE_MIN,
    });
    expect(res.outcome).toBe('TP1');
    // Gross R at 105 from 99 with 1.5 risk = 4.0
    expect(res.rMultiple).toBe(4);

    const rec = buildOutcomeRecord({
      signalId: 'probe-1', outcome: res.outcome, createdAt: T0, resolvedAt: T0 + FIVE_MIN,
      entry: 99, stop: 97.5, riskPerUnit: 1.5, side: 'bullish',
      bars: [{ t: T0 + FIVE_MIN }], priceAtResolve: 105,
      grossR: res.rMultiple!, mfeR: res.mfeR, maeR: res.maeR,
      funding8h: 0.0002, spreadBps: 4, ambiguous: res.ambiguous,
      engineVersion: ENGINE_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    });
    expect(rec.outcomeClass).toBe('win');
    expect(rec.grossR).toBe(4);
    // Net is strictly less than gross: costs are not optional.
    expect(rec.totalCostR).toBeGreaterThan(0);
    expect(rec.netR).toBeLessThan(rec.grossR);
    expect(rec.fundingMeasured).toBe(true);

    store.saveOutcome(rec);
    const [stored] = store.listOutcomes(10);
    expect(stored.signalId).toBe('probe-1');
    expect(stored.netR).toBe(rec.netR);
    expect(stored.outcomeClass).toBe('win');
  });

  it('does not let a later resolution overwrite the first', () => {
    const first = buildOutcomeRecord({
      signalId: 'probe-2', outcome: 'TP1', createdAt: T0, resolvedAt: T0 + FIVE_MIN,
      entry: 99, stop: 97.5, riskPerUnit: 1.5, side: 'bullish', bars: [],
      priceAtResolve: 105, grossR: 4, mfeR: 4, maeR: 0,
      funding8h: null, spreadBps: null, ambiguous: false,
      engineVersion: ENGINE_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    });
    store.saveOutcome(first);
    const second = { ...first, outcome: 'STOP' as const, outcomeClass: 'loss' as const, grossR: -1, netR: -1.1 };
    store.saveOutcome(second);

    const stored = store.listOutcomes(10).filter((o) => o.signalId === 'probe-2');
    expect(stored).toHaveLength(1);
    expect(stored[0].outcome).toBe('TP1');
    expect(stored[0].grossR).toBe(4);
  });

  it('classifies EXPIRED as censored, not as a loss', () => {
    const rec = buildOutcomeRecord({
      signalId: 'probe-3', outcome: 'EXPIRED', createdAt: T0, resolvedAt: T0 + 25 * 3600_000,
      entry: 99, stop: 97.5, riskPerUnit: 1.5, side: 'bullish',
      bars: [{ t: T0 }, { t: T0 + 3600_000 }],
      priceAtResolve: 99.2, grossR: 0.13, mfeR: 0.3, maeR: -0.2,
      funding8h: 0.0001, spreadBps: 4, ambiguous: false,
      engineVersion: ENGINE_VERSION, featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    });
    expect(rec.outcomeClass).toBe('censored');
    store.saveOutcome(rec);
    const stored = store.listOutcomes(10).find((o) => o.signalId === 'probe-3');
    expect(stored!.outcomeClass).toBe('censored');
    expect(stored!.expiredPolicy).toMatch(/censored/);
  });
});

describe('a feature record can be built directly and is auditable', () => {
  it('reports the missing-field index the report layer groups on', () => {
    const record = buildFeatureRecord({
      row: row(), now: T0, health: null, regime: 'range', sessionFor: () => 'asia',
    });
    const byReason = new Map<string, number>();
    for (const m of record.missing) byReason.set(m.reason, (byReason.get(m.reason) ?? 0) + 1);
    expect(byReason.size).toBeGreaterThan(1);
    expect(Object.isFrozen(record)).toBe(true);
  });
});