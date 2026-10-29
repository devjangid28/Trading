import type { Candle, HtfContext, Level, RetestState, Setup } from '../../../shared/types.js';
import { STRUCTURE } from '../config.js';

const FIVE_MIN = 5 * 60_000;

/** ATR-style average true range over a lookback, used to size "forceful" moves. */
export function averageRange(candles: Candle[], lookback = 20): number {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  let sum = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    const prev = slice[i - 1];
    const tr = prev
      ? Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c))
      : c.h - c.l;
    sum += tr;
  }
  return sum / slice.length;
}

/** Swing pivots: a high with lower highs on both sides, a low with higher lows. */
export interface Pivot {
  index: number;
  price: number;
  time: number;
  kind: 'high' | 'low';
}

export function findPivots(candles: Candle[], wing = 2): Pivot[] {
  const out: Pivot[] = [];
  for (let i = wing; i < candles.length - wing; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isHigh = false;
      if (candles[j].l <= c.l) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: c.h, time: c.t, kind: 'high' });
    if (isLow) out.push({ index: i, price: c.l, time: c.t, kind: 'low' });
  }
  return out;
}

/** Equal highs / equal lows within a tolerance â€” where stop orders pile up. */
export interface Pool {
  price: number;
  time: number;
  touches: number;
  kind: 'buy-side' | 'sell-side';
}

export function findLiquidityPools(pivots: Pivot[], tolerancePct = 0.12): Pool[] {
  const buckets = new Map<string, Pivot[]>();
  for (const p of pivots) {
    const key = `${p.kind}:${p.price.toFixed(2)}`;
    const arr = buckets.get(key);
    if (arr) arr.push(p);
    else buckets.set(key, [p]);
  }

  const pools: Pool[] = [];
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    const base = group[0].price;
    for (const p of group) {
      if (Math.abs((p.price - base) / base) * 100 > tolerancePct) continue;
      pools.push({
        price: p.price,
        time: p.time,
        touches: group.length,
        kind: p.kind === 'high' ? 'buy-side' : 'sell-side',
      });
    }
  }
  return pools;
}

/**
 * Index of the oldest candle that still belongs to the current session.
 *
 * Every 24h figure — session VWAP, day change, day high/low — is read over this
 * window, and the window is `STRUCTURE.SESSION_CANDLES` closed candles deep
 * (289 on 5m, i.e. the trailing 24h span inclusive of both ends). Returns 0 for
 * a series shorter than a session, so a short history reads as "everything we
 * have" instead of a negative index that silently drops candles.
 */
export function sessionStartIndex(candles: Candle[]): number {
  return Math.max(0, candles.length - STRUCTURE.SESSION_CANDLES);
}

/** First timestamp of the session window, or 0 when the series is empty. */
export function sessionStartTime(candles: Candle[]): number {
  return candles[sessionStartIndex(candles)]?.t ?? 0;
}

/**
 * Volume-weighted average price over the current session (UTC day for crypto).
 * Bullish setups above VWAP have the average participant on their side.
 */
export function sessionVwap(candles: Candle[], fromTime: number): number | null {
  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    if (c.t < fromTime) continue;
    const typical = (c.h + c.l + c.c) / 3;
    pv += typical * c.v;
    vol += c.v;
  }
  return vol > 0 ? pv / vol : null;
}

/**
 * Order block detection, using only *closed* candles.
 *
 * Bullish: the last down candle before a move that closes above the prior
 * swing high, where the move away is forceful â€” either it left a fair-value
 * gap, or it travelled at least one average candle range.
 *
 * The zone is drawn from the candle's low to its high. Z is the midpoint of
 * that band; the invalidation sits just beyond the far (low) side for a
 * bullish setup, mirroring to R1 just above the block for a bearish one.
 *
 * `prefer` selects which side to return, so a bullish board never shows a
 * bearish zone for the same asset.
 */
export function detectOrderBlock(
  candles: Candle[],
  opts: { range?: number; prefer?: 'bullish' | 'bearish' } = {},
): Setup | null {
  const closed = candles.filter((c) => c.closed);
  if (closed.length < 30) return null;

  const rng = opts.range ?? averageRange(closed, 20);
  if (rng <= 0) return null;

  const pivots = findPivots(closed, 2);
  const pools = findLiquidityPools(pivots);
  const poolPriceSet = new Set(pools.map((p) => Math.round(p.price)));

  // Walk forward looking for the most recent valid break of structure.
  let best: Setup | null = null;

  for (let i = 12; i < closed.length - 1; i++) {
    const blk = closed[i];
    const blkIsDown = blk.c < blk.o;

    // Cheap reject: if we only want one side, skip blocks that cannot produce it.
    if (opts.prefer && (opts.prefer === 'bullish') !== blkIsDown) continue;

    // The candle that must be swept out is the last opposite-colour candle
    // before a structural break. Break is checked over the next few candles.
    let breakIdx = -1;
    let bullish = false;
    for (let j = i + 1; j <= Math.min(i + 6, closed.length - 1); j++) {
      const c = closed[j];
      const priorHighs = pivots
        .filter((p) => p.kind === 'high' && p.index > i - 8 && p.index < i)
        .map((p) => p.price);
      const priorLows = pivots
        .filter((p) => p.kind === 'low' && p.index > i - 8 && p.index < i)
        .map((p) => p.price);

      const lastHigh = priorHighs.length ? Math.max(...priorHighs) : Math.max(...closed.slice(Math.max(0, i - 8), i).map((k) => k.h));
      const lastLow = priorLows.length ? Math.min(...priorLows) : Math.min(...closed.slice(Math.max(0, i - 8), i).map((k) => k.l));

      if (blkIsDown && c.c > lastHigh) {
        breakIdx = j;
        bullish = true;
        break;
      }
      if (!blkIsDown && c.c < lastLow) {
        breakIdx = j;
        bullish = false;
        break;
      }
    }
    if (breakIdx < 0) continue;

    // Forceful move test: a fair-value gap, or displacement of >= 1x range.
    const breakCandle = closed[breakIdx];
    const prevCandle = closed[breakIdx - 1];
    const displacement = bullish
      ? (breakCandle.c - prevCandle.c) / rng
      : (prevCandle.c - breakCandle.c) / rng;

    const fvg = bullish
      ? breakCandle.l > closed[breakIdx - 2].h
      : breakCandle.h < closed[breakIdx - 2].l;

    if (!fvg && displacement < 1) continue;

    // No later 5-minute close may have gone through the zone.
    let violated = false;
    for (let k = breakIdx + 1; k < closed.length; k++) {
      if (bullish && closed[k].c < blk.l) { violated = true; break; }
      if (!bullish && closed[k].c > blk.h) { violated = true; break; }
    }
    if (violated) continue;

    const zoneHigh = Math.max(blk.o, blk.c, blk.h);
    const zoneLow = Math.min(blk.o, blk.c, blk.l);
    const z = bullish ? (zoneHigh + zoneLow) / 2 : (zoneHigh + zoneLow) / 2;

    const invalidation = bullish ? zoneLow * 0.9995 : zoneHigh * 1.0005;
    const targets: Level[] = [];
    const context: Level[] = [];

    const last = closed[closed.length - 1];
    if (bullish) {
      for (const p of pivots) {
        if (p.kind !== 'high' || p.time <= blk.t) continue;
        if (p.price <= zoneHigh) continue;
        if (poolPriceSet.has(Math.round(p.price))) targets.push({ price: p.price, label: '', kind: 'liquidity', time: p.time });
        else context.push({ price: p.price, label: '', kind: 'context', time: p.time });
      }
      context.push({ price: last.h, label: 'DAY HIGH', kind: 'context', time: last.t });
    } else {
      for (const p of pivots) {
        if (p.kind !== 'low' || p.time <= blk.t) continue;
        if (p.price >= zoneLow) continue;
        if (poolPriceSet.has(Math.round(p.price))) targets.push({ price: p.price, label: '', kind: 'liquidity', time: p.time });
        else context.push({ price: p.price, label: '', kind: 'context', time: p.time });
      }
      context.push({ price: last.l, label: 'DAY LOW', kind: 'context', time: last.t });
    }

    // De-duplicate and sort by distance from the zone.
    const uniq = <T extends { price: number }>(arr: T[]): T[] => {
      const seen = new Set<number>();
      return arr.filter((x) => {
        const k = Math.round(x.price);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    const sortedTargets = bullish
      ? uniq(targets).sort((a, b) => a.price - b.price)
      : uniq(targets).sort((a, b) => b.price - a.price);

    const pickedTargets = sortedTargets.slice(0, 2);

    const risk = Math.abs(z - invalidation);
    // No liquidity ahead means no measured room, so we report zero rather than
    // inventing a multiple.
    const room = pickedTargets.length ? Math.abs(pickedTargets[pickedTargets.length - 1].price - z) : 0;
    const rr = risk > 0 && pickedTargets.length ? room / risk : 0;

    const ageMinutes = Math.round((closed[closed.length - 1].t - blk.t) / FIVE_MIN);

    // Prior setups of the same session, left where they happened.
    const previous: { obTime: number; obHigh: number; obLow: number; side: 'bullish' | 'bearish' }[] = [];
    for (let k = i - 1; k >= 0; k--) {
      const p = closed[k];
      if (closed.length - 1 - k > 70) break;
      if (k === i) continue;
      const pDown = p.c < p.o;
      if (pDown === blkIsDown) continue;
      previous.push({
        obTime: p.t,
        obHigh: Math.max(p.o, p.c, p.h),
        obLow: Math.min(p.o, p.c, p.l),
        side: pDown ? 'bearish' : 'bullish',
      });
      if (previous.length >= 3) break;
    }

    const candidate: Setup = {
      side: bullish ? 'bullish' : 'bearish',
      obTime: blk.t,
      obHigh: zoneHigh,
      obLow: zoneLow,
      z,
      invalidation,
      targets: pickedTargets.map((t, i) => ({ ...t, label: `${bullish ? 'R' : 'S'}${i + 1}` })),
      context: uniq(context)
        .filter((c) => (bullish ? c.price > zoneHigh : c.price < zoneLow))
        .sort((a, b) => (bullish ? a.price - b.price : b.price - a.price))
        .slice(0, 3)
        .map((c, i) => ({ ...c, label: `${bullish ? 'S' : 'R'}${i + 2}` })),
      rr,
      displacement,
      fvg,
      violated: false,
      ageMinutes,
      previous,
      retest: computeRetest(closed, blk.t, zoneLow, zoneHigh, bullish, 0),
      distanceAtr: 0,
      htf: EMPTY_HTF,
    };

    // Distance from live price to the zone, in ATR, then re-derive the retest
    // state now that we know how far price actually is.
    const lastClose = closed[closed.length - 1].c;
    candidate.distanceAtr = rng > 0 ? (lastClose - z) / rng : 0;
    candidate.retest = computeRetest(
    closed, blk.t, zoneLow, zoneHigh, bullish, candidate.distanceAtr,
    );

    // The most recent valid block wins.
    best = candidate;
  }

  return best;
}

const EMPTY_HTF: HtfContext = {
  aligned: false,
  conflict: false,
  trend1h: 'range',
  trend4h: 'range',
  setups: [],
  scoreAdj: 0,
};

/**
 * Retest state machine â€” this is where "wait for the first retest" is encoded.
 *
 * fresh           never touched since it formed
 * approaching     within 1 ATR of the zone, not yet there
 * in-zone         price is inside the band right now
 * retested-held   price came in and bounced without closing through
 * violated        a later close went through the far side (also excludes it)
 */
export function computeRetest(
  candles: Candle[],
  obTime: number,
  obLow: number,
  obHigh: number,
  bullish: boolean,
  distanceAtr: number,
): RetestState {
  const closed = candles.filter((c) => c.closed);
  const after = closed.filter((c) => c.t > obTime);
  if (!after.length) return 'fresh';

  let touched = false;
  for (const c of after) {
    const inside = bullish
      ? c.l <= obHigh && c.h >= obLow
      : c.h >= obLow && c.l <= obHigh;
    if (inside) touched = true;
    // A close through the far side kills the zone outright.
    if (bullish && c.c < obLow) return 'violated';
    if (!bullish && c.c > obHigh) return 'violated';
  }

  const last = closed[closed.length - 1];
  const inZoneNow = bullish
    ? last.l <= obHigh && last.h >= obLow
    : last.h >= obLow && last.l <= obHigh;
  if (inZoneNow) return 'in-zone';
  if (touched) return 'retested-held';
  if (Math.abs(distanceAtr) <= STRUCTURE.APPROACH_ATR) return 'approaching';
  return 'fresh';
}

/**
 * Pivot-structure trend: higher highs and higher lows is up, the mirror is
 * down, anything else is a range.
 */
export function trendFromPivots(pivots: Pivot[]): 'up' | 'down' | 'range' {
  const highs = pivots.filter((p) => p.kind === 'high').slice(-3);
  const lows = pivots.filter((p) => p.kind === 'low').slice(-3);
  if (highs.length < 2 || lows.length < 2) return 'range';
  const hh = highs[highs.length - 1].price > highs[0].price;
  const hl = lows[lows.length - 1].price > lows[0].price;
  const lh = highs[highs.length - 1].price < highs[0].price;
  const ll = lows[lows.length - 1].price < lows[0].price;
  if (hh && hl) return 'up';
  if (lh && ll) return 'down';
  return 'range';
}

/**
 * One-directional strength: how far today is from the asset's own recent
 * history, in units of its own daily range. A stock that ran up 3% and came
 * straight back down scores near zero even with a huge intraday range.
 */
export function strengthScore(changePct: number, rangePct: number): number {
  if (rangePct <= 0) return 0;
  // Efficiency = |net move| / total range. A stock that goes up and back down
  // has a large range but near-zero efficiency.
  const efficiency = Math.abs(changePct) / rangePct;
  if (efficiency < 0.25) return 0;
  const directional = Math.abs(changePct);
  return Math.round(directional * efficiency * 1000) / 1000;
}

/** Percentile rank of a value within the sample, 0..100. */
export function percentileOf(values: number[], value: number): number {
  if (!values.length) return 50;
  let below = 0;
  for (const v of values) if (v < value) below++;
  return Math.round((below / values.length) * 1000) / 10;
}

/** ADX-style choppiness index: 0 = clean trend, 100 = pure chop. */
export function choppiness(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  const slice = candles.slice(-(period + 1));
  let sumTR = 0;
  let sumHL = 0;
  let sumAbs = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    const p = slice[i - 1];
    sumTR += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    sumHL += Math.max(c.h, p.h) - Math.min(c.l, p.l);
    sumAbs += Math.abs(c.c - p.c);
  }
  if (sumTR === 0) return 50;
  const ratio = Math.log(sumTR / sumHL) / Math.log(period);
  return Math.round(100 / (1 + ratio)) ;
}
