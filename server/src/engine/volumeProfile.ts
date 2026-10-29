import type { Candle } from '../../../shared/types.js';

export interface VolumeProfile {
  /** Point of Control — price level with the highest traded volume. */
  poc: number;
  /** Value Area High — top of the 70% volume zone. */
  vah: number;
  /** Value Area Low — bottom of the 70% volume zone. */
  val: number;
  /** Total volume in the profile window. */
  totalVolume: number;
  /** Buckets for rendering a histogram (price → volume). */
  buckets: { price: number; volume: number; delta: number }[];
}

export interface FootprintCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Buy volume (taker buy base). */
  buyVol: number;
  /** Sell volume (total - taker buy). */
  sellVol: number;
  /** Net delta: buyVol - sellVol. Positive = buyers dominated. */
  delta: number;
  /** Cumulative delta up to and including this candle. */
  cvd: number;
  /** True when price made a new high but delta was negative (bearish divergence). */
  deltaDiv: boolean;
}

/**
 * Compute a volume profile from closed candles.
 * Uses 50 price buckets across the high-low range of the window.
 * VAH/VAL enclose 70% of total volume (the "value area").
 */
export function computeVolumeProfile(candles: Candle[], bucketCount = 50): VolumeProfile | null {
  const closed = candles.filter((c) => c.closed && c.v > 0);
  if (closed.length < 10) return null;

  const hi = Math.max(...closed.map((c) => c.h));
  const lo = Math.min(...closed.map((c) => c.l));
  if (hi <= lo) return null;

  const step = (hi - lo) / bucketCount;
  // bucket[i] covers [lo + i*step, lo + (i+1)*step)
  const volBuckets = new Float64Array(bucketCount);
  const deltaBuckets = new Float64Array(bucketCount);

  for (const c of closed) {
    // Distribute this candle's volume across the buckets it spans, weighted by
    // the fraction of the candle's range that falls in each bucket.
    const candleRange = c.h - c.l || step;
    const buyVol = c.takerBuyBase ?? c.v * 0.5;
    const sellVol = c.v - buyVol;
    const delta = buyVol - sellVol;

    const iLo = Math.max(0, Math.floor((c.l - lo) / step));
    const iHi = Math.min(bucketCount - 1, Math.floor((c.h - lo) / step));

    for (let i = iLo; i <= iHi; i++) {
      const bLo = lo + i * step;
      const bHi = bLo + step;
      const overlap = Math.min(c.h, bHi) - Math.max(c.l, bLo);
      const frac = overlap / candleRange;
      volBuckets[i] += c.v * frac;
      deltaBuckets[i] += delta * frac;
    }
  }

  // POC = bucket with max volume
  let pocIdx = 0;
  let maxVol = 0;
  let totalVolume = 0;
  for (let i = 0; i < bucketCount; i++) {
    totalVolume += volBuckets[i];
    if (volBuckets[i] > maxVol) { maxVol = volBuckets[i]; pocIdx = i; }
  }

  const poc = lo + (pocIdx + 0.5) * step;

  // Value area: start at POC, expand outward to capture 70% of volume
  const target = totalVolume * 0.70;
  let vaVol = volBuckets[pocIdx];
  let vaLo = pocIdx;
  let vaHi = pocIdx;

  while (vaVol < target && (vaLo > 0 || vaHi < bucketCount - 1)) {
    const addLo = vaLo > 0 ? volBuckets[vaLo - 1] : 0;
    const addHi = vaHi < bucketCount - 1 ? volBuckets[vaHi + 1] : 0;
    if (addHi >= addLo && vaHi < bucketCount - 1) {
      vaHi++;
      vaVol += volBuckets[vaHi];
    } else if (vaLo > 0) {
      vaLo--;
      vaVol += volBuckets[vaLo];
    } else {
      vaHi++;
      vaVol += volBuckets[vaHi];
    }
  }

  const vah = lo + (vaHi + 1) * step;
  const val = lo + vaLo * step;

  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    price: lo + (i + 0.5) * step,
    volume: volBuckets[i],
    delta: deltaBuckets[i],
  }));

  return { poc, vah, val, totalVolume, buckets };
}

/**
 * Compute per-candle footprint data from candles that carry takerBuyBase.
 * Returns the last `limit` candles with delta and CVD.
 */
export function computeFootprint(candles: Candle[], limit = 60): FootprintCandle[] {
  const closed = candles.filter((c) => c.closed);
  const slice = closed.slice(-limit);
  let cvd = 0;
  const result: FootprintCandle[] = [];

  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    const buyVol = c.takerBuyBase ?? c.v * 0.5;
    const sellVol = c.v - buyVol;
    const delta = buyVol - sellVol;
    cvd += delta;

    // Delta divergence: price made a higher high vs prev candle but delta is negative
    const prev = slice[i - 1];
    const deltaDiv = prev
      ? c.h > prev.h && delta < 0
      : false;

    result.push({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, buyVol, sellVol, delta, cvd, deltaDiv });
  }

  return result;
}

/**
 * Confluence score: how many independent factors agree on a direction.
 * Returns 0–100. Used to rank picks on the Signals page.
 */
export interface ConfluenceInput {
  side: 'bullish' | 'bearish';
  hasOB: boolean;
  obRetest: string;
  pocAbove: boolean; // price above POC for bullish, below for bearish
  inValueArea: boolean;
  deltaPositive: boolean; // recent delta agrees with side
  cvdSlope: number; // from derivatives
  vwapSide: boolean; // price on correct side of VWAP
  htfAligned: boolean;
  fundingFavorable: boolean;
  domImbalance: number; // -1..1, positive = more bids
  newsAligned: boolean;
  convictionScore: number; // 0..100 from existing engine
}

export function confluenceScore(inp: ConfluenceInput): number {
  const wantUp = inp.side === 'bullish';
  let pts = 0;

  // Structure (30 pts)
  if (inp.hasOB) pts += 10;
  if (inp.obRetest === 'in-zone' || inp.obRetest === 'approaching') pts += 10;
  if (inp.htfAligned) pts += 10;

  // Volume profile (20 pts)
  if (inp.pocAbove) pts += 10;
  if (inp.inValueArea) pts += 10;

  // Order flow (25 pts)
  if (inp.deltaPositive === wantUp) pts += 10;
  if ((inp.cvdSlope > 0) === wantUp) pts += 8;
  if (inp.vwapSide) pts += 7;

  // Positioning + DOM (15 pts)
  if (inp.fundingFavorable) pts += 8;
  const domFav = wantUp ? inp.domImbalance > 0.1 : inp.domImbalance < -0.1;
  if (domFav) pts += 7;

  // News (10 pts)
  if (inp.newsAligned) pts += 10;

  // Blend with existing conviction (cap at 100)
  const blended = pts * 0.6 + inp.convictionScore * 0.4;
  return Math.min(100, Math.round(blended));
}
