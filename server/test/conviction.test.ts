import { describe, it, expect } from 'vitest';
import type { Candle, DerivRow, NewsItem, Setup } from '../../shared/types';
import { evaluateVetoes, scoreConviction, buildChecklist, gradeFor } from '../src/engine/conviction.js';
import { LEDGER, VETO } from '../src/config.js';
import { HOUR, MINUTE } from '../src/lib/time.js';

/**
 * Veto tests.
 *
 * These matter more than they look: every A/B signal is a signal NOT taken.
 * If a veto fires when it should not, the ledger silently loses trades. If it
 * fails to fire, the ledger records trades that were never actually viable.
 * The shadow-signal design depends on the veto being exactly right.
 */

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0); // fixed clock

function candles(n: number, opts: { start?: number; stepPct?: number; v?: number } = {}): Candle[] {
  const start = opts.start ?? 100;
  const step = opts.stepPct ?? 0;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = start * (1 + (step * i) / 100);
    out.push({
      t: NOW - (n - i) * 5 * MINUTE,
      o: c, h: c * 1.001, l: c * 0.999, c,
      v: opts.v ?? 1000, qv: (opts.v ?? 1000) * c,
      takerBuyQuote: (opts.v ?? 1000) * c * 0.5,
      closed: true,
    });
  }
  return out;
}

function setup(over: Partial<Setup> = {}): Setup {
  return {
    side: 'bullish',
    obTime: NOW - 60 * MINUTE,
    obHigh: 101, obLow: 99, z: 100,
    invalidation: 98.9,
    targets: [{ price: 105, label: 'R1', kind: 'liquidity', time: NOW }],
    context: [], rr: 5, displacement: 1.5, fvg: true,
    violated: false, ageMinutes: 60, previous: [],
    retest: 'fresh', distanceAtr: 0.5,
    htf: { aligned: true, conflict: false, trend1h: 'up', trend4h: 'up', setups: [], scoreAdj: 8 },
    ...over,
  };
}

function deriv(over: Partial<DerivRow> = {}): DerivRow {
  return {
    symbol: 'TESTUSDT',
    funding8h: 0.00002, fundingZ: 0.2, fundingIntervalH: 8, fundingLabel: 'NEUTRAL',
    openInterest: 1000, oiUsd: 100_000,
    oiChange: { m5: 0.1, h1: 1.2, h4: 2, d1: 3 },
    quadrant: 'new-longs', quadrantLabel: 'New longs',
    markPrice: 100, indexPrice: 100, basisPct: 0.01,
    longShortAccountRatio: 1.2, topTraderPositionRatio: 1.2, lsDivergence: 0,
    cvd: 1000, cvdSlope: 100, takerRatio: 0.55, cvdDivergence: false,
    liq: { m5: 0, h1: 0, d1: 0, longM5: 0, shortM5: 0, longH1: 0, shortH1: 0, cascade: false, isSample: true },
    depth: { bidUsd: 500_000, askUsd: 500_000, imbalance: 0, spreadBps: 1, walls: [], distanceToPriceBps: 0, asOf: NOW },
    crossVenue: null,
    meta: { asOf: NOW, source: 'test', stale: false },
    ...over,
  };
}

function news(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'n1', headline: 'Test headline', url: '', source: 'Test', tier: 12,
    publishedAt: NOW - HOUR, ageMinutes: 60,
    assets: ['TEST'], sectorHint: null, macroEntity: null, jurisdiction: 'GLOBAL',
    categories: [], tags: [], nis: 40, severity: 20, relevance: 10, sentiment: 0,
    direction: 0, severityClass: 'MEDIUM', expectedBps: 0, reversalRisk: 0.3,
    corroboration: 1, sources: 1, novelty: 1, noveltyLabel: 'NEW',
    isMacro: false, routine: false, reactions: [], clusterId: null, surpriseBp: null,
    summary: '',
    ...over,
  };
}

interface Over {
  side?: 'bullish' | 'bearish';
  c?: Candle[];
  s?: Setup | null;
  d?: DerivRow | null;
  n?: NewsItem[];
  tradability?: { bidUsd: number; askUsd: number; spreadBps: number } | null;
  events?: { id: string; title: string; t: number; blackout: boolean; kind: 'FOMC' }[];
  unlocks?: { token: string; date: string; pct: number; cliff: boolean; category: string; unverified: boolean }[];
}

function input(over: Over = {}) {
  const s = over.s === undefined ? setup() : over.s;
  return {
    symbol: 'TEST',
    side: over.side ?? ('bullish' as const),
    price: 100,
    setup: s,
    strength: 5,
    strengthPercentile: 90,
    volumeUsd: 200_000_000,
    choppiness: 30,
    vwap: 99,
    candles: over.c ?? candles(48),
    deriv: over.d === undefined ? deriv() : over.d,
    vol: null,
    sectorAvgChange: 1.5,
    breadth: 'bullish' as const,
    news: over.n ?? [],
    macroRegimeScore: 0.7,
    tradability: over.tradability === undefined
      ? { bidUsd: 500_000, askUsd: 500_000, spreadBps: 1 }
      : over.tradability,
    events: (over.events ?? []) as never,
    now: NOW,
    unlocks: over.unlocks ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('veto: macro blackout', () => {
  it('fires inside the window before a tier-1 event', () => {
    const v = evaluateVetoes(input({
      events: [{ id: 'fomc', title: 'FOMC statement', t: NOW + 10 * MINUTE, blackout: true, kind: 'FOMC' } as never],
    }));
    expect(v.some((x) => x.includes('blackout'))).toBe(true);
  });

  it('fires just after the event too', () => {
    const v = evaluateVetoes(input({
      events: [{ id: 'fomc', title: 'FOMC', t: NOW - 20 * MINUTE, blackout: true, kind: 'FOMC' } as never],
    }));
    expect(v.some((x) => x.includes('blackout'))).toBe(true);
  });

  it('does not fire outside the window', () => {
    const v = evaluateVetoes(input({
      events: [{ id: 'fomc', title: 'FOMC', t: NOW + 5 * HOUR, blackout: true, kind: 'FOMC' } as never],
    }));
    expect(v.some((x) => x.includes('blackout'))).toBe(false);
  });

  it('ignores a non-blackout event', () => {
    const v = evaluateVetoes(input({
      events: [{ id: 'x', title: 'CPI', t: NOW, blackout: false, kind: 'FOMC' } as never],
    }));
    expect(v.some((x) => x.includes('blackout'))).toBe(false);
  });
});

describe('veto: event risk from an existing large move', () => {
  it(`fires when the day move is at or above ${VETO ? 14 : 14}%`, () => {
    const v = evaluateVetoes(input({ c: candles(48, { stepPct: 1 }) }));
    // 47 steps of 1% compounds well past 14%.
    expect(v.some((x) => x.includes('event risk'))).toBe(true);
  });

  it('does not fire on a calm day', () => {
    const v = evaluateVetoes(input({ c: candles(48, { stepPct: 0 }) }));
    expect(v.some((x) => x.includes('event risk'))).toBe(false);
  });
});

describe('veto: security event in the last 6h', () => {
  it('fires for a hack tag inside the window', () => {
    const v = evaluateVetoes(input({
      n: [news({ tags: ['HACK_EXCHANGE_MAJOR'], publishedAt: NOW - 2 * HOUR, ageMinutes: 120 })],
    }));
    expect(v.length).toBeGreaterThan(0);
  });

  it('fires for a depeg tag inside the window', () => {
    const v = evaluateVetoes(input({
      n: [news({ tags: ['DEPEG_MAJOR'], publishedAt: NOW - 1 * HOUR, ageMinutes: 60 })],
    }));
    expect(v.length).toBeGreaterThan(0);
  });

  it('does not fire when the event is older than the window', () => {
    const v = evaluateVetoes(input({
      n: [news({ tags: ['HACK_EXCHANGE_MAJOR'], publishedAt: NOW - 8 * HOUR, ageMinutes: 480 })],
    }));
    expect(v.some((x) => x.includes('within'))).toBe(false);
  });

  it('ignores ordinary news', () => {
    const v = evaluateVetoes(input({ n: [news({ tags: ['LISTING_TIER1'], publishedAt: NOW - HOUR })] }));
    expect(v.length).toBe(0);
  });
});

describe('veto: token unlock', () => {
  const unlock = (pct: number, offsetH: number) => ({
    token: 'TEST', date: new Date(NOW + offsetH * HOUR).toISOString(),
    pct, cliff: true, category: 'test', unverified: true,
  });

  it(`fires for a long with a >= ${VETO.UNLOCK_MATERIAL_PCT}% unlock inside ${VETO.UNLOCK_LOOKAHEAD_H}h`, () => {
    const v = evaluateVetoes(input({ side: 'bullish', unlocks: [unlock(5, 10)] }));
    expect(v.some((x) => x.includes('unlock'))).toBe(true);
  });

  it('does not fire for a short', () => {
    const v = evaluateVetoes(input({ side: 'bearish', unlocks: [unlock(5, 10)] }));
    expect(v.some((x) => x.includes('unlock'))).toBe(false);
  });

  it('does not fire for an immaterial unlock', () => {
    const v = evaluateVetoes(input({ side: 'bullish', unlocks: [unlock(0.5, 10)] }));
    expect(v.some((x) => x.includes('unlock'))).toBe(false);
  });

  it('does not fire outside the look-ahead window', () => {
    const v = evaluateVetoes(input({ side: 'bullish', unlocks: [unlock(5, 200)] }));
    expect(v.some((x) => x.includes('unlock'))).toBe(false);
  });
});

describe('veto: tradability', () => {
  it('fires when depth is below the minimum', () => {
    const v = evaluateVetoes(input({
      tradability: { bidUsd: 100, askUsd: 100, spreadBps: 1 },
    }));
    expect(v.some((x) => x.includes('depth'))).toBe(true);
  });

  it('fires when spread is too wide', () => {
    const v = evaluateVetoes(input({
      tradability: { bidUsd: 500_000, askUsd: 500_000, spreadBps: 25 },
    }));
    expect(v.some((x) => x.includes('spread'))).toBe(true);
  });

  it('does not fire on a healthy book', () => {
    const v = evaluateVetoes(input({
      tradability: { bidUsd: 500_000, askUsd: 500_000, spreadBps: 1 },
    }));
    expect(v.some((x) => x.includes('depth') || x.includes('spread'))).toBe(false);
  });
});

describe('veto: funding crowded our way while OI falls', () => {
  it('fires for a long with crowded-long funding and falling OI', () => {
    const v = evaluateVetoes(input({
      side: 'bullish',
      d: deriv({ fundingLabel: 'CROWDED_LONG', oiChange: { m5: 0, h1: -2, h4: -3, d1: -5 } }),
    }));
    expect(v.some((x) => x.includes('unwinding'))).toBe(true);
  });

  it('does not fire when OI is rising — that is genuine crowding, not unwinding', () => {
    const v = evaluateVetoes(input({
      side: 'bullish',
      d: deriv({ fundingLabel: 'CROWDED_LONG', oiChange: { m5: 0, h1: 3, h4: 4, d1: 5 } }),
    }));
    expect(v.some((x) => x.includes('unwinding'))).toBe(false);
  });

  it('does not fire when funding is crowded the OTHER way', () => {
    const v = evaluateVetoes(input({
      side: 'bullish',
      d: deriv({ fundingLabel: 'CROWDED_SHORT', oiChange: { m5: 0, h1: -2, h4: -3, d1: -5 } }),
    }));
    expect(v.some((x) => x.includes('unwinding'))).toBe(false);
  });
});

describe('grade and checklist', () => {
  it('a veto forces NO TRADE regardless of score', () => {
    const out = scoreConviction(input({
      tradability: { bidUsd: 10, askUsd: 10, spreadBps: 99 },
    }));
    expect(out.grade).toBe('NO TRADE');
    expect(out.vetoes.length).toBeGreaterThan(0);
  });

  it('a veto forces the rule to NOT_PICKED_VETO', () => {
    const out = scoreConviction(input({
      tradability: { bidUsd: 10, askUsd: 10, spreadBps: 99 },
    }));
    expect(out.rule).toBe('NOT_PICKED_VETO');
  });

  it('an A/B grade with no liquidity target is NOT_PICKED_NO_LIQUIDITY', () => {
    const out = scoreConviction(input({ s: setup({ targets: [] }) }));
    expect(out.rule).toBe('NOT_PICKED_NO_LIQUIDITY');
  });

  it('no zone means no grade above Pass', () => {
    const out = scoreConviction(input({ s: null }));
    expect(out.grade).not.toBe('A');
    expect(out.grade).not.toBe('B');
  });

  it('has exactly 8 checklist points', () => {
    const cl = buildChecklist(input());
    expect(cl.length).toBe(8);
    expect(cl.filter((c) => c.ok).length).toBe(out(cl).length);
  });

  it('every checklist point carries a reason', () => {
    for (const c of buildChecklist(input())) {
      expect(c.reason).toBeTruthy();
    }
  });

  function out(cl: ReturnType<typeof buildChecklist>): unknown[] {
    return cl.filter((c) => c.ok);
  }

  it('grade thresholds require BOTH score and checklist', () => {
    expect(gradeFor(90, 7, false)).toBe('A');
    expect(gradeFor(90, 6, false)).not.toBe('A');
    expect(gradeFor(74, 8, false)).not.toBe('A');
    expect(gradeFor(60, 5, false)).toBe('B');
    expect(gradeFor(20, 8, false)).not.toBe('B');
  });

  it('ledger minimum sample is enforced as a constant, not magic', () => {
    expect(LEDGER.MIN_SAMPLE_FOR_RATE).toBe(30);
  });
});

describe('ledger outcome resolution policy', () => {
  it('resolves same-candle stop and target as STOP', () => {
    // This is asserted here so the policy is pinned even before the resolver
    // exists. LEDGER.AMBIGUITY is the single source of truth for the choice.
    expect(LEDGER.AMBIGUITY).toBe('STOP_FIRST');
  });

  it('expires un-resolved signals after 24h', () => {
    expect(LEDGER.EXPIRY_HOURS).toBe(24);
  });
});
