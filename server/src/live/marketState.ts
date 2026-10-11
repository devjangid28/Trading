import type { Candle, LiqEvent, Tf } from '../../../shared/types';
import { LIVE, REFRESH } from '../config.js';

/**
 * In-memory market state fed by WebSockets, with REST as the backfill path.
 *
 * Rules that this structure exists to enforce:
 *  - the engine reads **closed** candles only, so a setup never repaints
 *  - reconnects backfill the gap over REST, so no candle is ever missing
 *  - liquidation totals are a **lower bound** because forceOrder@arr samples
 *    at most one liquidation per symbol per 1000ms
 */

const TF_MS: Record<Tf, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

export interface SymbolState {
  symbol: string;
  candles: Map<Tf, Candle[]>;
  /** The currently-forming candle per timeframe, kept separately. */
  forming: Map<Tf, Candle>;
  lastPrice: number;
  markPrice: number | null;
  indexPrice: number | null;
  changePct: number;
  change1hPct: number;
  change4hPct: number;
  quoteVolume24h: number;
  lastTickAt: number;
  lastKlineAt: number;
}

export class MarketState {
  readonly symbols = new Map<string, SymbolState>();

  constructor(readonly tfs: Tf[] = ['5m']) {}

  ensure(symbol: string): SymbolState {
    let s = this.symbols.get(symbol);
    if (!s) {
      s = {
        symbol,
        candles: new Map(this.tfs.map((tf) => [tf, [] as Candle[]])),
        forming: new Map(),
        lastPrice: 0,
        markPrice: null,
        indexPrice: null,
        changePct: 0,
        change1hPct: 0,
        change4hPct: 0,
        quoteVolume24h: 0,
        lastTickAt: 0,
        lastKlineAt: 0,
      };
      this.symbols.set(symbol, s);
    }
    return s;
  }

  closedCandles(symbol: string, tf: Tf): Candle[] {
    return this.symbols.get(symbol)?.candles.get(tf) ?? [];
  }

  /**
   * Ingest a kline from the stream. Returns true when a candle just **closed**,
   * which is the trigger for recomputing a setup.
   */
  ingestKline(symbol: string, tf: Tf, k: Candle): boolean {
    const s = this.ensure(symbol);
    const arr = s.candles.get(tf) ?? [];
    const bucket = TF_MS[tf];
    const openTime = Math.floor(k.t / bucket) * bucket;
    const candle: Candle = { ...k, t: openTime, closed: k.t + bucket <= Date.now() };

    if (candle.closed) {
      const last = arr[arr.length - 1];
      if (last && last.t === candle.t) {
        arr[arr.length - 1] = candle;
        return false;
      }
      if (last && candle.t < last.t) return false; // out-of-order, ignore
      arr.push(candle);
      if (arr.length > LIVE.RING_BUFFER_CANDLES) arr.shift();
      s.forming.delete(tf);
      s.lastKlineAt = Date.now();
      return true; // a candle just closed
    }

    s.forming.set(tf, candle);
    return false;
  }

  /** Merge a REST backfill. Returns the number of candles actually added. */
  backfill(symbol: string, tf: Tf, candles: Candle[]): number {
    const s = this.ensure(symbol);
    const arr = s.candles.get(tf) ?? [];
    const bucket = TF_MS[tf];
    const byTime = new Map(arr.map((c) => [c.t, c]));

    let added = 0;
    for (const raw of candles) {
      const t = Math.floor(raw.t / bucket) * bucket;
      if (raw.t + bucket > Date.now()) continue; // skip the forming candle
      if (!byTime.has(t)) added++;
      byTime.set(t, { ...raw, t, closed: true });
    }

    const merged = [...byTime.values()].sort((a, b) => a.t - b.t).slice(-LIVE.RING_BUFFER_CANDLES);
    s.candles.set(tf, merged);
    return added;
  }

  ingestTick(symbol: string, price: number, ts = Date.now()): void {
    const s = this.ensure(symbol);
    s.lastPrice = price;
    s.lastTickAt = ts;
  }

  ingestMark(symbol: string, mark: number, index: number | null): void {
    const s = this.ensure(symbol);
    s.markPrice = mark;
    if (index !== null) s.indexPrice = index;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Liquidation aggregation
// ─────────────────────────────────────────────────────────────────────────────

export interface LiqTally {
  m5: number;
  h1: number;
  d1: number;
  longM5: number;
  shortM5: number;
  longH1: number;
  shortH1: number;
  history: { t: number; m5: number }[];
}

const MIN = 60_000;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * Liquidation buckets. Note `isSample` is always true for the WS source:
 * `!forceOrder@arr` pushes only the latest liquidation per symbol per 1000ms,
 * so these are lower bounds and the UI must say so.
 */
export class LiquidationTracker {
  private readonly events: LiqEvent[] = [];
  private readonly m5Buckets = new Map<number, number>();

  constructor(private readonly maxAgeMs = 2 * DAY) {}

  add(e: LiqEvent): void {
    this.events.push(e);
    const bucket = Math.floor(e.t / (5 * MIN)) * (5 * MIN);
    this.m5Buckets.set(bucket, (this.m5Buckets.get(bucket) ?? 0) + e.usd);
    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
    for (const t of this.m5Buckets.keys()) {
      if (t < cutoff) this.m5Buckets.delete(t);
    }
  }

  private sumSince(symbol: string | null, since: number, side?: 'BUY' | 'SELL'): number {
    let total = 0;
    for (const e of this.events) {
      if (e.t < since) continue;
      if (symbol && e.symbol !== symbol) continue;
      if (side && e.side !== side) continue;
      total += e.usd;
    }
    return total;
  }

  /**
   * Cascade when current 5m liquidation USD is >= 3 sigma of the trailing 20
   * windows. Binance defines a SELL force order as a long being liquidated.
   */
  tally(symbol: string, sigma: number, window: number): {
    m5: number; h1: number; d1: number;
    longM5: number; shortM5: number; longH1: number; shortH1: number;
    cascade: boolean; isSample: true;
  } {
    const now = Date.now();
    const m5Since = now - 5 * MIN;
    const h1Since = now - HOUR;
    const d1Since = now - DAY;

    const currentBucket = Math.floor(now / (5 * MIN)) * (5 * MIN);
    const m5 = this.sumSince(symbol, m5Since);

    const trailing = [...this.m5Buckets.entries()]
      .filter(([t]) => t !== currentBucket)
      .sort((a, b) => a[0] - b[0])
      .slice(-window)
      .map(([, v]) => v);
    const mean = trailing.length ? trailing.reduce((a, b) => a + b, 0) / trailing.length : 0;
    const sd = trailing.length > 1
      ? Math.sqrt(trailing.reduce((a, b) => a + (b - mean) ** 2, 0) / trailing.length)
      : 0;
    const cascade = sd > 0 && m5 >= mean + sigma * sd;

    return {
      m5,
      h1: this.sumSince(symbol, h1Since),
      d1: this.sumSince(symbol, d1Since),
      // A SELL force order is a long being liquidated.
      longM5: this.sumSince(symbol, m5Since, 'SELL'),
      shortM5: this.sumSince(symbol, m5Since, 'BUY'),
      longH1: this.sumSince(symbol, h1Since, 'SELL'),
      shortH1: this.sumSince(symbol, h1Since, 'BUY'),
      cascade,
      isSample: true,
    };
  }

  recent(symbol: string | null, limit: number): LiqEvent[] {
    const out: LiqEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.events[i];
      if (!symbol || e.symbol === symbol) out.push(e);
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cumulative volume delta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cumulative volume delta, in USD notional.
 *
 * Two things this must get right, both of which were live bugs:
 *
 *  1. Binance puts taker-buy volume at index 9 in BASE units and index 10 in
 *     QUOTE units. Reading only index 9 gave a raw base-asset number that was
 *     meaningless across coins.
 *  2. Even in base units the number is not comparable — a slope of -88,000 on
 *     a $0.10 token says nothing about a $83,000 one. Quote notional
 *     (takerBuyQuote minus the sell side of total quote volume) is the
 *     standard CVD definition and is comparable and economically meaningful.
 */
export function cvd(candles: Candle[]): {
  /** Cumulative delta in USD over the window. */
  value: number;
  /** Least-squares slope in USD per candle. */
  slope: number;
  takerRatio: number;
  windowQuoteVolume: number;
} {
  if (!candles.length) {
    return { value: 0, slope: 0, takerRatio: 0.5, windowQuoteVolume: 0 };
  }
  const slice = candles.slice(-CVD_WINDOW);

  let delta = 0;
  let buy = 0;
  let sell = 0;
  let quoteVol = 0;
  const series: number[] = [];

  for (const c of slice) {
    // Fall back to base volume x price when quote fields are absent, so a
    // candle sourced from a venue that omits them still contributes.
    const total = c.qv ?? c.v * c.c;
    const b = c.takerBuyQuote ?? (c.takerBuyBase !== undefined ? c.takerBuyBase * c.c : total * 0.5);
    const s = total - b;
    buy += b;
    sell += s;
    delta += b - s;
    quoteVol += total;
    series.push(delta);
  }

  const n = series.length;
  const meanX = (n - 1) / 2;
  const meanY = series.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += (i - meanX) * (series[i] - meanY);
    varX += (i - meanX) ** 2;
  }

  return {
    value: delta,
    slope: varX > 0 ? cov / varX : 0,
    takerRatio: buy + sell > 0 ? buy / (buy + sell) : 0.5,
    windowQuoteVolume: quoteVol,
  };
}

export const CVD_WINDOW = 24;

/** Price made a new high over the window without CVD following it. */
export function cvdDivergence(candles: Candle[]): boolean {
  if (candles.length < CVD_WINDOW) return false;
  const slice = candles.slice(-CVD_WINDOW);
  const first = slice.slice(0, CVD_WINDOW / 2);
  const second = slice.slice(CVD_WINDOW / 2);
  const highFirst = Math.max(...first.map((c) => c.h));
  const highSecond = Math.max(...second.map((c) => c.h));
  if (highSecond <= highFirst) return false;
  // A new price high with a non-positive cumulative delta is unconfirmed.
  return cvd(slice).value <= 0;
}

export { TF_MS, REFRESH };
