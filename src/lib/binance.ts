import type { Candle, TerminalInterval } from '../../shared/types';

export const BINANCE_REST_BASE = 'https://api.binance.com';
export const BINANCE_WS_BASE = 'wss://stream.binance.com:9443';
export const HISTORY_LIMIT = 1_500;
const REQUEST_LIMIT = 1_000;

export interface BinanceTicker24h {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  bidPrice: number;
  askPrice: number;
  quoteVolume: number;
  at: number;
}

export interface BinanceTrade {
  id: number;
  t: number;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
}

export interface BinanceBookTicker {
  bid: number;
  ask: number;
  at: number;
}

export interface StreamHandlers {
  onKline: (candle: Candle) => void;
  onTrade?: (trade: BinanceTrade) => void;
  onBookTicker?: (ticker: BinanceBookTicker) => void;
  onStatus: (status: 'connecting' | 'live' | 'reconnecting' | 'offline' | 'error') => void;
  onLatency?: (ms: number) => void;
}

export interface MarketDataSource {
  id: string;
  label: string;
  fetchKlines: (
    symbol: string,
    interval: TerminalInterval,
    limit?: number,
    signal?: AbortSignal,
  ) => Promise<Candle[]>;
  fetchTicker: (symbol: string, signal?: AbortSignal) => Promise<BinanceTicker24h | null>;
  subscribe: (symbol: string, interval: TerminalInterval, handlers: StreamHandlers) => () => void;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseRestKline(raw: unknown, now = Date.now()): Candle | null {
  if (!Array.isArray(raw) || raw.length < 11) return null;
  const t = finite(raw[0]);
  const o = finite(raw[1]);
  const h = finite(raw[2]);
  const l = finite(raw[3]);
  const c = finite(raw[4]);
  const v = finite(raw[5]);
  const closeTime = finite(raw[6]);
  const qv = finite(raw[7]);
  const trades = finite(raw[8]);
  const takerBuyBase = finite(raw[9]);
  const takerBuyQuote = finite(raw[10]);
  if (t === null || o === null || h === null || l === null || c === null || v === null) return null;
  return {
    t,
    o,
    h,
    l,
    c,
    v,
    closed: closeTime !== null && closeTime <= now,
    qv: qv ?? undefined,
    trades: trades ?? undefined,
    takerBuyBase: takerBuyBase ?? undefined,
    takerBuyQuote: takerBuyQuote ?? undefined,
  };
}

export function parseWsKline(raw: unknown): Candle | null {
  if (!raw || typeof raw !== 'object') return null;
  const k = raw as Record<string, unknown>;
  const t = finite(k.t);
  const o = finite(k.o);
  const h = finite(k.h);
  const l = finite(k.l);
  const c = finite(k.c);
  const v = finite(k.v);
  if (t === null || o === null || h === null || l === null || c === null || v === null) return null;
  return {
    t,
    o,
    h,
    l,
    c,
    v,
    closed: k.x === true,
    qv: finite(k.q) ?? undefined,
    trades: finite(k.n) ?? undefined,
    takerBuyBase: finite(k.V) ?? undefined,
    takerBuyQuote: finite(k.Q) ?? undefined,
  };
}

export function parseTrade(raw: unknown): BinanceTrade | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = finite(value.t);
  const t = finite(value.T);
  const price = finite(value.p);
  const qty = finite(value.q);
  if (id === null || t === null || price === null || qty === null) return null;
  return {
    id,
    t,
    price,
    qty,
    side: value.m === true ? 'sell' : 'buy',
  };
}

export function parseBookTicker(raw: unknown): BinanceBookTicker | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const bid = finite(value.b);
  const ask = finite(value.a);
  if (bid === null || ask === null) return null;
  return { bid, ask, at: Date.now() };
}

export function parseTicker24h(raw: unknown): BinanceTicker24h | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const lastPrice = finite(value.lastPrice);
  if (lastPrice === null) return null;
  return {
    symbol: typeof value.symbol === 'string' ? value.symbol : '',
    lastPrice,
    priceChangePercent: finite(value.priceChangePercent) ?? 0,
    bidPrice: finite(value.bidPrice) ?? lastPrice,
    askPrice: finite(value.askPrice) ?? lastPrice,
    quoteVolume: finite(value.quoteVolume) ?? 0,
    at: Date.now(),
  };
}

async function readJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { msg?: string; error?: string };
      detail = body.msg ?? body.error ?? detail;
    } catch {
      /* the body was not JSON */
    }
    throw new Error(detail);
  }
  return response.json();
}

function klineUrl(symbol: string, interval: TerminalInterval, limit: number, endTime?: number): string {
  const query = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(limit),
  });
  if (endTime !== undefined) query.set('endTime', String(endTime));
  return `${BINANCE_REST_BASE}/api/v3/klines?${query.toString()}`;
}

export async function fetchKlines(
  symbol: string,
  interval: TerminalInterval,
  limit = HISTORY_LIMIT,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const wanted = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(limit)));
  let remaining = wanted;
  let endTime: number | undefined;
  const chunks: Candle[][] = [];

  while (remaining > 0) {
    const take = Math.min(REQUEST_LIMIT, remaining);
    const body = await readJson(klineUrl(symbol, interval, take, endTime), signal);
    if (!Array.isArray(body)) throw new Error('Binance returned an unexpected kline payload');
    const parsed = body.map((row) => parseRestKline(row)).filter((row): row is Candle => row !== null);
    if (parsed.length === 0) break;
    chunks.unshift(parsed);
    remaining -= take;
    if (parsed.length < take || remaining <= 0) break;
    endTime = parsed[0].t - 1;
  }

  const byTime = new Map<number, Candle>();
  for (const chunk of chunks) for (const candle of chunk) byTime.set(candle.t, candle);
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-wanted);
}

export async function fetchTicker24h(
  symbol: string,
  signal?: AbortSignal,
): Promise<BinanceTicker24h | null> {
  const query = new URLSearchParams({ symbol: symbol.toUpperCase() });
  const body = await readJson(
    `${BINANCE_REST_BASE}/api/v3/ticker/24hr?${query.toString()}`,
    signal,
  );
  return parseTicker24h(body);
}

export function subscribeMarketStream(
  symbol: string,
  interval: TerminalInterval,
  handlers: StreamHandlers,
): () => void {
  const symbolLower = symbol.toLowerCase();
  const streams = [
    `${symbolLower}@kline_${interval}`,
    `${symbolLower}@trade`,
    `${symbolLower}@bookTicker`,
  ].join('/');
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = false;

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt += 1;
    clearRetry();
    retryTimer = setTimeout(connect, delay);
  };

  const connect = () => {
    if (stopped) return;
    clearRetry();
    handlers.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      socket = new WebSocket(`${BINANCE_WS_BASE}/stream?streams=${streams}`);
    } catch {
      handlers.onStatus('error');
      schedule();
      return;
    }

    socket.onopen = () => {
      attempt = 0;
      handlers.onStatus('live');
    };

    socket.onmessage = (event) => {
      let message: { stream?: string; data?: unknown };
      try {
        message = JSON.parse(String(event.data)) as { stream?: string; data?: unknown };
      } catch {
        return;
      }
      const stream = message.stream ?? '';
      const data = message.data;
      if (stream.includes('@kline_')) {
        const kline = (data as { k?: unknown } | null)?.k;
        const candle = parseWsKline(kline);
        if (candle) handlers.onKline(candle);
        const eventTime = finite((data as { E?: unknown } | null)?.E);
        if (eventTime !== null) handlers.onLatency?.(Math.max(0, Date.now() - eventTime));
        return;
      }
      if (stream.endsWith('@trade')) {
        const trade = parseTrade(data);
        if (trade) handlers.onTrade?.(trade);
        const eventTime = finite((data as { E?: unknown } | null)?.E);
        if (eventTime !== null) handlers.onLatency?.(Math.max(0, Date.now() - eventTime));
        return;
      }
      if (stream.endsWith('@bookTicker')) {
        const ticker = parseBookTicker(data);
        if (ticker) handlers.onBookTicker?.(ticker);
      }
    };

    socket.onerror = () => {
      handlers.onStatus('error');
    };

    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      handlers.onStatus(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
      schedule();
    };
  };

  const onOnline = () => {
    if (stopped) return;
    clearRetry();
    attempt = 0;
    connect();
  };

  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
  connect();

  return () => {
    stopped = true;
    clearRetry();
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    if (socket) {
      socket.onclose = null;
      socket.close();
      socket = null;
    }
  };
}

export function subscribeKline(
  symbol: string,
  interval: TerminalInterval,
  onKline: (candle: Candle) => void,
  onStatus?: StreamHandlers['onStatus'],
): () => void {
  return subscribeMarketStream(symbol, interval, {
    onKline,
    onStatus: onStatus ?? (() => {}),
  });
}

export function computeHeikinAshi(candles: Candle[]): Candle[] {
  if (candles.length === 0) return [];
  const output: Candle[] = [];
  let previousOpen = (candles[0].o + candles[0].c) / 2;
  let previousClose = (candles[0].o + candles[0].h + candles[0].l + candles[0].c) / 4;
  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];
    const close = (candle.o + candle.h + candle.l + candle.c) / 4;
    const open = i === 0 ? (candle.o + candle.c) / 2 : (previousOpen + previousClose) / 2;
    output.push({
      ...candle,
      o: open,
      h: Math.max(candle.h, open, close),
      l: Math.min(candle.l, open, close),
      c: close,
    });
    previousOpen = open;
    previousClose = close;
  }
  return output;
}

export const binanceDataSource: MarketDataSource = {
  id: 'binance-spot',
  label: 'Binance Spot',
  fetchKlines,
  fetchTicker: fetchTicker24h,
  subscribe: subscribeMarketStream,
};
