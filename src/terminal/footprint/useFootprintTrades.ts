import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TerminalInterval, TerminalTrade } from '../../../shared/types';
import { INTERVAL_MS } from '../math';

const PAGE_LIMIT = 1_000;
const INITIAL_CANDLES = 12;
const OLDER_CANDLES = 50;
const CAP = 220_000;
const BATCH = 10;
const RETRIES = 2;

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

function aggUrl(symbol: string, params: Record<string, string | number>): string {
  const url = new URL('https://data-api.binance.vision/api/v3/aggTrades');
  url.searchParams.set('symbol', symbol.toUpperCase());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  let last: Error | null = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const response = await fetch(url, { signal });
    if (response.ok) return response.json();
    last = new Error(`Binance aggTrades returned HTTP ${response.status}`);
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => { setTimeout(resolve, 300 * (attempt + 1)); });
  }
  throw last ?? new Error('Binance aggTrades request failed');
}

/**
 * Read every aggregate trade in a closed time window. Binance exposes
 * aggregate-trade ids in sequence, so one probe at each edge gives the exact
 * id range; the pages then come back in parallel batches instead of one long
 * sequential walk. The newest `maxTrades` prints win when a window is wider
 * than the cap, which keeps the candles nearest the chart full.
 */
async function fetchWindow(
  symbol: string,
  from: number,
  to: number,
  maxTrades: number,
  signal: AbortSignal,
): Promise<TerminalTrade[]> {
  if (!(to >= from) || maxTrades <= 0) return [];
  const firstPayload = await fetchJson(aggUrl(symbol, {
    startTime: Math.max(1, Math.floor(from)),
    endTime: Math.max(1, Math.floor(to)),
    limit: 1,
  }), signal);
  const lastPayload = await fetchJson(aggUrl(symbol, {
    endTime: Math.max(1, Math.floor(to)),
    limit: 1,
  }), signal);
  if (!Array.isArray(firstPayload) || !firstPayload.length) return [];
  if (!Array.isArray(lastPayload) || !lastPayload.length) return [];
  const first = parseTrade(firstPayload[0] as AggTrade);
  const last = parseTrade(lastPayload[0] as AggTrade);
  if (!first || !last || last.id < first.id) return [];

  const endId = last.id;
  const startId = Math.max(first.id, endId - maxTrades + 1);
  const byId = new Map<number, TerminalTrade>();
  const chunks: number[] = [];
  for (let id = startId; id <= endId; id += PAGE_LIMIT) chunks.push(id);

  for (let offset = 0; offset < chunks.length; offset += BATCH) {
    const batch = chunks.slice(offset, offset + BATCH);
    const pages = await Promise.all(batch.map((fromId) => (
      fetchJson(aggUrl(symbol, { fromId, limit: PAGE_LIMIT }), signal)
    )));
    for (const payload of pages) {
      if (!Array.isArray(payload)) continue;
      for (const item of payload) {
        const trade = parseTrade(item as AggTrade);
        if (!trade || trade.t < from || trade.t > to) continue;
        byId.set(trade.id, trade);
      }
    }
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
  const [loading, setLoading] = useState(enabled);
  const [loaded, setLoaded] = useState(!enabled);
  const [olderLoading, setOlderLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const oldestRef = useRef<number | null>(null);

  useEffect(() => {
    setBackfill([]);
    setLoading(enabled);
    setLoaded(!enabled);
    setOlderLoading(false);
    setError(null);
    setFrom(null);
    oldestRef.current = null;
    if (!enabled || typeof fetch === 'undefined') return;
    const controller = new AbortController();
    const step = INTERVAL_MS[interval];
    const now = Date.now();
    const currentStart = Math.floor(now / step) * step;
    const target = currentStart - (INITIAL_CANDLES - 1) * step;
    setLoading(true);
    void fetchWindow(symbol, target, now, CAP, controller.signal)
      .then((trades) => {
        if (controller.signal.aborted) return;
        setBackfill(trades);
        const oldest = trades.length ? trades[0].t : null;
        oldestRef.current = oldest;
        setFrom(oldest);
        setLoaded(true);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError((err as Error).message);
        setLoaded(true);
        setLoading(false);
      });
    return () => controller.abort();
  }, [symbol, interval, enabled]);

  const loadOlder = useCallback(() => {
    if (!enabled || olderLoading) return;
    const oldest = oldestRef.current;
    if (oldest === null) return;
    const remaining = CAP - backfill.length;
    if (remaining <= 0) return;
    const step = INTERVAL_MS[interval];
    const target = oldest - OLDER_CANDLES * step;
    const controller = new AbortController();
    setOlderLoading(true);
    setError(null);
    void fetchWindow(symbol, target, oldest - 1, remaining, controller.signal)
      .then((trades) => {
        if (!trades.length) {
          setOlderLoading(false);
          return;
        }
        setBackfill((previous) => {
          const byId = new Map<number, TerminalTrade>();
          for (const trade of previous) byId.set(trade.id, trade);
          for (const trade of trades) byId.set(trade.id, trade);
          const merged = [...byId.values()].sort((a, b) => a.t - b.t || a.id - b.id);
          const capped = merged.length > CAP ? merged.slice(merged.length - CAP) : merged;
          oldestRef.current = capped.length ? capped[0].t : null;
          setFrom(oldestRef.current);
          return capped;
        });
        setOlderLoading(false);
      })
      .catch((err: unknown) => {
        setError((err as Error).message);
        setOlderLoading(false);
      });
  }, [backfill.length, enabled, interval, olderLoading, symbol]);

  const trades = useMemo(() => {
    if (enabled && !loaded) return [];
    if (!backfill.length) return [...liveTrades].sort((a, b) => a.t - b.t || a.id - b.id).slice(-CAP);
    const newest = backfill[backfill.length - 1];
    const tail = liveTrades.filter((trade) => trade.id > newest.id);
    if (!tail.length) return backfill;
    const merged = backfill.concat(tail);
    return merged.length > CAP ? merged.slice(merged.length - CAP) : merged;
  }, [backfill, enabled, liveTrades, loaded]);

  return {
    trades,
    loading,
    olderLoading,
    error,
    from,
    canLoadOlder: enabled && from !== null && backfill.length < CAP,
    loadOlder,
  };
}
