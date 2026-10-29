import { useCallback, useEffect, useRef, useState } from 'react';
import type { Candle, TerminalInterval } from '../../shared/types';
import {
  HISTORY_LIMIT,
  fetchKlines,
  fetchTicker24h,
  subscribeMarketStream,
  type BinanceBookTicker,
  type BinanceTrade,
} from '../lib/binance';
import type { MarketState, StreamStatus, TickerSnapshot } from '../charts/types';

const EMPTY_TICKER: TickerSnapshot = {
  price: null,
  prevPrice: null,
  direction: 'flat',
  bid: null,
  ask: null,
  changePct: null,
  at: null,
};

function mergeBars(base: Candle[], extra: Candle[]): Candle[] {
  if (extra.length === 0) return base;
  const byTime = new Map<number, Candle>();
  for (const candle of base) byTime.set(candle.t, candle);
  for (const candle of extra) byTime.set(candle.t, candle);
  return [...byTime.values()].sort((a, b) => a.t - b.t).slice(-HISTORY_LIMIT);
}

function direction(previous: number | null, next: number): TickerSnapshot['direction'] {
  if (previous === null || previous === next) return 'flat';
  return next > previous ? 'up' : 'down';
}

export interface UseBinanceMarketResult extends MarketState {
  reload: () => void;
}

export function useBinanceMarket(symbol: string, interval: TerminalInterval): UseBinanceMarketResult {
  const [bars, setBars] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [ticker, setTicker] = useState<TickerSnapshot>(EMPTY_TICKER);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [lastRestAt, setLastRestAt] = useState<number | null>(null);
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const barsRef = useRef<Candle[]>([]);
  const tickerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTicker = useRef<Partial<TickerSnapshot> | null>(null);
  const lastTickerPaint = useRef(0);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  const paintTicker = useCallback(() => {
    tickerTimer.current = null;
    const patch = pendingTicker.current;
    pendingTicker.current = null;
    if (!patch) return;
    lastTickerPaint.current = Date.now();
    setTicker((previous) => {
      const price = patch.price ?? previous.price;
      const prevPrice = price !== null && price !== previous.price ? previous.price : previous.prevPrice;
      return {
        ...previous,
        ...patch,
        price,
        prevPrice,
        direction: price === null ? 'flat' : direction(previous.price, price),
      };
    });
  }, []);

  const queueTicker = useCallback((patch: Partial<TickerSnapshot>) => {
    pendingTicker.current = { ...(pendingTicker.current ?? {}), ...patch };
    const elapsed = Date.now() - lastTickerPaint.current;
    if (elapsed >= 100) {
      paintTicker();
      return;
    }
    if (!tickerTimer.current) {
      tickerTimer.current = setTimeout(paintTicker, 100 - elapsed);
    }
  }, [paintTicker]);

  useEffect(() => {
    setTicker(EMPTY_TICKER);
    setLatencyMs(null);
  }, [symbol, interval]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    barsRef.current = [];
    setBars([]);
    setLoading(true);
    setError(null);
    setStatus('connecting');

    Promise.all([
      fetchKlines(symbol, interval, HISTORY_LIMIT, controller.signal),
      fetchTicker24h(symbol, controller.signal).catch(() => null),
    ])
      .then(([history, ticker24h]) => {
        if (cancelled) return;
        barsRef.current = mergeBars(history, barsRef.current);
        setBars(barsRef.current);
        setLoading(false);
        setLastRestAt(Date.now());
        if (ticker24h) {
          const last = history[history.length - 1];
          setTicker((previous) => ({
            ...previous,
            price: last?.c ?? ticker24h.lastPrice,
            prevPrice: previous.price,
            direction: 'flat',
            bid: ticker24h.bidPrice,
            ask: ticker24h.askPrice,
            changePct: ticker24h.priceChangePercent,
            at: Date.now(),
          }));
        }
      })
      .catch((cause: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        setLoading(false);
        setStatus((current) => current === 'live' ? 'live' : 'error');
        setError(cause instanceof Error ? cause.message : 'Could not load Binance candles');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [symbol, interval, reloadKey]);

  useEffect(() => {
    const close = subscribeMarketStream(symbol, interval, {
      onKline: (candle) => {
        const next = mergeBars(barsRef.current, [candle]);
        barsRef.current = next;
        setBars(next);
        setLastMessageAt(Date.now());
        if (candle.closed) queueTicker({ price: candle.c, at: Date.now() });
      },
      onTrade: (trade: BinanceTrade) => {
        queueTicker({ price: trade.price, at: Date.now() });
      },
      onBookTicker: (book: BinanceBookTicker) => {
        queueTicker({ bid: book.bid, ask: book.ask, at: book.at });
      },
      onStatus: (next) => {
        setStatus(next);
        if (next === 'live') setError(null);
      },
      onLatency: (ms) => setLatencyMs(ms),
    });
    return close;
  }, [symbol, interval, queueTicker]);

  useEffect(() => () => {
    if (tickerTimer.current) clearTimeout(tickerTimer.current);
  }, []);

  return {
    symbol,
    interval,
    bars,
    loading,
    error,
    status,
    ticker,
    latencyMs,
    lastRestAt,
    lastMessageAt,
    reload,
  };
}
