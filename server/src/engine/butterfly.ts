/**
 * Butterfly distribution of % moves across the whole universe.
 *
 * "Butterfly" here means the two halves of the histogram share one axis: bars
 * for gains extend left of the spine, bars for losses extend right, and the
 * spine is exactly 0%. It answers a question the ranked board cannot — not
 * "which coin is best" but "is anything actually moving, and in one direction
 * or both". A board full of green rows with an empty right half is a very
 * different market from a symmetric one, and only the distribution shows that
 * at a glance.
 *
 * This module is deliberately pure and free of any rendering concern so it can
 * be tested directly. The chart component consumes its output verbatim.
 */

/**
 * The chart only ever reads the move, so it accepts anything shaped like that
 * rather than a concrete row type. The scanner passes its internal `Scanned`
 * records and the API layer passes `AssetRow`s; neither should have to be
 * widened into the other just to build a histogram.
 */
export interface HasChange {
  changePct: number;
}

export interface ButterflyBucket {
  /** Inclusive lower edge of the bucket, in percent. */
  from: number;
  /** Exclusive upper edge, in percent. Symmetric around 0 for |buckets|. */
  to: number;
  bullish: number;
  bearish: number;
  /**
   * Assets sitting exactly on the spine. Tracked separately so that
   * `bullish + bearish + flat === total` holds exactly. Splitting the spine
   * bucket across both sides instead would double-count them.
   */
  flat: number;
  total: number;
  /** Longest bar in this bucket, used to scale the column. */
  max: number;
}

export interface Butterfly {
  buckets: ButterflyBucket[];
  /** Total assets bucketed. */
  n: number;
  bullish: number;
  bearish: number;
  flat: number;
  /** Strongest gain and loss in the universe, in percent. */
  top: number;
  bottom: number;
  /**
   * Where the mass sits, in [-1, 1]. +1 means every mover is a gainer.
   * Null when there is nothing to measure.
   */
  skew: number | null;
  /** Buckets used on each side. Odd so the spine bucket exists. */
  half: number;
  /** True when any single bucket holds a large share — breadth, not a spike. */
  concentrated: boolean;
}

/**
 * Bucket edges. 5 buckets per side covers +/-1% to +/-5% and beyond, which is
 * where most crypto intraday moves land. The outermost buckets are open-ended
 * in practice because we clamp into them.
 */
export const EDGES = [-Infinity, -5, -3, -2, -1, 0, 1, 2, 3, 5, Infinity];

export const HALF_BUCKETS = 5;

function bucketIndex(pct: number): number {
  for (let i = 0; i < EDGES.length - 1; i++) {
    if (pct >= EDGES[i] && pct < EDGES[i + 1]) return i;
  }
  return EDGES.length - 2;
}

export function buildButterfly(rows: HasChange[], half = HALF_BUCKETS): Butterfly {
  // Keep exactly `2 * half` buckets centred on the spine bucket (the one whose
  // lower edge is 0). EDGES has `2 * half` gaps in total, so this starts at 0.
  // The earlier version computed `EDGES.length - 1 - half`, which started three
  // buckets too late and silently DROPPED every move below -1% — the chart
  // would have disagreed with the row count below it.
  const size = half * 2;
  const first = EDGES.length - 1 - size;

  const bull = new Array<number>(size).fill(0);
  const bear = new Array<number>(size).fill(0);
  const flatIn = new Array<number>(size).fill(0);

  let n = 0;
  let b = 0;
  let s = 0;
  let flat = 0;
  let top = -Infinity;
  let bottom = Infinity;

  for (const r of rows) {
    const pct = r.changePct;
    if (!Number.isFinite(pct)) continue;
    n++;
    if (pct > top) top = pct;
    if (pct < bottom) bottom = pct;
    // Exactly 0% is flat, not a gainer. Counting it as bullish made skew read
    // +1 for a universe where nothing had moved at all.
    if (pct > 0) b++;
    else if (pct < 0) s++;
    else flat++;

    const i = bucketIndex(pct) - first;
    if (i < 0 || i >= size) continue;
    if (pct > 0) bull[i]++;
    else if (pct < 0) bear[i]++;
    else flatIn[i]++;
  }

  const buckets: ButterflyBucket[] = [];
  for (let i = 0; i < size; i++) {
    const from = EDGES[first + i];
    const to = EDGES[first + i + 1];
    buckets.push({
      from, to,
      bullish: bull[i],
      bearish: bear[i],
      flat: flatIn[i],
      total: bull[i] + bear[i] + flatIn[i],
      max: Math.max(bull[i], bear[i]),
    });
  }

  const movers = b + s;
  const peak = Math.max(...buckets.map((x) => x.total), 0);

  return {
    buckets,
    n,
    bullish: b,
    bearish: s,
    flat,
    top: Number.isFinite(top) ? top : 0,
    bottom: Number.isFinite(bottom) ? bottom : 0,
    skew: movers === 0 ? null : (b - s) / movers,
    half,
    concentrated: peak > 0 && peak / n > 0.25,
  };
}

/**
 * Assets at or beyond a move, used for the "strongest moves" caption that the
 * depth chart labels carry.
 */
export function extremes<T extends HasChange>(rows: T[], pct: number): { up: T[]; down: T[] } {
  const up = rows.filter((r) => r.changePct >= pct).sort((a, z) => z.changePct - a.changePct);
  const down = rows.filter((r) => r.changePct <= -pct).sort((a, z) => a.changePct - z.changePct);
  return { up, down };
}

/**
 * Human label for a bucket edge. Infinity is the open-ended bucket and reads
 * as "5%+" rather than "Infinity", which is the only case where clamping is
 * also the honest description.
 */
export function edgeLabel(pct: number): string {
  if (!Number.isFinite(pct)) return '5%+';
  const s = String(Math.abs(pct));
  return pct > 0 ? `+${s}%` : pct < 0 ? `−${s}%` : '0';
}