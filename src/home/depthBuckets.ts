/**
 * Adaptive bucket edges for the market-depth curve.
 *
 * WHY ADAPTIVE
 *
 * The fixed edges Â±1/2/3/5% came from equities. Crypto intraday moves are
 * routinely 5-40%, so on a typical crypto day the outermost bucket swallowed
 * almost everything and the inner four sat empty â€” exactly the crowding seen in
 * the screenshot (5%+ 11, 3%+ 11, 2%+ 12, 1%+ 14 out of 40).
 *
 * THE RULE
 *
 * Take the absolute 24h change of every asset in the universe and compute the
 * quantiles at 1/5, 2/5, 3/5 and 4/5. Those four numbers are the inner bucket
 * edges. The outermost bucket is open-ended and labelled with the largest
 * observed move.
 *
 * Quantiles rather than fixed steps because the distribution is heavily
 * right-skewed: the median crypto coin moves under 1% while the median mover
 * moves several percent, so a symmetric fixed ladder puts 90% of coins in one
 * bucket. Quantiles guarantee each bucket holds a roughly comparable share,
 * which is what makes the mirrored curve readable.
 *
 * Edges are then rounded outward to a "nice" value (1, 1.5, 2, 3, 5, 7.5, 10,
 * 15, 20, 30, 50, ...) so the axis labels are numbers a human would have
 * chosen, and strictly increasing so two quantiles can never collapse into one
 * bucket after rounding.
 *
 * Pure and dependency-free: this is asserted directly by the unit tests rather
 * than checked by eye on a chart.
 */

export const DEFAULT_HALF_BUCKETS = 5;

/** Tabular numerals for axis labels and counts. */
export const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Values a human would have picked for a percentage axis. */
const NICE_STEPS = [
  0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200,
];

/** Smallest edge we will ever produce, so a flat market does not divide by ~0. */
const MIN_EDGE = 0.1;

export function niceEdge(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_EDGE;
  for (const s of NICE_STEPS) if (value <= s) return s;
  return Math.ceil(value / 50) * 50;
}

export interface AdaptiveBuckets {
  /** Strictly increasing positive edges. Length = half - 1. */
  edges: number[];
  /** Largest |change| observed; the open-ended outermost bucket is this and up. */
  maxAbs: number;
  /** Quantiles BEFORE rounding, kept so the UI can explain the choice. */
  rawQuantiles: number[];
  /** True when the data was too flat for quantiles to mean anything. */
  degenerate: boolean;
}

export function adaptiveEdges(
  changes: number[],
  half = DEFAULT_HALF_BUCKETS,
): AdaptiveBuckets {
  const abs = changes
    .map((c) => Math.abs(c))
    .filter((c) => Number.isFinite(c) && c > 0)
    .sort((a, b) => a - b);

  const maxAbs = abs.length ? abs[abs.length - 1] : 0;

  if (abs.length < 4) {
    // Too few assets for a quantile to be meaningful; fall back to a simple
    // ladder off the observed maximum rather than inventing precision.
    return {
      edges: fallbackEdges(maxAbs, half),
      maxAbs,
      rawQuantiles: [],
      degenerate: true,
    };
  }

  const q = (p: number): number => {
    const idx = (abs.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? abs[lo] : abs[lo] + (abs[hi] - abs[lo]) * (idx - lo);
  };

  const rawQuantiles: number[] = [];
  for (let i = 1; i < half; i++) rawQuantiles.push(q(i / half));

  // Round outward, then enforce strict monotonicity. Two quantiles can round to
  // the same nice value on a narrow distribution, which would produce a
  // zero-width bucket and a division by zero in the chart.
  const edges: number[] = [];
  let prev = 0;
  for (const r of rawQuantiles) {
    let e = niceEdge(r);
    if (e <= prev) e = niceEdge(prev * 1.05 || prev + MIN_EDGE);
    edges.push(e);
    prev = e;
  }

  return { edges, maxAbs, rawQuantiles, degenerate: false };
}

function fallbackEdges(maxAbs: number, half: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 1; i < half; i++) {
    const e = niceEdge((maxAbs * i) / half);
    out.push(e > prev ? e : niceEdge(prev + MIN_EDGE));
    prev = out[out.length - 1];
  }
  return out;
}

export interface DepthBucket {
  /** Lower edge, inclusive. The innermost bucket on each side starts at 0. */
  from: number;
  /** Upper edge, exclusive. The outermost is the observed maximum. */
  to: number;
  count: number;
  /** Symbols in this bucket, strongest first, for the hover tooltip. */
  symbols: { ticker: string; changePct: number }[];
}

export interface DepthDistribution {
  bullish: DepthBucket[];
  bearish: DepthBucket[];
  /** Universe partition: every asset is in exactly one of these three. */
  up: number;
  down: number;
  choppy: number;
  flat: number;
  total: number;
  edges: number[];
  maxAbs: number;
  degenerate: boolean;
}

/**
 * Split the universe into `half` buckets per side using adaptive edges.
 *
 * The outer edge is `maxAbs` (the largest move actually observed) rather than
 * infinity: the chart must not claim to cover moves that do not exist, and an
 * infinite edge renders as a bucket with no right-hand boundary.
 */
export function buildDistribution(
  rows: { changePct: number; strength?: number; ticker: string }[],
  half = DEFAULT_HALF_BUCKETS,
): DepthDistribution {
  const changes = rows.map((r) => r.changePct).filter((c) => Number.isFinite(c));
  const { edges, maxAbs, degenerate } = adaptiveEdges(changes, half);

  const outer = Math.max(maxAbs, edges[edges.length - 1] ?? MIN_EDGE);
  const bounds = [0, ...edges, outer];

const mk = (_side: 'bullish' | 'bearish'): DepthBucket[] =>
    bounds.slice(0, bounds.length - 1).map((from, i) => ({ from, to: bounds[i + 1], count: 0, symbols: [] }));

  const bullish = mk('bullish');
  const bearish = mk('bearish');

  let up = 0;
  let down = 0;
  let choppy = 0;
  let flat = 0;

  for (const r of rows) {
    const pct = r.changePct;
    if (!Number.isFinite(pct)) continue;

    // Partition first. `strength <= 0` is the engine's efficiency gate saying
    // the move went nowhere; such a coin is counted once, as chop.
    const isChoppy = r.strength !== undefined && !(r.strength > 0);
    if (isChoppy) { choppy++; continue; }
    if (pct > 0) up++;
    else if (pct < 0) down++;
    else { flat++; continue; }

    const mag = Math.abs(pct);
    const list = pct > 0 ? bullish : bearish;
    let placed = false;
    for (const b of list) {
      if (mag >= b.from && (mag < b.to || b.to === outer)) {
        b.count++;
        b.symbols.push({ ticker: r.ticker, changePct: pct });
        placed = true;
        break;
      }
    }
    if (!placed && list.length) {
      // Beyond the outermost observed edge. Clamped into the last bucket
      // rather than dropped, so the counts always sum to the partition total.
      const last = list[list.length - 1];
      last.count++;
      last.to = Math.max(last.to, mag);
      last.symbols.push({ ticker: r.ticker, changePct: pct });
    }
  }

  for (const b of [...bullish, ...bearish]) {
    b.symbols.sort((a, z) => Math.abs(z.changePct) - Math.abs(a.changePct));
    b.symbols = b.symbols.slice(0, 5);
  }

  return {
    bullish, bearish,
    up, down, choppy, flat,
    total: rows.length,
    edges, maxAbs: outer, degenerate,
  };
}

/** Axis label for an edge, signed to match the side it sits on. */
export function edgeTickLabel(edge: number, side: 'bullish' | 'bearish'): string {
  if (edge === 0) return '0';
  const v = `${edge >= 10 ? edge : edge.toFixed(edge < 1 ? 2 : 1).replace(/\.0$/, '')}%`;
  // U+2212 MINUS SIGN rather than a hyphen: it aligns with digit width, which
  // matters on a tabular axis where a hyphen reads as a gap.
  return side === 'bullish' ? `+${v}` : `−${v}`;
}
