import { describe, it, expect, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Redirect the ledger BEFORE importing the store, so this file never touches the
// production DB — the same reason `store.test.ts` does it.
const DB = resolve(process.cwd(), 'data/mind-freeze-test.db');
process.env.ORDERFLOW_DB = DB;

const { freezeFromScan } = await import('../src/ledger/worker.js');
const { listSignals, closeLedger, signalCount } = await import('../src/ledger/store.js');
const { buildFeatureVector, measured } = await import('../src/engine/mind/index.js');
const { listSignals: ls2 } = await import('../src/ledger/store.js');
void ls2;

import type { AssetRow, Conviction, Setup, TradePlan } from '../../shared/types';

const FIVE_MIN = 5 * 60_000;
const BASE = 1_700_000_000_000;
const NOW = BASE + 60 * FIVE_MIN;

function candles(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const o = 100 + i;
    return { t: BASE + i * FIVE_MIN, o, h: o + 2, l: o - 2, c: o + 1, v: 1000, closed: true };
  });
}

function plan(): TradePlan {
  return {
    symbol: 'BTCUSDT', side: 'bullish',
    entryLow: 99, entryHigh: 101, entryMid: 100, stop: 97.5,
    targets: [{ label: 'R1', price: 105, rr: 2, netR: 0 }],
    rr: 2, noRoom: false, riskPerUnit: 2.5,
    qty: null, riskAmount: null, rewardAmount: null,
    costs: { feeBps: 5, feeAmount: 0, fundingBps: 0, fundingAmount: 0, slippageBps: 5, slippageAmount: 0, totalBps: 10 },
    netR: null,
  };
}

function setup(): Setup {
  return {
    side: 'bullish', obTime: BASE, obHigh: 100, obLow: 98, z: 99,
    invalidation: 97.5,
    targets: [{ price: 105, label: 'R1', kind: 'liquidity', time: 0 }],
    context: [], rr: 2, displacement: 1.2, fvg: true, violated: false,
    ageMinutes: 30, previous: [], retest: 'approaching', distanceAtr: 0.8,
    htf: { aligned: true, conflict: false, trend1h: 'up', trend4h: 'up', setups: [], scoreAdj: 0 },
  };
}

function conviction(grade: Conviction['grade']): Conviction {
  return {
    score: 60, grade, side: 'bullish',
    components: { structure: 60, orderFlow: 60, momentum: 60, positioning: 60, newsEvents: 60, macroRegime: 60, tradability: 60 },
    missing: [], scoreIncomplete: false, vetoes: [], checklist: [], checklistScore: 8,
    rule: 'PICK', isPick: true,
  };
}

function row(over: Partial<AssetRow> = {}): AssetRow {
  return {
    id: 'BTC', symbol: 'BTCUSDT', base: 'BTC', displayTicker: 'BTC', displayName: 'Bitcoin',
    logoUrl: null, quote: 'USDT', pair: 'BTCUSDT', name: 'Bitcoin', sector: 'Store', exchange: 'binance',
    price: 100, changePct: 3, change1hPct: 1, change4hPct: 2, volumeUsd: 1e9,
    strength: 70, percentile: 90, choppiness: 0.3, side: 'bullish', rank: 1, prevRank: null,
    eventRisk: false, spark: [1, 2, 3], setup: setup(), vwap: 99,
    conviction: conviction('B'), isPick: true, plan: plan(), leverage: null, tax: null,
    derivatives: null, newsDot: null, unlock: null, updatedAt: NOW,
    ...over,
  } as AssetRow;
}

function featuresFor(symbol: string, side: 'bullish' | 'bearish') {
  const v = buildFeatureVector({
    symbol, side, asOf: NOW, candles: candles(60),
    setup: setup(), strength: 70, macroBlackoutMin: 600,
  });
  v.regimeLabel = 'range';
  return v;
}

function mindFor(base: string, side: 'bullish' | 'bearish') {
  return {
    id: `${base}:${side}`,
    symbol: `${base}USDT`,
    side,
    probability: 0.58,
    expectedR: 2,
    netExpectedR: 1.9,
    regime: 'range' as const,
    drivers: [{ feature: 'structure.htf1h', contribution: 0.12, reason: 'the 1h agrees' }],
    vetoes: [],
    confidenceBand: 'medium' as const,
    actionable: true,
    rank: 0.1,
    asOf: NOW,
  };
}

// The store keeps the SQLite handle open for the life of the process, so the DB
// file cannot be deleted between tests on Windows (EPERM). Each test therefore
// uses its own symbols and reads back only its own, and the file is removed once
// at the end. Same approach as `store.test.ts`.
afterAll(() => {
  closeLedger();
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(DB + suffix, { force: true });
  }
});

/** Read back exactly one frozen signal by symbol, or fail loudly. */
function frozenFor(symbol: string) {
  const found = listSignals(500, 'all').find((s) => s.symbol === symbol);
  if (!found) throw new Error(`no frozen signal for ${symbol}`);
  return found;
}

describe('the ledger freeze carries the Mind verdict and its feature vector', () => {
  it('stores both halves when the row carries them', () => {
    const r = row({ mind: mindFor('BTC', 'bullish'), mindFeatures: featuresFor('BTCUSDT', 'bullish') });
    const report = freezeFromScan([r], NOW, 'trend-up');
    expect(report.frozen).toBe(1);

    const frozen = frozenFor('BTC');
    expect(frozen.snapshot.mind).toBeDefined();
    expect(frozen.snapshot.mind!.probability).toBeCloseTo(0.58, 4);
    expect(frozen.snapshot.mind!.regime).toBe('range');
    // The vector, not just the verdict — so the row can be audited later.
    expect(frozen.snapshot.mind!.features).toBeDefined();
    expect(frozen.snapshot.mind!.features.asOf).toBe(NOW);
    expect(frozen.snapshot.mind!.features.symbol).toBe('BTCUSDT');
  });

  it('still freezes a row with no Mind verdict, and stores neither half', () => {
    // The layer is optional: a scan without `ctx.mind` must produce exactly the
    // board it produced before. Storing a half-formed `mind` would be worse.
    const report = freezeFromScan([row({ base: 'ETH', pair: 'ETHUSDT', id: 'ETH' })], NOW, 'range');
    expect(report.frozen).toBe(1);
    const frozen = frozenFor('ETH');
    expect(frozen.snapshot.mind).toBeUndefined();
  });

  it('stores neither half when the verdict exists but the vector does not', () => {
    // A probability with no evidence is a number nobody can check.
    const r = row({ base: 'SOL', pair: 'SOLUSDT', id: 'SOL', mind: mindFor('SOL', 'bullish'), mindFeatures: null });
    freezeFromScan([r], NOW, 'trend-up');
    const frozen = frozenFor('SOL');
    expect(frozen.snapshot.mind).toBeUndefined();
  });

  it('does not change which grades get frozen', () => {
    // The brief forbids altering the freeze grades until calibration justifies it.
    // A is real, C is shadow — same as before the Mind layer.
    const report = freezeFromScan(
      [
        row({ base: 'AA', pair: 'AAUSDT', id: 'AA', conviction: conviction('A') }),
        row({ base: 'CC', pair: 'CCUSDT', id: 'CC', conviction: conviction('C') }),
      ],
      NOW,
      'risk-off',
    );
    expect(report.real).toBe(1);
    expect(report.shadow).toBe(1);
    expect(signalCount().total).toBeGreaterThanOrEqual(3);
  });

  it('counts Mind vetoes without letting them change the freeze', () => {
    const vetoed = mindFor('XRP', 'bullish');
    const r = row({
      base: 'XRP', pair: 'XRPUSDT', id: 'XRP',
      mind: { ...vetoed, probability: 0, actionable: false, vetoes: [{ code: 'macro-blackout', reason: 'CPI in 5 min', rule: 'macro' }] },
      mindFeatures: featuresFor('XRPUSDT', 'bullish'),
    });
    const report = freezeFromScan([r], NOW, 'trend-up');
    // A vetoed signal is still RECORDED. That is the whole point of the shadow
    // set: the only way to learn whether a veto was right is to keep the counter-
    // examples.
    expect(report.frozen).toBe(1);
    const frozen = frozenFor('XRP');
    expect(frozen.snapshot.mind!.vetoCodes).toEqual(['macro-blackout']);
    expect(frozen.snapshot.mind!.probability).toBe(0);
  });
});

void measured;