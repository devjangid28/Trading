import { useSyncExternalStore } from 'react';
import type { LiveAggregate } from '../../shared/types';

/**
 * The live aggregate store — the client half of the 1-second server snapshot.
 *
 * Kept OUTSIDE React context on purpose. The aggregate changes once per second;
 * publishing it through `liveContext` would give the provider a new identity
 * every second and re-render the whole app shell with it, which is exactly the
 * regression `priceStore` was written to remove. Components that need a live
 * number subscribe here and re-render alone.
 *
 * Last-writer-wins by `asOf`, so a replayed or out-of-order event never rolls
 * the market backwards.
 */

let current: LiveAggregate | null = null;
const listeners = new Set<() => void>();

export function applyAgg(agg: LiveAggregate): void {
  if (current && agg.asOf <= current.asOf) return;
  current = agg;
  for (const l of listeners) l();
}

/** Non-reactive read, for event handlers and tests. */
export function liveAggregate(): LiveAggregate | null {
  return current;
}

/** Subscribe to the newest aggregate. Re-renders once per second while live. */
export function useAggregate(): LiveAggregate | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    liveAggregate,
    () => null,
  );
}

/** Test helper: forget the aggregate. */
export function __resetAggStore(): void {
  current = null;
  listeners.clear();
}
