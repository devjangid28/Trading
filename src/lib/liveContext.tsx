import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveStream, type LiveStreamResult } from './useLiveStream';
import type { StreamMsg, ScanResult } from '../../shared/types';
import { applyTick, markData } from './priceStore';
import { applyAgg } from './aggStore';

/**
 * Stage 1 — the app-level live stream.
 *
 * Owns one socket for the whole app (rather than one per panel) and exposes the
 * low-frequency state:
 *
 *   - `scan`   the newest full board, replaced by `scan` push events (~1/min)
 *   - `state`  connecting / open / reconnecting / closed
 *   - `blackedOut` the event-risk flag carried by the scan
 *
 * HIGH-FREQUENCY PRICES ARE NOT PUBLISHED HERE.
 *
 * An earlier version put a `prices` record in this context and rebuilt it on
 * every tick. That gave the context a new identity every second, force-rendered
 * every `useLive()` subscriber (the whole app shell included), and re-rendered
 * every price cell for one symbol's tick. Prices now live in `priceStore`, an
 * external store with per-symbol subscriptions, and this context only changes
 * when the board itself changes — roughly once a minute.
 */

export type { LivePrice } from './priceStore';
export { useLivePrice, livePrice } from './priceStore';

export interface LiveContextValue {
  scan: ScanResult | null;
  state: LiveStreamResult<StreamMsg>['state'];
  blackedOut: boolean;
}

const EMPTY: LiveContextValue = {
  scan: null,
  state: 'connecting',
  blackedOut: false,
};

let current: LiveContextValue = EMPTY;
const listeners = new Set<() => void>();

function publish(next: LiveContextValue): void {
  current = next;
  for (const l of listeners) l();
}

export function subscribeLive(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLive(): LiveContextValue {
  return current;
}

export function useLive(): LiveContextValue {
  const [, force] = useState(0);
  useEffect(() => subscribeLive(() => force((n) => n + 1)), []);
  return current;
}

/**
 * Mount once, high in the tree. Opens the socket and keeps the derived state
 * published to all consumers.
 *
 * `visibleSymbols` narrows the SSE subscription to the symbols the app actually
 * renders: the server then pushes ticks for only those (see
 * POST /api/stream/visible). Pass `null` to keep the legacy all-symbols feed.
 */
export function useLiveStreamProvider(
  fallbackScan: ScanResult | null,
  visibleSymbols?: string[] | null,
): void {
  const [scan, setScan] = useState<ScanResult | null>(fallbackScan);
  const [blackedOut, setBlackedOut] = useState(false);

  // Ticks go straight into the external store, never through React state, so
  // the provider does not re-render per tick.
  const onTick = useCallback((msg: Extract<StreamMsg, { type: 'tick' }>) => {
    applyTick(msg.symbol, msg.price, msg.changePct, msg.ts);
  }, []);

  const stream = useLiveStream({
    onSnapshot: (m) => {
      setScan(m.scan);
      setBlackedOut(m.blackedOut);
    },
    onScan: (m) => {
      setScan(m.scan);
      setBlackedOut(m.scan.blackedOut);
    },
    onTick,
    // The 1s aggregate goes into its own external store, so the app shell does
    // not re-render once per second with it.
    onAgg: (m) => applyAgg(m.agg),
    // Freshness clock: the exact receive time of the newest data message, fed
    // to the store so the badge ages correctly without a render per tick.
    onData: markData,
    visibleSymbols,
  });

  const { state } = stream;

  const value = useMemo<LiveContextValue>(
    () => ({ scan, state, blackedOut }),
    [scan, state, blackedOut],
  );

  // Publish on every change; subscribers re-read via useLive().
  useEffect(() => { publish(value); }, [value]);
}
