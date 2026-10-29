import type { FanAsset } from '../../shared/types';

/**
 * Stage-space geometry for the 24h fan and the rails that flank it.
 *
 * Coordinates are in the reference 1920x1200 stage's own pixels (the whole
 * stage is scaled by CSS `transform`). The fan reads left-to-right: a single
 * origin at the vertical middle, threads spreading to the bracket at `x1`, a
 * count histogram just past it, then the funnel and the card matrix.
 */
export const FAN_GEO = {
  /** Plot box. Threads start on the left edge, end on the bracket. */
  x0: 122,
  x1: 584,
  top: 92,
  bottom: 1164,
  /** Far-left coloured rail: green top -> red bottom. */
  railX: 16,
  railW: 4,
  /** Narrow sector-label column (no wide bars, per the reference). */
  labelLeft: 26,
  labelRight: 110,
  /** Count histogram sits immediately right of the bracket. */
  histX: 588,
  histW: 16,
} as const;

export const FAN_MID = (FAN_GEO.top + FAN_GEO.bottom) / 2;
export const FAN_W = FAN_GEO.x1 - FAN_GEO.x0;
export const FAN_H = FAN_GEO.bottom - FAN_GEO.top;

/** Top / bottom N by 24h move form the bright bull / bear sets. */
export const FAN_SET = 20;
/** Pointer distance (stage px) within which a thread is considered hovered. */
export const FAN_HIT = 10;

const GREEN = '#3fd487';
const RED = '#f87171';

/** Thread colour by its end value. */
export function threadColor(final: number): string {
  return final >= 0 ? GREEN : RED;
}

/**
 * Symmetric log compression. A linear % axis lets one 30% mover flatten every
 * other thread; symlog keeps the core readable while still ranking the tails.
 */
export function symlog(v: number, c = 1): number {
  return Math.sign(v) * Math.log10(1 + Math.abs(v) / c);
}

export interface FanScale {
  /** Largest |%| in the payload — also the outer gridline level. */
  maxAbs: number;
  /** Stage px per symlog unit. */
  scaleY: number;
}

export function buildScale(assets: FanAsset[]): FanScale {
  let maxAbs = 2;
  for (const a of assets) {
    for (const v of a.series) {
      const m = Math.abs(v);
      if (Number.isFinite(m) && m > maxAbs) maxAbs = m;
    }
  }
  const symMax = symlog(maxAbs) || 1;
  const half = FAN_H / 2 - 30;
  return { maxAbs, scaleY: half / symMax };
}

/** Value -> stage y. Positive is up (above the mid line). */
export function yOf(v: number, s: FanScale): number {
  return FAN_MID - symlog(v) * s.scaleY;
}

/** Series index -> stage x, spread across the plot box. */
export function xOf(i: number, n: number): number {
  const t = n <= 1 ? 1 : i / (n - 1);
  return FAN_GEO.x0 + t * FAN_W;
}

export interface FanSeries {
  asset: FanAsset;
  /** Polyline in stage coords. */
  pts: { x: number; y: number }[];
  final: number;
}

export function buildSeries(assets: FanAsset[], scale: FanScale): FanSeries[] {
  return assets.map((asset) => {
    const n = asset.series.length;
    const pts = asset.series.map((v, i) => ({ x: xOf(i, n), y: yOf(v, scale) }));
    return { asset, pts, final: asset.series[n - 1] ?? asset.changePct };
  });
}

/** Sector aggregate: volume-weighted mean end value + its y level. */
export interface SectorRow {
  sector: string;
  mean: number;
  n: number;
  y: number;
  color: string;
}

export function buildSectors(series: FanSeries[], scale: FanScale): SectorRow[] {
  const acc = new Map<string, { w: number; sum: number; n: number }>();
  for (const s of series) {
    const a = acc.get(s.asset.sector) ?? { w: 0, sum: 0, n: 0 };
    const w = s.asset.volumeUsd > 0 ? s.asset.volumeUsd : 1;
    a.w += w;
    a.sum += s.final * w;
    a.n += 1;
    acc.set(s.asset.sector, a);
  }
  return [...acc.entries()]
    .map(([sector, a]) => {
      const mean = a.w > 0 ? a.sum / a.w : 0;
      return { sector, mean, n: a.n, y: yOf(mean, scale), color: threadColor(mean) };
    })
    .sort((a, b) => b.mean - a.mean);
}

/** Histogram of thread endpoints into `buckets` equal y-bands. */
export interface HistBucket {
  yTop: number;
  yBottom: number;
  count: number;
  color: string;
}

export function buildHistogram(series: FanSeries[], buckets = 26): HistBucket[] {
  const h = FAN_H / buckets;
  const out: HistBucket[] = [];
  for (let b = 0; b < buckets; b++) {
    const yTop = FAN_GEO.top + b * h;
    const yBottom = yTop + h;
    out.push({ yTop, yBottom, count: 0, color: yBottom <= FAN_MID ? GREEN : RED });
  }
  for (const s of series) {
    const y = s.pts[s.pts.length - 1]?.y;
    if (y === undefined) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((y - FAN_GEO.top) / h)));
    out[idx].count += 1;
  }
  return out;
}
