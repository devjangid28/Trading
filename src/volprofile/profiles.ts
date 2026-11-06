import type { Candle } from '../../shared/types';
import { BIN_AUTO_PCT, minTick } from './tokens';
import type { Profile, ProfileRow, ProfilesMode } from './types';
import { istDayShort } from './format';

/**
 * Volume-profile engine.
 *
 * A profile is a horizontal histogram of volume by price bin over a time range.
 * Bins are anchored to the range's lowest typical price and are `binSize`
 * wide. Per-row data is everything the UI needs: quote + base volume, the
 * taker-buy/taker-sell split (Bid x Ask mode, delta), and the net delta.
 *
 * Value area: sort rows by volume descending, accumulate until `valueAreaPct`
 * of total volume, VAH = highest included price, VAL = lowest included price.
 *
 * Rebuilds are cheap (~a few hundred rows), but we cache per range and only
 * invalidate when the candle series fingerprint changes, so the 60fps loop
 * never rebuilds on animation frames.
 */

export interface ProfileOpts {
  binSize: number;
  valueAreaPct: number;
}

export function autoBinSize(referencePrice: number): number {
  return Math.max(minTick(referencePrice), referencePrice * BIN_AUTO_PCT);
}

export function binSizeFor(binSize: 'auto' | number, referencePrice: number): number {
  const b = binSize === 'auto' ? autoBinSize(referencePrice) : binSize;
  return Math.max(minTick(referencePrice), b);
}

interface Acc {
  floor: number;
  rows: Map<number, ProfileRow>;
  totalUsd: number;
  totalBase: number;
  totalDelta: number;
  maxUsd: number;
  maxAbsDelta: number;
  builtThroughT: number;
}

function createAcc(): Acc {
  return {
    floor: NaN,
    rows: new Map(),
    totalUsd: 0,
    totalBase: 0,
    totalDelta: 0,
    maxUsd: 0,
    maxAbsDelta: 0,
    builtThroughT: -Infinity,
  };
}

function addToAcc(acc: Acc, c: Candle, binSize: number): void {
  const tp = (c.h + c.l + c.c) / 3;
  if (!Number.isFinite(tp) || tp <= 0) return;
  if (!Number.isFinite(acc.floor)) {
    acc.floor = Math.floor(tp / binSize) * binSize;
  }
  const idx = Math.floor((tp - acc.floor) / binSize);
  let row = acc.rows.get(idx);
  if (!row) {
    row = {
      index: idx,
      lo: acc.floor + idx * binSize,
      hi: acc.floor + (idx + 1) * binSize,
      price: acc.floor + (idx + 0.5) * binSize,
      vol: 0,
      base: 0,
      buy: 0,
      sell: 0,
      delta: 0,
    };
    acc.rows.set(idx, row);
  }
  const qv = c.qv && c.qv > 0 ? c.qv : c.v * tp;
  const buy = c.takerBuyQuote && c.takerBuyQuote > 0 ? c.takerBuyQuote : 0;
  const sell = Math.max(0, qv - buy);
  row.vol += qv;
  row.base += c.v;
  row.buy += buy;
  row.sell += sell;
  row.delta += buy - sell;
  acc.totalUsd += qv;
  acc.totalBase += c.v;
  acc.totalDelta += buy - sell;
  if (row.vol > acc.maxUsd) acc.maxUsd = row.vol;
  const ad = Math.abs(row.delta);
  if (ad > acc.maxAbsDelta) acc.maxAbsDelta = ad;
  acc.builtThroughT = Math.max(acc.builtThroughT, c.t);
}

function finishProfile(
  acc: Acc,
  kind: ProfilesMode,
  label: string,
  t0: number,
  t1: number,
  anchor: 'left' | 'right',
  opts: ProfileOpts,
): Profile {
  const rows = [...acc.rows.values()].sort((a, b) => b.price - a.price);
  const total = acc.totalUsd;
  let pocPrice = 0;
  let pocVol = -1;
  for (const r of rows) {
    if (r.vol > pocVol) {
      pocVol = r.vol;
      pocPrice = r.price;
    }
  }
  const sorted = [...rows].sort((a, b) => b.vol - a.vol);
  let running = 0;
  let vah = -Infinity;
  let val = Infinity;
  for (const r of sorted) {
    running += r.vol;
    vah = Math.max(vah, r.hi);
    val = Math.min(val, r.lo);
    if (total > 0 && running >= total * (opts.valueAreaPct / 100)) break;
  }
  if (!Number.isFinite(vah)) vah = pocPrice;
  if (!Number.isFinite(val)) val = pocPrice;
  return {
    id: `${kind}:${t0}:${t1}:${anchor}`,
    kind,
    label,
    t0,
    t1,
    anchor,
    rows,
    totalUsd: acc.totalUsd,
    totalBase: acc.totalBase,
    totalDelta: acc.totalDelta,
    pocPrice,
    vah,
    val,
    maxUsd: acc.maxUsd,
    maxAbsDelta: acc.maxAbsDelta,
    builtThroughT: acc.builtThroughT,
  };
}

function lowerBound(candles: readonly Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(candles: readonly Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function candleSlice(
  candles: readonly Candle[],
  t0: number,
  t1: number,
  inclusiveEnd: boolean,
): Candle[] {
  const a = lowerBound(candles, t0);
  const b = upperBound(candles, inclusiveEnd ? t1 : t1 - 1);
  return candles.slice(a, b);
}

/**
 * Fingerprint of the candles inside ONE time range. Profiles are keyed by this
 * (not the global series fingerprint): a closed range never changes, so only
 * the range containing the forming candle is ever rebuilt when a tick arrives.
 */
export function rangeFingerprint(
  candles: readonly Candle[],
  t0: number,
  t1: number,
  inclusiveEnd = true,
): string {
  const slice = candleSlice(candles, t0, t1, inclusiveEnd);
  if (!slice.length) return 'empty';
  const last = slice[slice.length - 1];
  return `${slice.length}:${last.t}:${last.h}:${last.l}:${last.c}`;
}

/** Fingerprint of one header-timeframe bar (exclusive end). */
export function barFingerprint(candles: readonly Candle[], barT: number, stepMs: number): string {
  return rangeFingerprint(candles, barT, barT + stepMs, false);
}

export function buildProfile(
  candles: readonly Candle[],
  kind: ProfilesMode,
  label: string,
  t0: number,
  t1: number,
  anchor: 'left' | 'right',
  opts: ProfileOpts,
  inclusiveEnd = true,
): Profile {
  const acc = createAcc();
  for (const c of candleSlice(candles, t0, t1, inclusiveEnd)) {
    addToAcc(acc, c, opts.binSize);
  }
  return finishProfile(acc, kind, label, t0, t1, anchor, opts);
}

/** Evenly spaced indices across n items, capped at `cap` (stable ordering). */
export function thinIndices(n: number, cap: number): number[] {
  if (n <= cap) {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(i);
    return out;
  }
  const out: number[] = [];
  for (let i = 0; i < cap; i++) {
    out.push(Math.round((i * (n - 1)) / (cap - 1)));
  }
  return out;
}

/**
 * Session / timeframe profiles share a rebuild-on-fingerprint cache, so a pan
 * or zoom that toggles visibility never rebuilds an already-built range.
 */
export class ProfileCache {
  private entries = new Map<string, { fp: string; profile: Profile }>();
  private order: string[] = [];
  private readonly cap = 240;

  get(key: string, fp: string, build: () => Profile): Profile {
    const hit = this.entries.get(key);
    if (hit && hit.fp === fp) return hit.profile;
    const profile = build();
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __vpProfileBuilds?: number };
      w.__vpProfileBuilds = (w.__vpProfileBuilds ?? 0) + 1;
    }
    this.entries.set(key, { fp, profile });
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
    if (this.order.length > this.cap) {
      const victim = this.order.shift();
      if (victim) this.entries.delete(victim);
    }
    return profile;
  }

  clear(): void {
    this.entries.clear();
    this.order = [];
  }
}

export function timeframeLabel(barT: number): string {
  return `${istDayShort(barT)}`;
}

export function sessionLabel(sessionT0: number, sessionT1: number): string {
  return `${istDayShort(sessionT0)} - ${istDayShort(sessionT1)}`;
}
