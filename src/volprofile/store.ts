import { useCallback, useEffect, useRef, useState } from 'react';
import type { Candle } from '../../shared/types';
import { api } from '../lib/api';
import { useLivePrice } from '../lib/priceStore';
import { useLive } from '../lib/liveContext';
import { buildMockCandles } from './mock';
import { readKlineCache, writeKlineCache } from './idb';
import { CACHE_TTL_MS, CANDLE_STEP_MS, MAX_CANDLES, REFRESH_MS } from './tokens';
import type { DataStatus } from './types';

export interface VolData {
  candles: Candle[];
  status: DataStatus;
  count: number;
  error: string | null;
  refresh: () => void;
}

function mergeByTime(existing: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(c.t, c);
  for (const c of incoming) map.set(c.t, c);
  return [...map.values()].sort((a, b) => a.t - b.t).slice(-MAX_CANDLES);
}

interface StoreShape {
  candles: Candle[];
  status: DataStatus;
  error: string | null;
  lastTickAt: number;
  fetching: boolean;
}

/**
 * Owns the 1m candle series for the volume-profile view:
 *
 *   1. IndexedDB cache is read first (instant paint, "from the cache").
 *   2. A paged REST load (12,000 candles) fills the gaps and is written back,
 *      flipping the footnote to "live".
 *   3. Live ticks from the app-wide stream extend the forming candle, so the
 *      screen is live without polling every second.
 *
 * The array lives in a ref, not React state: a 12k-candle copy per tick is
 * wasteful, and the render loop already reads refs. `version` only bumps when
 * the array/status/count actually change.
 */
export function useVolCandles(symbol: string, mock: boolean): VolData {
  const [, bumpState] = useState(0);
  const bump = useCallback(() => bumpState((v) => v + 1), []);
  const live = useLive();
  const livePrice = useLivePrice(symbol);
  const st = useRef<StoreShape>({
    candles: [],
    status: 'loading',
    error: null,
    lastTickAt: 0,
    fetching: false,
  }).current;

  useEffect(() => {
    let cancelled = false;
    st.candles = [];
    st.status = 'loading';
    st.error = null;
    bump();

    if (mock) {
      st.candles = buildMockCandles(symbol);
      st.status = 'live';
      bump();
      return () => { cancelled = true; };
    }

    const fetchLong = async () => {
      if (st.fetching) return;
      st.fetching = true;
      try {
        const res = await api.terminalKlines(symbol, '1m', MAX_CANDLES);
        if (cancelled) return;
        const merged = mergeByTime(st.candles, res.candles);
        st.candles = merged;
        st.status = 'live';
        st.error = null;
        void writeKlineCache(symbol, { storedAt: Date.now(), candles: merged });
        bump();
      } catch (err) {
        if (!cancelled && st.candles.length === 0) {
          st.error = err instanceof Error ? err.message : String(err);
          bump();
        }
      } finally {
        st.fetching = false;
      }
    };

    void (async () => {
      const cached = await readKlineCache(symbol);
      if (cancelled) return;
      if (cached && cached.candles.length > 0) {
        st.candles = cached.candles.slice(-MAX_CANDLES);
        st.status = Date.now() - cached.storedAt < CACHE_TTL_MS ? 'cache' : 'loading';
        bump();
        if (Date.now() - cached.storedAt >= CACHE_TTL_MS) void fetchLong();
      } else {
        void fetchLong();
      }
    })();

    const interval = setInterval(() => void fetchLong(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, mock]);

  useEffect(() => {
    if (mock || live.state !== 'open') return;
    const px = livePrice ? livePrice.price : null;
    if (px === null || !Number.isFinite(px) || px <= 0) return;
    const now = Date.now();
    if (now - st.lastTickAt < 250) return;
    st.lastTickAt = now;
    const candles = st.candles;
    if (!candles.length) return;
    const bucket = Math.floor(now / CANDLE_STEP_MS) * CANDLE_STEP_MS;
    const last = candles[candles.length - 1];
    let next: Candle[];
    if (bucket > last.t) {
      next = [
        ...candles,
        { t: bucket, o: px, h: px, l: px, c: px, v: 0, qv: 0, closed: false },
      ];
    } else if (bucket === last.t) {
      if (last.closed === false && last.c === px && last.h >= px && last.l <= px) {
        if (st.status !== 'live') {
          st.status = 'live';
          bump();
        }
        return;
      }
      next = [
        ...candles.slice(0, -1),
        { ...last, h: Math.max(last.h, px), l: Math.min(last.l, px), c: px, closed: false },
      ];
    } else {
      return;
    }
    st.candles = next.slice(-MAX_CANDLES);
    if (st.status !== 'live') st.status = 'live';
    bump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrice, live.state, mock]);

  const refresh = useCallback(() => {
    if (mock) return;
    const fetchLong = async () => {
      if (st.fetching) return;
      st.fetching = true;
      try {
        const res = await api.terminalKlines(symbol, '1m', MAX_CANDLES);
        const merged = mergeByTime(st.candles, res.candles);
        st.candles = merged;
        st.status = 'live';
        st.error = null;
        void writeKlineCache(symbol, { storedAt: Date.now(), candles: merged });
        bump();
      } catch (err) {
        if (st.candles.length === 0) st.error = err instanceof Error ? err.message : String(err);
      } finally {
        st.fetching = false;
      }
    };
    void fetchLong();
  }, [symbol, mock, bump, st]);

  return {
    candles: st.candles,
    status: st.status,
    count: st.candles.length,
    error: st.error,
    refresh,
  };
}
