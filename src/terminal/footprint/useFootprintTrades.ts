import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalInterval, TerminalTrade } from '../../../shared/types';
import { INTERVAL_MS, mergeTrades } from '../math';

const PAGE_LIMIT = 1_000;
const INITIAL_CANDLES = 12;
const OLDER_CANDLES = 50;
const INITIAL_PAGES = 48;
const OLDER_PAGES = 80;
const CAP = 220_000;

interface AggTrade {
  a?: number;
  p?: string;
  q?: string;
  T?: number;
  m?: boolean;
}

function parseTrade(raw: AggTrade): TerminalTrade | null {
  if (typeof raw.a !== 'number' || typeof raw.p !== 'string' || typeof raw.q !== 'string' || typeof raw.T !== 'number') {
    return null;
  }
  const price = Number(raw.p);
  const qty = Number(raw.q);
  if (!(price > 0) || !(qty > 0)) return null;
  return {
    id: raw.a,
    t: raw.T,
    price,
    qty,
    usd: price * qty,
    side: raw.m === true ? 'sell' : 'buy',
    count: 1,
  };
}

async function fetchPages(
  symbol: string,
  endTime: number,
  targetStart: number,
  maxPages: number,
  signal: AbortSignal,
): Promise<TerminalTrade[]> {
  const byId = new Map<number, TerminalTrade>();
  let end = endTime;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL('https://data-api.binance.vision/api/v3/aggTrades');
    url.searchParams.set('symbol', symbol.toUpperCase());
    url.searchParams.set('endTime', String(Math.max(1, Math.floor(end))));
    url.searchParams.set('limit', String(PAGE_LIMIT));
    const response = await fetch(url.toString(), { signal });
    if (!response.ok) throw new Error(`Binance aggTrades returned HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload) || payload.length === 0) break;
    let oldest = end;
    for (const item of payload) {
      const trade = parseTrade(item as AggTrade);
      if (!trade) continue;
      byId.set(trade.id, trade);
      if (trade.t < oldest) oldest = trade.t;
    }
    if (oldest >= end) break;
    end = oldest - 1;
    if (oldest <= targetStart) break;
  }
  return [...byId.values()].sort((a, b) => a.t - b.t || a.id - b.id);
}

export interface FootprintTradeFeed {
  trades: TerminalTrade[];
  loading: boolean;
  olderLoading: boolean;
  error: string | null;
  from: number | null;
  canLoadOlder: boolean;
  loadOlder: () => void;
}

export function useFootprintTrades(
  symbol: string,
  interval: TerminalInterval,
  enabled: boolean,
  liveTrades: readonly TerminalTrade[],
): FootprintTradeFeed {
  const [backfill, setBackfill] = useState<TerminalTrade[]>([]);
  const [loading, setLoading] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const oldestRef = useRef<number | null>(null);

  useEffect(() => {
    setBackfill([]);
    setLoading(false);
    setOlderLoading(false);
    setError(null);
    setFrom(null);
    oldestRef.current = null;
    if (!enabled || typeof fetch === 'undefined') return;
    const controller = new AbortController();
    const step = INTERVAL_MS[interval];
    const target = Date.now() - INITIAL_CANDLES * step;
    setLoading(true);
    void fetchPages(symbol, Date.now(), target, INITIAL_PAGES, controller.signal)
      .then((trades) => {
        if (controller.signal.aborted) return;
        setBackfill(trades);
        const oldest = trades.length ? trades[0].t : null;
        oldestRef.current = oldest;
        setFrom(oldest);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError((err as Error).message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [symbol, interval, enabled]);

  const loadOlder = useCallback(() => {
    if (!enabled || olderLoading) return;
    const oldest = oldestRef.current;
    if (oldest === null) return;
    const step = INTERVAL_MS[interval];
    const target = oldest - OLDER_CANDLES * step;
    const controller = new AbortController();
    setOlderLoading(true);
    setError(null);
    void fetchPages(symbol, oldest - 1, target, OLDER_PAGES, controller.signal)
      .then((trades) => {
        if (!trades.length) {
          setOlderLoading(false);
          return;
        }
        setBackfill((prev) => {
          const merged = mergeTrades(prev, trades, CAP);
          oldestRef.current = merged.length ? merged[0].t : null;
          setFrom(oldestRef.current);
          return merged;
        });
        setOlderLoading(false);
      })
      .catch((err: unknown) => {
        setError((err as Error).message);
        setOlderLoading(false);
      });
  }, [enabled, interval, olderLoading, symbol]);

  const trades = useMemo(
    () => mergeTrades(backfill, [...liveTrades], CAP),
    [backfill, liveTrades],
  );

  return {
    trades,
    loading,
    olderLoading,
    error,
    from,
    canLoadOlder: enabled && from !== null,
    loadOlder,
  };
}
