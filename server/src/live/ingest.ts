import { LIVE, NETWORK } from '../config.js';
import type { Candle, LiqEvent } from '../../../shared/types';
import { LiquidationTracker, MarketState } from './marketState.js';
import type { ConnectionStatus } from '../../../shared/types';
import { fetchKlines } from '../data/binance.js';

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

type Handler = {
  onKlineClose?: (symbol: string, closed: boolean) => void;
  onTick?: (symbol: string, price: number, changePct: number) => void;
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

  statuses(): Record<string, ConnectionStatus> {
    return { [this.spot.status.name]: this.spot.status, [this.futures.status.name]: this.futures.status };
  }

  private emit(state: WsState): void {
    this.handler.onStatus?.({ ...state.status });
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reconnect with exponential backoff + jitter
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private scheduleReconnect(state: WsState, open: () => void): void {
    if (state.reconnectTimer) return;
    state.status.state = 'reconnecting';
    state.status.reconnects++;
    this.emit(state);

    const base = Math.min(LIVE.RECONNECT_MAX_MS, LIVE.RECONNECT_BASE_MS * 2 ** state.attempt);
    const jitter = base * LIVE.RECONNECT_JITTER * (Math.random() * 2 - 1);
    const delay = Math.max(500, base + jitter);
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
    for (const symbol of this.symbols) {
      try {
        const candles = await fetchKlines(symbol, '5m', 300, 0);
        added += this.market.backfill(symbol, '5m', candles);
      } catch {
        // One symbol failing must not stop the rest of the backfill.
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

    const streams = [...this.symbols.map((s) => `${s.toLowerCase()}@kline_5m`), '!miniTicker@arr'];
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
          s: string; c: string; o: string; q: string;
        }[];
        if (!Array.isArray(arr)) return;
        for (const t of arr) {
          const price = Number(t.c);
          if (!Number.isFinite(price)) continue;
          this.market.ingestTick(t.s, price);
          const s = this.market.ensure(t.s);
          s.changePct = Number(t.o) > 0 ? ((price - Number(t.o)) / Number(t.o)) * 100 : 0;
          s.quoteVolume24h = Number(t.q) || 0;
          // changePct is forwarded so the client can render a tick without
          // re-deriving it. It was hard-coded to 0 on the wire before, which
          // made every streamed tick look like a flat day.
          this.handler.onTick?.(t.s, price, s.changePct);
        }
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
    this.connectSpot();
    this.connectFutures();
  }

  stop(): void {
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
