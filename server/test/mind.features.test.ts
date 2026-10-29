import { describe, it, expect } from 'vitest';
import {
  buildFeatureVector,
  sliceAsOf,
  newsAsOf,
  featureCoverage,
  measured,
  absent,
  num,
  type FeatureInputs,
} from '../src/engine/mind/index.js';
import { sessionVwap, sessionStartIndex } from '../src/engine/orderblock.js';
import { fundingCrowdedAgainst } from '../src/engine/derivatives.js';
import type { Candle, NewsItem, Setup, DerivRow } from '../../shared/types';

const FIVE_MIN = 5 * 60_000;

/**
 * A candle series with a known, deterministic shape.
 *
 * `base` is the timestamp of candle 0. Candle `n` opens at `base + n*5m` and
 * CLOSES at `base + (n+1)*5m`, which is the arithmetic the point-in-time tests
 * depend on.
 */
function series(count: number, base = 1_700_000_000_000, opts: { startPrice?: number } = {}): Candle[] {
  const start = opts.startPrice ?? 100;
  return Array.from({ length: count }, (_, n) => {
    const o = start + n;
    return {
      t: base + n * FIVE_MIN,
      o,
      h: o + 2,
      l: o - 2,
      c: o + 1,
      v: 1000 + n,
      qv: (1000 + n) * o,
      takerBuyBase: 600,
      takerBuyQuote: 600 * o,
      trades: 50,
      // Everything in this helper is a closed candle; the look-ahead tests build
      // the unclosed ones explicitly so the distinction stays visible.
      closed: true,
    };
  });
}

function makeSetup(over: Partial<Setup> = {}): Setup {
  return {
    side: 'bullish',
    obTime: 1_700_000_000_000,
    obHigh: 100,
    obLow: 98,
    z: 99,
    invalidation: 97.5,
    targets: [
      { price: 104, label: 'R1', kind: 'liquidity', time: 0 },
      { price: 108, label: 'R2', kind: 'liquidity', time: 0 },
    ],
    context: [{ price: 106, label: 'ctx', kind: 'context', time: 0 }],
    rr: 2,
    displacement: 1.2,
    fvg: true,
    violated: false,
    ageMinutes: 45,
    previous: [],
    retest: 'approaching',
    distanceAtr: 0.8,
    htf: { aligned: true, conflict: false, trend1h: 'up', trend4h: 'up', setups: [], scoreAdj: 0 },
    ...over,
  };
}

function news(publishedAt: number, over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: `n${publishedAt}`,
    title: 'headline',
    url: 'https://example.test/a',
    source: 'test',
    tier: 1,
    publishedAt,
    ageMinutes: 0,
    assets: [],
    sectorHint: null,
    macroEntity: null,
    jurisdiction: null,
    categories: ['GENERAL'],
    tags: [],
    nis: 40,
    severity: 4,
    relevance: 50,
    sentiment: 0.5,
    direction: 1,
    severityClass: 'MEDIUM',
    expectedBps: 10,
    reversalRisk: 0.1,
    corroboration: 1,
    sources: 1,
    novelty: 1,
    noveltyLabel: 'day',
    isMacro: false,
    routine: false,
    reactions: [],
    clusterId: null,
    surpriseBp: 0,
    summary: 'headline',
    ...over,
  } as NewsItem;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('sliceAsOf — the wall', () => {
  // Candle `n` OPENS at base + n*5m and CLOSES at base + (n+1)*5m, so the instant
  // "candle n has just closed" is expressed as `closeOf(n)`.
  const closeOf = (base: number, n: number) => base + (n + 1) * FIVE_MIN;

  it('keeps a candle only once it has actually closed', () => {
    const base = 1_700_000_000_000;
    const candles = series(3, base);
    expect(sliceAsOf(candles, closeOf(base, 0)).map((c) => c.t)).toEqual([base]);
  });

  it('drops the candle in progress at asOf', () => {
    const base = 1_700_000_000_000;
    const candles = series(4, base);
    // One tick past candle 1's close: candles 0 and 1 are in, 2 and 3 are not.
    expect(sliceAsOf(candles, closeOf(base, 1)).length).toBe(2);
    // Exactly at candle 2's close, candle 2 IS in.
    expect(sliceAsOf(candles, closeOf(base, 2)).length).toBe(3);
  });

  it('does not trust the caller-supplied closed flag — asOf is authoritative', () => {
    const base = 1_700_000_000_000;
    const candles = series(2, base);
    // Candle 1 claims closed:true, but at candle 0's close it has not closed.
    // asOf wins.
    const result = sliceAsOf(candles, closeOf(base, 0));
    expect(result.map((c) => c.t)).toEqual([base]);
  });

  it('returns nothing when asOf precedes every close', () => {
    const candles = series(5);
    expect(sliceAsOf(candles, candles[0].t - 1)).toHaveLength(0);
  });
});

describe('newsAsOf — the same wall, different series', () => {
  it('drops headlines published after asOf', () => {
    const items = [news(100), news(200), news(300)];
    expect(newsAsOf(items, 250).map((n) => n.publishedAt)).toEqual([100, 200]);
  });

  it('keeps a headline published exactly at asOf', () => {
    expect(newsAsOf([news(100)], 100)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE TEST THAT MATTERS
// ─────────────────────────────────────────────────────────────────────────────

describe('point-in-time correctness — no look-ahead', () => {
  const base = 1_700_000_000_000;
  const AS_OF = base + 60 * FIVE_MIN;

  function inputsAt(candles: Candle[]): FeatureInputs {
    return {
      symbol: 'BTCUSDT',
      side: 'bullish',
      asOf: AS_OF,
      candles,
      setup: makeSetup(),
      news: [news(base + 10 * FIVE_MIN), news(base + 20 * FIVE_MIN)],
      macroBlackoutMin: 600,
      strength: 70,
      macro: { btcDominanceTrendPp: 0.2, fearGreed: 55, fearGreedHistory: [50, 52, 54, 56, 58, 60, 62] },
    };
  }

  it('produces a byte-identical vector when future candles are appended', () => {
    const clean = buildFeatureVector(inputsAt(series(60, base)));

    // 40 more candles that had NOT closed at AS_OF, with violent values that
    // would wreck any statistic computed over the whole array: a 10x range, a
    // session VWAP at a completely different level, a huge new high.
    const future = Array.from({ length: 40 }, (_, n) => ({
      t: AS_OF + n * FIVE_MIN,
      o: 1000 + n,
      h: 5000 + n,
      l: 1,
      c: 4000 + n,
      v: 999_999,
      qv: 4_000_000,
      takerBuyBase: 900_000,
      takerBuyQuote: 3_600_000,
      trades: 5000,
      closed: false,
    }));

    const withFuture = buildFeatureVector(inputsAt([...series(60, base), ...future]));

    expect(JSON.stringify(withFuture)).toBe(JSON.stringify(clean));
  });

  it('is unaffected by a future candle that opens a brand-new session high', () => {
    const clean = buildFeatureVector(inputsAt(series(60, base)));
    const spike = buildFeatureVector(
      inputsAt([
        ...series(60, base),
        { t: AS_OF, o: 100, h: 99_999, l: 99, c: 99_998, v: 1, closed: false },
      ]),
    );
    expect(spike.structure.vwapDistFrac).toEqual(clean.structure.vwapDistFrac);
    expect(spike.structure.displacementX).toEqual(clean.structure.displacementX);
    expect(spike.structure.choppiness).toEqual(clean.structure.choppiness);
  });

  it('session VWAP in the vector matches a VWAP computed only over closed candles', () => {
    const candles = series(60, base);
    const closed = sliceAsOf(candles, AS_OF);
    // The same window the implementation uses: the engine's sessionStartIndex,
    // not index 0. The session window is shorter than the whole series.
    const fromTime = closed[sessionStartIndex(closed)]?.t;
    const expected = sessionVwap(closed, fromTime!);

    const vector = buildFeatureVector(inputsAt(candles));
    // The vector stores the *distance* from VWAP: dist = (price - vwap) / vwap,
    // so vwap = price / (1 + dist).
    const dist = num(vector.structure.vwapDistFrac)!;
    const lastClose = closed[closed.length - 1].c;
    expect(lastClose / (1 + dist)).toBeCloseTo(expected!, 6);
  });

  it('the VWAP it does report is not the VWAP of the whole array', () => {
    const candles = series(60, base);
    const lastClosed = sliceAsOf(candles, AS_OF);
    // A future candle with enough volume to dominate any VWAP that includes it.
    const leakySeries = [
      ...lastClosed,
      { t: AS_OF, o: 100, h: 100, l: 100, c: 100_000, v: 1e12, closed: false },
    ];
    const fromTime = lastClosed[sessionStartIndex(lastClosed)]?.t!;
    const honest = sessionVwap(lastClosed, fromTime)!;
    const leaky = sessionVwap(leakySeries, leakySeries[sessionStartIndex(leakySeries)]?.t!)!;
    // If these ever converged, the guard would be broken.
    expect(Math.abs(leaky - honest)).toBeGreaterThan(100);
  });

  it('ignores news published after asOf when reading the catalyst window', () => {
    // The SAME in-window news as the clean case, PLUS one from the future.
    const clean = buildFeatureVector(inputsAt(series(60, base)));
    const withFutureNews = buildFeatureVector({
      ...inputsAt(series(60, base)),
      news: [
        news(base + 10 * FIVE_MIN),
        news(base + 20 * FIVE_MIN),
        news(AS_OF + 1, { nis: 99 }),
      ],
    });
    expect(num(withFutureNews.catalyst.maxNis4h)).toBe(num(clean.catalyst.maxNis4h));
  });

  it('ignores a future news item even when it would have set the direction', () => {
    const clean = buildFeatureVector(inputsAt(series(60, base)));
    const future = buildFeatureVector({
      ...inputsAt(series(60, base)),
      news: [
        news(base + 10 * FIVE_MIN),
        news(base + 20 * FIVE_MIN),
        news(AS_OF + 1, { nis: 99, direction: -1 }),
      ],
    });
    expect(future.catalyst.newsDirection).toBe(clean.catalyst.newsDirection);
  });

  it('the in-window headline IS read — proving the previous two are not vacuous', () => {
    const v = buildFeatureVector(inputsAt(series(60, base)));
    // base+20 candles = 100 minutes before AS_OF, so inside the 4h window.
    expect(num(v.catalyst.maxNis4h)).toBe(40);
    expect(v.catalyst.newsDirection).toBe(1);
  });

  it('news older than the 4h window is excluded', () => {
    const v = buildFeatureVector({
      ...inputsAt(series(60, base)),
      news: [news(AS_OF - 5 * 3600_000, { nis: 95 })],
    });
    expect(v.catalyst.maxNis4h.value).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('missing data is null, never zero', () => {
  const base = 1_700_000_000_000;
  const AS_OF = base + 60 * FIVE_MIN;

  it('an absent setup yields hasSetup 0 but no fake structure features', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT',
      side: 'bullish',
      asOf: AS_OF,
      candles: series(60, base),
      setup: null,
    });
    // "No setup" genuinely is a zero — it was measured and it was false.
    expect(v.structure.hasSetup).toEqual(measured(0, AS_OF));
    // But its age, displacement and pool distance were never measured.
    expect(v.structure.obAgeMin.value).toBeNull();
    expect(v.structure.displacementX.value).toBeNull();
    expect(v.structure.liqPoolDistFrac.value).toBeNull();
  });

  it('an India-path asset has null derivatives, not zero funding', () => {
    const v = buildFeatureVector({
      symbol: 'RELIANCE',
      side: 'bullish',
      asOf: AS_OF,
      candles: series(60, base),
      setup: makeSetup(),
      deriv: null,
    });
    expect(v.positioning.fundingZ.value).toBeNull();
    expect(v.positioning.oiChange1h.value).toBeNull();
    expect(v.positioning.cvdSlope.value).toBeNull();
    // And crucially, none of them are 0, which would read as "flat positioning".
    expect(v.positioning.fundingZ.value).not.toBe(0);
  });

  it('an Unavailable liquidation feed is an absence, not an empty bucket set', () => {
    const deriv = {
      fundingZ: null,
      funding8h: 0.0001,
      fundingIntervalH: 8,
      fundingLabel: 'neutral',
      openInterest: 1,
      oiUsd: 1,
      oiChange: { m5: 0, h1: 0, h4: 0, d1: 0 },
      quadrant: 'flat',
      quadrantLabel: 'flat',
      markPrice: 100,
      indexPrice: 100,
      basisPct: 0,
      longShortAccountRatio: 1,
      topTraderPositionRatio: 1,
      lsDivergence: 0,
      cvd: 0,
      cvdSlope: 0,
      takerRatio: 1,
      cvdDivergence: 0,
      liq: { available: false, reason: 'no feed', lastGoodAt: null },
      depth: null,
      crossVenue: null,
      meta: { asOf: AS_OF, source: 'test', stale: false },
    } as unknown as DerivRow;

    const v = buildFeatureVector({
      symbol: 'BTCUSDT',
      side: 'bullish',
      asOf: AS_OF,
      candles: series(60, base),
      deriv,
    });
    expect(v.positioning.liqClusterDistFrac.value).toBeNull();
  });

  it('rejects NaN and Infinity rather than shipping them', () => {
    expect(measured(NaN, 1).value).toBeNull();
    expect(measured(Infinity, 1).value).toBeNull();
    expect(absent()).toEqual({ value: null, at: null });
  });

  it('reports coverage so a sparse vector is visible rather than implied', () => {
    const rich = buildFeatureVector({
      symbol: 'BTCUSDT',
      side: 'bullish',
      asOf: AS_OF,
      candles: series(60, base),
      setup: makeSetup(),
      strength: 70,
      macroBlackoutMin: 600,
      macro: { btcDominanceTrendPp: 0.1 },
    });
    const sparse = buildFeatureVector({
      symbol: 'RELIANCE',
      side: 'bullish',
      asOf: AS_OF,
      candles: series(60, base),
    });
    const r = featureCoverage(rich);
    const s = featureCoverage(sparse);
    expect(s.total).toBe(r.total);
    expect(s.measured).toBeLessThan(r.measured);
  });
});

describe('derived features', () => {
  const base = 1_700_000_000_000;
  const AS_OF = base + 60 * FIVE_MIN;

  it('vwapDistFrac is signed: above is positive', () => {
    const candles = series(60, base);
    const v = buildFeatureVector({
      symbol: 'BTCUSDT',
      side: 'bullish',
      asOf: AS_OF,
      candles,
      setup: makeSetup(),
    });
    // The synthetic series trends up, so the last close sits above the VWAP.
    expect(num(v.structure.vwapDistFrac)).toBeGreaterThan(0);
  });

  it('crowdedAgainst reads funding against the side only when OI is rising', () => {
    const mk = (fundingZ: number, oiH1: number, side: 'bullish' | 'bearish' = 'bullish') =>
      buildFeatureVector({
        symbol: 'BTCUSDT',
        side,
        asOf: AS_OF,
        candles: series(60, base),
        deriv: {
          fundingZ,
          oiChange: { m5: 0, h1: oiH1, h4: 0, d1: 0 },
          meta: { asOf: AS_OF, source: 'test', stale: false },
        } as unknown as DerivRow,
      });

    // Funding is what longs pay, so positive funding = the crowd is already long.
    // A LONG joining that crowd is the crowded case; a SHORT into it is not.
    expect(num(mk(2.5, 0.05, 'bullish').positioning.crowdedAgainst)).toBe(1);
    expect(num(mk(2.5, 0.05, 'bearish').positioning.crowdedAgainst)).toBe(0);
    // Mirror: negative funding = crowded short, which crowds a SHORT setup.
    expect(num(mk(-2.5, 0.05, 'bearish').positioning.crowdedAgainst)).toBe(1);
    expect(num(mk(-2.5, 0.05, 'bullish').positioning.crowdedAgainst)).toBe(0);
    // Same funding but OI falling — positioning is unwinding, not crowding.
    expect(num(mk(2.5, -0.05, 'bullish').positioning.crowdedAgainst)).toBe(0);
  });

  it('crowdedAgainst agrees with the engine own fundingCrowdedAgainst convention', () => {
    // Guards the sign against a future edit that flips it back.
    expect(fundingCrowdedAgainst('CROWDED_LONG', 'bullish')).toBe(true);
    expect(fundingCrowdedAgainst('CROWDED_LONG', 'bearish')).toBe(false);
    expect(fundingCrowdedAgainst('CROWDED_SHORT', 'bearish')).toBe(true);
    expect(fundingCrowdedAgainst('CROWDED_SHORT', 'bullish')).toBe(false);
  });

  it('the nested-FVG feature is honestly unmeasured, not faked as false', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT',
      side: 'bullish',
      asOf: AS_OF,
      candles: series(60, base),
      setup: makeSetup({ fvg: true }),
    });
    expect(v.structure.hasFvg).toEqual(measured(1, AS_OF));
    // Setup.fvg is a boolean with no bounds, so containment cannot be tested.
    expect(v.structure.fvgInsideHtfOb.value).toBeNull();
  });

  it('asOf is recorded on the vector so a stored vector can be audited', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT',
      side: 'bearish',
      asOf: AS_OF,
      candles: series(60, base),
    });
    expect(v.asOf).toBe(AS_OF);
    expect(v.side).toBe('bearish');
    expect(v.symbol).toBe('BTCUSDT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The five features added in Part XIX, and their leakage guards.
//
// Each one is guarded by its OWN timestamp. A book snapshot from three
// seconds in the future is still a look-ahead, and a "we checked the vector
// is point-in-time" claim that only covers the candles is not a claim.
// ─────────────────────────────────────────────────────────────────────────────

describe('microstructure and cross-venue features', () => {
  const base = 1_700_000_000_000;
  const AS_OF = base + 60 * FIVE_MIN;
  const LATER = AS_OF + 60_000;

  function depthAt(asOf: number) {
    return {
      bidUsd: 60_000, askUsd: 40_000,
      imbalance: 0.2, spreadBps: 3.5,
      walls: [], distanceToPriceBps: 4, asOf,
    };
  }

  it('depth is measured when the snapshot is at or before asOf', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
      deriv: {
        depth: depthAt(AS_OF),
        oiChange: { m5: 0, h1: 0, h4: 0, d1: 0 },
        meta: { asOf: AS_OF, source: 'test', stale: false },
      } as unknown as DerivRow,
    });
    expect(num(v.microstructure.bookImbalance)).toBeCloseTo((60_000 - 40_000) / 100_000, 6);
    expect(num(v.microstructure.spreadBps)).toBeCloseTo(3.5, 6);
  });

  it('a depth snapshot taken AFTER asOf is not used — it is absent, not zero', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
      deriv: {
        depth: depthAt(LATER),
        oiChange: { m5: 0, h1: 0, h4: 0, d1: 0 },
        meta: { asOf: AS_OF, source: 'test', stale: false },
      } as unknown as DerivRow,
    });
    expect(v.microstructure.bookImbalance.value).toBeNull();
    expect(v.microstructure.spreadBps.value).toBeNull();
  });

  it('no depth at all is absent, never a fabricated zero imbalance', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
    });
    expect(v.microstructure.bookImbalance.value).toBeNull();
    expect(v.microstructure.bookImbalance.at).toBeNull();
  });

  it('GEX is measured when the snapshot is at or before asOf', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
      gex: { totalNetGex: -1_234_000, asOf: AS_OF },
    });
    expect(num(v.microstructure.gexUsd)).toBeCloseTo(-1_234_000, 3);
  });

  it('a GEX snapshot taken AFTER asOf is not used', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
      gex: { totalNetGex: -1_234_000, asOf: LATER },
    });
    expect(v.microstructure.gexUsd.value).toBeNull();
  });

  it('the aggTrade imbalance is computed from the CLOSED candles only', () => {
    // The series reports taker-buy notional of 600 * price against a quote
    // volume of (1000 + n) * price, so the buy side is above half and the
    // imbalance is positive. The point of the test is the SECOND assertion:
    // appending a candle from the future must not move it.
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
    });
    expect(v.microstructure.aggTradeImbalance.value).toBeGreaterThan(0);
    const withFuture = series(60, base).concat(series(10, base + 60 * FIVE_MIN));
    const v2 = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: withFuture,
    });
    expect(v2.microstructure.aggTradeImbalance.value).toBe(v.microstructure.aggTradeImbalance.value);
  });

  it('the Coinbase premium is measured when its own timestamp allows it', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
      crossVenue: { coinbasePremiumBps: 4.2, coinbaseAsOf: AS_OF },
    });
    expect(num(v.crossVenue.coinbasePremiumBps)).toBeCloseTo(4.2, 6);
  });

  it('a Coinbase premium measured AFTER asOf is not used', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
      crossVenue: { coinbasePremiumBps: 4.2, coinbaseAsOf: LATER },
    });
    expect(v.crossVenue.coinbasePremiumBps.value).toBeNull();
  });

  it('the India premium is measured when its own timestamp allows it', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
      crossVenue: { indiaPremiumPct: 0.8, indiaAsOf: AS_OF },
    });
    expect(num(v.crossVenue.indiaPremiumPct)).toBeCloseTo(0.8, 6);
  });

  it('an India premium measured AFTER asOf is not used', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
      crossVenue: { indiaPremiumPct: 0.8, indiaAsOf: LATER },
    });
    expect(v.crossVenue.indiaPremiumPct.value).toBeNull();
  });

  it('the cross-venue block is entirely absent when nothing is supplied', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: AS_OF,
      candles: series(60, base),
    });
    expect(v.crossVenue.coinbasePremiumBps.value).toBeNull();
    expect(v.crossVenue.indiaPremiumPct.value).toBeNull();
  });
});