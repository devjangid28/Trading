import { useCallback, useSyncExternalStore } from 'react';

/**
 * The high-frequency live-price store.
 *
 * WHY THIS IS NOT REACT CONTEXT
 *
 * The SSE stream pushes a tick for every tracked symbol about once a second.
 * Routing those through `liveContext` re-published the whole context object on
 * every tick, which force-rendered `App` — and therefore the entire tree —
 * once per second. Worse, the published object contained a fresh `prices`
 * record each time, so a single SOL tick re-rendered every cell on the page.
 *
 * This module keeps the live numbers OUTSIDE React:
 *
 *   - one module-level Map keyed by symbol,
 *   - one listener set per symbol, so a tick for SOL only re-renders the cells
 *     that actually display SOL,
 *   - notifications batched in a single `requestAnimationFrame`, so a burst of
 *     ticks that arrives in the same frame (the server flushes ~150 symbols at
 *     once) produces one re-render round rather than 150,
 *   - reads through `useSyncExternalStore`, which is the supported way to read
 *     an external mutable source without tearing.
 *
 * `liveContext` keeps only the low-frequency state (board snapshot, connection
 * state, blackout); it no longer carries prices at all.
 */

export interface LivePrice {
  price: number;
  changePct: number;
  dir: 'up' | 'down' | 'flat';
  at: number;
}

const overrides = new Map<string, LivePrice>();
const lastPrice = new Map<string, number>();
const symbolListeners = new Map<string, Set<() => void>>();
const revisionListeners = new Set<() => void>();
let revision = 0;

let rafPending = false;
const dirtySymbols = new Set<string>();

function flush(): void {
  rafPending = false;
  const symbols = [...dirtySymbols];
  dirtySymbols.clear();
  for (const symbol of symbols) {
    const set = symbolListeners.get(symbol);
    if (set) for (const cb of [...set]) cb();
  }
  if (symbols.length > 0) for (const cb of [...revisionListeners]) cb();
}

function schedule(): void {
  if (rafPending) return;
  rafPending = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

/**
 * Apply one live tick. Returns true when a displayed value actually changed —
 * an unchanged price (the common case on the mini-ticker) schedules nothing, so
 * a quiet symbol costs no renders.
 */
export function applyTick(symbol: string, price: number, changePct: number, at: number): boolean {
  const was = lastPrice.get(symbol);
  lastPrice.set(symbol, price);
  const current = overrides.get(symbol);
  const dir: LivePrice['dir'] =
    was === undefined || was === price ? (current?.dir ?? 'flat') : price > was ? 'up' : 'down';

  if (current && current.price === price && current.changePct === changePct && current.dir === dir) {
    return false;
  }

  overrides.set(symbol, { price, changePct, dir, at });
  revision += 1;
  dirtySymbols.add(symbol);
  schedule();
  if (import.meta.env?.DEV && typeof window !== 'undefined') {
    const w = window as unknown as { __ofAppliedTicks?: number };
    w.__ofAppliedTicks = (w.__ofAppliedTicks ?? 0) + 1;
  }
  return true;
}

/** Non-reactive read, for event handlers and one-shot lookups. */
export function livePrice(symbol: string | null | undefined): LivePrice | null {
  if (!symbol) return null;
  return overrides.get(symbol) ?? null;
}

function subscribeSymbol(symbol: string, cb: () => void): () => void {
  let set = symbolListeners.get(symbol);
  if (!set) {
    set = new Set();
    symbolListeners.set(symbol, set);
  }
  set.add(cb);
  return () => {
    const current = symbolListeners.get(symbol);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) symbolListeners.delete(symbol);
  };
}

/**
 * Subscribe to one symbol. The component re-renders only when THIS symbol's
 * price/change/direction changes.
 */
export function useLivePrice(symbol: string | null | undefined): LivePrice | null {
  const subscribe = useCallback(
    (cb: () => void) => (symbol ? subscribeSymbol(symbol, cb) : () => {}),
    [symbol],
  );
  return useSyncExternalStore(
    subscribe,
    () => (symbol ? overrides.get(symbol) ?? null : null),
    () => null,
  );
}

function subscribeRevision(cb: () => void): () => void {
  revisionListeners.add(cb);
  return () => { revisionListeners.delete(cb); };
}

/**
 * Coarse subscription for views that render a whole list of prices (the stage).
 * It re-renders on any price change — deliberately scoped to that view rather
 * than the app shell. Prefer `useLivePrice` for per-cell subscriptions.
 */
export function usePriceRevision(): number {
  return useSyncExternalStore(subscribeRevision, () => revision, () => 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Freshness clock — the age of the newest DATA message, kept out of the
// per-tick render path. Only the freshness badge subscribes to this.
// ─────────────────────────────────────────────────────────────────────────────

let dataAt: number | null = null;
const dataListeners = new Set<() => void>();

/** Record that a data-bearing message arrived. Ignores out-of-order stamps. */
export function markData(at: number): void {
  if (dataAt !== null && at <= dataAt) return;
  dataAt = at;
  for (const cb of [...dataListeners]) cb();
}

export function lastDataAt(): number | null {
  return dataAt;
}

/** Reactive age source for the LIVE / DELAYED / STALE badge. */
export function useLastDataAt(): number | null {
  return useSyncExternalStore(
    (cb) => {
      dataListeners.add(cb);
      return () => { dataListeners.delete(cb); };
    },
    lastDataAt,
    () => null,
  );
}

/** Test helper: forget every live value. */
export function __resetLiveStore(): void {
  overrides.clear();
  lastPrice.clear();
  dirtySymbols.clear();
  symbolListeners.clear();
  revisionListeners.clear();
  revision = 0;
  dataAt = null;
}

// Dev-only tick injector, used by qa/render-count.spec.ts to prove that a burst
// of ticks does not re-render the app shell. Stripped from production builds.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  const w = window as unknown as {
    __ofSimulateTicks?: (n: number) => void;
  };
  w.__ofSimulateTicks = (n: number): void => {
    const at = Date.now();
    for (let i = 0; i < n; i++) {
      // A synthetic symbol nothing on screen subscribes to.
      applyTick('__SIM__USDT', 100 + i, i * 0.01, at);
    }
  };
}
