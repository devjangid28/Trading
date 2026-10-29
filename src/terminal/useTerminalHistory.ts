import { useEffect, useState } from 'react';
import type { TerminalHistory, TerminalSpan } from '../../shared/types';
import { api } from '../lib/api';

export interface TerminalHistoryState {
  history: TerminalHistory | null;
  loading: boolean;
  error: string | null;
}

export function useTerminalHistory(
  symbol: string,
  span: TerminalSpan,
  enabled = true,
): TerminalHistoryState {
  const [history, setHistory] = useState<TerminalHistory | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setHistory(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    let first = true;
    let inflight = false;
    setHistory(null);
    setLoading(true);
    setError(null);

    const load = () => {
      if (inflight) return;
      inflight = true;
      api.terminalHistory(symbol, span, 900, controller.signal)
        .then((next) => {
          if (cancelled) return;
          setHistory(next.symbol === symbol ? next : null);
          if (first) setLoading(false);
          setError(null);
          first = false;
        })
        .catch((err: Error) => {
          if (cancelled || err.name === 'AbortError') return;
          setError(err.message);
          if (first) setLoading(false);
          first = false;
        })
        .finally(() => {
          inflight = false;
        });
    };
    load();
    const refresh = setInterval(load, 30_000);

    return () => {
      cancelled = true;
      clearInterval(refresh);
      controller.abort();
    };
  }, [symbol, span, enabled]);

  return { history, loading, error };
}
