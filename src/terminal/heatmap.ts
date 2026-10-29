import type { TerminalBookLevel, TerminalSpan, TerminalTrade } from '../../shared/types';
import type { BookFrame, SideWall, SideWalls } from './math';
import type { BubbleMode, StepMode } from './settings';

export const SPAN_MS: Record<TerminalSpan, number> = {
  '1m': 60_000,
  '2m': 120_000,
  '5m': 300_000,
  '12m': 720_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 12;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function percentile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[clampNumber(Math.floor((sorted.length - 1) * q), 0, sorted.length - 1)];
}

/** A compact local clock; the terminal never silently relabels UTC as local. */
export function localClock(ts: number, seconds = true): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return seconds ? `${hm}:${p(d.getSeconds())}` : hm;
}

/** Price notation without grouping commas, so 80629.05 does not become 80,629.05. */
export function plainPrice(price: number, decimals = 2): string {
  if (!Number.isFinite(price)) return '\u2014';
  return price.toFixed(decimals);
}

export interface PriceTicks {
  values: number[];
  step: number;
}

/** Nice price steps for the axis, independent of the row lattice. */
export function nicePriceTicks(min: number, max: number, count = 8): PriceTicks {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return { values: [], step: 0 };
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = nice * mag;
  const first = Math.ceil(min / step) * step;
  const values: number[] = [];
  for (let value = first; value <= max + step * 1e-8 && values.length < 64; value += step) {
    values.push(Number(value.toFixed(12)));
  }
  return { values, step };
}

export interface SparseThresholds {
  low: number;
  med: number;
  high: number;
  max: number;
  cells: number;
}

/**
 * Perceptual thresholds for the sparse strip. They are computed from rendered
 * row totals and are deliberately not per-level: one row can hold several
 * book levels, and a per-level p90 would paint almost every row yellow.
 */
export function sparseThresholds(
  frames: readonly BookFrame[],
  priceMin: number,
  priceMax: number,
  rows: number,
  minLiquidityUsd = 0,
): SparseThresholds {
  const values: number[] = [];
  const stride = Math.max(1, Math.ceil(frames.length / 600));
  for (let i = 0; i < frames.length; i += stride) {
    const { bid, ask } = frameRowTotals(frames[i], priceMin, priceMax, rows, minLiquidityUsd);
    for (let row = 0; row < rows; row++) {
      const value = (bid[row] ?? 0) + (ask[row] ?? 0);
      if (value > 0) values.push(value);
    }
  }
  values.sort((a, b) => a - b);
  return {
    low: percentile(values, 0.40),
    med: percentile(values, 0.70),
    high: percentile(values, 0.90),
    max: percentile(values, 0.95),
    cells: values.length,
  };
}

/** Map a row total onto the reference's four sparse bands. */
export function sparseIntensity(usd: number, thresholds: SparseThresholds, gain = 1): number {
  if (usd <= 0 || thresholds.low <= 0) return 0;
  if (usd < thresholds.low) return 0;
  const span = (a: number, b: number) => Math.max(1e-9, b - a);
  let t = 0;
  if (usd < thresholds.med) {
    t = 0.04 + 0.38 * ((usd - thresholds.low) / span(thresholds.low, thresholds.med));
  } else if (usd < thresholds.high) {
    t = 0.42 + 0.28 * ((usd - thresholds.med) / span(thresholds.med, thresholds.high));
  } else if (usd < thresholds.max) {
    t = 0.70 + 0.20 * ((usd - thresholds.high) / span(thresholds.high, thresholds.max));
  } else {
    t = 0.90 + 0.10 * clampNumber((usd - thresholds.max) / Math.max(1, thresholds.max), 0, 1);
  }
  return clampNumber(t * gain, 0, 1);
}

/** Auto tape threshold: the top decile of prints, floored at $5K and rounded. */
export function autoTapeThresholdUsd(trades: readonly TerminalTrade[]): number {
  const values = trades.map((t) => t.usd).filter((usd) => usd > 0);
  if (!values.length) return 5_000;
  const q = percentile(values, 0.90);
  const step = q >= 100_000 ? 25_000 : q >= 20_000 ? 5_000 : 500;
  return Math.max(5_000, Math.round(q / step) * step);
}

export function tapeThresholdUsd(mode: string, trades: readonly TerminalTrade[]): number {
  if (mode === 'all') return 0;
  if (mode === '1k') return 1_000;
  if (mode === '10k') return 10_000;
  if (mode === '100k') return 100_000;
  return autoTapeThresholdUsd(trades);
}

export function timeToX(time: number, start: number, end: number, left: number, width: number): number {
  if (end <= start || width <= 0) return left;
  return left + ((time - start) / (end - start)) * width;
}

export function xToTime(x: number, start: number, end: number, left: number, width: number): number {
  if (width <= 0) return start;
  return start + ((x - left) / width) * (end - start);
}

export function priceToY(
  price: number,
  priceMin: number,
  priceMax: number,
  top: number,
  height: number,
): number {
  if (priceMax <= priceMin || height <= 0) return top;
  return top + ((priceMax - price) / (priceMax - priceMin)) * height;
}

export function yToPrice(
  y: number,
  priceMin: number,
  priceMax: number,
  top: number,
  height: number,
): number {
  if (height <= 0) return priceMin;
  return priceMax - ((y - top) / height) * (priceMax - priceMin);
}

/** Latest frame at or before `time`; binary search so it is safe on every pointer move. */
export function frameIndexAt(frames: readonly BookFrame[], time: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].asOf <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function frameAt(frames: readonly BookFrame[], time: number): BookFrame | null {
  const index = frameIndexAt(frames, time);
  return index >= 0 ? frames[index] : null;
}

export function rowCountFor(plotH: number, rowPx: number): number {
  return Math.max(1, Math.floor(plotH / Math.max(1, rowPx)));
}

export function rowIndexForPrice(
  price: number,
  priceMin: number,
  priceMax: number,
  rows: number,
): number {
  if (priceMax <= priceMin || rows <= 0) return 0;
  return clampNumber(
    Math.floor(((priceMax - price) / (priceMax - priceMin)) * rows),
    0,
    rows - 1,
  );
}

export function rowPriceRange(
  row: number,
  priceMin: number,
  priceMax: number,
  rows: number,
): { low: number; high: number } {
  const step = (priceMax - priceMin) / Math.max(1, rows);
  const high = priceMax - row * step;
  return { low: high - step, high };
}

export interface CellLevel {
  side: 'bid' | 'ask';
  level: TerminalBookLevel;
}

export interface CellHit {
  frame: BookFrame;
  levels: CellLevel[];
  row: number;
  low: number;
  high: number;
  /** Sum of all recorded liquidity in the rendered row, including compact history. */
  bidUsd: number;
  askUsd: number;
  bidBins: number;
  askBins: number;
}

/**
 * Exact rendered cell lookup. It never snaps to a nearby non-empty level: an
 * empty cell returns an empty `levels` array so the UI can honestly say so.
 * Compact history has no individual levels, only recorded price-bin sums.
 */
export function cellAt(
  frames: readonly BookFrame[],
  time: number,
  row: number,
  priceMin: number,
  priceMax: number,
  rows: number,
): CellHit | null {
  const frame = frameAt(frames, time);
  if (!frame) return null;
  const clampedRow = clampNumber(row, 0, Math.max(0, rows - 1));
  const range = rowPriceRange(clampedRow, priceMin, priceMax, rows);
  const levels: CellLevel[] = [];
  let bidUsd = 0;
  let askUsd = 0;
  let bidBins = 0;
  let askBins = 0;

  if (frame.lattice) {
    const step = frame.lattice.binBps / 10_000;
    const overlap = (low: number, high: number) => (
      Math.max(0, Math.min(high, range.high) - Math.max(low, range.low)) / Math.max(1e-12, high - low)
    );
    for (let i = 0; i < frame.lattice.binsPerSide; i++) {
      const bidValue = frame.lattice.bids[i] ?? 0;
      if (bidValue > 0) {
        const low = frame.mid * (1 - (i + 1) * step);
        const share = overlap(low, frame.mid * (1 - i * step));
        if (share > 0) {
          bidUsd += bidValue * share;
          bidBins += 1;
        }
      }
      const askValue = frame.lattice.asks[i] ?? 0;
      if (askValue > 0) {
        const high = frame.mid * (1 + (i + 1) * step);
        const share = overlap(frame.mid * (1 + i * step), high);
        if (share > 0) {
          askUsd += askValue * share;
          askBins += 1;
        }
      }
    }
  } else {
    const inRow = (level: TerminalBookLevel) => (
      rowIndexForPrice(level.price, priceMin, priceMax, rows) === clampedRow
    );
    for (const level of frame.bids) {
      if (inRow(level)) {
        levels.push({ side: 'bid', level });
        bidUsd += level.usd;
        bidBins += 1;
      }
    }
    for (const level of frame.asks) {
      if (inRow(level)) {
        levels.push({ side: 'ask', level });
        askUsd += level.usd;
        askBins += 1;
      }
    }
    levels.sort((a, b) => b.level.usd - a.level.usd);
  }

  return {
    frame,
    levels,
    row: clampedRow,
    low: range.low,
    high: range.high,
    bidUsd,
    askUsd,
    bidBins,
    askBins,
  };
}

export interface FrameRowTotals {
  bid: Float64Array;
  ask: Float64Array;
}

/**
 * Spread one recorded price bin across every rendered row it overlaps, in
 * proportion to the overlap. The server stores the summed notional for the
 * bin, so uniform density inside the bin is the least-assuming drawing. It
 * keeps the bin's total intact and leaves no artificial stripe between bins.
 */
function addLatticeBand(
  values: Float64Array,
  usd: number,
  low: number,
  high: number,
  priceMin: number,
  priceMax: number,
): void {
  if (!(usd > 0) || !(high > low)) return;
  if (high <= priceMin || low >= priceMax) return;
  const rows = values.length;
  const rowStep = (priceMax - priceMin) / rows;
  const first = clampNumber(Math.floor((priceMax - high) / rowStep), 0, rows - 1);
  const last = clampNumber(Math.floor((priceMax - low) / rowStep), 0, rows - 1);
  const band = high - low;
  for (let row = first; row <= last; row++) {
    const rowHigh = priceMax - row * rowStep;
    const rowLow = rowHigh - rowStep;
    const overlap = Math.min(high, rowHigh) - Math.max(low, rowLow);
    if (overlap > 0) values[row] += usd * (overlap / band);
  }
}

/** Aggregate either exact levels or a captured lattice into rendered rows. */
export function frameRowTotals(
  frame: BookFrame,
  priceMin: number,
  priceMax: number,
  rows: number,
  minUsd = 0,
): FrameRowTotals {
  const bid = new Float64Array(Math.max(1, rows));
  const ask = new Float64Array(Math.max(1, rows));
  if (priceMax <= priceMin || rows <= 0) return { bid, ask };
  if (frame.lattice) {
    const step = frame.lattice.binBps / 10_000;
    for (let i = 0; i < frame.lattice.binsPerSide; i++) {
      const bidValue = frame.lattice.bids[i] ?? 0;
      if (bidValue >= minUsd && bidValue > 0) {
        addLatticeBand(
          bid, bidValue,
          frame.mid * (1 - (i + 1) * step), frame.mid * (1 - i * step),
          priceMin, priceMax,
        );
      }
      const askValue = frame.lattice.asks[i] ?? 0;
      if (askValue >= minUsd && askValue > 0) {
        addLatticeBand(
          ask, askValue,
          frame.mid * (1 + i * step), frame.mid * (1 + (i + 1) * step),
          priceMin, priceMax,
        );
      }
    }
    return { bid, ask };
  }
  for (const level of frame.bids) {
    if (level.price < priceMin || level.price > priceMax || level.usd < minUsd) continue;
    bid[rowIndexForPrice(level.price, priceMin, priceMax, rows)] += level.usd;
  }
  for (const level of frame.asks) {
    if (level.price < priceMin || level.price > priceMax || level.usd < minUsd) continue;
    ask[rowIndexForPrice(level.price, priceMin, priceMax, rows)] += level.usd;
  }
  return { bid, ask };
}

export interface BubblePoint {
  t: number;
  firstT: number;
  lastT: number;
  price: number;
  usd: number;
  qty: number;
  side: 'buy' | 'sell';
  count: number;
  aggregated: boolean;
  bucketMs?: number;
  /** Aggressor split, so a step bubble can render as a pie. */
  buyUsd: number;
  sellUsd: number;
}

export function displayBubbleMode(mode: BubbleMode, tradeCount: number, spanMs: number): BubbleMode {
  if (mode !== 'auto') return mode;
  return spanMs > 300_000 || tradeCount > 700 ? 'steps' : 'trades';
}

export function stepMsFor(spanMs: number, mode: StepMode): number {
  if (mode === '1m') return 60_000;
  if (mode !== 'auto') {
    const seconds = Number.parseInt(mode, 10);
    return Number.isFinite(seconds) ? seconds * 1_000 : 5_000;
  }
  return clampNumber(Math.round(spanMs / 90 / 1_000) * 1_000, 1_000, 300_000);
}

/**
 * Executions -> bubbles. Step mode groups both time and price so a single
 * bubble never claims a volume-weighted price that was not traded there.
 */
export function bubblePoints(
  trades: readonly TerminalTrade[],
  start: number,
  end: number,
  mode: BubbleMode,
  stepMode: StepMode,
  minTradeUsd: number,
  priceMin: number,
  priceMax: number,
  rows: number,
): BubblePoint[] {
  const visible = trades.filter((trade) => (
    trade.t >= start
    && trade.t <= end
    && trade.usd >= minTradeUsd
    && trade.price >= priceMin
    && trade.price <= priceMax
  ));
  if (mode === 'off') return [];

  const asPoint = (trade: TerminalTrade): BubblePoint => {
    const count = trade.count ?? 1;
    const bucketMs = trade.bucketMs;
    return {
      t: bucketMs ? trade.t + bucketMs / 2 : trade.t,
      firstT: trade.t,
      lastT: bucketMs ? trade.t + bucketMs : trade.t,
      price: trade.price,
      usd: trade.usd,
      qty: trade.qty,
      side: trade.side,
      count,
      aggregated: count > 1,
      bucketMs,
      buyUsd: trade.side === 'buy' ? trade.usd : 0,
      sellUsd: trade.side === 'sell' ? trade.usd : 0,
    };
  };

  const stepTrades = (source: readonly TerminalTrade[]): BubblePoint[] => {
    const stepMs = stepMsFor(end - start, stepMode);
    const bins = new Map<string, {
      firstT: number;
      lastT: number;
      notional: number;
      qty: number;
      buy: number;
      sell: number;
      count: number;
    }>();
    for (const trade of source) {
      const timeBin = Math.floor((trade.t - start) / stepMs);
      const priceBin = rowIndexForPrice(trade.price, priceMin, priceMax, rows);
      const key = `${timeBin}:${priceBin}`;
      const bin = bins.get(key) ?? {
        firstT: trade.t,
        lastT: trade.t,
        notional: 0,
        qty: 0,
        buy: 0,
        sell: 0,
        count: 0,
      };
      bin.firstT = Math.min(bin.firstT, trade.t);
      bin.lastT = Math.max(bin.lastT, trade.t);
      bin.notional += trade.usd;
      bin.qty += trade.qty;
      bin.buy += trade.side === 'buy' ? trade.usd : 0;
      bin.sell += trade.side === 'sell' ? trade.usd : 0;
      bin.count += trade.count ?? 1;
      bins.set(key, bin);
    }
    return [...bins.values()]
      .filter((bin) => bin.notional > 0 && bin.qty > 0)
      .map((bin) => ({
        t: bin.lastT,
        firstT: bin.firstT,
        lastT: bin.lastT,
        price: bin.notional / bin.qty,
        usd: bin.notional,
        qty: bin.qty,
        side: bin.buy >= bin.sell ? 'buy' as const : 'sell' as const,
        count: bin.count,
        aggregated: true,
        buyUsd: bin.buy,
        sellUsd: bin.sell,
      }))
      .sort((a, b) => a.t - b.t);
  };

  if (mode === 'trades') return visible.slice(-4_000).map(asPoint);
  if (mode === 'steps') return stepTrades(visible);

  // Auto: older than five minutes becomes low-noise step bubbles; the live
  // edge stays as individual prints. This is a hybrid, not a hidden switch.
  const cutoff = end - 5 * 60_000;
  if (end - start <= 5 * 60_000) return visible.slice(-4_000).map(asPoint);
  const older = visible.filter((trade) => trade.t < cutoff);
  const newer = visible.filter((trade) => trade.t >= cutoff);
  return [...stepTrades(older), ...newer.map(asPoint)].sort((a, b) => a.t - b.t);
}
export interface AbsorptionMark {
  t: number;
  price: number;
  side: 'buy' | 'sell';
  usd: number;
  /** Price change after the print, in basis points. */
  movedBps: number;
}

/**
 * Large aggressor prints that failed to move price. A buy is absorbed when the
 * mid does not rise over the following step; a sell when it does not fall.
 * Only prints in the top decile of the captured tape qualify.
 */
export function absorptionMarks(
  bubbles: readonly BubblePoint[],
  frames: readonly BookFrame[],
  stepMs: number,
  limit = 8,
): AbsorptionMark[] {
  if (bubbles.length < 4 || !frames.length) return [];
  const reference = percentile(bubbles.map((b) => b.usd), 0.92);
  const candidates = bubbles
    .filter((b) => b.usd >= reference && b.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, limit);
  const out: AbsorptionMark[] = [];
  for (const bubble of candidates) {
    const before = frameAt(frames, bubble.firstT);
    const after = frameAt(frames, bubble.firstT + stepMs);
    if (!before || !after || before.mid <= 0) continue;
    const movedBps = ((after.mid - before.mid) / before.mid) * 10_000;
    if (bubble.side === 'buy' && movedBps <= 0.5) {
      out.push({ t: bubble.t, price: bubble.price, side: 'buy', usd: bubble.usd, movedBps });
    } else if (bubble.side === 'sell' && movedBps >= -0.5) {
      out.push({ t: bubble.t, price: bubble.price, side: 'sell', usd: bubble.usd, movedBps });
    }
  }
  return out;
}

export function bubbleReferenceUsd(trades: readonly TerminalTrade[]): number {
  const positive = trades.map((trade) => trade.usd).filter((usd) => usd > 0);
  return Math.max(1, percentile(positive, 0.9));
}

/**
 * The reference's diameter rule: 6px + 1.8px per sqrt($1K), clamped 8..64px.
 * `_referenceUsd` is kept in the signature for older callers; the rule is
 * absolute notional, not a viewport-relative quantile.
 */
export function bubbleRadius(usd: number, _referenceUsd: number, scale = 1): number {
  const diameter = 6 + 1.8 * Math.sqrt(Math.max(0, usd) / 1_000);
  return clampNumber(diameter, 8, 64) * clampNumber(scale, 0.25, 3) / 2;
}

export interface VolumeBucket {
  buy: number;
  sell: number;
  total: number;
}

export function volumeBuckets(
  trades: readonly TerminalTrade[],
  start: number,
  end: number,
  count: number,
): VolumeBucket[] {
  const buckets = Array.from({ length: Math.max(1, count) }, () => ({ buy: 0, sell: 0, total: 0 }));
  const span = Math.max(1, end - start);
  for (const trade of trades) {
    if (trade.t < start || trade.t > end) continue;
    const index = clampNumber(
      Math.floor(((trade.t - start) / span) * buckets.length),
      0,
      buckets.length - 1,
    );
    const bucket = buckets[index];
    if (trade.side === 'buy') bucket.buy += trade.usd;
    else bucket.sell += trade.usd;
    bucket.total += trade.usd;
  }
  return buckets;
}

export function wallAt(walls: SideWalls, price: number, tolerance: number): SideWall | null {
  const candidates = [walls.bid, walls.ask]
    .filter((wall): wall is SideWall => Boolean(wall))
    .map((wall) => ({ wall, distance: Math.abs(wall.price - price) }))
    .filter((entry) => entry.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance);
  return candidates.length ? candidates[0].wall : null;
}

/** Keep historical colors steady while still allowing a genuinely larger wall to register. */
export function nextLiquidityScale(
  current: number,
  candidate: number,
  elapsedMs: number,
): number {
  if (!Number.isFinite(candidate) || candidate <= 0) return current;
  if (!Number.isFinite(current) || current <= 0) return candidate;
  if (candidate > current * 1.25 && elapsedMs >= 2_000) return candidate;
  if (candidate < current * 0.55 && elapsedMs >= 15_000) return candidate;
  return current;
}

/**
 * Scale the colour ramp against rendered row totals, not individual levels.
 * One row aggregates several book levels, so a per-level p95 saturates nearly
 * every row and turns the whole chart yellow.
 */
export function liquidityScaleForFrame(
  frame: BookFrame,
  priceMin: number,
  priceMax: number,
  rows: number,
  minLevelUsd = 0,
): number {
  if (priceMax <= priceMin || rows <= 0) return 1;
  const { bid, ask } = frameRowTotals(frame, priceMin, priceMax, rows, minLevelUsd);
  const totals: number[] = [];
  for (let row = 0; row < rows; row++) {
    const total = Math.max(bid[row], ask[row]);
    if (total > 0) totals.push(total);
  }
  if (!totals.length) return 1;
  const reference = totals.length >= 20 ? percentile(totals, 0.95) : Math.max(...totals);
  return Math.max(1, reference);
}

export function heatIntensity(usd: number, scale: number, gain: number): number {
  if (usd <= 0 || scale <= 0) return 0;
  return clampNumber(Math.sqrt(usd / scale) * gain, 0, 1);
}

const HEAT_STOPS: Array<{ t: number; rgb: [number, number, number] }> = [
  { t: 0, rgb: [11, 46, 122] },
  { t: 0.28, rgb: [29, 78, 216] },
  { t: 0.50, rgb: [37, 99, 235] },
  { t: 0.68, rgb: [34, 211, 238] },
  { t: 0.82, rgb: [165, 243, 252] },
  { t: 0.90, rgb: [240, 253, 255] },
  { t: 1, rgb: [253, 224, 71] },
];

export function heatColor(intensity: number, opacity = 1): string {
  const t = clampNumber(intensity, 0, 1);
  let index = 0;
  while (index < HEAT_STOPS.length - 2 && t > HEAT_STOPS[index + 1].t) index += 1;
  const a = HEAT_STOPS[index];
  const b = HEAT_STOPS[index + 1];
  const local = (t - a.t) / Math.max(1e-9, b.t - a.t);
  const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * local);
  const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * local);
  const blue = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * local);
  const alpha = clampNumber(opacity, 0, 1);
  return `rgba(${r},${g},${blue},${alpha.toFixed(3)})`;
}

export function tooltipPosition(
  pointerX: number,
  pointerY: number,
  tooltipW: number,
  tooltipH: number,
  viewportW: number,
  viewportH: number,
  gap = 14,
  pad = 8,
): { left: number; top: number } {
  const left = pointerX + gap + tooltipW + pad > viewportW
    ? pointerX - gap - tooltipW
    : pointerX + gap;
  const top = pointerY + gap + tooltipH + pad > viewportH
    ? pointerY - gap - tooltipH
    : pointerY + gap;
  return {
    left: clampNumber(left, pad, Math.max(pad, viewportW - tooltipW - pad)),
    top: clampNumber(top, pad, Math.max(pad, viewportH - tooltipH - pad)),
  };
}

export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1_000) return 'under 1s';
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1_000);
  if (secs === 0 || secs === 60) return `${mins} min`;
  return `${mins}m ${secs}s`;
}
export const fmtDuration = humanizeDuration;
