import { useCallback, useEffect, useState } from 'react';
import type { Candle, TerminalInterval } from '../../shared/types';
import { api } from '../lib/api';

/** [TUNED] Closed candles do not change; the forming bar is corrected on this cadence. */
const REFRESH_MS = 12_000;

interface Loaded {
  symbol: string;
  interval: TerminalInterval;
  candles: Candle[];
  asOf: number;
}

export function useTerminalCandles(symbol: string, interval: TerminalInterval) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setLoaded(null);
    setLoading(true);
    setError(null);
  }, [symbol, interval]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const load = async () => {
      try {
        const next = await api.terminalCandles(symbol, interval, 320, controller.signal);
        if (cancelled) return;
        setLoaded({
          symbol,
          interval,
          candles: next.candles,
          asOf: next.asOf,
        });
        setError(null);
      } catch (err) {
        if (cancelled || (err as Error).name === 'AbortError') return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(load, REFRESH_MS);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [symbol, interval, nonce]);

  const current = loaded?.symbol === symbol && loaded.interval === interval ? loaded : null;
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return {
    candles: current?.candles ?? null,
    asOf: current?.asOf ?? null,
    loading,
    error,
    reload,
  };
}
