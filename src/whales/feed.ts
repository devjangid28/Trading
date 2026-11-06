import type { Candle, TerminalInterval, TerminalTrade } from '../../shared/types';
import { fetchKlines, subscribeMarketStream } from '../lib/binance';
import { backfillTrades, BACKFILL_MINUTES, mergeTrades } from './backfill';
import { clampNumber, tapeStats } from './engine';
import { loadTrades, saveTrades } from './persist';
import type { WhaleFeedSnapshot, WhaleFeedState, WhaleTapeStats } from './types';
import { WHALE_AUTO_SIZE_CAP, WHALE_THRESHOLD_DEFAULT } from './tokens';

export interface WhaleFeedController {
  isMock: boolean;
  snapshot(): WhaleFeedSnapshot;
  destroy(): void;
  tickOnce(): void;
}

interface FeedCallbacks {
  onUpdate: () => void;
}

const MAX_BARS = 520;
const MAX_TRADES = 150_000;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function anchorPrice(symbol: string): number {
  const base = symbol.replace(/USDT$/i, '').toUpperCase();
  if (base === 'BTC') return 77_644.99;
  if (base === 'ETH') return 2_420;
  if (base === 'SOL') return 148;
  if (base === 'BNB') return 612;
  return 100;
}

const INTERVAL_MS: Record<TerminalInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

class LiveFeed implements WhaleFeedController {
  readonly isMock = false;
  private symbol: string;
  private interval: TerminalInterval;
  private cb: FeedCallbacks;
  private bars: Candle[] = [];
  private trades: TerminalTrade[] = [];
  private t0: number | null = null;
  private last: number | null = null;
  private bid: number | null = null;
  private ask: number | null = null;
  private state: WhaleFeedState = 'connecting';
  private latencyMs: number | null = null;
  private resyncs = 0;
  private reconnects = 0;
  private startedAt = Date.now();
  private messageTimes: number[] = [];
  private unsub: (() => void) | null = null;
  private destroyed = false;
  private pendingTrades: TerminalTrade[] = [];
  private backfilled = false;
  private persistDirty = false;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private stats: WhaleTapeStats | null = null;
  private keepUsd = WHALE_AUTO_SIZE_CAP;
  private fromTs: number | null = null;
  private backfillError: string | null = null;
  private lastStatsAt = 0;

  constructor(symbol: string, interval: TerminalInterval, cb: FeedCallbacks) {
    this.symbol = symbol;
    this.interval = interval;
    this.cb = cb;
  }

  start(): void {
    this.persistTimer = setInterval(() => {
      void this.persistNow();
    }, 5_000);
    void this.loadHistory();
    void this.loadPersisted();
    this.unsub = subscribeMarketStream(this.symbol, this.interval, {
      onKline: (candle) => this.handleKline(candle),
      onAggTrade: (trade) => this.handleAggTrade(trade),
      onBookTicker: (ticker) => {
        this.bid = ticker.bid;
        this.ask = ticker.ask;
        this.last = (this.bid + this.ask) / 2;
      },
      onStatus: (status) => {
        if (this.destroyed) return;
        this.state = status === 'live' ? 'live'
          : status === 'reconnecting' ? 'reconnecting'
            : status === 'offline' ? 'offline'
              : status === 'error' ? 'reconnecting'
                : 'connecting';
        if (status === 'reconnecting' || status === 'error') this.reconnects += 1;
        this.cb.onUpdate();
      },
      onLatency: (ms) => {
        this.latencyMs = ms;
      },
    }, { aggTrade: true });
  }

  private async loadPersisted(): Promise<void> {
    try {
      const persisted = await loadTrades(this.symbol);
      if (this.destroyed || !persisted.length) return;
      this.trades = persisted.sort((a, b) => a.id - b.id);
      this.t0 = Math.min(...this.trades.map((t) => t.t));
      this.cb.onUpdate();
    } catch {
      /* persistence is optional */
    }
    void this.runBackfill();
  }

  private async runBackfill(): Promise<void> {
    if (this.destroyed || this.backfilled) return;
    this.backfilled = true;
    try {
      const result = await backfillTrades(this.symbol, { minutes: BACKFILL_MINUTES });
      if (this.destroyed) return;
      if (result.trades.length) {
        this.trades = mergeTrades(this.trades, result.trades).slice(-MAX_TRADES);
        const earliest = Math.min(...this.trades.map((t) => t.t));
        this.t0 = this.t0 === null ? earliest : Math.min(this.t0, earliest);
        this.persistDirty = true;
      }
      this.refreshStats();
    } catch (reason) {
      /* backfill failed -> the live tape and persistence still hold */
      this.backfillError = String(reason);
    }
    this.cb.onUpdate();
  }

  private refreshStats(): void {
    const now = Date.now();
    if (now - this.lastStatsAt < 5_000 && this.stats) return;
    this.lastStatsAt = now;
    const s = tapeStats(this.trades);
    if (s.sampled > 0) {
      this.stats = s;
      this.keepUsd = Math.min(s.p99 || WHALE_AUTO_SIZE_CAP, WHALE_AUTO_SIZE_CAP);
      if (this.fromTs === null && this.trades.length) this.fromTs = this.trades[0].t;
    }
  }

  private async loadHistory(): Promise<void> {
    try {
      const bars = await fetchKlines(this.symbol, this.interval, 500);
      if (this.destroyed) return;
      this.bars = bars.slice(-MAX_BARS);
      this.state = 'live';
    } catch {
      if (!this.destroyed) this.state = 'offline';
    }
    this.cb.onUpdate();
  }

  private handleKline(candle: Candle): void {
    const lastBar = this.bars[this.bars.length - 1];
    if (lastBar && candle.t === lastBar.t) {
      this.bars[this.bars.length - 1] = candle;
    } else {
      if (lastBar && candle.t > lastBar.t) this.bars.push(candle);
      if (this.bars.length > MAX_BARS) this.bars = this.bars.slice(-MAX_BARS);
    }
    this.cb.onUpdate();
  }

  private handleAggTrade(trade: { id: number; t: number; price: number; qty: number; side: 'buy' | 'sell'; firstId: number; lastId: number }): void {
    const mapped: TerminalTrade = {
      id: trade.id,
      t: trade.t,
      price: trade.price,
      qty: trade.qty,
      usd: trade.price * trade.qty,
      side: trade.side,
      count: Math.max(1, trade.lastId - trade.firstId + 1),
    };
    this.t0 = this.t0 === null ? mapped.t : Math.min(this.t0, mapped.t);
    this.pendingTrades.push(mapped);
    if (this.pendingTrades.length > 200) this.flushTrades();
    this.last = mapped.price;
    this.persistDirty = true;
    this.cb.onUpdate();
  }

  private flushTrades(): void {
    if (!this.pendingTrades.length) return;
    this.trades = mergeTrades(this.trades, this.pendingTrades).slice(-MAX_TRADES);
    this.pendingTrades = [];
    const now = Date.now();
    this.messageTimes.push(now);
    if (this.messageTimes.length > 1_000) this.messageTimes = this.messageTimes.slice(-1_000);
  }

  private async persistNow(): Promise<void> {
    if (!this.persistDirty || this.destroyed) return;
    this.persistDirty = false;
    this.flushTrades();
    this.refreshStats();
    try {
      await saveTrades(this.symbol, this.trades);
    } catch {
      /* best-effort */
    }
  }

  snapshot(): WhaleFeedSnapshot {
    this.flushTrades();
    const now = Date.now();
    this.messageTimes = this.messageTimes.filter((t) => now - t <= 5_000);
    let tradeCountSinceT0 = 0;
    if (this.t0 !== null) {
      for (const t of this.trades) {
        if (t.t >= this.t0) tradeCountSinceT0 += t.count ?? 1;
      }
      for (const t of this.pendingTrades) {
        if (t.t >= this.t0) tradeCountSinceT0 += t.count ?? 1;
      }
    }
    return {
      bars: this.bars,
      trades: this.trades,
      t0: this.t0,
      last: this.last,
      bid: this.bid,
      ask: this.ask,
      state: this.state,
      latencyMs: this.latencyMs,
      resyncs: this.resyncs,
      reconnects: this.reconnects,
      tradeCountSinceT0,
      startedAt: this.startedAt,
      stats: this.stats,
      keepUsd: this.keepUsd,
      fromTs: this.fromTs,
      backfillError: this.backfillError,
    };
  }

  tickOnce(): void {
    /* live feed ticks from the socket */
  }

  destroy(): void {
    this.destroyed = true;
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    void this.persistNow();
    this.unsub?.();
    this.unsub = null;
  }
}

class MockFeed implements WhaleFeedController {
  readonly isMock = true;
  private cb: FeedCallbacks;
  private bars: Candle[] = [];
  private trades: TerminalTrade[] = [];
  private t0: number;
  private lastPrice: number;
  private startedAt = Date.now();
  private nextTradeId = 1;
  private stepMs: number;
  private random: () => number;
  private tickCount = 0;
  private stats: WhaleTapeStats | null = null;
  private keepUsd = WHALE_AUTO_SIZE_CAP;
  private fromTs: number | null = null;
  /** ONE price series shared by candles and trades (D1 data seam). */
  private path: number[];

  constructor(symbol: string, interval: TerminalInterval, cb: FeedCallbacks) {
    this.cb = cb;
    this.stepMs = INTERVAL_MS[interval];
    this.lastPrice = anchorPrice(symbol);
    this.random = rng(hash(`${symbol}:whales:${interval}`));
    this.t0 = Date.now() - 95 * 60_000;
    this.path = this.buildPath();
    this.buildBars();
    this.buildTrades();
    this.stats = tapeStats(this.trades);
    this.keepUsd = Math.min(this.stats.p99 || WHALE_AUTO_SIZE_CAP, WHALE_AUTO_SIZE_CAP);
    this.fromTs = this.t0;
  }

  private buildPath(): number[] {
    const n = 480;
    const base = this.lastPrice;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const target = base + 1_700 * (1 - u);
      out.push(clampTick(target + (this.random() - 0.5) * 120));
    }
    out[n - 1] = base;
    return out;
  }

  private priceAt(t: number): number {
    const span = 95 * 60_000;
    const u = clampNumber((t - this.t0) / span, 0, 0.9999);
    const idx = Math.floor(u * (this.path.length - 2));
    const p = this.path[idx];
    return clampTick(p + (this.random() - 0.5) * 180);
  }

  private buildBars(): void {
    const now = Date.now();
    const n = 480;
    const step = this.stepMs;
    const endAligned = Math.floor(now / step) * step;
    const bars: Candle[] = [];
    const random = this.random;
    for (let i = 0; i < n; i++) {
      const t = endAligned - (n - 1 - i) * step;
      const o = this.path[Math.max(0, i - 1)];
      const c = i === n - 1 ? this.lastPrice : this.path[i];
      const h = Math.max(o, c) + random() * 60;
      const l = Math.min(o, c) - random() * 60;
      const vBase = 12_000_000 + random() * 28_000_000;
      const qv = vBase;
      const takerBuyQuote = qv * (0.42 + random() * 0.16);
      bars.push({ t, o, h, l, c, v: qv / ((o + c) / 2), closed: t < endAligned, qv, takerBuyQuote });
    }
    const last = bars[bars.length - 1];
    if (last) last.c = this.lastPrice;
    this.bars = bars;
  }

  private buildTrades(): void {
    const now = this.t0 + 95 * 60_000;
    const trades: TerminalTrade[] = [];
    const push = (t: number, price: number, usd: number, side: 'buy' | 'sell', count = 1) => {
      trades.push({
        id: this.nextTradeId++,
        t,
        price,
        qty: usd / Math.max(1e-9, price),
        usd,
        side,
        count,
      });
    };
    const bigSellT = now - 10 * 60_000;
    const bigBuyT = now - 6 * 60_000;
    push(bigSellT, this.priceAt(bigSellT), 19_740_000, 'sell', 9);
    push(bigSellT + 900, this.priceAt(bigSellT + 900), 8_460_000, 'sell', 4);
    push(bigBuyT, this.priceAt(bigBuyT), 8_920_000, 'buy', 6);
    push(bigBuyT + 1_400, this.priceAt(bigBuyT + 1_400), 3_630_000, 'buy', 3);
    const whaleTrades = 34;
    for (let i = 0; i < whaleTrades; i++) {
      const u = (i + 0.4) / whaleTrades;
      const t = this.t0 + u * 95 * 60_000;
      const side = this.random() > 0.47 ? 'sell' : 'buy';
      const offset = (this.random() - 0.5) * 80;
      const usd = side === 'sell'
        ? 300_000 + this.random() * 3_000_000
        : 250_000 + this.random() * 2_500_000;
      push(t, this.priceAt(t) + offset, usd, side, 1 + Math.floor(this.random() * 5));
    }
    const smallStart = this.t0;
    const smallCount = 1_600;
    for (let i = 0; i < smallCount; i++) {
      const u = i / smallCount;
      const t = smallStart + u * 95 * 60_000;
      push(t, this.priceAt(t), 400 + this.random() * 60_000, this.random() > 0.5 ? 'buy' : 'sell', 1);
    }
    trades.sort((a, b) => a.t - b.t || a.id - b.id);
    this.trades = trades;
  }

  snapshot(): WhaleFeedSnapshot {
    return {
      bars: this.bars,
      trades: this.trades,
      t0: this.t0,
      last: this.lastPrice,
      bid: this.lastPrice - 0.01,
      ask: this.lastPrice + 0.01,
      state: 'mock',
      latencyMs: 0,
      resyncs: 0,
      reconnects: 0,
      tradeCountSinceT0: this.trades.reduce((n, t) => n + (t.t >= this.t0 ? (t.count ?? 1) : 0), 0),
      startedAt: this.startedAt,
      stats: this.stats,
      keepUsd: this.keepUsd,
      fromTs: this.fromTs,
      backfillError: null,
    };
  }

  tickOnce(): void {
    this.tickCount += 1;
    const now = Date.now();
    const step = this.stepMs;
    const lastBar = this.bars[this.bars.length - 1];
    const price = this.lastPrice + (this.random() - 0.5) * 18;
    this.lastPrice = clampTick(price);
    if (lastBar && now - lastBar.t < step) {
      const bar = lastBar;
      bar.h = Math.max(bar.h, this.lastPrice);
      bar.l = Math.min(bar.l, this.lastPrice);
      bar.c = this.lastPrice;
      bar.v += 0.02;
      bar.qv = (bar.qv ?? 0) + 8_000 + this.random() * 12_000;
      bar.takerBuyQuote = (bar.takerBuyQuote ?? 0) + (this.random() > 0.46 ? 6_000 + this.random() * 10_000 : 1_000);
    } else {
      this.bars.push({
        t: Math.floor(now / step) * step,
        o: this.lastPrice,
        h: this.lastPrice,
        l: this.lastPrice,
        c: this.lastPrice,
        v: 0.01,
        closed: false,
        qv: 0,
        takerBuyQuote: 0,
      });
      if (this.bars.length > MAX_BARS) this.bars = this.bars.slice(-MAX_BARS);
    }
    const usd = 500 + this.random() * 55_000;
    const side = this.random() > 0.5 ? 'buy' : 'sell';
    this.trades.push({
      id: this.nextTradeId++,
      t: now,
      price: this.lastPrice,
      qty: usd / this.lastPrice,
      usd,
      side,
      count: 1,
    });
    if (this.trades.length > MAX_TRADES) this.trades = this.trades.slice(-MAX_TRADES);
    if (this.tickCount % 300 === 0) {
      const whale = 300_000 + this.random() * 2_000_000;
      this.trades.push({
        id: this.nextTradeId++,
        t: now,
        price: this.lastPrice + (this.random() - 0.5) * 60,
        qty: whale / this.lastPrice,
        usd: whale,
        side: this.random() > 0.5 ? 'buy' : 'sell',
        count: 2 + Math.floor(this.random() * 4),
      });
    }
    this.cb.onUpdate();
  }

  destroy(): void {
    /* nothing to close */
  }
}

function clampTick(p: number): number {
  return Number(Math.max(1, Math.round(p * 100) / 100).toFixed(2));
}

export function createWhaleFeed(
  symbol: string,
  interval: TerminalInterval,
  mock: boolean,
  cb: FeedCallbacks,
): WhaleFeedController {
  const feed = mock ? new MockFeed(symbol, interval, cb) : new LiveFeed(symbol, interval, cb);
  if (!mock) (feed as LiveFeed).start();
  return feed;
}

export { INTERVAL_MS, WHALE_THRESHOLD_DEFAULT };
