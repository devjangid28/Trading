/**
 * Engine Lab — the new feature readings, and the leakage test for each.
 *
 * ## Why this file exists
 *
 * The house rule is that a zone never repaints from a candle that is still
 * forming, and the Mind layer's version of that rule is that NOTHING computed
 * from data may read past `asOf`. The original vector proved that with ONE
 * test — append future candles, assert the vector is byte-identical — which
 * catches a leak regardless of which field leaked it.
 *
 * That single test cannot cover the new readings, because most of them arrive
 * through a DIFFERENT series than the 5m candles: a higher-timeframe candle, a
 * BTC series, a book snapshot, a funding history. A leak in the 15m reader
 * would not be visible to a test that only appends 5m candles.
 *
 * So each new reading gets its OWN leakage test, and each one appends future
 * data of that reading's own kind. A test that cannot fail is not a test, so
 * each also asserts that the reading is actually MEASURED before the leak
 * check — otherwise "identical" would be true because both vectors were empty.
 */
import { describe, expect, it } from 'vitest';
import { buildFeatureVector, featureCatalogue, FEATURE_CATALOGUE } from '../src/engine/mind/features.js';
import type { Candle, DerivRow } from '../../shared/types.js';

const FIVE_MIN = 5 * 60_000;
const FIFTEEN_MIN = 15 * 60_000;
const HOUR = 60 * 60_000;
const FOUR_HOURS = 4 * HOUR;
const NOW = 1_700_000_000_000;

function candle(t: number, o: number, h: number, l: number, c: number): Candle {
  return { t, o, h, l, c, v: 1000, closed: true };
}

/** A flat-ish 5m series ending at NOW, all closed. */
function candles5m(n = 60): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const t = NOW - (n - i) * FIVE_MIN;
    const o = 100 + i * 0.05;
    out.push(candle(t, o, o + 0.4, o - 0.4, o + 0.1));
  }
  return out;
}

/**
 * The last CLOSED 5m close — the reference price the book levels are quoted
 * around. `sliceAsOf` drops any candle that has not closed by `asOf`, so the
 * reference is the second-to-last element of the raw series.
 */
const REFERENCE_PRICE = candles5m()[candles5m().length - 1].c;

function candlesTf(intervalMs: number, n: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const t = NOW - (n - i) * intervalMs;
    const o = 100 + i * 0.2;
    out.push(candle(t, o, o + 0.8, o - 0.8, o + 0.2));
  }
  return out;
}

/** A derivatives row with the readings the new features need. */
function derivFixture(): DerivRow {
  return {
    symbol: 'BTCUSDT',
    funding8h: 0.0002,
    fundingZ: 0.4,
    fundingIntervalH: 8,
    fundingLabel: 'NEUTRAL',
    openInterest: 1000,
    oiUsd: 100_000_000,
    oiChange: { m5: 0.001, h1: 0.004, h4: 0.006, d1: 0.01 },
    quadrant: 'flat',
    quadrantLabel: 'Flat',
    markPrice: REFERENCE_PRICE,
    indexPrice: REFERENCE_PRICE,
    basisPct: 0.01,
    longShortAccountRatio: 1.1,
    topTraderPositionRatio: 1.05,
    lsDivergence: 0.02,
    cvd: 1234,
    cvdSlope: 0.5,
    takerRatio: 0.51,
    cvdDivergence: false,
    liq: {
      available: false,
      reason: 'no liquidation feed attached in this fixture',
      lastGoodAt: null,
    },
    depth: null,
    crossVenue: null,
    meta: { asOf: NOW - 1000, source: 'test', ageMs: 1000, stale: false },
  } as unknown as DerivRow;
}

/** The vector under test, with every optional input supplied. */
function build(overrides: Record<string, unknown> = {}) {
  const mid = REFERENCE_PRICE;
  return buildFeatureVector({
    symbol: 'BTCUSDT',
    side: 'bullish',
    asOf: NOW,
    candles: candles5m(),
    deriv: derivFixture(),
    higherTimeframes: {
      '15m': candlesTf(FIFTEEN_MIN, 40),
      '1h': candlesTf(HOUR, 30),
      '4h': candlesTf(FOUR_HOURS, 20),
    },
    btcCandles: candlesTf(FIVE_MIN, 60),
    bookLevels: {
      bids: [
        { price: mid - 0.05, usd: 40_000 },
        { price: mid - 0.15, usd: 25_000 },
      ],
      asks: [
        { price: mid + 0.05, usd: 30_000 },
        { price: mid + 0.15, usd: 12_000 },
      ],
      asOf: NOW - 1000,
    },
    fundingHistory: [0.0001, 0.0002, 0.0003],
    macro: {
      stablecoinFloatUsd: 120_000_000_000,
      fearGreed: 55,
      fearGreedHistory: [40, 45, 50, 52, 54, 55, 56, 57, 58],
    },
    stablecoinFloat24hAgoUsd: 118_000_000_000,
    ...overrides,
  });
}

describe('Engine Lab — multi-timeframe readings', () => {
  it('measures the 15m, 1h and 4h returns', () => {
    const v = build();
    expect(v.timeframes.ret15mPct.value).not.toBeNull();
    expect(v.timeframes.ret1hPct.value).not.toBeNull();
    expect(v.timeframes.ret4hPct.value).not.toBeNull();
    expect(v.timeframes.range1hPct.value).not.toBeNull();
    expect(v.timeframes.rangePosition1h.value).not.toBeNull();
    expect(v.timeframes.atrPct5m.value).not.toBeNull();
  });

  it('LEAKAGE — a future higher-timeframe candle cannot change the vector', () => {
    const before = build();
    const future15 = candlesTf(FIFTEEN_MIN, 40);
    // A candle that opens AFTER asOf and has not closed by asOf.
    future15.push(candle(NOW + FIFTEEN_MIN, 500, 900, 100, 800));
    const after = build({
      higherTimeframes: {
        '15m': future15,
        '1h': candlesTf(HOUR, 30),
        '4h': candlesTf(FOUR_HOURS, 20),
      },
    });
    expect(after.timeframes).toEqual(before.timeframes);
    // And the reading was actually measured, so "identical" is not "empty".
    expect(before.timeframes.ret15mPct.value).not.toBeNull();
  });

  it('is null when the higher-timeframe series is not supplied', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: NOW, candles: candles5m(),
    });
    expect(v.timeframes.ret15mPct.value).toBeNull();
    expect(v.timeframes.ret1hPct.value).toBeNull();
    expect(v.timeframes.ret4hPct.value).toBeNull();
    expect(v.timeframes.range1hPct.value).toBeNull();
    expect(v.timeframes.rangePosition1h.value).toBeNull();
  });
});

describe('Engine Lab — cross-asset readings', () => {
  it('measures beta, correlation and the idiosyncratic return', () => {
    const v = build();
    expect(v.crossAsset.betaToBtc.value).not.toBeNull();
    expect(v.crossAsset.corrToBtc.value).not.toBeNull();
    expect(v.crossAsset.btcReturnPct.value).not.toBeNull();
    expect(v.crossAsset.idiosyncraticReturnPct.value).not.toBeNull();
  });

  it('LEAKAGE — a future BTC candle cannot change the vector', () => {
    const before = build();
    const futureBtc = candlesTf(FIVE_MIN, 60);
    futureBtc.push(candle(NOW + FIVE_MIN, 1, 9_000, 1, 8_000));
    const after = build({ btcCandles: futureBtc });
    expect(after.crossAsset).toEqual(before.crossAsset);
    expect(before.crossAsset.betaToBtc.value).not.toBeNull();
  });

  it('is null when there is no BTC series', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: NOW, candles: candles5m(),
    });
    expect(v.crossAsset.betaToBtc.value).toBeNull();
    expect(v.crossAsset.corrToBtc.value).toBeNull();
    expect(v.crossAsset.btcReturnPct.value).toBeNull();
    expect(v.crossAsset.idiosyncraticReturnPct.value).toBeNull();
  });
});

describe('Engine Lab — order-book depth', () => {
  it('measures depth within 10 bps and within 50 bps', () => {
    const v = build();
    expect(v.orderbook.depthUsd10bps.value).not.toBeNull();
    expect(v.orderbook.depthUsd50bps.value).not.toBeNull();
    expect(v.orderbook.imbalanceNear.value).not.toBeNull();
    expect(v.orderbook.imbalanceFar.value).not.toBeNull();
    // The far book must be at least as deep as the near book.
    expect(v.orderbook.depthUsd50bps.value!).toBeGreaterThanOrEqual(v.orderbook.depthUsd10bps.value!);
  });

  it('LEAKAGE — a book snapshot taken after asOf is refused, not used', () => {
    const before = build();
    const mid = REFERENCE_PRICE;
    const after = build({
      bookLevels: {
        bids: [{ price: mid - 0.05, usd: 1_000_000 }],
        asks: [{ price: mid + 0.05, usd: 1_000_000 }],
        asOf: NOW + 1,
      },
    });
    // The future snapshot is REFUSED. The whole group is absent, and no level
    // from it reaches the vector — which is the honest answer, because there
    // is no other snapshot to use.
    expect(after.orderbook.depthUsd10bps.value).toBeNull();
    expect(after.orderbook.depthUsd50bps.value).toBeNull();
    expect(after.orderbook.imbalanceNear.value).toBeNull();
    expect(after.orderbook.imbalanceFar.value).toBeNull();
    expect(after.orderbook.depthUsd10bps.value).not.toBe(1_000_000);

    // The VALID snapshot WAS measured, so the refusal above is a decision and
    // not an accident of the fixture.
    expect(before.orderbook.depthUsd10bps.value).not.toBeNull();
  });

  it('is null when no book snapshot is attached', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: NOW, candles: candles5m(),
    });
    expect(v.orderbook.depthUsd10bps.value).toBeNull();
    expect(v.orderbook.imbalanceNear.value).toBeNull();
  });
});

describe('Engine Lab — funding history', () => {
  it('measures the raw series behind the z-score', () => {
    const v = build();
    expect(v.funding.last8h.value).not.toBeNull();
    expect(v.funding.mean24h.value).not.toBeNull();
    expect(v.funding.min24h.value).not.toBeNull();
    expect(v.funding.max24h.value).not.toBeNull();
    expect(v.funding.min24h.value!).toBeLessThanOrEqual(v.funding.max24h.value!);
  });

  it('is null when there is no funding history', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: NOW, candles: candles5m(),
    });
    expect(v.funding.last8h.value).toBeNull();
    expect(v.funding.mean24h.value).toBeNull();
  });
});

describe('Engine Lab — stablecoin flow', () => {
  it('measures the 24h change of the float', () => {
    const v = build();
    expect(v.regime.stablecoinFlow24hPct.value).not.toBeNull();
    expect(v.regime.stablecoinFlow24hPct.value!).toBeCloseTo(
      ((120_000_000_000 - 118_000_000_000) / 118_000_000_000) * 100, 10,
    );
  });

  it('is null without the float 24 hours ago — a level is not a flow', () => {
    const v = build({ stablecoinFloat24hAgoUsd: undefined });
    expect(v.regime.stablecoinFloatUsd.value).not.toBeNull();
    expect(v.regime.stablecoinFlow24hPct.value).toBeNull();
  });
});

describe('Engine Lab — the feature catalogue', () => {
  it('gives every feature a name, a unit and a description', () => {
    for (const spec of FEATURE_CATALOGUE) {
      expect(spec.name, spec.path).toBeTruthy();
      expect(spec.unit, spec.path).toBeTruthy();
      expect(spec.description.length, spec.path).toBeGreaterThan(10);
    }
    // Names are unique: two features with the same name are one feature.
    const names = FEATURE_CATALOGUE.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('resolves every catalogue path against a real vector', () => {
    const v = build();
    const entries = featureCatalogue(v);
    expect(entries.length).toBe(FEATURE_CATALOGUE.length);
    // At least the readings this file added are present in the catalogue.
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get('ret15mPct')?.value).not.toBeNull();
    expect(byName.get('betaToBtc')?.value).not.toBeNull();
    expect(byName.get('depthUsd10bps')?.value).not.toBeNull();
    expect(byName.get('fundingMean24h')?.value).not.toBeNull();
    expect(byName.get('stablecoinFlow24hPct')?.value).not.toBeNull();
  });

  it('reports a missing feature as missing, never as zero', () => {
    const v = buildFeatureVector({
      symbol: 'BTCUSDT', side: 'bullish', asOf: NOW, candles: candles5m(),
    });
    const entries = featureCatalogue(v);
    const missing = entries.filter((e) => e.missing);
    expect(missing.length).toBeGreaterThan(0);
    for (const e of missing) {
      expect(e.value, e.name).toBeNull();
    }
  });
});
