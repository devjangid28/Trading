import { useCallback, useEffect, useRef, useState } from 'react';
import type { NextBlackout } from '../components/BlackoutCountdown';

/** Shape returned by GET /api/calendar. */
export interface CalendarResult {
  updatedAt: number;
  events: import('../../shared/types').MarketEvent[];
  sources: import('../../shared/types').EventCalendar['sources'];
  nextBlackout: NextBlackout | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api${path}`, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  scan: (s?: AbortSignal) => get<import('../../shared/types').ScanResult>('/scan', s),
  news: (s?: AbortSignal) => get<import('../../shared/types').NewsFeed>('/news', s),
  macro: (s?: AbortSignal) => get<import('../../shared/types').MacroState>('/macro', s),
  calendar: (s?: AbortSignal) => get<CalendarResult>('/calendar', s),
  india: (s?: AbortSignal) => get<import('../../shared/types').IndianMarket>('/india', s),
  asset: <T = unknown>(id: string, s?: AbortSignal) => get<T>(`/asset/${id}`, s),
  attributionAll: (s?: AbortSignal) =>
    get<{ updatedAt: number; horizon: number; attributions: import('../../shared/types').Attribution[] }>(
      '/attribution',
      s,
    ),
  attributionOne: (id: string, horizon: number, s?: AbortSignal) =>
    get<{ attribution: import('../../shared/types').Attribution | null; beta: number }>(
      `/attribution/${id}?horizon=${horizon}`,
      s,
    ),
};

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Poll an endpoint on an interval while the tab is visible. Polling pauses on
 * hidden tabs so a backgrounded terminal does not keep hammering the upstream
 * APIs.
 */
export function usePolling<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
  enabled = true,
): AsyncState<T> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: enabled,
  });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    // Deferred until the caller needs it. This keeps heavy, tab-specific feeds
    // (India, attribution) off the initial page load so the first scan is not
    // competing with them for the network and the engine.
    if (!enabled) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }

    const ac = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const run = async () => {
      try {
        const data = await fetcherRef.current(ac.signal);
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setState((s) => ({
          data: s.data,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        }));
      }
    };

    const start = () => {
      if (timer) return;
      void run();
      timer = setInterval(run, intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        stop();
        start();
      }
    };

    setState((s) => ({ ...s, loading: true }));
    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      stop();
      ac.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, enabled, tick, ...deps]);

  return { ...state, refresh };
}

/** One-shot fetch, used for on-demand panels like the asset chart popup. */
export function useLazy<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>,
  enabled: boolean,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    error: null,
    loading: false,
  });

  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    let cancelled = false;
    setState({ data: null, error: null, loading: true });

    fetcher(ac.signal)
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((err) => {
        if (cancelled || ac.signal.aborted) return;
        setState({ data: null, error: err instanceof Error ? err.message : String(err), loading: false });
      });

    return () => {
      cancelled = true;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return state;
}
