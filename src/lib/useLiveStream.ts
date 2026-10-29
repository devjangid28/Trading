import { useCallback, useEffect, useRef, useState } from 'react';
import type { StreamMsg } from '../../shared/types';
import { LIVE } from './freshness';

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveStreamOptions<T> {
  select?: (msg: StreamMsg) => T | null;
  onSnapshot?: (msg: Extract<StreamMsg, { type: 'snapshot' }>) => void;
  onScan?: (msg: Extract<StreamMsg, { type: 'scan' }>) => void;
  onAgg?: (msg: Extract<StreamMsg, { type: 'agg' }>) => void;
  onTick?: (msg: Extract<StreamMsg, { type: 'tick' }>) => void;
  onLiq?: (msg: Extract<StreamMsg, { type: 'liq' }>) => void;
  onStatus?: (msg: Extract<StreamMsg, { type: 'status' }>) => void;
  onAlert?: (msg: Extract<StreamMsg, { type: 'alert' }>) => void;
  onData?: (at: number) => void;
  visibleSymbols?: string[] | null;
  enabled?: boolean;
}

export interface LiveStreamResult<T> {
  state: StreamState;
  attempts: number;
  error: string | null;
  value: T | null;
}

// ── Reconnect tuning ────────────────────────────────────────────────────────
// Was 1s base / 30s max. 30s max meant a tab backgrounded for 30s would sit
// stale for another 30s after coming back. Now 500ms base / 8s max — fast
// enough to recover in one or two cycles, slow enough not to hammer the server.
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

// If no DATA message (tick, scan, snapshot, agg — NOT heartbeat) arrives within
// this window the upstream Binance feed is silently dead even though the SSE
// pipe is open. Tear down and reconnect.
const DATA_WATCHDOG_MS = 12_000;

export function useLiveStream<T = StreamMsg>(
  opts: LiveStreamOptions<T> = {},
): LiveStreamResult<T> {
  const {
    onSnapshot, onScan, onTick, onLiq, onStatus, onAlert, onData, onAgg,
    select, visibleSymbols, enabled = true,
  } = opts;

  const [state, setState] = useState<StreamState>('connecting');
  const [value, setValue] = useState<T | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const cbs = useRef({ onSnapshot, onScan, onTick, onLiq, onStatus, onAlert, onData, onAgg, select, visible: visibleSymbols });
  cbs.current = { onSnapshot, onScan, onTick, onLiq, onStatus, onAlert, onData, onAgg, select, visible: visibleSymbols };

  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);

  const cidRef = useRef<string | null>(null);
  const visibleKeyRef = useRef('');

  const ensureCid = (): string => {
    if (!cidRef.current) {
      cidRef.current =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID().replace(/-/g, '').slice(0, 20)
          : `of-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    return cidRef.current;
  };

  const postVisible = useCallback((force = false) => {
    const cid = cidRef.current;
    const list = cbs.current.visible;
    if (!cid || !Array.isArray(list)) return;
    const key = list.slice().sort().join(',');
    if (!force && key === visibleKeyRef.current) return;
    visibleKeyRef.current = key;
    void fetch('/api/stream/visible', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cid, symbols: list }),
    }).catch(() => {});
  }, []);

  const visibleKey = Array.isArray(visibleSymbols) ? visibleSymbols.slice().sort().join(',') : '';
  useEffect(() => {
    postVisible();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, postVisible]);

  // scheduleReconnect is defined after connect, but connect's closure needs it.
  // Use a ref so connect can call it without a circular dep.
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const armWatchdog = useCallback(() => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      // Upstream feed silently dead — close and reconnect.
      const es = esRef.current;
      if (es) { es.close(); esRef.current = null; }
      if (!closedByUs.current) scheduleReconnectRef.current();
    }, DATA_WATCHDOG_MS);
  }, []);

  const connect = useCallback(() => {
    if (!enabled) return;
    setState((s) => (s === 'open' ? s : 'reconnecting'));

    let es: EventSource;
    try {
      const wantsVisible = Array.isArray(cbs.current.visible);
      const url = wantsVisible ? `/api/stream?cid=${encodeURIComponent(ensureCid())}` : '/api/stream';
      es = new EventSource(url);
    } catch (e) {
      setError((e as Error).message);
      scheduleReconnectRef.current();
      return;
    }
    esRef.current = es;

    es.onopen = () => {
      setState('open');
      setError(null);
      setAttempts(0);
      postVisible(true);
      // Start the watchdog — if no data arrives within DATA_WATCHDOG_MS the
      // feed is silently dead and we reconnect.
      armWatchdog();
    };

    es.onerror = () => {
      setState('reconnecting');
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        scheduleReconnectRef.current();
      }
    };

    es.onmessage = (ev) => {
      const now = Date.now();
      let msg: StreamMsg;
      try {
        msg = JSON.parse(ev.data) as StreamMsg;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'snapshot': cbs.current.onSnapshot?.(msg); break;
        case 'scan':     cbs.current.onScan?.(msg);     break;
        case 'agg':      cbs.current.onAgg?.(msg);      break;
        case 'tick':     cbs.current.onTick?.(msg);     break;
        case 'liq':      cbs.current.onLiq?.(msg);      break;
        case 'status':   cbs.current.onStatus?.(msg);   break;
        case 'alert':    cbs.current.onAlert?.(msg);    break;
        case 'heartbeat':
          // Heartbeat proves the SSE pipe is open but NOT that Binance is
          // pushing ticks. Reset the watchdog so we don't reconnect during a
          // genuinely quiet market, but do NOT call onData — that would show
          // LIVE on a frozen price feed.
          armWatchdog();
          return;
        default:
          break;
      }

      // Real data: reset watchdog and mark freshness.
      armWatchdog();
      cbs.current.onData?.(now);

      const picked = cbs.current.select?.(msg) ?? null;
      if (picked !== null && picked !== undefined) setValue(picked);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, armWatchdog, postVisible]);

  const scheduleReconnect = useCallback(() => {
    if (closedByUs.current) return;
    if (timerRef.current) return;
    setAttempts((a) => {
      const next = a + 1;
      const wait = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(next, 4), MAX_BACKOFF_MS);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, wait);
      return next;
    });
  }, [connect]);

  // Keep the ref in sync so connect's closure can call it.
  useEffect(() => { scheduleReconnectRef.current = scheduleReconnect; }, [scheduleReconnect]);

  useEffect(() => {
    if (!enabled) {
      setState('closed');
      return;
    }
    closedByUs.current = false;
    connect();

    // Reconnect immediately when the tab becomes visible again.
    // A backgrounded tab has a dead SSE connection; without this the user
    // sees stale data for up to MAX_BACKOFF_MS after switching back.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const es = esRef.current;
      if (!es || es.readyState === EventSource.CLOSED) {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Also reconnect on network coming back online.
    const onOnline = () => {
      const es = esRef.current;
      if (!es || es.readyState === EventSource.CLOSED) {
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        connect();
      }
    };
    window.addEventListener('online', onOnline);

    return () => {
      closedByUs.current = true;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
      esRef.current?.close();
      esRef.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, connect]);

  return { state, value, attempts, error };
}

export { LIVE };
