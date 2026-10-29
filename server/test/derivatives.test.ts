import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Candle } from '../../shared/types';
import {
  normaliseFunding,
  fundingLabel,
  fundingCrowdedAgainst,
  fundingZScore,
  oiQuadrant,
  quadrantScore,
  basisPct,
  oiChanges,
  lsDivergence,
  clamp,
  crossVenue,
} from '../src/engine/derivatives.js';
import { bybitSymbolCandidates } from '../src/data/derivatives/providers.js';
import { cvd, cvdDivergence } from '../src/live/marketState.js';
import { DERIVATIVES } from '../src/config.js';

/**
 * These tests guard the numbers the ledger freezes into every signal. Each
 * one covers a bug that was found by running against live data, not by
 * reading the code.
 */

const FIX = resolve(__dirname, 'fixtures');
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(FIX, `${name}.json`), 'utf8')) as T;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Funding 8h normalisation
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('normaliseFunding', () => {
  it('leaves an 8h rate unchanged', () => {
    expect(normaliseFunding(0.0001, 8)).toBeCloseTo(0.0001, 12);
  });

  it('doubles a 4h rate to its 8h equivalent', () => {
    // The real bug this guards: a 4h coin looks half as extreme as an 8h coin
    // at the same true rate, so crowding was under-reported.
    expect(normaliseFunding(0.0001, 4)).toBeCloseTo(0.0002, 12);
  });

  it('octuples a 1h rate to its 8h equivalent', () => {
    expect(normaliseFunding(0.0001, 1)).toBeCloseTo(0.0008, 12);
  });

  it('scales down a 12h rate', () => {
    expect(normaliseFunding(0.0012, 12)).toBeCloseTo(0.0008, 12);
  });

  it('returns zero for a zero or negative interval rather than dividing by zero', () => {
    expect(normaliseFunding(0.0001, 0)).toBe(0);
    expect(normaliseFunding(0.0001, -4)).toBe(0);
  });

  it('returns zero for a non-finite rate', () => {
    expect(normaliseFunding(Number.NaN, 8)).toBe(0);
  });

  it('normalises real fundingInfo intervals read from the live fixture', () => {
    const fx = load<{ sample: { symbol: string; fundingIntervalHours: number }[] }>('funding_info');
    expect(fx.sample.length).toBeGreaterThan(0);
    for (const row of fx.sample) {
      expect(row.fundingIntervalHours).toBeGreaterThan(0);
      const before = 0.0001;
      const after = normaliseFunding(before, row.fundingIntervalHours);
      // Same true rate must always normalise to the same 8h figure.
      expect(after / before).toBeCloseTo(8 / row.fundingIntervalHours, 6);
    }
  });
});

describe('fundingLabel', () => {
  const { FUNDING_CROWDED_8H, FUNDING_EXTREME_8H, FUNDING_SQUEEZE_8H } = DERIVATIVES;

  it('flags crowded long only when OI is rising', () => {
    expect(fundingLabel(FUNDING_CROWDED_8H + 0.00001, true)).toBe('CROWDED_LONG');
    expect(fundingLabel(FUNDING_CROWDED_8H + 0.00001, false)).toBe('NEUTRAL');
  });

  it('flags extreme regardless of OI direction', () => {
    expect(fundingLabel(FUNDING_EXTREME_8H + 0.00001, false)).toBe('EXTREME_LONG');
  });

  it('flags squeeze fuel below the threshold with rising OI', () => {
    expect(fundingLabel(FUNDING_SQUEEZE_8H - 0.00001, true)).toBe('SQUEEZE_FUEL');
  });

  it('leaves small funding neutral', () => {
    expect(fundingLabel(0.00001, true)).toBe('NEUTRAL');
  });

  it('treats crowded-in-the-same-direction as veto-worthy for that side', () => {
    expect(fundingCrowdedAgainst('CROWDED_LONG', 'bullish')).toBe(true);
    expect(fundingCrowdedAgainst('CROWDED_LONG', 'bearish')).toBe(false);
    expect(fundingCrowdedAgainst('CROWDED_SHORT', 'bearish')).toBe(true);
  });
});

describe('fundingZScore', () => {
  it('returns null without enough history, never a fabricated zero', () => {
    // M1.4: a zero here renders as "z=0.00", which reads as "the current rate
    // is exactly at the mean". It is not that — it is that no z-score exists.
    expect(fundingZScore(0.001, [0.0001, 0.0002])).toBeNull();
  });

  it('returns null when the history has no variance', () => {
    // A constant history has zero standard deviation, so the z-score is
    // undefined. Dividing by it is not a measurement either.
    const flat = Array.from({ length: 30 }, () => 0.0005);
    expect(fundingZScore(0.001, flat)).toBeNull();
  });

  it('is positive when the current rate is above its own history', () => {
    const hist = Array.from({ length: 30 }, (_, i) => (i % 3) * 0.00001);
    expect(fundingZScore(0.001, hist)).toBeGreaterThan(1);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// CVD â€” USD notional, not base units
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Build a candle from a raw Binance kline array. */
function toCandle(k: (string | number)[]): Candle {
  return {
    t: Number(k[0]),
    o: Number(k[1]),
    h: Number(k[2]),
    l: Number(k[3]),
    c: Number(k[4]),
    v: Number(k[5]),
    qv: Number(k[7]),
    takerBuyBase: Number(k[9]),
    takerBuyQuote: Number(k[10]),
    closed: true,
  };
}

describe('cvd', () => {
  it('is in USD notional, not base units', () => {
    const fx = load<{ rows: (string | number)[][] }>('klines_btc_5m');
    const candles = fx.rows.map(toCandle);
    const { value, windowQuoteVolume } = cvd(candles);

    // The original bug returned base-asset units, which for BTC would be a
    // number in the tens. USD notional must be in the hundreds of thousands.
    expect(Math.abs(value)).toBeGreaterThan(1000);
    expect(windowQuoteVolume).toBeGreaterThan(1_000_000);

    // And it must be expressible as a share of real notional volume.
    expect(Math.abs(value)).toBeLessThanOrEqual(windowQuoteVolume);
  });

  it('is comparable across coins because both are USD', () => {
    const btc = load<{ rows: (string | number)[][] }>('klines_btc_5m');
    const xrp = load<{ rows: (string | number)[][] }>('klines_xrp_5m');
    const btcCvd = cvd(btc.rows.map(toCandle));
    const xrpCvd = cvd(xrp.rows.map(toCandle));

    // A base-unit implementation would give BTC and XRP wildly different
    // magnitudes purely because BTC trades ~800x more per coin.
    for (const c of [btcCvd, xrpCvd]) {
      expect(Math.abs(c.value)).toBeLessThan(c.windowQuoteVolume);
    }
    // Ratio of deltas should stay within the ratio of notional volumes.
    const notionalRatio = btcCvd.windowQuoteVolume / xrpCvd.windowQuoteVolume;
    const deltaRatio = Math.abs(btcCvd.value) / Math.max(1, Math.abs(xrpCvd.value));
    expect(deltaRatio).toBeLessThan(notionalRatio * 3);
  });

  it('taker ratio stays in 0..1', () => {
    const fx = load<{ rows: (string | number)[][] }>('klines_btc_5m');
    const { takerRatio } = cvd(fx.rows.map(toCandle));
    expect(takerRatio).toBeGreaterThan(0);
    expect(takerRatio).toBeLessThan(1);
  });

  it('returns zeros for an empty series rather than NaN', () => {
    const out = cvd([]);
    expect(out.value).toBe(0);
    expect(out.slope).toBe(0);
    expect(out.takerRatio).toBe(0.5);
  });

  it('falls back to base volume x price when quote fields are missing', () => {
    const fx = load<{ rows: (string | number)[][] }>('klines_btc_5m');
    const stripped = fx.rows.map(toCandle).map((c) => ({ ...c, takerBuyQuote: undefined, qv: undefined }));
    const { value, windowQuoteVolume } = cvd(stripped);
    expect(Number.isFinite(value)).toBe(true);
    expect(windowQuoteVolume).toBeGreaterThan(0);
  });

  it('is positive when every candle is fully taker-buy', () => {
    const synthetic: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      t: i * 300_000, o: 100, h: 101, l: 99, c: 100,
      v: 1, qv: 100, takerBuyQuote: 100, closed: true,
    }));
    const { value, takerRatio } = cvd(synthetic);
    expect(value).toBeGreaterThan(0);
    expect(takerRatio).toBe(1);
  });

  it('is negative when every candle is fully taker-sell', () => {
    const synthetic: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      t: i * 300_000, o: 100, h: 101, l: 99, c: 100,
      v: 1, qv: 100, takerBuyQuote: 0, closed: true,
    }));
    expect(cvd(synthetic).value).toBeLessThan(0);
  });
});

describe('cvdDivergence', () => {
  it('flags a new high with no cumulative delta', () => {
    const candles: Candle[] = [
      // first half: flat, low delta
      ...Array.from({ length: 12 }, (_, i) => ({
        t: i * 300_000, o: 100, h: 100.5, l: 99.5, c: 100,
        v: 1, qv: 100, takerBuyQuote: 50, closed: true,
      })),
      // second half: price makes a new high but every candle is taker-sell
      ...Array.from({ length: 12 }, (_, i) => ({
        t: (12 + i) * 300_000, o: 100, h: 102, l: 99.5, c: 100,
        v: 1, qv: 100, takerBuyQuote: 0, closed: true,
      })),
    ];
    expect(cvdDivergence(candles)).toBe(true);
  });

  it('does not flag when delta confirms the new high', () => {
    const candles: Candle[] = [
      ...Array.from({ length: 12 }, (_, i) => ({
        t: i * 300_000, o: 100, h: 100.5, l: 99.5, c: 100,
        v: 1, qv: 100, takerBuyQuote: 50, closed: true,
      })),
      ...Array.from({ length: 12 }, (_, i) => ({
        t: (12 + i) * 300_000, o: 100, h: 102, l: 99.5, c: 101,
        v: 1, qv: 100, takerBuyQuote: 100, closed: true,
      })),
    ];
    expect(cvdDivergence(candles)).toBe(false);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Basis
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('basisPct', () => {
  it('reports the raw mark-index gap as a percentage', () => {
    // 83008.965 mark vs 83045.975 index from the live premiumIndex fixture.
    const fx = load<{ data: { markPrice: string; indexPrice: string } }>('premium_index');
    const mark = Number(fx.data.markPrice);
    const index = Number(fx.data.indexPrice);
    const basis = basisPct(mark, index);
    expect(basis).not.toBeNull();
    expect(Math.abs(basis!)).toBeLessThan(1);
  });

  it('rejects a stale index rather than annualising a data artefact', () => {
    // This is the -941% bug. A >50% raw gap is a bad index, not a basis.
    expect(basisPct(100, 10)).toBeNull();
    expect(basisPct(10, 100)).toBeNull();
  });

  it('returns null for zero or negative index rather than dividing by zero', () => {
    expect(basisPct(100, 0)).toBeNull();
    expect(basisPct(100, -5)).toBeNull();
  });

  it('returns null for non-finite input', () => {
    expect(basisPct(Number.NaN, 100)).toBeNull();
    expect(basisPct(100, Number.NaN)).toBeNull();
  });

  it('is positive when the mark trades above the index', () => {
    expect(basisPct(101, 100)).toBeCloseTo(1, 6);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// OI x price quadrant
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('oiQuadrant', () => {
  it('price up + OI up = new longs', () => {
    expect(oiQuadrant(3, 5)).toBe('new-longs');
  });

  it('price up + OI down = short covering', () => {
    expect(oiQuadrant(3, -5)).toBe('short-cover');
  });

  it('price down + OI up = new shorts', () => {
    expect(oiQuadrant(-3, 5)).toBe('new-shorts');
  });

  it('price down + OI down = long liquidation', () => {
    expect(oiQuadrant(-3, -5)).toBe('long-liquidation');
  });

  it('treats a genuinely quiet market as flat', () => {
    expect(oiQuadrant(0.05, 0.2)).toBe('flat');
  });

  it('scores new longs as fully supportive of a long and weak for a short', () => {
    expect(quadrantScore('new-longs', 'bullish')).toBe(1);
    expect(quadrantScore('new-longs', 'bearish')).toBeLessThan(0.5);
  });

  it('scores short covering as weak for both sides â€” it is not a real trend', () => {
    expect(quadrantScore('short-cover', 'bullish')).toBeLessThan(0.6);
    expect(quadrantScore('short-cover', 'bearish')).toBeLessThan(0.6);
  });

  it('is never exactly zero for a non-flat quadrant', () => {
    for (const side of ['bullish', 'bearish'] as const) {
      expect(quadrantScore('new-shorts', side)).toBeGreaterThan(0);
      expect(quadrantScore('long-liquidation', side)).toBeGreaterThan(0);
    }
  });
});

describe('oiChanges', () => {
  it('reads multi-window percentage changes from a real history series', () => {
    const fx = load<{ rows: { timestamp: number; sumOpenInterest: string }[] }>('oi_hist_btc');
    const points = fx.rows.map((r, i, arr) => ({
      t: r.timestamp,
      oi: Number(r.sumOpenInterest),
      changePct: i > 0
        ? ((Number(r.sumOpenInterest) - Number(arr[i - 1].sumOpenInterest)) / Number(arr[i - 1].sumOpenInterest)) * 100
        : 0,
    }));
    const changes = oiChanges(points);
    expect(Number.isFinite(changes.h1)).toBe(true);
    expect(Number.isFinite(changes.d1)).toBe(true);
  });

  it('returns zeros for an empty series', () => {
    expect(oiChanges([])).toEqual({ m5: 0, h1: 0, h4: 0, d1: 0 });
  });
});

describe('lsDivergence', () => {
  it('is positive when retail is longer than top traders', () => {
    expect(lsDivergence(2.0, 1.0)).toBeCloseTo(1, 6);
  });

  it('is zero when they agree', () => {
    expect(lsDivergence(1.5, 1.5)).toBeCloseTo(0, 6);
  });

  it('returns null when either side is missing', () => {
    expect(lsDivergence(null, 1.0)).toBeNull();
    expect(lsDivergence(1.0, null)).toBeNull();
  });
});

describe('clamp', () => {
  it('bounds on both sides', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe('bybitSymbolCandidates', () => {
  it('places the 1000x multiplier where Bybit actually puts it', () => {
    expect(bybitSymbolCandidates('PEPE')).toContain('1000PEPEUSDT');
    expect(bybitSymbolCandidates('SHIB')).toContain('SHIB1000USDT');
  });

  it('still tries the direct symbol first', () => {
    expect(bybitSymbolCandidates('BTC')[0]).toBe('BTCUSDT');
  });
});

describe('crossVenue', () => {
  it('names Bybit as the primary when Bybit supplied the row', () => {
    const cv = crossVenue(
      'SOLUSDT',
      0.0001,
      599_587_374,
      [{ symbol: 'SOLUSDT', markPrice: 101, funding8h: 0.0001, openInterest: 5_000_000, volume24h: 0 }],
      new Map(),
      'bybit-linear',
    );
    expect(cv!.venues[0]).toMatchObject({ name: 'bybit', funding8h: 0.0001, available: true });
    expect(cv!.venues.filter((v) => v.name === 'bybit')).toHaveLength(1);
  });

  it('keeps Binance as the primary on the normal path and adds Bybit', () => {
    const cv = crossVenue(
      'SOLUSDT',
      0.0002,
      10,
      null,
      new Map([['SOLUSDT', { funding8h: 0.0001, oiUsd: 20 }]]),
      'binance-futures',
    );
    expect(cv!.venues.map((v) => v.name)).toEqual(['binance', 'hyperliquid', 'bybit']);
    expect(cv!.venues[2]).toMatchObject({ funding8h: 0.0001, oiUsd: 20, available: true });
  });
});
