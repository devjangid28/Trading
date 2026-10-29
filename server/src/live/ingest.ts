import { LIVE, NETWORK } from '../config.js';
import type { Candle, LiqEvent } from '../../../shared/types';
import { LiquidationTracker, MarketState } from './marketState.js';
import type { ConnectionStatus } from '../../../shared/types';
import { fetchKlines } from '../data/binance.js';
import { bans, hostOf } from '../lib/http.js';
import { ConnectAttemptLimiter, reconnectDelayMs } from '../lib/banGuard.js';

/**
 * Phase 1 â€” live ingest.
 *
 * Two sockets:
 *   spot    wss://data-stream.binance.vision/stream       @kline_5m + !miniTicker@arr
 *   futures wss://fstream.binance.com/market/stream      @markPrice + !forceOrder@arr
 *
 * The futures URL MUST carry the /market route. An un-routed URL connects
 * fine and silently delivers nothing â€” Phase 0 probed this explicitly.
 */

export type Handler = {
  onKlineClose?: (symbol: string, closed: boolean) => void;
  onTick?: (symbol: string, price: number, changePct: number, exchangeTs?: number) => void;
  onLiq?: (e: LiqEvent) => void;
  onStatus?: (s: ConnectionStatus) => void;
};

interface WsState {
  status: ConnectionStatus;
  ws: WebSocket | null;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  proactiveTimer: ReturnType<typeof setTimeout> | null;
  openedAt: number;
}

function newStatus(name: string): ConnectionStatus {
  return {
    name,
    state: 'connecting',
    since: Date.now(),
    lastMessageAt: null,
    messages: 0,
    reconnects: 0,
    backfilledCandles: 0,
    lastError: null,
  };
}

export class LiveIngest {
  readonly market = new MarketState(['5m']);
  readonly liquidations = new LiquidationTracker();
  private spot: WsState;
  private futures: WsState;
  /**
   * Binance caps connection attempts per IP. A reconnect loop that ignores its
   * own failures burns through that allowance in seconds, which turns a
   * transient outage into an IP ban.
   */
  readonly attemptLimiter = new ConnectAttemptLimiter();
  /** One-shot timer that retries the sockets when a ban window closes. */
  private banTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 24h open per symbol, cached from `!miniTicker@arr`.
   *
   * aggTrade carries a price but no 24h change, and miniTicker arrives only
   * once a second, so without this cache every real-time tick between two
   * miniTicker pushes would have to report a 0% day. The cache is what lets the
   * fast path and the slow path publish the same, correct, 24h figure.
   */
  private readonly dayOpen = new Map<string, number>();


  constructor(
    private symbols: string[],
    private handler: Handler = {},
  ) {
    this.spot = { status: newStatus('binance-spot'), ws: null, attempt: 0, reconnectTimer: null, proactiveTimer: null, openedAt: 0 };
    this.futures = { status: newStatus('binance-futures'), ws: null, attempt: 0, reconnectTimer: null, proactiveTimer: null, openedAt: 0 };
  }

  setHandlers(h: Handler): void {
    this.handler = h;
  }

  setSymbols(symbols: string[]): void {
    this.symbols = symbols;
    this.connectSpot();
    this.connectFutures();
  }

  /**
   * How many symbols fit on one spot connection.
   *
   * Each symbol now costs TWO streams (kline + aggTrade) plus the single
   * all-market miniTicker. Slicing the symbol list by MAX_STREAMS_PER_CONN —
   * which is what the boot sequence and the hourly refresh both used to do —
   * silently over-subscribed the socket by 2x at the cap, and Binance drops
   * the overflow, so the tail of the universe went quiet with no error.
   */
  static maxSymbolsPerConnection(): number {
    return Math.floor((LIVE.MAX_STREAMS_PER_CONN - 1) / 2);
  }


  statuses(): Record<string, ConnectionStatus> {
    return { [this.spot.status.name]: this.spot.status, [this.futures.status.name]: this.futures.status };
  }

  private emit(state: WsState): void {
    this.handler.onStatus?.({ ...state.status });
  }

  /**
   * Gate a socket open on the ban registry and the attempt cap.
   *
   * Returns false without touching the network, which is the requirement: a
   * banned host gets no reconnect attempt at all, and a host that is merely
   * over the connection allowance backs off rather than retrying into a ban.
   */
  private mayConnect(host: string): boolean {
    if (bans.isBanned(host)) {
      const ms = bans.remainingMs(host);
      console.warn(
        `[live] not connecting to ${host}: banned for another ${Math.ceil(ms / 1000)}s`,
      );
      return false;
    }
    if (!this.attemptLimiter.tryAcquire()) {
      console.warn(
        `[live] connection-attempt cap reached (${this.attemptLimiter.remaining()} left in window); ` +
        'backing off rather than retrying into a ban',
      );
      return false;
    }
    return true;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reconnect with exponential backoff + jitter
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private scheduleReconnect(state: WsState, open: () => void): void {
    if (state.reconnectTimer) return;
    state.status.state = 'reconnecting';
    state.status.reconnects++;
    this.emit(state);

    const delay = reconnectDelayMs({
      attempt: state.attempt,
      baseMs: LIVE.RECONNECT_BASE_MS,
      maxMs: LIVE.RECONNECT_MAX_MS,
      jitter: LIVE.RECONNECT_JITTER,
      random: Math.random,
    });
    state.attempt++;

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      open();
    }, delay);
  }

  /**
   * Backfill the candles that were missed while the socket was down. Without
   * this, a reconnect would silently leave a hole in the 5m series.
   */
  private async backfill(state: WsState): Promise<void> {
    let added = 0;
    // Staggered in small batches rather than 56 simultaneous requests. A
    // reconnect is exactly when the app is most likely to already be near a
    // weight limit, and an unthrottled 56-request burst is how a reconnect
    // turns into a ban.
    const BATCH = 4;
    const BATCH_DELAY_MS = 250;
    for (let i = 0; i < this.symbols.length; i += BATCH) {
      const batch = this.symbols.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (symbol) => {
          const candles = await fetchKlines(symbol, '5m', 300, 0, 'essential');
          return this.market.backfill(symbol, '5m', candles);
        }),
      );
      for (const r of results) {
        // One symbol failing must not stop the rest of the backfill.
        if (r.status === 'fulfilled') added += r.value;
      }
      if (bans.isBanned(hostOf(NETWORK.BINANCE_SPOT_WS))) {
        console.warn('[live] backfill paused: binance host is banned');
        break;
      }
      if (i + BATCH < this.symbols.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    state.status.backfilledCandles += added;
    this.emit(state);
  }

  private armProactive(state: WsState, close: () => void): void {
    if (state.proactiveTimer) clearTimeout(state.proactiveTimer);
    // Binance drops connections at 24h. Reconnect ourselves at 23h.
    state.proactiveTimer = setTimeout(close, LIVE.PROACTIVE_RECONNECT_MS);
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Spot socket
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private connectSpot(): void {
    if (!this.symbols.length) return;
    this.openSpot();
  }

  private openSpot(): void {
    const state = this.spot;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.mayConnect(hostOf(NETWORK.BINANCE_SPOT_WS))) return;

    // TWO price streams, because one of them is not a price stream at all:
    //
    //   <symbol>@aggTrade  real-time. Aggregated per taker order, pushed the
    //                      moment a fill happens. This is the actual price feed.
    //   !miniTicker@arr    1000ms. A once-per-second snapshot that carries the
    //                      24h open (`o`), the 24h change and the 24h volume.
    //
    // The bug this fixes: the socket originally carried ONLY !miniTicker@arr,
    // so the newest price the server could ever hold was up to a second old.
    // Nothing downstream — the coalescer, the SSE flush, the React store — can
    // invent freshness the upstream never sent. See config LIVE.TICK_PUSH_MS.
    const streams = [
      ...this.symbols.map((s) => `${s.toLowerCase()}@kline_5m`),
      ...this.symbols.map((s) => `${s.toLowerCase()}@aggTrade`),
      '!miniTicker@arr',
    ];
    if (streams.length > LIVE.MAX_STREAMS_PER_CONN) {
      console.warn(`[live] ${streams.length} streams exceeds ${LIVE.MAX_STREAMS_PER_CONN}; spot feed will miss symbols`);
    }
    const url = `${NETWORK.BINANCE_SPOT_WS}?streams=${streams.join('/')}`;

    const ws = new WebSocket(url);
    state.ws = ws;
    state.status.state = 'connecting';
    state.openedAt = Date.now();
    state.status.since = Date.now();
    this.emit(state);

    ws.onopen = () => {
      state.attempt = 0;
      state.status.state = 'open';
      state.status.since = Date.now();
      state.status.lastError = null;
      this.emit(state);
      // Only backfill on (re)connect after the first, to fill any gap.
      if (state.status.reconnects > 0) void this.backfill(state);
      this.armProactive(state, () => {
        try { ws.close(); } catch { /* already closing */ }
      });
    };

    ws.onmessage = (ev) => {
      state.status.messages++;
      state.status.lastMessageAt = Date.now();
      if (typeof ev.data !== 'string') return;
      let msg: { stream?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }

      if (msg.stream === '!miniTicker@arr') {
        const arr = msg.data as unknown as {
          s: string; c: string; o: string; q: string; E?: number;
        }[];
        if (!Array.isArray(arr)) return;
        for (const t of arr) {
          const price = Number(t.c);
          if (!Number.isFinite(price)) continue;
          this.market.ingestTick(t.s, price);
          const s = this.market.ensure(t.s);
          // The 24h open is the denominator for every change figure we show, and
          // miniTicker is the only stream that carries it. Cache it so a
          // real-time aggTrade tick arriving 200ms later can compute a correct
          // 24h change instead of reporting 0.
          const open = Number(t.o);
          if (Number.isFinite(open) && open > 0) this.dayOpen.set(t.s, open);
          s.changePct = open > 0 ? ((price - open) / open) * 100 : 0;
          s.quoteVolume24h = Number(t.q) || 0;
          // changePct is forwarded so the client can render a tick without
          // re-deriving it. It was hard-coded to 0 on the wire before, which
          // made every streamed tick look like a flat day.
          //
          // `E` is the exchange's own event time. Forwarding it is what lets the
          // latency check measure exchange -> browser rather than server ->
          // browser, which would hide a slow upstream.
          this.handler.onTick?.(t.s, price, s.changePct, Number(t.E) || 0);
        }
        return;
      }

      // Real-time price. Binance pushes this the moment a fill happens, so this
      // is the path that removes the one-second gap.
      if (msg.stream?.endsWith('@aggTrade')) {
        const d = msg.data as { s?: string; p?: string; E?: number } | undefined;
        if (!d?.s || !d.p) return;
        const price = Number(d.p);
        if (!Number.isFinite(price) || price <= 0) return;
        const symbol = d.s;
        this.market.ingestTick(symbol, price);
        const s = this.market.ensure(symbol);
        const open = this.dayOpen.get(symbol) ?? 0;
        const changePct = open > 0 ? ((price - open) / open) * 100 : s.changePct;
        s.changePct = changePct;
        this.handler.onTick?.(symbol, price, changePct, Number(d.E) || 0);
        return;
      }


      const k = msg.data?.k as
        | {
            t: number; o: string; h: string; l: string; c: string; v: string;
            q: string; n: number; V: string; x: boolean;
          }
        | undefined;
      if (!k || !msg.stream) return;
      const symbol = msg.stream.split('@')[0].toUpperCase();

      const candle: Candle = {
        t: Number(k.t),
        o: Number(k.o),
        h: Number(k.h),
        l: Number(k.l),
        c: Number(k.c),
        v: Number(k.v),
        qv: Number(k.q),
        takerBuyBase: Number(k.V),
        trades: Number(k.n),
        closed: Boolean(k.x),
      };

      const closed = this.market.ingestKline(symbol, '5m', candle);
      this.market.ingestTick(symbol, Number(k.c));
      this.handler.onKlineClose?.(symbol, closed);
    };

    ws.onerror = () => {
      state.status.lastError = 'socket error';
      state.status.state = 'reconnecting';
      this.emit(state);
    };

    ws.onclose = (ev) => {
      state.ws = null;
      if (state.proactiveTimer) clearTimeout(state.proactiveTimer);
      if (ev.code !== 1000) state.status.lastError = `closed ${ev.code}`;
      this.scheduleReconnect(state, () => this.openSpot());
    };
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Futures socket
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private connectFutures(): void {
    this.openFutures();
  }

  private openFutures(): void {
    const state = this.futures;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.mayConnect(hostOf(NETWORK.BINANCE_FUT_WS))) return;

    const url = `${NETWORK.BINANCE_FUT_WS}?streams=btcusdt@markPrice@1s/ethusdt@markPrice@1s/!forceOrder@arr`;

    const ws = new WebSocket(url);
    state.ws = ws;
    state.status.state = 'connecting';
    state.openedAt = Date.now();
    state.status.since = Date.now();
    this.emit(state);

    ws.onopen = () => {
      state.attempt = 0;
      state.status.state = 'open';
      state.status.since = Date.now();
      state.status.lastError = null;
      this.emit(state);
      this.armProactive(state, () => {
        try { ws.close(); } catch { /* already closing */ }
      });
    };

    ws.onmessage = (ev) => {
      state.status.messages++;
      state.status.lastMessageAt = Date.now();
      if (typeof ev.data !== 'string') return;
      let msg: { stream?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(ev.data) as typeof msg;
      } catch {
        return;
      }

      if (msg.stream === '!forceOrder@arr') {
        const o = msg.data?.o as
          | { s: string; S: string; p: string; q: string; T: number }
          | undefined;
        if (!o) return;
        const price = Number(o.p);
        const qty = Number(o.q);
        const event: LiqEvent = {
          symbol: o.s,
          // Binance uses SELL for a forced long liquidation.
          side: o.S === 'SELL' ? 'SELL' : 'BUY',
          price,
          qty,
          usd: price * qty,
          t: Number(o.T) || Date.now(),
        };
        this.liquidations.add(event);
        this.handler.onLiq?.(event);
        return;
      }

      const d = msg.data as
        | { e: string; s: string; p: string; i: string; r: string; T: number }
        | undefined;
      if (d?.e === 'markPriceUpdate') {
        this.market.ingestMark(d.s, Number(d.p), Number(d.i));
      }
    };

    ws.onerror = () => {
      state.status.lastError = 'socket error';
      state.status.state = 'reconnecting';
      this.emit(state);
    };

    ws.onclose = (ev) => {
      state.ws = null;
      if (state.proactiveTimer) clearTimeout(state.proactiveTimer);
      if (ev.code !== 1000) state.status.lastError = `closed ${ev.code}`;
      this.scheduleReconnect(state, () => this.openFutures());
    };
  }

  start(): void {
    // A banned host at startup must not be contacted, but it must also not be
    // forgotten: schedule one re-check for when the window closes.
    this.connectSpot();
    this.connectFutures();
    this.armBanWatchdog();
  }

  /**
   * Re-attempt the sockets once a ban expires.
   *
   * The registry is the single source of truth, so the watchdog only has to ask
   * it when the next check is due. One timer, not one per socket.
   */
  private armBanWatchdog(): void {
    if (this.banTimer) clearTimeout(this.banTimer);
    const now = Date.now();
    const waits = [hostOf(NETWORK.BINANCE_SPOT_WS), hostOf(NETWORK.BINANCE_FUT_WS)]
      .filter((h) => bans.isBanned(h))
      .map((h) => bans.remainingMs(h, now));
    if (!waits.length) return;

    const delay = Math.max(1000, Math.min(...waits) + 1000);
    console.log(
      `[live] sockets suppressed; will retry in ${Math.ceil(delay / 1000)}s ` +
      '(ban in effect — no connection attempts will be made before then)',
    );
    this.banTimer = setTimeout(() => {
      this.banTimer = null;
      this.connectSpot();
      this.connectFutures();
      this.armBanWatchdog();
    }, delay);
    // Do not hold the event loop open purely to watch a ban.
    this.banTimer.unref?.();
  }

  /** Connection-attempt accounting for /api/health. */
  attemptStats() {
    return {
      remainingInWindow: this.attemptLimiter.remaining(),
      suppressed: this.attemptLimiter.suppressedCount(),
      cap: LIVE.WS_CONNECT_LIMIT,
      windowMs: LIVE.WS_CONNECT_WINDOW_MS,
    };
  }

  stop(): void {
    if (this.banTimer) clearTimeout(this.banTimer);
    this.banTimer = null;
    for (const s of [this.spot, this.futures]) {
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      if (s.proactiveTimer) clearTimeout(s.proactiveTimer);
      try { s.ws?.close(); } catch { /* already closed */ }
      s.status.state = 'closed';
      this.emit(s);
    }
  }

  /** Simulated socket kill â€” used by the acceptance test for reconnect. */
  killForTest(): void {
    try { this.spot.ws?.close(); } catch { /* ignore */ }
    try { this.futures.ws?.close(); } catch { /* ignore */ }
  }
}

