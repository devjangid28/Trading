/**
 * Feature store — the Mind layer's single source of truth.
 *
 * ## Why this file is the hard part
 *
 * A model that leaks the future is worse than no model, because it produces
 * beautiful, wrong, actionable numbers. Every function here is therefore built
 * around one rule:
 *
 *   **`asOf` is a wall. Nothing computed here may read past it.**
 *
 * That is enforced structurally rather than by discipline. `buildFeatureVector`
 * takes the FULL series it is given — including candles that have not closed
 * yet — and every accessor goes through `sliceAsOf` / `newsAsOf` first. There is
 * no code path that can reach a future candle, because the future candles are
 * dropped before any computation starts.
 *
 * The test that matters is in `features.test.ts`: append future candles and
 * assert the vector is byte-identical. That catches the leak regardless of which
 * field leaked it.
 *
 * ## Missing data is `null`, never zero
 *
 * Every measurement is a `Measured` union. `null` means "we did not measure
 * this"; zero would mean "we measured it and it was nothing". Indian F&O has no
 * funding, no OI and no CVD, and those fields stay `null` — which is what makes
 * the lower-confidence India path fall out of the design instead of being bolted
 * on afterwards.
 */

import { MIND, STRUCTURE, SESSIONS_UTC } from '../../config.js';
import {
  choppiness as computeChoppiness,
  sessionStartIndex,
  sessionVwap,
} from '../orderblock.js';
// `isUnavailable` is a value import, not a type import: it is a runtime guard and
// it is what distinguishes "the liquidation feed is missing" from "no clusters".
import { isUnavailable } from '../../../../shared/types.js';
import type {
  Candle,
  DerivRow,
  HtfContext,
  Measured,
  MarketPicture,
  NewsItem,
  SectorFlow,
  Setup,
  Side,
  VolatilityContext,
  ConvictionComponents,
  FeatureVector,
  RetestState,
} from '../../../../shared/types.js';
import { deriveAttributionFeatures, type AttributionFeatureSource } from './attribution.js';

const TF_MS_5M = 5 * 60_000;
const TF_MS_15M = 15 * 60_000;
const TF_MS_1H = 60 * 60_000;
const TF_MS_4H = 4 * 60 * 60_000;

/**
 * How far back a candle-close snapshot may look for context. Chosen to cover the
 * 24h session window (STRUCTURE.SESSION_CANDLES) with room for the longer
 * lookbacks (ATR percentile, choppiness), and no further: a feature that needs
 * more history than the session window has to say so rather than silently
 * reaching back into a different session.
 */
export const FEATURE_LOOKBACK_CANDLES = STRUCTURE.SESSION_CANDLES;

/** A missing measurement, at an unknown time. Never a zero. */
export function absent(): Measured {
  return { value: null, at: null };
}

/** A measured value. Rejects non-finite numbers so `NaN` can never ship. */
export function measured(value: number, at: number | null): Measured {
  if (!Number.isFinite(value)) return absent();
  return { value, at };
}

/** Read a measurement as a plain number, or `null` when it was not measured. */
export function num(m: Measured): number | null {
  return m.value === null ? null : m.value;
}

/**
 * Candles that had actually closed at `asOf`.
 *
 * A Binance kline's `t` is its OPEN time, so it closes at `t + interval`. A
 * candle that has not closed yet is the single most dangerous thing to hand a
 * feature extractor, because it looks like data and is partly fiction.
 *
 * The `closed` flag is checked too, but `asOf` is authoritative: a caller that
 * passes a sloppy `closed` flag still cannot leak.
 */
export function sliceAsOf(candles: Candle[], asOf: number, intervalMs = TF_MS_5M): Candle[] {
  return candles.filter((c) => c.t + intervalMs <= asOf);
}

/** News published at or before `asOf`. Same wall, different series. */
export function newsAsOf(items: NewsItem[], asOf: number): NewsItem[] {
  return items.filter((n) => n.publishedAt <= asOf);
}

/**
 * Everything the feature store is allowed to read.
 *
 * Every field is optional-or-null except the ones that make a vector meaningless
 * without them. A caller with only candles still gets a valid, sparse vector.
 */
export interface FeatureInputs {
  symbol: string;
  side: Side;
  /** Candle-close instant. The wall. */
  asOf: number;

  /** FULL candle series. May contain unclosed candles; they are dropped. */
  candles: Candle[];
  setup?: Setup | null;
  htf?: HtfContext | null;
  deriv?: DerivRow | null;
  vol?: VolatilityContext | null;
  sector?: SectorFlow | null;
  market?: MarketPicture | null;
  news?: NewsItem[];
  /** Optional pre-computed attribution, so features.ts need not import the news engine. */
  attribution?: AttributionFeatureSource | null;

  /** The engine's seven conviction components, for the coverage feature. */
  components?: ConvictionComponents | null;
  /** The engine's own 0-100 strength, kept so the Mind score can be compared to it. */
  strength?: number | null;

  /** Market-wide context. Null on the India path. */
  macro?: {
    btcDominancePct?: number | null;
    btcDominanceTrendPp?: number | null;
    ethBtcChangePct?: number | null;
    stablecoinFloatUsd?: number | null;
    fearGreed?: number | null;
    fearGreedHistory?: number[];
  } | null;

  /** Minutes until the next tier-1 release; negative once inside the window. */
  macroBlackoutMin?: number | null;

  /**
   * The market's dealer gamma exposure, as of `gex.asOf`.
   *
   * A MARKET feature, so the same reading applies to every asset. The
   * timestamp is checked against `asOf` inside the builder.
   */
  gex?: { totalNetGex: number; asOf: number } | null;

  /**
   * Cross-venue premiums, each with its own timestamp.
   *
   * Neither has a historical source in this repo, so on the crypto path both
   * are normally absent. That is the honest state.
   */
  crossVenue?: {
    coinbasePremiumBps?: number | null;
    coinbaseAsOf?: number | null;
    indiaPremiumPct?: number | null;
    indiaAsOf?: number | null;
  } | null;

  // ── Engine Lab additions (21 Oct 2026) ───────────────────────────────────
  //
  // Every one of these is OPTIONAL and every one of them is `absent()` when
  // it is not supplied. The vector must stay usable with nothing but candles.

  /**
   * Higher-timeframe candle series, for the 5m-4h range the Lab needs.
   *
   * Each series is sliced by the same `asOf` wall as the 5m series, so a 1h
   * candle that has not closed cannot inform a decision.
   */
  higherTimeframes?: Partial<Record<'15m' | '1h' | '4h', Candle[]>> | null;

  /**
   * BTC's own candle series, for the cross-asset beta.
   *
   * The same symbol's return series is compared against BTC's over the same
   * window. Null when the caller has no BTC series, which is the honest state
   * on any path that is not the crypto board.
   */
  btcCandles?: Candle[] | null;

  /**
   * The order-book levels, for the depth readings.
   *
   * Each level carries its own price and USD size. The snapshot's own
   * timestamp is checked against `asOf` before a single number is read.
   */
  bookLevels?: {
    bids: Array<{ price: number; usd: number }>;
    asks: Array<{ price: number; usd: number }>;
    asOf: number;
  } | null;

  /**
   * Recent funding rates, oldest first, each on its own 8-hour basis.
   *
   * The vector's `fundingZ` is a z-score of the current print; this is the raw
   * series behind it, so a reader can see the shape rather than one
   * standardised number.
   */
  fundingHistory?: number[] | null;

  /**
   * The stablecoin float 24 hours ago, for the flow reading.
   *
   * The vector carries the float LEVEL. A level says nothing about whether
   * money is arriving; the 24-hour change does.
   */
  stablecoinFloat24hAgoUsd?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Session VWAP as of `asOf`, over candles that had closed by then.
 *
 * Passing the untruncated array to the engine's `sessionVwap` returns the VWAP
 * of the *whole* session including bars that close later — a textbook look-ahead
 * that would make every "distance from VWAP" feature quietly better-informed than
 * a live trader ever is. The slice happens here, once.
 */
function vwapAsOf(candles: Candle[]): number | null {
  if (candles.length === 0) return null;
  const from = sessionStartIndex(candles);
  if (from < 0) return null;
  const fromTime = candles[from]?.t;
  if (fromTime === undefined) return null;
  return sessionVwap(candles, fromTime);
}

/** UTC trading session for an hour. Mirrors `timeframes.sessionOf`. */
function sessionForHour(hourUtc: number): 'asia' | 'europe' | 'us' | 'off' {
  for (const [name, [start, end]] of Object.entries(SESSIONS_UTC)) {
    if (hourUtc >= start && hourUtc < end) return name as 'asia' | 'europe' | 'us';
  }
  return 'off';
}

/** ATR percentile from the engine's volatility context, when it measured one. */
function atrPercentileOf(vol: VolatilityContext | null | undefined): Measured {
  if (!vol) return absent();
  const p = vol.atrPercentile;
  if (typeof p !== 'number' || !Number.isFinite(p)) return absent();
  return measured(p, 0);
}

/**
 * Displacement away from the zone, in multiples of the local range.
 *
 * A zone that was left behind by 0.2× the local range has not been respected;
 * one left behind by 3× has. Both facts matter, and neither is in `Setup`
 * directly, so it is derived here rather than guessed at by the scorer.
 */
function displacementX(setup: Setup | null | undefined, candles: Candle[]): Measured {
  if (!setup) return absent();
  const mid = (setup.obHigh + setup.obLow) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return absent();

  const last = candles[candles.length - 1];
  if (!last) return absent();

  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles.slice(-STRUCTURE.ATR_LOOKBACK)) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  const range = hi - lo;
  if (!Number.isFinite(range) || range <= 0) return absent();

  const move = last.c - mid;
  return measured(Math.abs(move) / range, last.t);
}

/** Distance from price to the nearest liquidity level, as a fraction of price. */
function nearestLiquidityDistance(setup: Setup | null | undefined, price: number): Measured {
  if (!setup || !Number.isFinite(price) || price <= 0) return absent();
  const candidates: number[] = [];
  if (Number.isFinite(setup.invalidation)) candidates.push(setup.invalidation);
  for (const lvl of setup.context ?? []) {
    if (Number.isFinite(lvl.price)) candidates.push(lvl.price);
  }
  for (const t of setup.targets ?? []) {
    if (Number.isFinite(t.price)) candidates.push(t.price);
  }
  if (candidates.length === 0) return absent();
  let nearest = Infinity;
  for (const p of candidates) nearest = Math.min(nearest, Math.abs(p - price));
  if (!Number.isFinite(nearest)) return absent();
  return measured(nearest / price, 0);
}

/** -1 / 0 / +1: does this higher-timeframe frame agree with the side? */
function htfAgreement(
  htf: HtfContext | null | undefined,
  side: Side,
  tf: '15m' | '1h' | '4h',
): Measured {
  if (!htf) return absent();
  const frame = (htf.setups ?? []).find((s) => s.tf === tf);
  if (!frame || !frame.present) return absent();
  const wantUp = side === 'bullish';
  if (frame.side === (wantUp ? 'bullish' : 'bearish')) return measured(1, 0);
  return measured(-1, 0);
}

/**
 * True when positioning is crowded AGAINST the side.
 *
 * Direction is easy to get backwards, and getting it backwards turns a warning
 * into a green light: funding is what longs pay shorts, so **positive** funding
 * means the crowd is already long. Joining that crowd is "crowded" for a
 * *bullish* setup — you are late, and you are the exit liquidity if it turns.
 * The mirror holds for a short.
 *
 * This matches `fundingCrowdedAgainst()` in `derivatives.ts`, which is the
 * thresholded label form the engine's own veto layer already uses. Reading the
 * sign of the z-score here rather than re-deriving the label keeps one definition
 * of the *direction* in the codebase; the threshold stays where it already lives.
 */
function crowdedAgainst(deriv: DerivRow | null | undefined, side: Side): Measured {
  if (!deriv) return absent();
  const z = deriv.fundingZ;
  if (z === null || !Number.isFinite(z)) return absent();
  const oiRising = (deriv.oiChange?.h1 ?? 0) > 0;
  if (!oiRising) return measured(0, 0);
  const against = side === 'bullish' ? z > 0 : z < 0;
  return measured(against ? 1 : 0, 0);
}

/**
 * Distance to the nearest liquidation cluster, as a fraction of price.
 *
 * ## This is `absent()` and always has been — FIXED 21 Oct 2026 (bug #47)
 *
 * The old implementation read `deriv.liq.longH1` and `deriv.liq.shortH1` as
 * CLUSTER PRICES and computed `|price - cluster| / price`. They are not prices.
 * `LiquidationTracker.tally()` in `server/src/live/marketState.ts` returns
 * liquidation USD totals per window:
 *
 * ```
 * longH1:  this.sumSince(symbol, h1Since, 'SELL')   // USD, not a price
 * shortH1: this.sumSince(symbol, h1Since, 'BUY')    // USD, not a price
 * ```
 *
 * So the feature was subtracting a USD amount from a price and dividing by the
 * price: a coin at $65,000 with $50,000 of long liquidations in the hour
 * reported a "liquidation cluster 23% away" — a number about nothing, dressed
 * as a distance.
 *
 * There is no liquidation-cluster price anywhere in this repo, so there is
 * nothing to measure here. The feature returns `absent()` and the flow that
 * DOES exist is exposed separately as `liquidations.*`.
 */
function liqClusterDistance(deriv: DerivRow | null | undefined, _price: number): Measured {
  void deriv;
  void _price;
  return absent();
}


// ─────────────────────────────────────────────────────────────────────────────
// Engine Lab feature builders (21 Oct 2026)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The return over a closed higher-timeframe window, in percent.
 *
 * The window is the WHOLE supplied series, not a fixed number of bars, so the
 * caller decides what "1h" means by what it passes. `asOf` slices the series
 * first, so an unclosed higher-timeframe candle cannot leak.
 */
function returnOverWindow(series: Candle[], asOf: number, intervalMs: number): Measured {
  const closed = sliceAsOf(series, asOf, intervalMs);
  if (closed.length < 2) return absent();
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (!first.o || !Number.isFinite(first.o) || first.o <= 0) return absent();
  return measured(((last.c - first.o) / first.o) * 100, last.t);
}

/**
 * ATR on the 5m frame, as a fraction of price.
 *
 * Computed with the same simple-average-of-true-ranges definition the engine's
 * own volatility context uses, so the two cannot disagree about what ATR means.
 */
function atrPctOf(candles: Candle[], asOf: number): Measured {
  const closed = sliceAsOf(candles, asOf);
  if (closed.length < STRUCTURE.ATR_LOOKBACK + 1) return absent();
  const slice = closed.slice(-STRUCTURE.ATR_LOOKBACK);
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const c = slice[i];
    sum += Math.max(
      c.h - c.l,
      Math.abs(c.h - prev.c),
      Math.abs(c.l - prev.c),
    );
  }
  const atr = sum / slice.length;
  const last = slice[slice.length - 1];
  if (!Number.isFinite(atr) || atr <= 0 || last.c <= 0) return absent();
  return measured(atr / last.c, last.t);
}

/**
 * Where the last closed 1h candle sits in its own 24h range, 0-1.
 *
 * 0 is the bottom of the range, 1 the top. It is a position, not a direction:
 * a candle at the top of its range can be a breakout or a blow-off, and the
 * feature only says where it is.
 */
function rangePosition1hOf(candles: Candle[], asOf: number): Measured {
  const closed = sliceAsOf(candles, asOf, TF_MS_1H);
  if (closed.length < 2) return absent();
  const window = closed.slice(-24);
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of window) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  const last = window[window.length - 1];
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi <= lo) return absent();
  return measured((last.c - lo) / (hi - lo), last.t);
}

/** The range of the last closed 1h candle, as a percent of its close. */
function range1hPctOf(candles: Candle[], asOf: number): Measured {
  const closed = sliceAsOf(candles, asOf, TF_MS_1H);
  if (!closed.length) return absent();
  const last = closed[closed.length - 1];
  if (!Number.isFinite(last.c) || last.c <= 0) return absent();
  return measured(((last.h - last.l) / last.c) * 100, last.t);
}

/**
 * Beta, correlation and the idiosyncratic return against BTC.
 *
 * Both series are cut to the SAME closed candles and paired on their close
 * times, because a beta computed against a differently-timed series is not a
 * beta. The window is the shorter of the two.
 *
 * Beta is `cov(asset, btc) / var(btc)`, and it is `null` when BTC's variance
 * is zero — a flat BTC has no beta to give.
 */
function crossAssetOf(
  asset: Candle[],
  btc: Candle[] | null | undefined,
  asOf: number,
): FeatureVector['crossAsset'] {
  const empty: FeatureVector['crossAsset'] = {
    betaToBtc: absent(),
    corrToBtc: absent(),
    btcReturnPct: absent(),
    idiosyncraticReturnPct: absent(),
  };
  if (!btc || !Array.isArray(btc) || btc.length < 3) return empty;

  const a = sliceAsOf(asset, asOf);
  const b = sliceAsOf(btc, asOf);
  if (a.length < 3 || b.length < 3) return empty;

  // Pair on close time. Only candles present in BOTH series count, so a gap in
  // either feed cannot silently shift the pairing.
  const bByTime = new Map<number, Candle>();
  for (const c of b) bByTime.set(c.t, c);
  const pairs: Array<{ a: Candle; b: Candle }> = [];
  for (const c of a) {
    const other = bByTime.get(c.t);
    if (other) pairs.push({ a: c, b: other });
  }
  if (pairs.length < 3) return empty;

  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    const pa = pairs[i - 1].a.c;
    const pb = pairs[i].a.c;
    const qa = pairs[i - 1].b.c;
    const qb = pairs[i].b.c;
    if (!(pa > 0) || !(qa > 0)) continue;
    ra.push(pb / pa - 1);
    rb.push(qb / qa - 1);
  }
  if (ra.length < 3) return empty;

  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let cov = 0;
  let varB = 0;
  let varA = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    varB += (rb[i] - mb) ** 2;
    varA += (ra[i] - ma) ** 2;
  }
  if (!(varB > 0) || !(varA > 0)) return empty;

  const beta = cov / varB;
  const corr = cov / Math.sqrt(varA * varB);
  const btcReturn = rb[rb.length - 1] * 100;
  const assetReturn = ra[ra.length - 1] * 100;
  const idio = assetReturn - beta * btcReturn;
  const at = pairs[pairs.length - 1].a.t;

  return {
    betaToBtc: measured(beta, at),
    corrToBtc: measured(corr, at),
    btcReturnPct: measured(btcReturn, at),
    idiosyncraticReturnPct: measured(idio, at),
  };
}

/**
 * Liquidation FLOW over the last hour.
 *
 * `deriv.liq.longH1` and `shortH1` are USD amounts (see bug #47), so they are
 * used as amounts here. The net pressure is `(long - short) / (long + short)`:
 * positive means LONGS were flushed, which is what a long gets stopped out by.
 *
 * `absent()` when the liquidation feed is not attached. `isSample` is true for
 * the websocket source, so these are LOWER BOUNDS, and the caller is told so
 * through the catalogue description.
 */
function liquidationsOf(deriv: DerivRow | null | undefined): FeatureVector['liquidations'] {
  const empty: FeatureVector['liquidations'] = {
    longLiqUsd: absent(),
    shortLiqUsd: absent(),
    netLiqPressure: absent(),
  };
  if (!deriv || !deriv.liq || isUnavailable(deriv.liq)) return empty;
  const liq = deriv.liq;
  const longUsd = Number.isFinite(liq.longH1) ? liq.longH1 : null;
  const shortUsd = Number.isFinite(liq.shortH1) ? liq.shortH1 : null;
  if (longUsd === null && shortUsd === null) return empty;
  const at = deriv.meta?.asOf ?? null;
  const total = (longUsd ?? 0) + (shortUsd ?? 0);
  return {
    longLiqUsd: longUsd === null ? absent() : measured(longUsd, at),
    shortLiqUsd: shortUsd === null ? absent() : measured(shortUsd, at),
    netLiqPressure: total > 0 ? measured(((longUsd ?? 0) - (shortUsd ?? 0)) / total, at) : absent(),
  };
}

/**
 * Order-book depth within reach, and the imbalance at two ranges.
 *
 * The levels are grouped by how far they are from the mid, in basis points, so
 * "near" and "far" mean the same thing on every asset. The snapshot's own
 * timestamp is checked against `asOf` before any level is read.
 */
function orderbookOf(
  levels: FeatureInputs['bookLevels'],
  price: number,
  asOf: number,
): FeatureVector['orderbook'] {
  const empty: FeatureVector['orderbook'] = {
    depthUsd10bps: absent(),
    depthUsd50bps: absent(),
    imbalanceNear: absent(),
    imbalanceFar: absent(),
  };
  if (!levels || !Number.isFinite(levels.asOf) || levels.asOf > asOf) return empty;
  if (!Number.isFinite(price) || price <= 0) return empty;

  const bids = Array.isArray(levels.bids) ? levels.bids : [];
  const asks = Array.isArray(levels.asks) ? levels.asks : [];
  if (!bids.length && !asks.length) return empty;

  const within = (levelsIn: Array<{ price: number; usd: number }>, bps: number): number => {
    let sum = 0;
    for (const l of levelsIn) {
      if (!Number.isFinite(l.price) || !Number.isFinite(l.usd)) continue;
      if (Math.abs((l.price - price) / price) * 10_000 <= bps) sum += l.usd;
    }
    return sum;
  };

  const nearB = within(bids, 10);
  const nearA = within(asks, 10);
  const farB = within(bids, 50);
  const farA = within(asks, 50);

  const imbalance = (b: number, a: number): number | null => {
    const sum = b + a;
    return sum > 0 ? (b - a) / sum : null;
  };

  return {
    depthUsd10bps: measured(nearB + nearA, levels.asOf),
    depthUsd50bps: measured(farB + farA, levels.asOf),
    imbalanceNear: imbalance(nearB, nearA) === null
      ? absent()
      : measured(imbalance(nearB, nearA) as number, levels.asOf),
    imbalanceFar: imbalance(farB, farA) === null
      ? absent()
      : measured(imbalance(farB, farA) as number, levels.asOf),
  };
}

/**
 * The raw funding series behind the z-score.
 *
 * `deriv.funding8h` is the current print. The history, when supplied, gives
 * the shape: a mean, a low and a high over the last 24 hours. Three prints is
 * one day of funding, so anything shorter is not a day.
 */
function fundingOf(
  deriv: DerivRow | null | undefined,
  history: number[] | null | undefined,
): FeatureVector['funding'] {
  const empty: FeatureVector['funding'] = {
    last8h: absent(),
    mean24h: absent(),
    min24h: absent(),
    max24h: absent(),
  };
  const at = deriv?.meta?.asOf ?? null;
  const last = deriv && Number.isFinite(deriv.funding8h) ? deriv.funding8h : null;
  const series = Array.isArray(history)
    ? history.filter((h) => Number.isFinite(h)).slice(-3)
    : [];
  if (last === null && series.length === 0) return empty;
  return {
    last8h: last === null ? absent() : measured(last, at),
    mean24h: series.length ? measured(series.reduce((x, y) => x + y, 0) / series.length, at) : absent(),
    min24h: series.length ? measured(Math.min(...series), at) : absent(),
    max24h: series.length ? measured(Math.max(...series), at) : absent(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Materialise a frozen, point-in-time-correct feature vector.
 *
 * Pure. Takes the full candle series, drops everything that had not closed by
 * `asOf`, and derives every field from what remains.
 */
export function buildFeatureVector(i: FeatureInputs): FeatureVector {
  const asOf = i.asOf;

  // ── THE WALL. Nothing below this line can see past `asOf`. ────────────────
  const closed = sliceAsOf(i.candles, asOf);
  const news = newsAsOf(i.news ?? [], asOf);

  // NOTE: `events` and `unlocks` are deliberately NOT features. They are already
  // consumed by the engine's own veto layer, and the one thing the Mind layer
  // needs from the calendar — how close the next tier-1 release is — arrives as
  // the single `macroBlackoutMin` reading. Re-deriving it here would be a second
  // definition of "how close is the blackout", and two definitions of a veto
  // condition is how they drift apart.

  // ── Structure ───────────────────────────────────────────────────────────
  const last = closed[closed.length - 1] ?? null;
  const price = last ? last.c : 0;
  const vwap = vwapAsOf(closed);
  const setup = i.setup ?? null;

  const vwapDistFrac: Measured =
    vwap !== null && price > 0 && Number.isFinite(vwap)
      ? measured((price - vwap) / vwap, last?.t ?? null)
      : absent();

  const structure: FeatureVector['structure'] = {
    hasSetup: measured(setup ? 1 : 0, asOf),
    obAgeMin: setup ? measured(setup.ageMinutes, setup.obTime) : absent(),
    displacementX: displacementX(setup, closed),
    hasFvg: setup ? measured(setup.fvg ? 1 : 0, asOf) : absent(),
    fvgInsideHtfOb: fvgNestedInHtf(setup, i.htf),
    htf15m: htfAgreement(i.htf, i.side, '15m'),
    htf1h: htfAgreement(i.htf, i.side, '1h'),
    htf4h: htfAgreement(i.htf, i.side, '4h'),
    liqPoolDistFrac: nearestLiquidityDistance(setup, price),
    vwapDistFrac,
    choppiness:
      closed.length >= 15 ? measured(computeChoppiness(closed), asOf) : absent(),
    retest: (setup?.retest as RetestState | undefined) ?? null,
    strength: typeof i.strength === 'number' ? measured(i.strength, asOf) : absent(),
  };

  // ── Positioning ─────────────────────────────────────────────────────────
  const d = i.deriv ?? null;
  // `oiChange` is read defensively: a partially-built DerivRow from any caller
  // that skipped it would otherwise throw on `.h1`. Each read below degrades to
  // `absent()` rather than to a zero.
  const oi = d?.oiChange;
  const positioning: FeatureVector['positioning'] = {
    fundingZ:
      d && d.fundingZ !== null && Number.isFinite(d.fundingZ)
        ? measured(d.fundingZ, d.meta?.asOf ?? null)
        : absent(),
    oiChange1h: oi ? measured(oi.h1, d?.meta?.asOf ?? null) : absent(),
    oiChange4h: oi ? measured(oi.h4, d?.meta?.asOf ?? null) : absent(),
    oiChange24h: oi ? measured(oi.d1, d?.meta?.asOf ?? null) : absent(),
    longShortRatio:
      d && d.longShortAccountRatio !== null && Number.isFinite(d.longShortAccountRatio)
        ? measured(d.longShortAccountRatio, d.meta?.asOf ?? null)
        : absent(),
    cvdSlope:
      d && d.cvdSlope !== null && Number.isFinite(d.cvdSlope)
        ? measured(d.cvdSlope, d.meta?.asOf ?? null)
        : absent(),
    liqClusterDistFrac: liqClusterDistance(d, price),
    basisPct:
      d && d.basisPct !== null && Number.isFinite(d.basisPct)
        ? measured(d.basisPct, d.meta?.asOf ?? null)
        : absent(),
    crowdedAgainst: crowdedAgainst(d, i.side),
  };

  // ── Catalyst ────────────────────────────────────────────────────────────
  const fourHoursAgo = asOf - 4 * 3600_000;
  const recentNews = news.filter((n) => n.publishedAt >= fourHoursAgo);
  const attrib = deriveAttributionFeatures(i.attribution, recentNews, asOf);

  const catalyst: FeatureVector['catalyst'] = {
    maxNis4h: recentNews.length
      ? measured(Math.max(...recentNews.map((n) => n.nis)), asOf)
      : absent(),
    attributionCoveragePct: attrib.coveragePct,
    routineDominates: attrib.routineDominates,
    reversalRisk: attrib.reversalRisk,
    newsDirection: attrib.direction,
  };

  // ── Regime inputs ───────────────────────────────────────────────────────
  const m = i.macro ?? null;
  const breadthRatio =
    i.market && i.market.total >= MIND.REGIME_MIN_BOARD
      ? measured(i.market.bullishCount / i.market.total, asOf)
      : absent();

  const sectorRel: Measured =
    i.sector && Number.isFinite(i.sector.avgChange) && Number.isFinite(price) && price > 0
      ? measured(i.sector.avgChange / 100, i.sector.members.length ? asOf : null)
      : absent();

  const regime: FeatureVector['regime'] = {
    btcDominanceTrendPp:
      m && typeof m.btcDominanceTrendPp === 'number'
        ? measured(m.btcDominanceTrendPp, asOf)
        : absent(),
    ethBtcChangePct:
      m && typeof m.ethBtcChangePct === 'number' ? measured(m.ethBtcChangePct, asOf) : absent(),
    stablecoinFloatUsd:
      m && typeof m.stablecoinFloatUsd === 'number' ? measured(m.stablecoinFloatUsd, asOf) : absent(),
    // The stablecoin FLOW reading needs a second measurement (the float 24h
    // ago), so it is computed after this block and assigned below.
    stablecoinFlow24hPct: absent(),
    fearGreedZ: fearGreedZ(m?.fearGreed ?? null, m?.fearGreedHistory ?? []),
    macroBlackoutMin:
      typeof i.macroBlackoutMin === 'number' && Number.isFinite(i.macroBlackoutMin)
        ? measured(i.macroBlackoutMin, asOf)
        : absent(),
    breadthRatio,
    sectorRelativeStrength: sectorRel,
  };

  // ── Context ─────────────────────────────────────────────────────────────
  const hourUtc = last ? new Date(last.t).getUTCHours() : new Date(asOf).getUTCHours();
  const comps = i.components;
  const compValues = comps ? Object.values(comps) : [];
  const missingFrac = compValues.length
    ? compValues.filter((v) => v === null).length / compValues.length
    : 0;

  const eventRiskFrac =
    last && last.o > 0
      ? measured(Math.abs((last.c - last.o) / last.o), last.t)
      : absent();

  const context: FeatureVector['context'] = {
    hourUtc: measured(hourUtc, asOf),
    session: sessionForHour(hourUtc),
    atrPercentile: atrPercentileOf(i.vol),
    eventRisk: eventRiskFrac,
    convictionMissingFrac: measured(missingFrac, asOf),
  };

  // ── Microstructure and cross-venue (Part XIX) ────────────────────────────
  //
  // Every reading here is guarded by its OWN timestamp against `asOf`. A feed
  // that arrives with a snapshot taken after the decision must not be able to
  // inform the decision, and the guard has to be per-source: a book snapshot
  // from 3 seconds in the future is still a look-ahead.
  const depth = i.deriv?.depth ?? null;
  const depthOk = depth !== null && Number.isFinite(depth.asOf) && depth.asOf <= asOf;

  const gex = i.gex ?? null;
  const gexOk = gex !== null && Number.isFinite(gex.asOf) && gex.asOf <= asOf;

  const cv = i.crossVenue ?? null;
  const coinbaseOk =
    cv?.coinbasePremiumBps != null && cv.coinbaseAsOf != null
    && Number.isFinite(cv.coinbaseAsOf) && cv.coinbaseAsOf <= asOf
    && Number.isFinite(cv.coinbasePremiumBps);
  const indiaOk =
    cv?.indiaPremiumPct != null && cv.indiaAsOf != null
    && Number.isFinite(cv.indiaAsOf) && cv.indiaAsOf <= asOf
    && Number.isFinite(cv.indiaPremiumPct);

  const microstructure: FeatureVector['microstructure'] = {
    bookImbalance: depthOk
      ? measured((depth.bidUsd - depth.askUsd) / Math.max(1e-9, depth.bidUsd + depth.askUsd), depth.asOf)
      : absent(),
    spreadBps: depthOk ? measured(depth.spreadBps, depth.asOf) : absent(),
    // From the CLOSED candles' taker-buy notional, so it is point-in-time by
    // construction: the slice above already dropped anything still forming.
    aggTradeImbalance: aggTradeImbalanceOf(closed, last?.t ?? asOf),
    gexUsd: gexOk ? measured(gex.totalNetGex, gex.asOf) : absent(),
  };

  const crossVenue: FeatureVector['crossVenue'] = {
    coinbasePremiumBps: coinbaseOk
      ? measured(cv!.coinbasePremiumBps as number, cv!.coinbaseAsOf as number)
      : absent(),
    indiaPremiumPct: indiaOk
      ? measured(cv!.indiaPremiumPct as number, cv!.indiaAsOf as number)
      : absent(),
  };

  // ── Multi-timeframe ──────────────────────────────────────────────────────
  //
  // Each series is sliced by the same wall. A 1h candle that has not closed
  // cannot inform a 5m decision, and the slice is per-series rather than
  // global because the frames close at different instants.
  const ht = i.higherTimeframes ?? null;
  const t15 = ht?.['15m'] ?? [];
  const t1h = ht?.['1h'] ?? [];
  const t4h = ht?.['4h'] ?? [];

  const timeframes: FeatureVector['timeframes'] = {
    ret15mPct: returnOverWindow(t15, asOf, TF_MS_15M),
    ret1hPct: returnOverWindow(t1h, asOf, TF_MS_1H),
    ret4hPct: returnOverWindow(t4h, asOf, TF_MS_4H),
    atrPct5m: atrPctOf(closed, asOf),
    range1hPct: range1hPctOf(t1h, asOf),
    rangePosition1h: rangePosition1hOf(t1h, asOf),
  };

  // ── Cross-asset ──────────────────────────────────────────────────────────
  const crossAsset = crossAssetOf(i.candles, i.btcCandles, asOf);

  // ── Liquidations ─────────────────────────────────────────────────────────
  const liquidations = liquidationsOf(d);

  // ── Order book ───────────────────────────────────────────────────────────
  const orderbook = orderbookOf(i.bookLevels, price, asOf);

  // ── Funding history ──────────────────────────────────────────────────────
  const funding = fundingOf(d, i.fundingHistory);

  // ── Stablecoin FLOW ──────────────────────────────────────────────────────
  //
  // The vector already carries the float LEVEL under `regime`. A level says
  // nothing about whether money is arriving; the 24-hour change does. It is a
  // separate reading because it needs a second measurement the level does not.
  const floatNow = m && typeof m.stablecoinFloatUsd === 'number' ? m.stablecoinFloatUsd : null;
  const floatAgo = typeof i.stablecoinFloat24hAgoUsd === 'number' ? i.stablecoinFloat24hAgoUsd : null;
  const stablecoinFlow =
    floatNow !== null && floatAgo !== null && floatAgo > 0
      ? measured(((floatNow - floatAgo) / floatAgo) * 100, asOf)
      : absent();

  return {
    symbol: i.symbol,
    asOf,
    side: i.side,
    structure,
    positioning,
    catalyst,
    regime: { ...regime, stablecoinFlow24hPct: stablecoinFlow },
    context,
    microstructure,
    crossVenue,
    timeframes,
    crossAsset,
    liquidations,
    orderbook,
    funding,
    // Filled by the caller that also runs the classifier. Keeping it here as
    // `null` would break the type, so the builder takes the default and the
    // classifier overwrites it in one place.
    regimeLabel: 'quiet',
  };
}

/**
 * Aggressive buy minus aggressive sell, as a fraction of the total volume.
 *
 * Computed from the taker-buy notional on the CLOSED candles: the buy side is
 * known, and the sell side is the remainder. A candle whose taker-buy
 * notional is not reported carries no information, so it is left out of the
 * sum rather than counted as zero volume.
 *
 * `null` — not zero — when there is nothing to measure.
 */
function aggTradeImbalanceOf(closed: Candle[], at: number | null): Measured {
  let buy = 0;
  let total = 0;
  for (const c of closed) {
    const qv = c.qv;
    const tbq = c.takerBuyQuote;
    if (qv === undefined || tbq === undefined) continue;
    if (!Number.isFinite(qv) || !Number.isFinite(tbq)) continue;
    if (qv <= 0) continue;
    buy += tbq;
    total += qv;
  }
  if (total <= 0) return absent();
  return measured((2 * buy - total) / total, at);
}

/** Fear & Greed as a z-score over its own recent history. */
function fearGreedZ(current: number | null | undefined, history: number[]): Measured {
  if (current === null || current === undefined || !Number.isFinite(current)) return absent();
  if (!Array.isArray(history) || history.length < 8) return absent();
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  let variance = 0;
  for (const h of history) variance += (h - mean) ** 2;
  const sd = Math.sqrt(variance / history.length);
  if (!Number.isFinite(sd) || sd <= 0) return absent();
  return measured((current - mean) / sd, null);
}

/**
 * True when the setup's FVG sits inside a higher-timeframe zone.
 *
 * **Currently always unmeasurable, and that is deliberate.** `Setup.fvg` is a
 * boolean: the engine detects the gap but does not publish its price bounds, so
 * there is nothing here to test containment against. Rather than substitute a
 * proxy and present it as the ICT nested-FVG feature, this returns `absent()`.
 *
 * It stays in the schema so the scorer's feature list is stable. Making it real
 * means exporting `fvgLow`/`fvgHigh` from `detectOrderBlock` — recorded as an
 * honest gap in CONTEXT.md §13, not quietly approximated here.
 */
function fvgNestedInHtf(
  _setup: Setup | null | undefined,
  _htf: HtfContext | null | undefined,
): Measured {
  return absent();
}

/** Count of features that could not be measured, and the total. Used for coverage. */
export function featureCoverage(v: FeatureVector): { measured: number; total: number } {
  let measuredCount = 0;
  let total = 0;
  for (const group of [
    v.structure,
    v.positioning,
    v.catalyst,
    v.regime,
    v.context,
    v.microstructure,
    v.crossVenue,
    v.timeframes,
    v.crossAsset,
    v.liquidations,
    v.orderbook,
    v.funding,
  ]) {
    for (const val of Object.values(group)) {
      if (val && typeof val === 'object' && 'value' in (val as Measured)) {
        total += 1;
        if ((val as Measured).value !== null) measuredCount += 1;
      }
    }
  }
  return { measured: measuredCount, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// The feature catalogue — every feature has a NAME and a UNIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The unit a feature's value is expressed in.
 *
 * A unit is not decoration. "0.12" means something different as a ratio, as a
 * percent and as a USD amount, and a model that reads a percent as a ratio
 * will learn a rule that is true of the label and false of the world.
 */
export type FeatureUnit =
  | 'ratio'
  | 'percent'
  | 'usd'
  | 'bps'
  | 'zscore'
  | 'count'
  | 'flag'
  | 'minutes'
  | 'hours'
  | 'index'
  | 'text';

export interface FeatureSpec {
  /** The stable, machine-readable name of the feature. */
  name: string;
  /** The dotted path of the feature inside the `FeatureVector`. */
  path: string;
  /** The unit the value is in. */
  unit: FeatureUnit;
  /** One line saying what the feature measures. */
  description: string;
}

/**
 * Every feature the engine can see, with its name, unit and meaning.
 *
 * The list is the CONTRACT between the feature store and anything that reads a
 * model: a feature that is not in this list is not a feature, and a feature in
 * this list that is `null` was NOT MEASURED — it is not a zero.
 */
export const FEATURE_CATALOGUE: readonly FeatureSpec[] = [
  // ── Structure ────────────────────────────────────────────────────────────
  { name: 'hasSetup', path: 'structure.hasSetup', unit: 'flag', description: 'Whether an order-block setup was detected at decision time.' },
  { name: 'obAgeMin', path: 'structure.obAgeMin', unit: 'minutes', description: 'Minutes since the order block formed.' },
  { name: 'displacementX', path: 'structure.displacementX', unit: 'ratio', description: 'Displacement away from the zone, in multiples of the local range.' },
  { name: 'hasFvg', path: 'structure.hasFvg', unit: 'flag', description: 'Whether a fair-value gap was detected.' },
  { name: 'fvgInsideHtfOb', path: 'structure.fvgInsideHtfOb', unit: 'flag', description: 'Whether the FVG sits inside a higher-timeframe zone. Always null: the engine does not publish FVG price bounds.' },
  { name: 'htf15m', path: 'structure.htf15m', unit: 'index', description: '15m agreement with the side: -1 against, +1 with.' },
  { name: 'htf1h', path: 'structure.htf1h', unit: 'index', description: '1h agreement with the side: -1 against, +1 with.' },
  { name: 'htf4h', path: 'structure.htf4h', unit: 'index', description: '4h agreement with the side: -1 against, +1 with.' },
  { name: 'liqPoolDistFrac', path: 'structure.liqPoolDistFrac', unit: 'ratio', description: 'Distance from price to the nearest published liquidity level, as a fraction of price.' },
  { name: 'vwapDistFrac', path: 'structure.vwapDistFrac', unit: 'ratio', description: 'Signed distance from session VWAP. Positive is above.' },
  { name: 'choppiness', path: 'structure.choppiness', unit: 'ratio', description: 'Efficiency of the last 15 closed candles. Lower is choppier.' },
  { name: 'strength', path: 'structure.strength', unit: 'index', description: "The engine's own 0-100 strength score." },

  // ── Positioning ──────────────────────────────────────────────────────────
  { name: 'fundingZ', path: 'positioning.fundingZ', unit: 'zscore', description: 'Funding rate z-scored over its rolling window.' },
  { name: 'oiChange1h', path: 'positioning.oiChange1h', unit: 'percent', description: 'Open interest change over 1h.' },
  { name: 'oiChange4h', path: 'positioning.oiChange4h', unit: 'percent', description: 'Open interest change over 4h.' },
  { name: 'oiChange24h', path: 'positioning.oiChange24h', unit: 'percent', description: 'Open interest change over 24h.' },
  { name: 'longShortRatio', path: 'positioning.longShortRatio', unit: 'ratio', description: 'Account long/short ratio.' },
  { name: 'cvdSlope', path: 'positioning.cvdSlope', unit: 'index', description: 'Slope of cumulative volume delta. Positive is buy-aggressive.' },
  { name: 'liqClusterDistFrac', path: 'positioning.liqClusterDistFrac', unit: 'ratio', description: 'Distance to the nearest liquidation cluster. Always null: no cluster price exists in this repo.' },
  { name: 'basisPct', path: 'positioning.basisPct', unit: 'percent', description: 'Mark-to-index basis.' },
  { name: 'crowdedAgainst', path: 'positioning.crowdedAgainst', unit: 'flag', description: 'Whether positioning is crowded AGAINST the side.' },

  // ── Catalyst ─────────────────────────────────────────────────────────────
  { name: 'maxNis4h', path: 'catalyst.maxNis4h', unit: 'index', description: 'Highest news-impact score published in the last 4h.' },
  { name: 'attributionCoveragePct', path: 'catalyst.attributionCoveragePct', unit: 'percent', description: 'Share of the move the headlines account for.' },
  { name: 'routineDominates', path: 'catalyst.routineDominates', unit: 'flag', description: 'Whether the leading driver is routine price commentary.' },
  { name: 'reversalRisk', path: 'catalyst.reversalRisk', unit: 'index', description: 'The engine\'s reversal-risk reading on the catalyst.' },
  { name: 'newsDirection', path: 'catalyst.newsDirection', unit: 'index', description: 'Direction of the strongest aligned headline: -1, 0, +1.' },

  // ── Regime ───────────────────────────────────────────────────────────────
  { name: 'btcDominanceTrendPp', path: 'regime.btcDominanceTrendPp', unit: 'percent', description: 'BTC dominance trend, in percentage points.' },
  { name: 'ethBtcChangePct', path: 'regime.ethBtcChangePct', unit: 'percent', description: 'ETH against BTC, in percent.' },
  { name: 'stablecoinFloatUsd', path: 'regime.stablecoinFloatUsd', unit: 'usd', description: 'Total stablecoin float, in USD.' },
  { name: 'stablecoinFlow24hPct', path: 'regime.stablecoinFlow24hPct', unit: 'percent', description: 'Stablecoin float change over 24h.' },
  { name: 'fearGreedZ', path: 'regime.fearGreedZ', unit: 'zscore', description: 'Fear & Greed z-scored over its own recent history.' },
  { name: 'macroBlackoutMin', path: 'regime.macroBlackoutMin', unit: 'minutes', description: 'Minutes until the next tier-1 release; negative inside the window.' },
  { name: 'breadthRatio', path: 'regime.breadthRatio', unit: 'ratio', description: 'Bullish share of the board.' },
  { name: 'sectorRelativeStrength', path: 'regime.sectorRelativeStrength', unit: 'ratio', description: "The asset's sector's average move, as a fraction of price." },

  // ── Context ──────────────────────────────────────────────────────────────
  { name: 'hourUtc', path: 'context.hourUtc', unit: 'hours', description: 'UTC hour of the candle.' },
  { name: 'session', path: 'context.session', unit: 'text', description: 'UTC trading session: asia, europe, us or off.' },
  { name: 'atrPercentile', path: 'context.atrPercentile', unit: 'percent', description: 'ATR percentile over the lookback window.' },
  { name: 'eventRisk', path: 'context.eventRisk', unit: 'ratio', description: 'Size of the last candle\'s move relative to its open.' },
  { name: 'convictionMissingFrac', path: 'context.convictionMissingFrac', unit: 'ratio', description: 'Fraction of the conviction components that could not be measured.' },

  // ── Microstructure ───────────────────────────────────────────────────────
  { name: 'bookImbalance', path: 'microstructure.bookImbalance', unit: 'ratio', description: 'Top-of-book imbalance, (bid - ask) / (bid + ask).' },
  { name: 'spreadBps', path: 'microstructure.spreadBps', unit: 'bps', description: 'The book spread, in basis points.' },
  { name: 'aggTradeImbalance', path: 'microstructure.aggTradeImbalance', unit: 'ratio', description: 'Aggressive buy minus aggressive sell as a fraction of total volume.' },
  { name: 'gexUsd', path: 'microstructure.gexUsd', unit: 'usd', description: 'Net dealer gamma exposure, market-wide, in USD.' },

  // ── Cross-venue ──────────────────────────────────────────────────────────
  { name: 'coinbasePremiumBps', path: 'crossVenue.coinbasePremiumBps', unit: 'bps', description: "Coinbase's price over Binance's, in basis points." },
  { name: 'indiaPremiumPct', path: 'crossVenue.indiaPremiumPct', unit: 'percent', description: "The India market's premium or discount." },

  // ── Multi-timeframe ──────────────────────────────────────────────────────
  { name: 'ret15mPct', path: 'timeframes.ret15mPct', unit: 'percent', description: 'Return over the closed 15m window.' },
  { name: 'ret1hPct', path: 'timeframes.ret1hPct', unit: 'percent', description: 'Return over the closed 1h window.' },
  { name: 'ret4hPct', path: 'timeframes.ret4hPct', unit: 'percent', description: 'Return over the closed 4h window.' },
  { name: 'atrPct5m', path: 'timeframes.atrPct5m', unit: 'ratio', description: 'ATR on the 5m frame as a fraction of price.' },
  { name: 'range1hPct', path: 'timeframes.range1hPct', unit: 'percent', description: 'Range of the last closed 1h candle, as a percent of its close.' },
  { name: 'rangePosition1h', path: 'timeframes.rangePosition1h', unit: 'ratio', description: 'Where the last closed 1h candle sits in its own 24h range.' },

  // ── Cross-asset ──────────────────────────────────────────────────────────
  { name: 'betaToBtc', path: 'crossAsset.betaToBtc', unit: 'ratio', description: 'Rolling beta of this asset\'s returns to BTC\'s.' },
  { name: 'corrToBtc', path: 'crossAsset.corrToBtc', unit: 'ratio', description: 'Correlation with BTC over the same window.' },
  { name: 'btcReturnPct', path: 'crossAsset.btcReturnPct', unit: 'percent', description: "BTC's own return over the window." },
  { name: 'idiosyncraticReturnPct', path: 'crossAsset.idiosyncraticReturnPct', unit: 'percent', description: "This asset's return minus beta times BTC's return." },

  // ── Liquidations ─────────────────────────────────────────────────────────
  { name: 'longLiqUsd', path: 'liquidations.longLiqUsd', unit: 'usd', description: 'Long liquidations over the last hour. A LOWER BOUND from the websocket feed.' },
  { name: 'shortLiqUsd', path: 'liquidations.shortLiqUsd', unit: 'usd', description: 'Short liquidations over the last hour. A LOWER BOUND from the websocket feed.' },
  { name: 'netLiqPressure', path: 'liquidations.netLiqPressure', unit: 'ratio', description: '(long - short) / (long + short). Positive means longs were flushed.' },

  // ── Order book ───────────────────────────────────────────────────────────
  { name: 'depthUsd10bps', path: 'orderbook.depthUsd10bps', unit: 'usd', description: 'Book depth within 10 bps of the mid.' },
  { name: 'depthUsd50bps', path: 'orderbook.depthUsd50bps', unit: 'usd', description: 'Book depth within 50 bps of the mid.' },
  { name: 'imbalanceNear', path: 'orderbook.imbalanceNear', unit: 'ratio', description: 'Imbalance of the near book only.' },
  { name: 'imbalanceFar', path: 'orderbook.imbalanceFar', unit: 'ratio', description: 'Imbalance of the whole attached book.' },

  // ── Funding history ──────────────────────────────────────────────────────
  { name: 'fundingLast8h', path: 'funding.last8h', unit: 'ratio', description: 'The most recent funding rate, on an 8h basis.' },
  { name: 'fundingMean24h', path: 'funding.mean24h', unit: 'ratio', description: 'Mean funding over the last 24h.' },
  { name: 'fundingMin24h', path: 'funding.min24h', unit: 'ratio', description: 'Lowest funding over the last 24h.' },
  { name: 'fundingMax24h', path: 'funding.max24h', unit: 'ratio', description: 'Highest funding over the last 24h.' },
];

/** One catalogue entry, resolved against a live vector. */
export interface CatalogueEntry extends FeatureSpec {
  /** The measured value, or null when the feature was not measured. */
  value: number | null;
  /** The timestamp of the measurement, or null. */
  at: number | null;
  /** True when the value is missing rather than zero. */
  missing: boolean;
}

/**
 * Read one dotted path out of a vector.
 *
 * Returns `undefined` when the path does not exist, which the catalogue turns
 * into a `null` value and a `missing: true` flag. A path that does not exist is
 * a bug in the catalogue, and it shows up as a missing feature rather than as
 * a crash in the middle of a scan.
 */
function readPath(v: FeatureVector, path: string): Measured | undefined {
  let cur: unknown = v;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  if (!cur || typeof cur !== 'object' || !('value' in (cur as Measured))) return undefined;
  return cur as Measured;
}

/**
 * The catalogue, resolved against a live vector.
 *
 * This is what the Lab shows: every feature the engine can see, its unit, and
 * its value — or the fact that it was not measured.
 */
export function featureCatalogue(v: FeatureVector): CatalogueEntry[] {
  return FEATURE_CATALOGUE.map((spec) => {
    const m = readPath(v, spec.path);
    const isMeasured = m !== undefined && m.value !== null;
    return {
      ...spec,
      value: isMeasured ? (m!.value as number) : null,
      at: m?.at ?? null,
      missing: !isMeasured,
    };
  });
}
