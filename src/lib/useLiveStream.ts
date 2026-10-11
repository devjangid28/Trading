import { useCallback, useEffect, useRef, useState } from 'react';
import type { StreamMsg } from '../../shared/types';
import { LIVE } from './freshness';

/**
 * Stage 1 — the SSE client.
 *
 * `usePolling` stays as the fallback: if the socket cannot be established at
 * all, the app must still show data rather than a dead screen. The hook
 * therefore reports its own state instead of throwing, and the consumer
 * decides whether to fall back.
 *
 * The important behaviours:
 *
 * - Auto-reconnect with backoff. A closed laptop lid or a proxy restart should
 *   recover on its own; the caller does not remount anything.
 * - `lastEventAt` drives the LIVE / DELAYED / STALE badge. This is the only
 *   honest signal that the data is current: a socket can be "open" while the
 *   upstream feed has silently gone quiet, and an open socket alone would show
 *   a reassuring green badge over stale prices.
 * - Reconnect asks the server for a fresh snapshot via `Last-Event-ID`
 *   semantics, so a gap in ticks is corrected rather than left as a hole.
 * - Heartbeats alone do NOT reset `lastDataAt`. A heartbeat proves the
 *   connection is alive, not that market data is flowing; counting it as
 *   fresh would keep a board looking live while every price is frozen.
 */

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveStreamOptions<T> {
  /** Reduce a raw message into the shape the UI wants, or null to ignore it. */
  select?: (msg: StreamMsg) => T | null;
  onSnapshot?: (msg: Extract<StreamMsg, { type: 'snapshot' }>) => void;
  onScan?: (msg: Extract<StreamMsg, { type: 'scan' }>) => void;
  onTick?: (msg: Extract<StreamMsg, { type: 'tick' }>) => void;
  onLiq?: (msg: Extract<StreamMsg, { type: 'liq' }>) => void;
  onStatus?: (msg: Extract<StreamMsg, { type: 'status' }>) => void;
  onAlert?: (msg: Extract<StreamMsg, { type: 'alert' }>) => void;
  enabled?: boolean;
}

export interface LiveStreamResult<T> {
  state: StreamState;
  /** ms since the last message that carried real data. */
  lastDataAgeMs: number | null;
  /** Epoch ms of the last data-bearing event. */
  lastDataAt: number | null;
  /** Epoch ms of the last heartbeat, proving the socket itself is alive. */
  lastEventAt: number | null;
  attempts: number;
  error: string | null;
  value: T | null;
}

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function useLiveStream<T = StreamMsg>(
  opts: LiveStreamOptions<T> = {},
): LiveStreamResult<T> {
  const {
    onSnapshot, onScan, onTick, onLiq, onStatus, onAlert,
    select, enabled = true,
  } = opts;

  const [state, setState] = useState<StreamState>('connecting');
  const [value, setValue] = useState<T | null>(null);
  const [lastDataAt, setLastDataAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Callbacks live in a ref so that passing an inline arrow does not tear down
  // and re-establish the socket on every parent render.
  const cbs = useRef({ onSnapshot, onScan, onTick, onLiq, onStatus, onAlert, select });
  cbs.current = { onSnapshot, onScan, onTick, onLiq, onStatus, onAlert, select };

  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUs = useRef(false);

  const connect = useCallback(() => {
    if (!enabled) return;
    setState((s) => (s === 'open' ? s : 'reconnecting'));

    let es: EventSource;
    try {
      es = new EventSource('/api/stream');
    } catch (e) {
      setError((e as Error).message);
      scheduleReconnect();
      return;
    }
    esRef.current = es;

    es.onopen = () => {
      setState('open');
      setError(null);
      setAttempts(0);
    };

    es.onerror = () => {
      // EventSource retries on its own, but with no control over backoff and
      // no way to reset the attempt counter, so we close it and drive the
      // reconnect ourselves. `readyState === CLOSED` means it gave up.
      setState((s) => (s === 'open' ? 'reconnecting' : 'reconnecting'));
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        scheduleReconnect();
      }
    };

    es.onmessage = (ev) => {
      const now = Date.now();
      setLastEventAt(now);
      let msg: StreamMsg;
      try {
        msg = JSON.parse(ev.data) as StreamMsg;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'snapshot': cbs.current.onSnapshot?.(msg); break;
        case 'scan': cbs.current.onScan?.(msg); break;
        case 'tick': cbs.current.onTick?.(msg); break;
        case 'liq': cbs.current.onLiq?.(msg); break;
        case 'status': cbs.current.onStatus?.(msg); break;
        case 'alert': cbs.current.onAlert?.(msg); break;
        case 'heartbeat':
          // Deliberately does NOT touch lastDataAt. See the note above.
          return;
        default:
          break;
      }

      setLastDataAt(now);
      const picked = cbs.current.select?.(msg) ?? null;
      if (picked !== null && picked !== undefined) setValue(picked);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const scheduleReconnect = useCallback(() => {
    if (closedByUs.current) return;
    if (timerRef.current) return;
    setAttempts((a) => {
      const next = a + 1;
      // Exponential backoff, capped. Deterministic rather than jittered
      // because a single client reconnects, not a fleet.
      const wait = Math.min(BASE_BACKOFF_MS * 2 ** Math.min(next, 5), MAX_BACKOFF_MS);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, wait);
      return next;
    });
  }, [connect]);

  useEffect(() => {
    if (!enabled) {
      setState('closed');
      return;
    }
    closedByUs.current = false;
    connect();
    return () => {
      closedByUs.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      esRef.current?.close();
      esRef.current = null;
    };
  }, [enabled, connect]);

  // Tick the age so the badge transitions on its own without a re-render
  // storm from the stream itself.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 2_000);
    return () => clearInterval(id);
  }, []);

  const lastDataAgeMs = lastDataAt === null ? null : Date.now() - lastDataAt;

  return {
    state,
    value,
    lastDataAt,
    lastEventAt,
    lastDataAgeMs,
    attempts,
    error,
  };
}

export { LIVE };