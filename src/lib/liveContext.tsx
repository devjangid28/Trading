import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveStream, type LiveStreamResult } from './useLiveStream';
import { freshnessOf, ageLabel, type Freshness } from './freshness';
import type { StreamMsg, ScanResult } from '../../shared/types';

/**
 * Stage 1 — the app-level live stream.
 *
 * Owns one socket for the whole app (rather than one per panel) and exposes it
 * three ways:
 *
 *   - `scan`   the newest full board, replaced by `scan` push events
 *   - `prices` a live price overlay keyed by symbol, applied on top of the
 *              scan rows so prices move between candle closes
 *   - `freshness` the LIVE / DELAYED / STALE badge state
 *
 * The price overlay is deliberately a Map rather than a re-render of the row
 * array. Rebuilding rows on every tick would re-sort and re-run every cell,
 * which is what makes tick-driven boards feel laggy and flicker. Instead the
 * overlay is applied at render time in the cell that needs it, so a price
 * change touches one text node.
 */

export interface LivePrice {
  price: number;
  changePct: number;
  /** 'up' or 'down' relative to the previous streamed price, for the flash. */
  dir: 'up' | 'down' | 'flat';
  at: number;
}

export interface LiveContextValue {
  scan: ScanResult | null;
  prices: Record<string, LivePrice>;
  getPrice: (symbol: string) => LivePrice | null;
  freshness: Freshness;
  freshnessLabel: string;
  state: LiveStreamResult<StreamMsg>['state'];
  lastDataAt: number | null;
  blackedOut: boolean;
  /** True once the socket has produced data; used to decide polling fallback. */
  isLive: boolean;
}

const EMPTY: LiveContextValue = {
  scan: null,
  prices: {},
  getPrice: () => null,
  freshness: 'UNKNOWN',
  freshnessLabel: 'no data',
  state: 'connecting',
  lastDataAt: null,
  blackedOut: false,
  isLive: false,
};

let current: LiveContextValue = EMPTY;
const listeners = new Set<() => void>();

function publish(next: LiveContextValue) {
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
 */
export function useLiveStreamProvider(fallbackScan: ScanResult | null): void {
  const [scan, setScan] = useState<ScanResult | null>(fallbackScan);
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const [blackedOut, setBlackedOut] = useState(false);

  // Previous prices drive the flash direction. Kept in a ref so the tick
  // handler does not need the previous state object.
  const prev = useRef<Record<string, number>>({});

  const onTick = useCallback((msg: Extract<StreamMsg, { type: 'tick' }>) => {
    const sym = msg.symbol;
    const was = prev.current[sym];
    prev.current[sym] = msg.price;
    const entry: LivePrice = {
      price: msg.price,
      changePct: msg.changePct,
      dir: was === undefined || was === msg.price ? 'flat' : msg.price > was ? 'up' : 'down',
      at: msg.ts,
    };
    setPrices((p) => (p[sym]?.price === msg.price && p[sym]?.dir === entry.dir ? p : { ...p, [sym]: entry }));
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
  });

  const { state, lastDataAgeMs, lastDataAt } = stream;

  const value = useMemo<LiveContextValue>(() => ({
    scan,
    prices,
    getPrice: (symbol: string) => prices[symbol] ?? null,
    freshness: freshnessOf(lastDataAgeMs),
    freshnessLabel: ageLabel(lastDataAgeMs),
    state,
    lastDataAt,
    blackedOut,
    isLive: lastDataAt !== null,
  }), [scan, prices, state, lastDataAgeMs, lastDataAt, blackedOut]);

  // Publish on every change; subscribers re-read via useLive().
  useEffect(() => { publish(value); }, [value]);
}