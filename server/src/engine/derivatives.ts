import { DERIVATIVES, LIVE } from '../config.js';
import type { Candle, DerivRow, LiqBuckets, OiPoint } from '../../../shared/types';
import type { DerivRaw, HyperRow } from '../data/derivatives/providers.js';

/**
 * Phase 2 â€” pure analytics. No I/O in this file, so it is fully unit-testable.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Funding arrives per the symbol's own interval (1h, 4h or 8h) and must be
 * normalised to 8h before any cross-coin comparison. Otherwise a 4h coin
 * looks twice as extreme as it is, which is a false crowding signal.
 */
export function normaliseFunding(rate: number, intervalH: number): number {
  if (!Number.isFinite(rate) || intervalH <= 0) return 0;
  return rate * (8 / intervalH);
}

/**
 * z-score of the current funding rate against its own history.
 *
 * **Null, never zero** — the M1.4 fix.
 *
 * This used to return `0` when the history was too short to compute a
 * z-score, and `0` when the history had no variance. Both are fabrications:
 * a z-score of exactly zero says "the current rate is exactly at the mean",
 * and a UI that renders it as `z=0.00` is presenting a placeholder under a
 * label that implies a computation. The board path already emits
 * `fundingZ: null` for the same reason (`buildDerivatives` collects no
 * funding history), so this function was the one place still able to
 * manufacture the zero.
 *
 * A constant history has zero standard deviation, so the z-score is
 * genuinely undefined — division by zero is not a measurement either.
 */
export function fundingZScore(current: number, history: number[]): number | null {
  if (history.length < 8) return null;
  // Welford's algorithm, not `sum / n`.
  //
  // The naive mean of 30 identical values is not exactly that value in
  // floating point, so the naive variance of a constant history is not exactly
  // zero either — it comes out around 1e-19, and dividing by it produces a
  // z-score of 1.5e15, which is a number about nothing. Welford's incremental
  // form leaves `m2` at EXACTLY zero for identical values, so the
  // "no variance" case is detected as the no-variance case it is.
  let mean = 0;
  let m2 = 0;
  for (let i = 0; i < history.length; i++) {
    const delta = history[i] - mean;
    mean += delta / (i + 1);
    m2 += delta * (history[i] - mean);
  }
  if (!(m2 > 0)) return null;
  const sd = Math.sqrt(m2 / history.length);
  if (!(sd > 0)) return null;
  return (current - mean) / sd;
}

export type FundingLabel =
  | 'NEUTRAL' | 'CROWDED_LONG' | 'CROWDED_SHORT'
  | 'EXTREME_LONG' | 'EXTREME_SHORT' | 'SQUEEZE_FUEL';

/**
 * Funding high while OI is FALLING is longs unwinding, not new longs piling
 * in. That is a different and worse setup than high funding with rising OI,
 * which is genuine crowding. The `oiRising` flag is what separates them.
 *
 * The negative thresholds are negated at the call site on purpose. Writing
 * `f <= FUNDING_CROWDED_8H` instead of `f <= -FUNDING_CROWDED_8H` once made
 * this function label EVERY coin with funding below +0.03% as CROWDED_SHORT,
 * including coins at +0.01%. The unit test 'leaves small funding neutral'
 * exists to keep that from coming back.
 */
export function fundingLabel(funding8h: number, oiRising: boolean): FundingLabel {
  const f = funding8h;
  const { FUNDING_CROWDED_8H, FUNDING_EXTREME_8H, FUNDING_SQUEEZE_8H } = DERIVATIVES;

  if (f >= FUNDING_EXTREME_8H) return 'EXTREME_LONG';
  if (f <= -FUNDING_EXTREME_8H) return 'EXTREME_SHORT';
  if (f >= FUNDING_CROWDED_8H && oiRising) return 'CROWDED_LONG';
  if (f <= -FUNDING_CROWDED_8H && oiRising) return 'CROWDED_SHORT';
  if (f <= FUNDING_SQUEEZE_8H && oiRising) return 'SQUEEZE_FUEL';
  return 'NEUTRAL';
}

/** Is funding crowded in the direction we want to trade? */
export function fundingCrowdedAgainst(fundingLabelValue: FundingLabel, side: 'bullish' | 'bearish'): boolean {
  if (side === 'bullish') return fundingLabelValue === 'CROWDED_LONG' || fundingLabelValue === 'EXTREME_LONG';
  return fundingLabelValue === 'CROWDED_SHORT' || fundingLabelValue === 'EXTREME_SHORT';
}

export type OiQuadrant = 'new-longs' | 'short-cover' | 'new-shorts' | 'long-liquidation' | 'flat';

/**
 * The single most useful derivatives read. Price direction crossed with OI
 * direction tells you whether a move is being built by new positions or by
 * positions closing.
 */
export function oiQuadrant(priceChangePct: number, oiChangePct: number): OiQuadrant {
  const flat = Math.abs(priceChangePct) < 0.1 && Math.abs(oiChangePct) < 0.5;
  if (flat) return 'flat';
  if (priceChangePct > 0) return oiChangePct > 0 ? 'new-longs' : 'short-cover';
  return oiChangePct > 0 ? 'new-shorts' : 'long-liquidation';
}

export const QUADRANT_LABEL: Record<OiQuadrant, string> = {
  'new-longs': 'New longs',
  'short-cover': 'Short covering',
  'new-shorts': 'New shorts',
  'long-liquidation': 'Long liquidation',
  flat: 'Flat',
};

/** How healthy the quadrant is for a trade in `side`. 1 = supportive, 0 = against. */
export function quadrantScore(q: OiQuadrant, side: 'bullish' | 'bearish'): number {
  const supportive: Record<OiQuadrant, Partial<Record<'bullish' | 'bearish', number>>> = {
    'new-longs': { bullish: 1, bearish: 0.2 },
    'new-shorts': { bearish: 1, bullish: 0.2 },
    'short-cover': { bullish: 0.4, bearish: 0.4 },
    'long-liquidation': { bullish: 0.3, bearish: 0.7 },
    flat: { bullish: 0.5, bearish: 0.5 },
  };
  return supportive[q][side] ?? 0.5;
}

/**
 * Mark-to-index basis, as a percentage.
 *
 * Deliberately NOT annualised. For illiquid perps the index price goes stale,
 * and annualising a stale gap produces figures like -900% which look like a
 * signal but are really a data-quality artefact. A raw basis above 50% is
 * treated as a bad index and returns null rather than a misleading number.
 */
export function basisPct(mark: number, index: number): number | null {
  if (!Number.isFinite(mark) || !Number.isFinite(index) || index <= 0 || mark <= 0) return null;
  const raw = (mark - index) / index;
  if (Math.abs(raw) > 0.5) return null;
  return raw * 100;
}

/** OI change across several windows, each as a percentage. */
export function oiChanges(history: OiPoint[]): { m5: number; h1: number; h4: number; d1: number } {
  const out = { m5: 0, h1: 0, h4: 0, d1: 0 };
  if (!history.length) return out;
  const latest = history[history.length - 1].oi;
  if (latest <= 0) return out;

  const atOrBefore = (target: number): number | null => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].t <= target) return history[i].oi;
    }
    return null;
  };
  const now = history[history.length - 1].t;
  const windows: [keyof typeof out, number][] = [
    ['m5', 5 * 60_000], ['h1', 60 * 60_000], ['h4', 4 * 60 * 60_000], ['d1', 24 * 60 * 60_000],
  ];
  for (const [key, ms] of windows) {
    const base = atOrBefore(now - ms);
    if (base !== null && base > 0) out[key] = ((latest - base) / base) * 100;
  }
  return out;
}

/** Retail vs top traders. Positive divergence = retail one way, smart money the other. */
export function lsDivergence(
  accountRatio: number | null,
  topPositionRatio: number | null,
): number | null {
  if (accountRatio === null || topPositionRatio === null) return null;
  if (!(accountRatio > 0) || !(topPositionRatio > 0)) return null;
  return (accountRatio - topPositionRatio) / topPositionRatio;
}

export function crossVenue(
  symbol: string,
  primaryFunding8h: number,
  primaryOiUsd: number,
  hyper: HyperRow[] | null,
  bybit: Map<string, { funding8h: number; oiUsd: number }>,
  primaryName: 'binance-futures' | 'bybit-linear' = 'binance-futures',
): DerivRow['crossVenue'] {
  const venues: NonNullable<DerivRow['crossVenue']>['venues'] = [
    {
      name: primaryName === 'bybit-linear' ? 'bybit' : 'binance',
      funding8h: primaryFunding8h,
      oiUsd: primaryOiUsd,
      available: true,
    },
  ];

  const hl = hyper?.find((h) => h.symbol === symbol);
  venues.push({
    name: 'hyperliquid',
    funding8h: hl?.funding8h ?? 0,
    oiUsd: (hl?.openInterest ?? 0) * (hl?.markPrice ?? 0),
    available: !!hl,
  });

  if (primaryName !== 'bybit-linear') {
    const by = bybit.get(symbol);
    venues.push({
      name: 'bybit',
      funding8h: by?.funding8h ?? 0,
      oiUsd: by?.oiUsd ?? 0,
      available: !!by,
    });
  }

  const available = venues.filter((v) => v.available);
  if (available.length < 2) return { venues, fundingSpread: null, oiConcentration: null, divergence: false };

  const fundings = available.map((v) => v.funding8h);
  const fundingSpread = Math.max(...fundings) - Math.min(...fundings);
  const totalOi = available.reduce((a, v) => a + v.oiUsd, 0);
  const oiConcentration = totalOi > 0 ? Math.max(...available.map((v) => v.oiUsd)) / totalOi : null;

  // One venue crowded while the others are not is a venue-specific story, not
  // a market-wide one.
  const crowded = available.filter((v) => v.funding8h >= DERIVATIVES.FUNDING_CROWDED_8H).length;
  const divergence = fundingSpread >= DERIVATIVES.FUNDING_DIVERGENCE && crowded === 1;

  return { venues, fundingSpread, oiConcentration, divergence };
}

/** Rolling z-score against the last `window` readings. */
export function isCascade(current: number, history: number[], sigma = DERIVATIVES.LIQ_CASCADE_SIGMA): boolean {
  if (history.length < 5) return false;
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const sd = Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length);
  return sd > 0 && current >= mean + sigma * sd;
}

/**
 * DVOL regime from its own history. Compressed vol before expansion is a
 * condition, not a prediction.
 */
export function dvolRegime(
  dvol: number | null,
  history: number[],
): 'COMPRESSED' | 'NORMAL' | 'STRESSED' | null {
  if (dvol === null || history.length < 20) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const p = (q: number) => sorted[clamp(Math.floor(q * sorted.length), 0, sorted.length - 1)];
  if (dvol <= p(0.2)) return 'COMPRESSED';
  if (dvol >= p(0.8)) return 'STRESSED';
  return 'NORMAL';
}

export interface BuildRowInput {
  raw: DerivRaw;
  oiHistoryPoints: OiPoint[];
  fundingHistory: number[];
  accountRatio: number | null;
  topPositionRatio: number | null;
  takerRatio: number | null;
  candles: Candle[];
  cvd: { value: number; slope: number; takerRatio: number };
  cvdDivergence: boolean;
  liq: LiqBuckets;
  cross: DerivRow['crossVenue'];
  depth: DerivRow['depth'];
  /**
   * When the upstream snapshot was taken.
   *
   * Added by the M1.4 fix. This function used to stamp `meta.stale: false`
   * unconditionally — a hardcoded claim that the data was fresh, made by a
   * function that had no idea how old the data was. The age is now measured
   * from the caller's `asOf`, and the staleness is derived from it.
   */
  asOf?: number;
}

export function buildDerivRow(input: BuildRowInput): DerivRow {
  const {
    raw, oiHistoryPoints, fundingHistory, accountRatio, topPositionRatio,
    takerRatio, cvd, cvdDivergence, liq, cross, depth,
  } = input;
  const asOf = input.asOf ?? Date.now();

  const funding8h = normaliseFunding(raw.fundingRate, raw.fundingIntervalH);
  const changes = oiChanges(oiHistoryPoints);
  const oiUsd = raw.openInterest * raw.markPrice;
  const oiRising = changes.h1 > 0.5;

  return {
    symbol: raw.symbol,
    funding8h,
    fundingZ: fundingZScore(funding8h, fundingHistory),
    fundingIntervalH: raw.fundingIntervalH,
    fundingLabel: fundingLabel(funding8h, oiRising),
    openInterest: raw.openInterest,
    oiUsd,
    oiChange: changes,
    quadrant: oiQuadrant(
      candlesPct(input.candles),
      changes.h1,
    ),
    quadrantLabel: '',
    markPrice: raw.markPrice,
    indexPrice: raw.indexPrice,
    basisPct: basisPct(raw.markPrice, raw.indexPrice),
    longShortAccountRatio: accountRatio,
    topTraderPositionRatio: topPositionRatio,
    lsDivergence: lsDivergence(accountRatio, topPositionRatio),
    cvd: cvd.value,
    cvdSlope: cvd.slope,
    takerRatio: takerRatio ?? cvd.takerRatio,
    cvdDivergence,
    liq,
    depth,
    crossVenue: cross,
    // The M1.4 fix: `stale` is MEASURED from the caller's `asOf`, not asserted.
    // A hardcoded `false` was a claim about freshness that the function had no
    // information to support.
    meta: {
      asOf,
      source: 'binance-futures',
      ageMs: Math.max(0, Date.now() - asOf),
      stale: Math.max(0, Date.now() - asOf) >= LIVE.STALE_AFTER_MS,
    },
  };
}

function candlesPct(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const a = candles[0].c;
  return a > 0 ? ((candles[candles.length - 1].c - a) / a) * 100 : 0;
}
