import type { Candle, HtfContext, HtfSetup, Tf } from '../../../shared/types';
import { CONVICTION, SESSIONS_UTC, STRUCTURE } from '../config.js';
import { averageRange, detectOrderBlock, findPivots, trendFromPivots } from './orderblock.js';

/**
 * Phase 3 — multi-timeframe structure.
 *
 * The 5m setup is the entry. Everything here exists to answer one question:
 * is this 5m zone trading with the higher timeframes or against them?
 */

export const TF_MS: Record<Tf, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

/** Run the order block detector on each higher timeframe. */
export function higherFrameSetups(
  candlesByTf: Partial<Record<Tf, Candle[]>>,
): HtfSetup[] {
  const out: HtfSetup[] = [];
  for (const tf of ['15m', '1h', '4h'] as Tf[]) {
    const candles = candlesByTf[tf] ?? [];
    const closed = candles.filter((c) => c.closed);
    if (closed.length < 40) {
      out.push({ tf, side: null, z: null, obLow: null, obHigh: null, present: false });
      continue;
    }
    const setup = detectOrderBlock(candles, {
      range: averageRange(closed, STRUCTURE.ATR_LOOKBACK),
    });
    out.push({
      tf,
      side: setup?.side ?? null,
      z: setup?.z ?? null,
      obLow: setup?.obLow ?? null,
      obHigh: setup?.obHigh ?? null,
      present: !!setup,
    });
  }
  return out;
}

/**
 * Alignment: a 5m zone that sits inside or touches a same-side 1h/4h zone is
 * aligned. One fighting a fresh opposite-side higher frame is penalised.
 *
 * The overlay case matters more than the trend case — a 5m zone inside a 4h
 * zone has far better odds than a 5m zone that merely agrees with a 4m trend.
 */
export function assessHtf(
  zoneLow: number,
  zoneHigh: number,
  side: 'bullish' | 'bearish',
  candlesByTf: Partial<Record<Tf, Candle[]>>,
): HtfContext {
  const setups = higherFrameSetups(candlesByTf);

  const trend = (tf: Tf) => {
    const candles = (candlesByTf[tf] ?? []).filter((c) => c.closed);
    return candles.length >= 30 ? trendFromPivots(findPivots(candles, STRUCTURE.PIVOT_WING)) : 'range';
  };
  const trend1h = trend('1h');
  const trend4h = trend('4h');

  const sameSide = setups.filter((s) => s.present && s.side === side && s.obLow !== null && s.obHigh !== null);
  const overlay = sameSide.some((s) => zoneLow >= s.obLow! && zoneHigh <= s.obHigh!);
  const nearTouch = sameSide.some(
    (s) => zoneLow <= s.obHigh! && zoneHigh >= s.obLow!,
  );

  const opposite = setups.filter((s) => s.present && s.side !== null && s.side !== side);
  const freshOpposite = opposite.find((s) => {
    const candles = candlesByTf[s.tf] ?? [];
    const closed = candles.filter((c) => c.closed);
    if (!closed.length) return false;
    return closed[closed.length - 1].t - s.obHigh! < 60 * 60_000;
  });

  const trendAgrees =
    side === 'bullish'
      ? trend1h === 'up' || trend4h === 'up'
      : trend1h === 'down' || trend4h === 'down';

  const aligned = overlay || (nearTouch && trendAgrees);
  const conflict = !!freshOpposite && !overlay;

  let scoreAdj = 0;
  if (overlay) scoreAdj += CONVICTION.HTF_ALIGNED_BONUS;
  else if (nearTouch && trendAgrees) scoreAdj += CONVICTION.HTF_ALIGNED_BONUS * 0.6;
  else if (trendAgrees) scoreAdj += CONVICTION.HTF_ALIGNED_BONUS * 0.3;
  if (conflict) scoreAdj -= CONVICTION.HTF_CONFLICT_PENALTY;

  return { aligned, conflict, trend1h, trend4h, setups, scoreAdj: Math.round(scoreAdj) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Volatility context
// ─────────────────────────────────────────────────────────────────────────────

function percentileOfSample(value: number, sample: number[]): number {
  if (sample.length < 5) return 50;
  const below = sample.filter((v) => v < value).length;
  return Math.round((below / sample.length) * 1000) / 10;
}

export function volatilityContext(candles: Candle[]): {
  atrPct: number;
  atrPercentile: number;
  realisedVolPct: number;
  realisedVolPercentile: number;
  bollingerWidth: number;
  squeeze: boolean;
  hourlyVolumeProfile: number[];
  session: 'asia' | 'europe' | 'us' | 'off';
} {
  const closed = candles.filter((c) => c.closed);
  if (closed.length < 30) {
    return {
      atrPct: 0, atrPercentile: 50, realisedVolPct: 0, realisedVolPercentile: 50,
      bollingerWidth: 0, squeeze: false, hourlyVolumeProfile: new Array(24).fill(0),
      session: 'off',
    };
  }

  const last = closed[closed.length - 1].c;
  const rng = averageRange(closed, STRUCTURE.ATR_LOOKBACK);
  const atrPct = last > 0 ? (rng / last) * 100 : 0;

  // Rolling ATR% history for the percentile.
  const atrSeries: number[] = [];
  for (let end = STRUCTURE.ATR_LOOKBACK + 1; end <= closed.length; end += 1) {
    const r = averageRange(closed.slice(0, end), STRUCTURE.ATR_LOOKBACK);
    const c = closed[end - 1].c;
    if (c > 0) atrSeries.push((r / c) * 100);
  }

  // Realised volatility: stdev of log returns, annualised is overkill for an
  // intraday read so we report per-candle sigma in %.
  const returns: number[] = [];
  for (let i = closed.length - STRUCTURE.SQUEEZE_LOOKBACK - 1; i < closed.length; i++) {
    const a = closed[i - 1].c;
    if (a > 0) returns.push(Math.log(closed[i].c / a));
  }
  const rvMean = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const realisedVolPct = Math.sqrt(
    returns.reduce((a, b) => a + (b - rvMean) ** 2, 0) / Math.max(1, returns.length),
  ) * 100;

  // Bollinger width for the squeeze flag — compression often precedes expansion.
  const window = closed.slice(-STRUCTURE.SQUEEZE_LOOKBACK);
  const sma = window.reduce((a, c) => a + c.c, 0) / window.length;
  const variance = window.reduce((a, c) => a + (c.c - sma) ** 2, 0) / window.length;
  const sd = Math.sqrt(variance);
  const bollingerWidth = sma > 0 ? (4 * sd) / sma * 100 : 0;

  const widthHistory: number[] = [];
  for (let end = STRUCTURE.SQUEEZE_LOOKBACK; end <= closed.length; end += STRUCTURE.SQUEEZE_LOOKBACK) {
    const w = closed.slice(end - STRUCTURE.SQUEEZE_LOOKBACK, end);
    const m = w.reduce((a, c) => a + c.c, 0) / w.length;
    const v = w.reduce((a, c) => a + (c.c - m) ** 2, 0) / w.length;
    if (m > 0) widthHistory.push((4 * Math.sqrt(v)) / m * 100);
  }
  const squeeze = bollingerWidth > 0 &&
    percentileOfSample(bollingerWidth, widthHistory) <= STRUCTURE.SQUEEZE_PERCENTILE;

  return {
    atrPct: Math.round(atrPct * 100) / 100,
    atrPercentile: percentileOfSample(atrPct, atrSeries),
    realisedVolPct: Math.round(realisedVolPct * 100) / 100,
    realisedVolPercentile: percentileOfSample(realisedVolPct, atrSeries),
    bollingerWidth: Math.round(bollingerWidth * 100) / 100,
    squeeze,
    hourlyVolumeProfile: hourlyVolumeProfile(closed),
    session: sessionOf(Date.now()),
  };
}

/**
 * Time-of-day volume profile over the window, normalised to max 1. Shows the
 * user when this coin actually moves rather than assuming a session.
 */
export function hourlyVolumeProfile(candles: Candle[]): number[] {
  const buckets = new Array(24).fill(0);
  for (const c of candles) {
    buckets[new Date(c.t).getUTCHours()] += c.v;
  }
  const max = Math.max(...buckets, 1);
  return buckets.map((v) => Math.round((v / max) * 100) / 100);
}

export function sessionOf(t: number): 'asia' | 'europe' | 'us' | 'off' {
  const h = new Date(t).getUTCHours();
  if (h >= SESSIONS_UTC.asia[0] && h < SESSIONS_UTC.asia[1]) return 'asia';
  if (h >= SESSIONS_UTC.europe[0] && h < SESSIONS_UTC.europe[1]) return 'europe';
  if (h >= SESSIONS_UTC.us[0] && h < SESSIONS_UTC.us[1]) return 'us';
  return 'off';
}

// ─────────────────────────────────────────────────────────────────────────────
// Relative strength
// ─────────────────────────────────────────────────────────────────────────────

export function relativeStrength(
  asset: Candle[],
  btc: Candle[],
  eth: Candle[] | null,
  btcDominance: number | null,
  altseasonIndex: number | null,
): {
  vsBtc1h: number; vsBtc4h: number; vsBtc24h: number; vsEth4h: number;
  btcDominance: number; altseasonIndex: number;
} {
  const pct = (candles: Candle[], n: number): number => {
    const closed = candles.filter((c) => c.closed);
    if (closed.length <= n) return 0;
    const a = closed[closed.length - 1 - n].c;
    return a > 0 ? ((closed[closed.length - 1].c - a) / a) * 100 : 0;
  };

  const sub = (a: number, b: number) => Math.round((a - b) * 100) / 100;

  return {
    vsBtc1h: sub(pct(asset, 12), pct(btc, 12)),
    vsBtc4h: sub(pct(asset, 48), pct(btc, 48)),
    vsBtc24h: sub(pct(asset, 288), pct(btc, 288)),
    vsEth4h: eth ? sub(pct(asset, 48), pct(eth, 48)) : 0,
    btcDominance: btcDominance ?? 0,
    altseasonIndex: altseasonIndex ?? 0,
  };
}
