import type { TerminalTrade } from '../../../shared/types';
import { INTERVAL_MS } from '../math';
import type {
  FootprintAggregateOptions, FootprintCandle, FootprintCandleMeta, FootprintDataset, FootprintRow,
  PreparedFootprintCandle, PreparedFootprintRow,
} from './types';

interface RowAccum {
  bidUsd: number;
  askUsd: number;
  bidQty: number;
  askQty: number;
}

interface CandleAccum {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
  volumeQty: number;
  buyUsd: number;
  sellUsd: number;
  buyQty: number;
  sellQty: number;
  rows: Map<number, RowAccum>;
}

export function intervalMs(interval: FootprintAggregateOptions['interval']): number {
  return INTERVAL_MS[interval];
}

export function baseTickFor(symbol: string, reference = 0): number {
  const base = symbol.replace(/USDT$/i, '').toUpperCase();
  if (base === 'BTC') return 0.5;
  if (base === 'ETH') return 0.05;
  if (reference >= 1_000) return 0.5;
  if (reference >= 100) return 0.01;
  if (reference >= 1) return 0.001;
  if (reference >= 0.01) return 0.0001;
  return 0.00001;
}

export function rowLadder(baseTick: number): number[] {
  if (Math.abs(baseTick - 0.5) < 1e-9) return [0.5, 1, 2, 5, 10, 25, 50, 100];
  return [1, 2, 5, 10, 25, 50, 100, 200].map((n) => n * baseTick);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function chooseRowSize(
  trades: readonly TerminalTrade[],
  stepMs: number,
  baseTick: number,
): number {
  if (!trades.length) return rowLadder(baseTick)[5];
  const ranges = new Map<number, { high: number; low: number }>();
  for (const trade of trades) {
    const bucket = Math.floor(trade.t / stepMs) * stepMs;
    const range = ranges.get(bucket);
    if (!range) ranges.set(bucket, { high: trade.price, low: trade.price });
    else {
      if (trade.price > range.high) range.high = trade.price;
      if (trade.price < range.low) range.low = trade.price;
    }
  }
  const medianRange = median([...ranges.values()].map((r) => Math.max(0, r.high - r.low)));
  const target = Math.max(baseTick, medianRange / 18);
  const ladder = rowLadder(baseTick);
  return ladder.find((step) => step >= target) ?? ladder[ladder.length - 1];
}

/**
 * Pick the finest ladder step that still gives the visible candles a readable
 * number of rows. The renderer calls this whenever the plot is resized or the
 * visible window changes.
 */
export function resolveAutoRowSize(candles: readonly FootprintCandle[], plotH: number): number {
  if (!candles.length) return 25;
  const reference = median(candles.map((candle) => candle.c));
  const baseTick = baseTickFor('', reference);
  const ranges = candles.map((candle) => Math.max(0, candle.h - candle.l)).filter((value) => value > 0);
  const medianRange = median(ranges);
  const targetRows = Math.max(8, Math.min(42, Math.round(plotH / 20)));
  const target = Math.max(baseTick, medianRange / targetRows);
  const ladder = rowLadder(baseTick);
  return ladder.find((step) => step >= target) ?? ladder[ladder.length - 1];
}

export function averageVolume(candles: readonly FootprintCandle[], lookback = 20): number {
  if (!candles.length) return 0;
  const sample = candles.slice(-1 - lookback, -1);
  if (!sample.length) return 0;
  return sample.reduce((sum, candle) => sum + candle.volumeUsd, 0) / sample.length;
}

function valueArea(
  rows: readonly FootprintRow[], pocPos: number, pct: number,
): { high: number; low: number } {
  if (!rows.length) return { high: 0, low: 0 };
  const total = rows.reduce((sum, row) => sum + row.bidUsd + row.askUsd, 0);
  if (total <= 0) return { high: rows[0].price, low: rows[rows.length - 1].price };
  let sum = rows[pocPos].bidUsd + rows[pocPos].askUsd;
  let top = pocPos;
  let bottom = pocPos;
  const target = total * (pct / 100);
  while (sum < target && (top > 0 || bottom < rows.length - 1)) {
    const up = top > 0 ? rows[top - 1].bidUsd + rows[top - 1].askUsd : -1;
    const down = bottom < rows.length - 1 ? rows[bottom + 1].bidUsd + rows[bottom + 1].askUsd : -1;
    if (up >= down && top > 0) {
      top -= 1;
      sum += up;
    } else if (bottom < rows.length - 1) {
      bottom += 1;
      sum += down;
    } else {
      break;
    }
  }
  return { high: rows[top].price, low: rows[bottom].price };
}

function markImbalances(
  rows: FootprintRow[],
  opts: Pick<FootprintAggregateOptions, 'imbalanceRatio' | 'minVolumeUsd' | 'imbalanceMode'>,
): { buy: number; sell: number } {
  let buy = 0;
  let sell = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const above = i > 0 ? rows[i - 1] : null;
    const below = i < rows.length - 1 ? rows[i + 1] : null;
    let isBuy = false;
    let isSell = false;
    if (opts.imbalanceMode === 'diagonal') {
      isBuy = Boolean(
        below
        && row.askUsd >= opts.imbalanceRatio * below.bidUsd
        && row.askUsd >= opts.minVolumeUsd,
      );
      isSell = Boolean(
        above
        && row.bidUsd >= opts.imbalanceRatio * above.askUsd
        && row.bidUsd >= opts.minVolumeUsd,
      );
    } else {
      isBuy = row.askUsd >= opts.imbalanceRatio * row.bidUsd && row.askUsd >= opts.minVolumeUsd;
      isSell = row.bidUsd >= opts.imbalanceRatio * row.askUsd && row.bidUsd >= opts.minVolumeUsd;
    }
    if (isBuy && isSell) {
      const buyRatio = row.bidUsd > 0 ? row.askUsd / row.bidUsd : Number.POSITIVE_INFINITY;
      const sellRatio = row.askUsd > 0 ? row.bidUsd / row.askUsd : Number.POSITIVE_INFINITY;
      row.buyImbalance = buyRatio >= sellRatio;
      row.sellImbalance = !row.buyImbalance;
    } else {
      row.buyImbalance = isBuy;
      row.sellImbalance = isSell;
    }
    if (row.buyImbalance) buy += 1;
    if (row.sellImbalance) sell += 1;
  }
  return { buy, sell };
}

function forceImbalanceCounts(rows: FootprintRow[], buy: number, sell: number): { buy: number; sell: number } {
  for (const row of rows) {
    row.buyImbalance = false;
    row.sellImbalance = false;
  }
  const byAsk = [...rows].sort((a, b) => b.askUsd - a.askUsd);
  const byBid = [...rows].sort((a, b) => b.bidUsd - a.bidUsd);
  const buyRows = new Set(byAsk.slice(0, Math.min(buy, byAsk.length)));
  for (const row of buyRows) row.buyImbalance = true;
  let remaining = sell;
  for (const row of byBid) {
    if (remaining <= 0) break;
    if (row.buyImbalance) continue;
    row.sellImbalance = true;
    remaining -= 1;
  }
  for (const row of byBid) {
    if (remaining <= 0) break;
    if (row.sellImbalance) continue;
    row.sellImbalance = true;
    remaining -= 1;
  }
  return {
    buy: rows.filter((row) => row.buyImbalance).length,
    sell: rows.filter((row) => row.sellImbalance).length,
  };
}

interface BuildCandleOptions {
  intervalMs: number;
  rowSize: number;
  baseTick: number;
  imbalanceRatio: number;
  minVolumeUsd: number;
  imbalanceMode: FootprintAggregateOptions['imbalanceMode'];
  valueAreaPct: number;
}

/**
 * Build a display candle from prepared row totals. Used by the reference
 * composition, where the row values are known, and by the live aggregator once
 * it has summed real prints.
 */
export function buildCandleFromRows(
  input: PreparedFootprintCandle,
  opts: BuildCandleOptions,
): FootprintCandle {
  const rows: FootprintRow[] = [...input.rows]
    .filter((row) => Number.isFinite(row.price) && (row.bidUsd > 0 || row.askUsd > 0))
    .sort((a, b) => b.price - a.price)
    .map((row, index) => ({
      price: row.price,
      index,
      bidUsd: Math.max(0, row.bidUsd),
      askUsd: Math.max(0, row.askUsd),
      bidQty: row.bidQty ?? (row.price > 0 ? row.bidUsd / row.price : 0),
      askQty: row.askQty ?? (row.price > 0 ? row.askUsd / row.price : 0),
      buyImbalance: false,
      sellImbalance: false,
    }));

  const volumeUsd = rows.reduce((sum, row) => sum + row.bidUsd + row.askUsd, 0);
  const buyUsd = rows.reduce((sum, row) => sum + row.askUsd, 0);
  const sellUsd = rows.reduce((sum, row) => sum + row.bidUsd, 0);
  const buyQty = rows.reduce((sum, row) => sum + row.askQty, 0);
  const sellQty = rows.reduce((sum, row) => sum + row.bidQty, 0);
  const volumeQty = buyQty + sellQty;

  let pocPos = 0;
  let pocTotal = -1;
  for (let i = 0; i < rows.length; i++) {
    const total = rows[i].bidUsd + rows[i].askUsd;
    if (total > pocTotal) {
      pocTotal = total;
      pocPos = i;
    }
  }
  const pocRowPrice = input.pocPrice ?? rows[pocPos]?.price ?? input.c;
  const pocPrice = pocRowPrice;
  const pocRowIndex = rows.reduce((best, row, index) => (
    Math.abs(row.price - pocPrice) < Math.abs(rows[best].price - pocPrice) ? index : best
  ), 0);
  const pocRow = rows[pocRowIndex];

  const marked = input.buyImbalanceRows !== undefined || input.sellImbalanceRows !== undefined
    ? forceImbalanceCounts(rows, input.buyImbalanceRows ?? 0, input.sellImbalanceRows ?? 0)
    : markImbalances(rows, opts);

  let uaHigh: number | null = null;
  let uaLow: number | null = null;
  for (const row of rows) {
    if (row.bidUsd > 0 && row.askUsd > 0) {
      if (uaHigh === null) uaHigh = row.price + opts.rowSize / 2;
      uaLow = row.price - opts.rowSize / 2;
    }
  }

  const area = valueArea(rows, pocRowIndex, opts.valueAreaPct);
  const notable = (input.notable ?? []).filter((marker) => (
    rows.some((row) => Math.abs(row.price - marker.price) < Math.max(1e-9, opts.rowSize / 2))
  ));

  return {
    t: input.t,
    o: input.o,
    h: input.h,
    l: input.l,
    c: input.c,
    volumeUsd,
    volumeQty,
    buyUsd,
    sellUsd,
    buyQty,
    sellQty,
    deltaUsd: buyUsd - sellUsd,
    deltaQty: buyQty - sellQty,
    cumDeltaUsd: 0,
    cumDeltaQty: 0,
    rows,
    pocPrice,
    pocRowPrice: pocRow?.price ?? pocPrice,
    uaHigh,
    uaLow,
    valueAreaHigh: area.high,
    valueAreaLow: area.low,
    buyPct: volumeUsd > 0 ? (buyUsd / volumeUsd) * 100 : 0,
    sellPct: volumeUsd > 0 ? (sellUsd / volumeUsd) * 100 : 0,
    imbalanceBuy: marked.buy,
    imbalanceSell: marked.sell,
    notable,
    forming: !input.closed,
    hidden: false,
    forceQuiet: input.quietOverride,
  };
}

function rowCenter(key: number, rowSize: number): number {
  return key * rowSize + rowSize / 2;
}

export function aggregateTrades(
  trades: readonly TerminalTrade[],
  opts: FootprintAggregateOptions,
): FootprintDataset {
  const step = intervalMs(opts.interval);
  const empty: FootprintDataset = {
    symbol: opts.symbol,
    interval: opts.interval,
    rowSize: opts.rowSize,
    baseTick: opts.baseTick,
    candles: [],
    from: null,
    to: null,
    lastPrice: 0,
    levels: [],
    annotations: [],
    liqEvents: [],
    recordStart: null,
    source: opts.source ?? 'live',
    mock: (opts.source ?? 'live') === 'mock',
  };
  if (!trades.length || !(opts.rowSize > 0) || !(opts.baseTick > 0)) return empty;

  const sorted = [...trades].sort((a, b) => a.t - b.t || a.id - b.id);
  const buckets = new Map<number, CandleAccum>();

  for (const trade of sorted) {
    if (!Number.isFinite(trade.price) || !(trade.price > 0) || !(trade.usd > 0)) continue;
    const bucket = Math.floor(trade.t / step) * step;
    let candle = buckets.get(bucket);
    if (!candle) {
      candle = {
        t: bucket,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volumeUsd: 0,
        volumeQty: 0,
        buyUsd: 0,
        sellUsd: 0,
        buyQty: 0,
        sellQty: 0,
        rows: new Map(),
      };
      buckets.set(bucket, candle);
    }
    candle.high = Math.max(candle.high, trade.price);
    candle.low = Math.min(candle.low, trade.price);
    candle.close = trade.price;
    candle.volumeUsd += trade.usd;
    candle.volumeQty += trade.qty;
    if (trade.side === 'buy') {
      candle.buyUsd += trade.usd;
      candle.buyQty += trade.qty;
    } else {
      candle.sellUsd += trade.usd;
      candle.sellQty += trade.qty;
    }

    const key = Math.floor(trade.price / opts.rowSize);
    let row = candle.rows.get(key);
    if (!row) {
      row = { bidUsd: 0, askUsd: 0, bidQty: 0, askQty: 0 };
      candle.rows.set(key, row);
    }
    if (trade.side === 'buy') {
      row.askUsd += trade.usd;
      row.askQty += trade.qty;
    } else {
      row.bidUsd += trade.usd;
      row.bidQty += trade.qty;
    }
  }

  const candles: FootprintCandle[] = [];
  let cumUsd = 0;
  let cumQty = 0;
  const now = opts.now ?? Date.now();

  for (const bucket of [...buckets.values()].sort((a, b) => a.t - b.t)) {
    const meta = opts.meta?.get(bucket.t);
    const prepared: PreparedFootprintRow[] = [...bucket.rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([key, row]) => ({
        price: rowCenter(key, opts.rowSize),
        bidUsd: row.bidUsd,
        askUsd: row.askUsd,
        bidQty: row.bidQty,
        askQty: row.askQty,
      }));
    const built = buildCandleFromRows({
      t: bucket.t,
      o: meta?.open ?? bucket.open,
      h: meta?.high ?? bucket.high,
      l: meta?.low ?? bucket.low,
      c: meta?.close ?? bucket.close,
      closed: !(meta?.forming ?? bucket.t + step > now),
      rows: prepared,
      notable: meta?.notable,
      quietOverride: meta?.forceQuiet,
      pocPrice: meta?.pocPrice,
    }, {
      intervalMs: step,
      rowSize: opts.rowSize,
      baseTick: opts.baseTick,
      imbalanceRatio: opts.imbalanceRatio,
      minVolumeUsd: opts.minVolumeUsd,
      imbalanceMode: opts.imbalanceMode,
      valueAreaPct: opts.valueAreaPct,
    });

    if (meta?.uaHigh !== undefined) built.uaHigh = meta.uaHigh;
    if (meta?.uaLow !== undefined) built.uaLow = meta.uaLow;
    if (meta?.valueAreaHigh !== undefined) built.valueAreaHigh = meta.valueAreaHigh;
    if (meta?.valueAreaLow !== undefined) built.valueAreaLow = meta.valueAreaLow;
    built.forming = meta?.forming ?? !(bucket.t + step <= now);
    built.hidden = meta?.hidden === true;
    built.readingOverride = meta?.readingOverride;
    built.forceQuiet = meta?.forceQuiet;
    cumUsd = meta?.cumDeltaUsd ?? cumUsd + built.deltaUsd;
    cumQty = meta?.cumDeltaQty ?? cumQty + built.deltaQty;
    built.cumDeltaUsd = cumUsd;
    built.cumDeltaQty = cumQty;
    candles.push(built);
  }

  const last = candles[candles.length - 1];
  return {
    ...empty,
    candles,
    from: candles.length ? candles[0].t : null,
    to: candles.length ? candles[candles.length - 1].t + step : null,
    lastPrice: last?.c ?? sorted[sorted.length - 1]?.price ?? 0,
  };
}

export function metaFromCandles(
  candles: readonly FootprintCandle[],
): Map<number, FootprintCandleMeta> {
  const out = new Map<number, FootprintCandleMeta>();
  for (const candle of candles) {
    out.set(candle.t, {
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
      uaHigh: candle.uaHigh,
      uaLow: candle.uaLow,
      valueAreaHigh: candle.valueAreaHigh,
      valueAreaLow: candle.valueAreaLow,
      cumDeltaUsd: candle.cumDeltaUsd,
      cumDeltaQty: candle.cumDeltaQty,
      forming: candle.forming,
      hidden: candle.hidden,
      pocPrice: candle.pocPrice,
      notable: candle.notable,
      readingOverride: candle.readingOverride,
      forceQuiet: candle.forceQuiet,
    });
  }
  return out;
}
