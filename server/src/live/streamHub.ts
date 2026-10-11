import type { ConnectionStatus, LiqEvent, StreamMsg } from '../../../shared/types.js';
import { LIVE } from '../config.js';

const LIVE_TICK_FLUSH_MS = LIVE.TICK_PUSH_MS;

/**
 * Stage 1 — the SSE fan-out hub.
 *
 * WHY THIS EXISTS
 *
 * The first version of `/api/stream` called `live.setHandlers(...)` inside the
 * request handler. `setHandlers` REPLACES the handler rather than adding to it,
 * so every new browser tab silently unsubscribed the previous one: the module
 * level broadcast defined at boot was overwritten by whichever client
 * connected last, and on disconnect the handler still pointed at a dead
 * `res`. Two tabs open, one of them goes quiet, and nothing logs an error.
 *
 * This module owns the single handler registration and fans out to every
 * subscriber. The route just adds and removes a `send` function.
 *
 * TICK THROTTLING
 *
 * Binance miniTicker arrives many times a second per symbol. Pushing each one
 * individually is a firehose that costs more than the data is worth, so ticks
 * are coalesced into a map keyed by symbol and flushed once per second. A
 * client therefore sees at most one update per symbol per second, which is
 * what the "price change visible within 2s" acceptance check needs, and the
 * newest price always wins rather than an arbitrary earlier one.
 */

type Send = (msg: StreamMsg) => void;

const subscribers = new Set<Send>();

/** Latest price per symbol since the last flush. */
const pendingTicks = new Map<string, { price: number; changePct: number }>();

let flushTimer: NodeJS.Timeout | null = null;

/** Wall-clock of the last flush, so /api/health can report tick freshness. */
let lastFlushAt = 0;
let ticksFlushed = 0;

export function lastTickAt(): number {
  return lastFlushAt;
}

export function subscriberCount(): number {
  return subscribers.size;
}

function broadcast(msg: StreamMsg): void {
  for (const send of subscribers) {
    try {
      send(msg);
    } catch {
      // A dead socket must never break the loop for the healthy ones. It is
      // removed by the route's own close handler.
    }
  }
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (pendingTicks.size === 0) return;
    const ts = Date.now();
    for (const [symbol, v] of pendingTicks) {
      broadcast({ type: 'tick', symbol, price: v.price, changePct: v.changePct, ts });
    }
    ticksFlushed += pendingTicks.size;
    pendingTicks.clear();
    lastFlushAt = ts;
  }, LIVE_TICK_FLUSH_MS);
}

export function subscribe(send: Send): () => void {
  subscribers.add(send);
  ensureFlushTimer();
  return () => {
    subscribers.delete(send);
    if (subscribers.size === 0 && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  };
}

export function send(msg: StreamMsg): void {
  broadcast(msg);
}

/** Record the newest price for a symbol; it is flushed on the 1s timer. */
export function stageTick(symbol: string, price: number, changePct: number): void {
  pendingTicks.set(symbol, { price, changePct });
}

/**
 * Tick and kline-close hooks are set by the boot sequence via
 * `setIngestHandlers`; only the broadcast-only hooks are built here.
 */
let ingestHooks: {
  onTick?: (symbol: string, price: number, changePct: number) => void;
  onKlineClose?: (symbol: string, closed: boolean) => void;
} = {};

export function setIngestHandlers(h: {
  onTick?: (symbol: string, price: number, changePct: number) => void;
  onKlineClose?: (symbol: string, closed: boolean) => void;
}): void {
  ingestHooks = h;
}

/**
 * The half of the handler set that LiveIngest owns. `ingestHooks` is merged in
 * by the caller so there is still exactly one `setHandlers` call in the
 * process, which is what prevents the second-tab-silently-unsubscribes-the-
 * first bug this module was written to fix.
 */
export function ingestHandlers(): {
  onTick: (symbol: string, price: number, changePct: number) => void;
  onKlineClose: (symbol: string, closed: boolean) => void;
  onLiq: (e: LiqEvent) => void;
  onStatus: (s: ConnectionStatus) => void;
} {
  return {
    onTick: (s, p, c) => ingestHooks.onTick?.(s, p, c),
    onKlineClose: (s, c) => ingestHooks.onKlineClose?.(s, c),
    onLiq: (e) => broadcast({ type: 'liq', event: e, ts: Date.now() }),
    onStatus: (s) => broadcast({ type: 'status', connection: { [s.name]: s }, ts: Date.now() }),
  };
}

export const streamStats = () => ({
  subscribers: subscribers.size,
  pendingTicks: pendingTicks.size,
  lastFlushAt,
  ticksFlushed,
  flushIntervalMs: LIVE_TICK_FLUSH_MS,
});