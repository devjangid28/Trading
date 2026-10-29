import type { Candle, LiqEvent } from '../../../shared/types';
import type { ConnectionStatus } from '../../../shared/types';
import { LiquidationTracker, MarketState } from '../live/marketState.js';
import type { Handler } from '../live/ingest.js';
import { ingestHandlers } from '../live/streamHub.js';

/**
 * Fix 3 â€” the mock live feed.
 *
 * Implements the same surface the server uses from `LiveIngest`, so index.ts
 * picks one or the other with a ternary and nothing else in the app changes.
 *
 * It replays:
 *   - `!miniTicker@arr` ticks, drifting price slightly each second
 *   - `kline_5m` closes every MOCK_CANDLE_CLOSE_MS, which is what makes the
 *     board genuinely re-rank in mock mode rather than sitting still
 *   - `!forceOrder@arr` liquidations, because the liquidation tape is a panel
 *
 * The candles come from the captured fixtures, so the chart shows a real
 * recorded market rather than invented numbers.
 */

/**
 * Mock tick cadence.
 *
 * [TUNED] Matched to `LIVE.TICK_PUSH_MS`, which is what production flushes at.
 * It was 1000ms because that is what the real socket's `!miniTicker@arr`
 * published, and mock mode reuses that number everywhere. Now that the real
 * socket carries `@aggTrade` (real-time) and flushes every 200ms, a mock that
 * ticked every 1000ms would exercise a path production never takes, and a bug
 * that only appears at the production cadence would pass QA.
 */
export const MOCK_TICK_MS = 200;
export const MOCK_CANDLE_CLOSE_MS = 15_000;

export interface MockLiveOptions {
  symbols: string[];
  handler?: Handler;
  candlesBySymbol: Map<string, Candle[]>;
  /** Base price per symbol, from the tickers fixture. */
  priceBySymbol: Map<string, number>;
  changeBySymbol: Map<string, number>;
  /** Overridable so a test does not have to wait 15 real seconds. */
  tickMs?: number;
  candleCloseMs?: number;
}

export class MockLive {
  readonly market = new MarketState(['5m']);
  readonly liquidations = new LiquidationTracker();
  private timers: ReturnType<typeof setInterval>[] = [];
  private prices = new Map<string, number>();
  private tickCount = 0;
  private candleCursor = new Map<string, number>();
  private attempts = 0;
  private reconnects = 0;

  constructor(private opts: MockLiveOptions) {
    for (const [s, p] of opts.priceBySymbol) this.prices.set(s, p);
  }

  private status(name: string): ConnectionStatus {
    return {
      name,
      state: 'open',
      since: Date.now(),
      lastMessageAt: Date.now(),
      messages: this.tickCount,
      reconnects: this.reconnects,
      backfilledCandles: 0,
      lastError: null,
    };
  }

  statuses(): Record<string, ConnectionStatus> {
    return {
      'binance-spot (MOCK)': this.status('binance-spot (MOCK)'),
      'binance-futures (MOCK)': this.status('binance-futures (MOCK)'),
    };
  }

  attemptStats() {
    return { remainingInWindow: 300, suppressed: 0, cap: 300, windowMs: 300_000, mock: true };
  }

  start(): void {
    const handler = this.opts.handler ?? ingestHandlers();

    // Seed each symbol's ring buffer with its recorded candles, so the very
    // first render has history rather than a single forming bar.
    for (const [symbol, candles] of this.opts.candlesBySymbol) {
      for (const c of candles) {
        this.market.ingestKline(symbol, '5m', { ...c, closed: true });
      }
      this.candleCursor.set(symbol, 0);
    }

this.timers.push(setInterval(() => this.tickOnce(handler), this.opts.tickMs ?? MOCK_TICK_MS));
    this.timers.push(setInterval(() => this.closeACandle(handler), this.opts.candleCloseMs ?? MOCK_CANDLE_CLOSE_MS));
  }

  /**
   * A tick round: every tracked symbol moves a little.
   *
   * The drift is deterministic (a hash of the symbol and tick count) so a
   * repeated mock run produces the same board. Non-determinism in a fixture
   * mode makes UI bugs impossible to reproduce.
   */
  private tickOnce(handler: Handler): void {
    this.tickCount++;
    for (const [symbol, base] of this.prices) {
      const seed = hash(symbol) + this.tickCount * 37;
      const drift = Math.sin(seed / 11) * 0.0012;
      const price = base * (1 + drift);
      this.prices.set(symbol, price);
      this.market.ingestTick(symbol, price);
      const change = this.opts.changeBySymbol.get(symbol) ?? 0;
      handler.onTick?.(symbol, price, change);
    }

    // A synthetic liquidation every few ticks, so the tape is not empty.
    if (this.tickCount % 7 === 0) {
      const symbols = [...this.prices.keys()];
      const s = symbols[hash(String(this.tickCount)) % symbols.length];
      const price = this.prices.get(s) ?? 0;
      const usd = 20_000 + (hash(`${s}${this.tickCount}`) % 400_000);
      const qty = price > 0 ? usd / price : 0;
      const ev: LiqEvent = {
        symbol: s,
        side: hash(`${s}x`) % 2 === 0 ? 'SELL' : 'BUY',
        price, qty, usd, t: Date.now(),
      };
      this.liquidations.add(ev);
      handler.onLiq?.(ev);
    }
  }

  /**
   * Close one candle per symbol, advancing through the recorded series.
   *
   * This is what the re-rank assertion depends on: `onKlineClose` is the same
   * callback the real socket invokes, so the debounce â†’ forceScan â†’ SSE path
   * runs for real.
   */
  private closeACandle(handler: Handler): void {
    for (const [symbol, candles] of this.opts.candlesBySymbol) {
      const i = (this.candleCursor.get(symbol) ?? 0) % candles.length;
      this.candleCursor.set(symbol, i + 1);
      const base = candles[i];
      const closed: Candle = { ...base, closed: true };
      this.market.ingestKline(symbol, '5m', closed);
      this.market.ingestTick(symbol, closed.c);
      handler.onKlineClose?.(symbol, true);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Universe refresh: mock mode replays whatever fixtures exist, so this is a
   *  documented no-op rather than a silent divergence from LiveIngest. */
  setSymbols(symbols: string[]): void {
    this.opts = { ...this.opts, symbols };
  }

  killForTest(): void {
    this.reconnects++;
  }

  /** Diagnostics for /api/health. */
  stats() {
    this.attempts++;
    return { ticks: this.tickCount, ticksServed: this.prices.size, mock: true };
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export type { Handler };
