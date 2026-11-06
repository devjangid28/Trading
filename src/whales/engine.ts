import type { Candle, TerminalInterval, TerminalTrade } from '../../shared/types';
import type { WhaleAverages, WhaleBubble, WhaleBubbleMode, WhalePlaceAt, WhaleSizeBy, WhaleTapeStats } from './types';
import { WHALE_BUBBLE_R_SCALE, WHALE_BUBBLE_MAX_R, WHALE_BUBBLE_MIN_R } from './tokens';

export const INTERVAL_MS: Record<TerminalInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export function clampNumber(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function ema(values: readonly number[], period: number): number[] {
  const out: number[] = [];
  if (!values.length) return out;
  const k = 2 / (period + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export interface CandleStats {
  buyUsd: number;
  sellUsd: number;
}

export function candleStatsFor(
  bars: readonly Candle[],
  trades: readonly TerminalTrade[],
  stepMs: number,
): Map<number, CandleStats> {
  const map = new Map<number, CandleStats>();
  for (const bar of bars) map.set(bar.t, { buyUsd: 0, sellUsd: 0 });
  for (const trade of trades) {
    const bucket = Math.floor(trade.t / stepMs) * stepMs;
    const stat = map.get(bucket);
    if (!stat) continue;
    if (trade.side === 'buy') stat.buyUsd += trade.usd;
    else stat.sellUsd += trade.usd;
  }
  for (const bar of bars) {
    const stat = map.get(bar.t);
    if (!stat) continue;
    const hasTrades = stat.buyUsd + stat.sellUsd > 0;
    if (!hasTrades) {
      const qv = bar.qv ?? bar.v * ((bar.o + bar.c) / 2);
      const buy = bar.takerBuyQuote ?? qv / 2;
      stat.buyUsd = buy;
      stat.sellUsd = Math.max(0, qv - buy);
    }
  }
  return map;
}

export interface BubbleBuildOptions {
  threshold: number;
  /** Max allowed gap (ms) between same-side near-same-price prints in one cluster. */
  clusterWindowMs: number;
  sideFilter: 'both' | 'buys' | 'sells';
  t0: number | null;
  /** Detection mode. `sweep` is the default cluster-based mode. */
  mode?: WhaleBubbleMode;
  sizeBy?: WhaleSizeBy;
  placeAt?: WhalePlaceAt;
}

export interface BubbleAccum {
  firstT: number;
  lastT: number;
  sumPx: number;
  buyUsd: number;
  sellUsd: number;
  count: number;
  prints: number;
  ids: number[];
}

interface BubbleSeed {
  key: string;
  t: number;
  firstT: number;
  lastT: number;
  anchorPrice: number;
  sumPx: number;
  buyUsd: number;
  sellUsd: number;
  count: number;
  ids: number[];
  prints: number;
}

/**
 * A whale bubble is a group of whale prints:
 * - `sweep` (default): fast same-side trades within the cluster window and
 *   near the same price, grouped into one bubble (a market order / burst).
 * - `aggressive`: same grouping; for a taker-only tape the aggressor side is
 *   exactly the print side, so this matches sweep (documented limitation).
 * - `level`: all qualifying volume at one price tick in one candle groups into
 *   one bubble (the volume at one price level).
 * - `print`: every qualifying trade is its own bubble.
 * Position: x = the group's real time, y = `placeAt` anchor (VWAP / first /
 * last price). Radius = 24 * sqrt(notional / 1e6), clamped [4, 38]px.
 */
export function buildBubbles(
  trades: readonly TerminalTrade[],
  stepMs: number,
  opts: BubbleBuildOptions,
): WhaleBubble[] {
  const { threshold, sideFilter, clusterWindowMs } = opts;
  const mode = opts.mode ?? 'sweep';
  const placeAt = opts.placeAt ?? 'vwap';
  const floorT = opts.t0 ?? -Infinity;
  const seeds = new Map<string, BubbleSeed>();
  const TICK = 0.01;

  let aggSide: 'buy' | 'sell' | null = null;
  let aggLastT = -Infinity;
  let aggLastPx = -Infinity;
  let aggKey = '';
  let aggSeed: BubbleSeed | null = null;

  const flushAgg = () => {
    if (aggSeed && aggSeed.buyUsd + aggSeed.sellUsd > 0) seeds.set(aggKey, aggSeed);
    aggSeed = null;
    aggKey = '';
    aggSide = null;
  };

  const startAgg = (trade: TerminalTrade) => {
    aggSide = trade.side;
    aggLastT = trade.t;
    aggLastPx = trade.price;
    aggKey = `s${trade.id}`;
    aggSeed = seedFor(trade, String(trade.id), 1);
  };

  const extendAgg = (trade: TerminalTrade) => {
    if (!aggSeed) return;
    aggSeed.lastT = trade.t;
    aggSeed.sumPx += trade.price * trade.usd;
    aggSeed.count += trade.count ?? 1;
    aggSeed.ids.push(trade.id);
    if (trade.side === 'buy') aggSeed.buyUsd += trade.usd;
    else aggSeed.sellUsd += trade.usd;
    aggLastT = trade.t;
    aggLastPx = trade.price;
  };

  const seedFor = (trade: TerminalTrade, key: string, prints: number): BubbleSeed => ({
    key,
    t: trade.t,
    firstT: trade.t,
    lastT: trade.t,
    anchorPrice: trade.price,
    sumPx: trade.price * trade.usd,
    buyUsd: trade.side === 'buy' ? trade.usd : 0,
    sellUsd: trade.side === 'sell' ? trade.usd : 0,
    count: trade.count ?? 1,
    ids: [trade.id],
    prints,
  });

  for (const trade of trades) {
    if (trade.t < floorT) continue;
    if (trade.usd < threshold) continue;
    if (sideFilter === 'buys' && trade.side === 'sell') continue;
    if (sideFilter === 'sells' && trade.side === 'buy') continue;

    if (mode === 'print') {
      const seed = seedFor(trade, `p${trade.id}`, 1);
      seeds.set(seed.key, seed);
      continue;
    }

    if (mode === 'level') {
      const candleKey = Math.floor(trade.t / stepMs) * stepMs;
      const priceKey = Math.round(trade.price / TICK);
      const key = `l${candleKey}:${priceKey}`;
      const seed = seeds.get(key) ?? seedFor(trade, key, 0);
      seed.lastT = Math.max(seed.lastT, trade.t);
      seed.firstT = Math.min(seed.firstT, trade.t);
      seed.sumPx += trade.price * trade.usd;
      seed.count += trade.count ?? 1;
      seed.ids.push(trade.id);
      if (trade.side === 'buy') seed.buyUsd += trade.usd;
      else seed.sellUsd += trade.usd;
      seeds.set(key, seed);
      continue;
    }

    if (aggSeed && aggSide === trade.side && trade.t - aggLastT <= clusterWindowMs && Math.abs(trade.price - aggLastPx) / trade.price <= 0.002) {
      extendAgg(trade);
    } else {
      flushAgg();
      startAgg(trade);
    }
  }
  flushAgg();

  const out: WhaleBubble[] = [];
  const byCandle = new Map<number, WhaleBubble>();
  for (const seed of seeds.values()) {
    const notional = seed.buyUsd + seed.sellUsd;
    if (notional <= 0) continue;
    const anchor = placeAt === 'first' ? seed.firstT
      : placeAt === 'last' ? seed.lastT
        : seed.t;
    const price = placeAt === 'first' ? firstPriceFor(trades, seed.ids) ?? seed.anchorPrice
      : placeAt === 'last' ? lastPriceFor(trades, seed.ids) ?? seed.anchorPrice
        : seed.sumPx / notional;
    const bubble: WhaleBubble = {
      id: `w${seed.key}`,
      t: Math.floor(anchor / stepMs) * stepMs,
      price,
      buyUsd: seed.buyUsd,
      sellUsd: seed.sellUsd,
      notional,
      count: seed.count,
      prints: Math.max(1, seed.prints),
      tradeIds: seed.ids,
      avg: seed.sumPx / notional,
    };
    if (mode === 'sweep') {
      const prev = byCandle.get(bubble.t);
      if (prev) {
        const total = prev.notional + bubble.notional;
        const buyUsd = prev.buyUsd + bubble.buyUsd;
        const sellUsd = prev.sellUsd + bubble.sellUsd;
        const merged: WhaleBubble = {
          id: `${prev.id}+${bubble.id}`,
          t: prev.t,
          price: (prev.price * prev.notional + bubble.price * bubble.notional) / total,
          buyUsd,
          sellUsd,
          notional: total,
          count: prev.count + bubble.count,
          prints: prev.prints + bubble.prints,
          tradeIds: [...prev.tradeIds, ...bubble.tradeIds],
          avg: total > 0 ? (prev.avg * prev.notional + bubble.avg * bubble.notional) / total : 0,
        };
        byCandle.set(prev.t, merged);
      } else {
        byCandle.set(bubble.t, bubble);
      }
    } else {
      out.push(bubble);
    }
  }
  if (mode === 'sweep') out.push(...byCandle.values());
  return out.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
}

function firstPriceFor(trades: readonly TerminalTrade[], ids: readonly number[]): number | null {
  let best: TerminalTrade | null = null;
  for (const t of trades) {
    if (ids.includes(t.id) && (best === null || t.t < best.t)) best = t;
  }
  return best ? best.price : null;
}

function lastPriceFor(trades: readonly TerminalTrade[], ids: readonly number[]): number | null {
  let best: TerminalTrade | null = null;
  for (const t of trades) {
    if (ids.includes(t.id) && (best === null || t.t > best.t)) best = t;
  }
  return best ? best.price : null;
}

export function countWhalePrints(
  trades: readonly TerminalTrade[],
  candleKey: number,
  stepMs: number,
  threshold: number,
  sideFilter: 'both' | 'buys' | 'sells',
  floorT: number,
  clusterWindowMs: number,
): number {
  let prints = 0;
  let curSide: 'buy' | 'sell' | null = null;
  let curLastT = -Infinity;
  let curPrice = -Infinity;
  for (const trade of trades) {
    if (trade.t < candleKey || trade.t >= candleKey + stepMs) continue;
    if (trade.t < floorT) continue;
    if (trade.usd < threshold) continue;
    if (sideFilter === 'buys' && trade.side === 'sell') continue;
    if (sideFilter === 'sells' && trade.side === 'buy') continue;
    if (curSide === trade.side && trade.t - curLastT <= clusterWindowMs && Math.abs(trade.price - curPrice) < 0.0051) {
      curLastT = trade.t;
      continue;
    }
    prints += 1;
    curSide = trade.side;
    curLastT = trade.t;
    curPrice = trade.price;
  }
  return prints;
}

export function bubbleRadius(notional: number): number {
  const r = Math.sqrt(Math.max(0, notional)) * WHALE_BUBBLE_R_SCALE;
  return clampNumber(r, WHALE_BUBBLE_MIN_R, WHALE_BUBBLE_MAX_R);
}

export function whaleAverages(bubbles: readonly WhaleBubble[]): WhaleAverages {
  let buyUsd = 0;
  let sellUsd = 0;
  let buySumPx = 0;
  let sellSumPx = 0;
  let buyCount = 0;
  let sellCount = 0;
  for (const b of bubbles) {
    if (b.buyUsd > 0) {
      buyUsd += b.buyUsd;
      buySumPx += b.buyUsd * b.price;
      buyCount += 1;
    }
    if (b.sellUsd > 0) {
      sellUsd += b.sellUsd;
      sellSumPx += b.sellUsd * b.price;
      sellCount += 1;
    }
  }
  const total = buyUsd + sellUsd;
  return {
    buyAvg: buyUsd > 0 ? buySumPx / buyUsd : null,
    sellAvg: sellUsd > 0 ? sellSumPx / sellUsd : null,
    avg: total > 0 ? (buySumPx + sellSumPx) / total : null,
    buyUsd,
    sellUsd,
    buyCount,
    sellCount,
  };
}

export interface WhaleNet {
  net: number;
  total: number;
  buyUsd: number;
  sellUsd: number;
  bubbles: number;
}

/**
 * Percentile stats over the recorded tape (notional per print). Used for the
 * "Auto" whale-size floor (top ~0.5% = p99, capped at $5K).
 */
export function tapeStats(trades: readonly TerminalTrade[]): WhaleTapeStats {
  const values: number[] = [];
  for (const t of trades) {
    if (Number.isFinite(t.usd) && t.usd > 0) values.push(t.usd);
  }
  if (values.length === 0) return { median: 0, p99: 0, p999: 0, sampled: 0 };
  if (values.length > 20_000) {
    values.sort((a, b) => a - b);
    const stride = Math.ceil(values.length / 20_000);
    const sampled: number[] = [];
    for (let i = 0; i < values.length; i += stride) sampled.push(values[i]);
    return { median: percentileOf(sampled, 0.5), p99: percentileOf(sampled, 0.99), p999: percentileOf(sampled, 0.999), sampled: sampled.length };
  }
  values.sort((a, b) => a - b);
  return { median: percentileOf(values, 0.5), p99: percentileOf(values, 0.99), p999: percentileOf(values, 0.999), sampled: values.length };
}

function percentileOf(sorted: readonly number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[idx];
}

export interface ZoneBand {
  low: number;
  high: number;
  side: 'buy' | 'sell';
  totalUsd: number;
}

/**
 * Bands where the most whale dollars traded (top N per side, in the visible
 * price range). Runs of non-empty price buckets are ranked by total $.
 */
export function zoneBands(
  bubbles: readonly WhaleBubble[],
  priceMin: number,
  priceMax: number,
  rows = 140,
  topN = 2,
): ZoneBand[] {
  if (!(priceMax > priceMin) || rows <= 0 || bubbles.length === 0) return [];
  const step = (priceMax - priceMin) / rows;
  const buy = new Float64Array(rows);
  const sell = new Float64Array(rows);
  for (const b of bubbles) {
    const idx = clampNumber(Math.floor((priceMax - b.price) / step), 0, rows - 1);
    buy[idx] += b.buyUsd;
    sell[idx] += b.sellUsd;
  }
  const collect = (arr: Float64Array, side: 'buy' | 'sell'): ZoneBand[] => {
    const runs: ZoneBand[] = [];
    let i = 0;
    while (i < rows) {
      if (arr[i] > 0) {
        let j = i;
        let total = 0;
        while (j < rows && arr[j] > 0) {
          total += arr[j];
          j += 1;
        }
        runs.push({
          low: priceMax - j * step,
          high: priceMax - i * step,
          side,
          totalUsd: total,
        });
        i = j;
      } else i += 1;
    }
    runs.sort((a, b) => b.totalUsd - a.totalUsd);
    return runs.slice(0, topN);
  };
  return [...collect(buy, 'buy'), ...collect(sell, 'sell')];
}

export function whaleNet(bubbles: readonly WhaleBubble[]): WhaleNet {
  let buyUsd = 0;
  let sellUsd = 0;
  for (const b of bubbles) {
    buyUsd += b.buyUsd;
    sellUsd += b.sellUsd;
  }
  return {
    net: buyUsd - sellUsd,
    total: buyUsd + sellUsd,
    buyUsd,
    sellUsd,
    bubbles: bubbles.length,
  };
}

export interface HistRow {
  low: number;
  high: number;
  buyUsd: number;
  sellUsd: number;
}

export function priceHistogram(
  bubbles: readonly WhaleBubble[],
  priceMin: number,
  priceMax: number,
  rows: number,
): HistRow[] {
  const out: HistRow[] = [];
  if (!(priceMax > priceMin) || rows <= 0) return out;
  const step = (priceMax - priceMin) / rows;
  for (let i = 0; i < rows; i++) {
    out.push({ low: priceMax - (i + 1) * step, high: priceMax - i * step, buyUsd: 0, sellUsd: 0 });
  }
  for (const b of bubbles) {
    const idx = clampNumber(Math.floor((priceMax - b.price) / step), 0, rows - 1);
    const row = out[idx];
    row.buyUsd += b.buyUsd;
    row.sellUsd += b.sellUsd;
  }
  return out;
}

export interface NetPoint {
  t: number;
  whale: number;
  everyone: number;
}

export function bubbleNet(
  bars: readonly Candle[],
  bubbles: readonly WhaleBubble[],
  trades: readonly TerminalTrade[],
  t0: number | null,
  stepMs: number,
  threshold: number,
): { points: NetPoint[]; whaleCum: number; everyoneCum: number } {
  const byT = new Map<number, NetPoint>();
  for (const bar of bars) {
    byT.set(bar.t, { t: bar.t, whale: 0, everyone: 0 });
  }
  const floorT = t0 === null ? -Infinity : Math.floor(t0 / stepMs) * stepMs;
  for (const b of bubbles) {
    if (b.t < floorT) continue;
    const point = byT.get(b.t);
    if (point) point.whale += b.buyUsd - b.sellUsd;
  }
  for (const trade of trades) {
    if (trade.t < floorT) continue;
    if (trade.usd >= threshold) continue;
    const bucket = Math.floor(trade.t / stepMs) * stepMs;
    const point = byT.get(bucket);
    if (point) point.everyone += trade.side === 'buy' ? trade.usd : -trade.usd;
  }
  const points = [...byT.values()].sort((a, b) => a.t - b.t);
  let whaleCum = 0;
  let everyoneCum = 0;
  for (const p of points) {
    whaleCum += p.whale;
    everyoneCum += p.everyone;
  }
  return { points, whaleCum, everyoneCum };
}

export interface LiqLevels {
  shorts: number;
  longs: number;
}

/**
 * Estimated liquidation clusters from the whale entry average.
 *
 * Formula (documented, swappable): a cluster of entry price `avg` built with
 * assumed leverage L liquidates when price moves ~1/L against the entry.
 *   shorts liquidate = avg * (1 + 1/L)   (shorts' liq is ABOVE the entry)
 *   longs liquidate = avg * (1 - 1/L)   (longs' liq is BELOW the entry)
 * This is an estimate used when no real liquidation feed is available; a real
 * feed (e.g. Bybit forceOrder) can replace this function.
 */
export function estimateLiquidationLevels(avg: number | null, leverage = 5): LiqLevels {
  const a = avg && avg > 0 ? avg : 0;
  if (a <= 0) return { shorts: 0, longs: 0 };
  const inv = 1 / Math.max(1, leverage);
  return { shorts: a * (1 + inv), longs: a * (1 - inv) };
}

export function visiblePoc(
  trades: readonly TerminalTrade[],
  start: number,
  end: number,
  priceMin: number,
  priceMax: number,
  buckets = 120,
): number | null {
  const totals = new Map<number, number>();
  const step = (priceMax - priceMin) / buckets;
  for (const trade of trades) {
    if (trade.t < start || trade.t > end) continue;
    if (trade.price < priceMin || trade.price > priceMax) continue;
    const bucket = clampNumber(Math.floor((trade.price - priceMin) / step), 0, buckets - 1);
    totals.set(bucket, (totals.get(bucket) ?? 0) + trade.usd);
  }
  let best: number | null = null;
  let bestUsd = -1;
  for (const [bucket, usd] of totals) {
    if (usd > bestUsd) {
      bestUsd = usd;
      best = bucket;
    }
  }
  return best === null ? null : priceMin + (best + 0.5) * step;
}
