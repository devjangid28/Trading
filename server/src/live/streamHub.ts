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
 * Binance's `!miniTicker@arr` arrives once a second, so the original build
 * coalesced into a map keyed by symbol and flushed once per second, and the
 * acceptance check was written against "price change visible within 2s". Both
 * numbers were honest about a 1 Hz upstream and dishonest about a trading
 * terminal: the gap the user sees between the real price and the shown price
 * was not a rendering bug, it was the upstream stream's own 1000ms cadence.
 *
 * The socket now also carries `<symbol>@aggTrade`, which Binance documents as
 * real-time (aggregated per taker order, pushed on the fill). The flush
 * interval in config is therefore a BANDWIDTH decision, not a freshness one —
 * it bounds how often the browser repaints, not how old the price is. At 200ms
 * the client repaints at 5Hz while a burst of several hundred trades inside one
 * window still collapses to exactly one update per symbol, newest price wins.
 *
 * ONE WRITE PER FLUSH
 *
 * `flushNow` used to call the client's send function once per symbol, and each
 * of those did its own `res.write`. At 1 Hz that was invisible; at 5 Hz with
 * 200 visible symbols it is 1000 syscall-sized writes per flush per client,
 * which shows up as server-side event-loop lag — the exact symptom of "prices
 * feel behind". A client may therefore register a RAW subscriber, which
 * receives the whole flush as one already-serialised string to write once. The
 * message contract is unchanged; only the number of writes is.
 *
 * PER-CLIENT SYMBOL VISIBILITY
 *
 * The board shows a few dozen rows; the server ticks ~150 symbols. Pushing
 * every symbol's tick to every client is bandwidth that buys nothing — the
 * symbols the client is not showing go straight into the store and out again.
 * A client announces which symbols it renders (`POST /api/stream/visible`,
 * or the `?symbols=` query on connect) and the hub only flushes ticks for
 * those symbols to that client. Non-tick messages (snapshot, scan, liq,
 * status, heartbeat, alert, news) always reach everyone: they are the reason
 * the connection exists, not the noise it exists to avoid.
 *
 * `null` visible set means ALL ticks (legacy clients, the stage that renders a
 * whole list, diagnostics). The cap in config.ts keeps a buggy or hostile
 * client from asking for more symbols than the server is willing to stream.
 */

type Send = (msg: StreamMsg) => void;
/** Receives a pre-serialised SSE payload covering the whole flush. */
type SendRaw = (frame: string) => void;

/** Subscriber state: `null` = receive every tick, otherwise the allowed set. */
const subscribers = new Map<Send, Set<string> | null>();

/** Raw subscribers, keyed by the same visible-set rule, written once per flush. */
const rawSubscribers = new Map<SendRaw, Set<string> | null>();

/** cid -> send, so POST /api/stream/visible can narrow an open connection. */
const byCid = new Map<string, Send | SendRaw>();

/** Latest price per symbol since the last flush. */
const pendingTicks = new Map<string, { price: number; changePct: number; E: number }>();

/**
 * Last price+changePct already delivered for a symbol.
 *
 * Dedup on both fields: a price that hasn't moved but whose 24h change has
 * (e.g. the day rolls over) must still be sent, otherwise the change column
 * freezes while the price column looks live.
 */
const lastSent = new Map<string, { price: number; changePct: number }>();

let flushTimer: NodeJS.Timeout | null = null;

/** Wall-clock of the last flush, so /api/health can report tick freshness. */
let lastFlushAt = 0;
/**
 * Wall-clock of the last ingested tick. The flush clock only advances when a
 * client is subscribed, which made the boot scan report "no live price" before
 * any browser connected. Freshness is a property of ingestion, not fan-out.
 */
let lastIngestAt = 0;
let ticksFlushed = 0;

export function lastTickAt(): number {
  return Math.max(lastIngestAt, lastFlushAt);
}

/**
 * Total connected clients.
 *
 * MUST count raw subscribers. It gates the 1s `agg` push in the boot sequence:
 * with `subscribers.size` only, moving the SSE route to `subscribeRaw` made the
 * count read 0 for every real browser client and the aggregate silently stopped
 * being sent — a live regression found by measuring the wire, not by reading
 * the diff.
 */
export function subscriberCount(): number {
  return subscribers.size + rawSubscribers.size;
}

/**
 * Fan a non-tick message out to everyone, message subscribers and raw
 * subscribers alike. A raw subscriber MUST be included here or it would go
 * deaf to exactly the low-frequency events — scan, agg, status, liquidation —
 * that the connection exists for.
 */
function broadcast(msg: StreamMsg): void {
  for (const send of subscribers.keys()) {
    try {
      send(msg);
    } catch {
      // A dead socket must never break the loop for the healthy ones. It is
      // removed by the route's own close handler.
    }
  }
  for (const sendRaw of rawSubscribers.keys()) {
    try {
      sendRaw(frame(msg));
    } catch {
      /* handled by the route's close handler */
    }
  }
}

function frame(msg: StreamMsg): string {
  return `data: ${JSON.stringify(msg)}\n\n`;
}

/**
 * One flush pass.
 *
 * Raw subscribers get every tick of the pass concatenated into a SINGLE string,
 * so the route performs exactly one `res.write` per flush regardless of how
 * many symbols moved. Message subscribers keep receiving discrete messages,
 * which is what the tests and any non-HTTP consumer rely on.
 */
function flushNow(): number {
  if (pendingTicks.size === 0) return lastFlushAt;
  const ts = Date.now();

  // Only symbols whose price or changePct actually moved are worth a frame.
  const moved: Array<[string, { price: number; changePct: number; E: number }]> = [];
  for (const [symbol, v] of pendingTicks) {
    const prev = lastSent.get(symbol);
    if (prev && prev.price === v.price && prev.changePct === v.changePct) continue;
    moved.push([symbol, v]);
  }
  pendingTicks.clear();
  if (moved.length === 0) return lastFlushAt;

  for (const sendRaw of rawSubscribers.keys()) {
    const visible = rawSubscribers.get(sendRaw) ?? null;
    let out = '';
    for (const [symbol, v] of moved) {
      if (visible && !visible.has(symbol)) continue;
      out += frame({ type: 'tick', symbol, price: v.price, changePct: v.changePct, ts, E: v.E });
    }
    if (!out) continue;
    try {
      sendRaw(out);
    } catch {
      /* handled by the route's close handler */
    }
  }

  for (const [symbol, v] of moved) {
    for (const [send, visible] of subscribers) {
      // The one place the visible budget is enforced: a tick for a symbol the
      // client did not ask for is not written to that client's socket.
      if (visible && !visible.has(symbol)) continue;
      try {
        send({ type: 'tick', symbol, price: v.price, changePct: v.changePct, ts, E: v.E });
      } catch {
        /* handled by the route's close handler */
      }
    }
  }

  for (const [symbol, v] of moved) lastSent.set(symbol, { price: v.price, changePct: v.changePct });
  ticksFlushed += moved.length;
  lastFlushAt = ts;
  return ts;
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushNow, LIVE_TICK_FLUSH_MS);
}

function totalSubscribers(): number {
  return subscribers.size + rawSubscribers.size;
}

function dropVisibleSet(send: Send | SendRaw): void {
  subscribers.delete(send as Send);
  rawSubscribers.delete(send as SendRaw);
}

export interface SubscribeOptions {
  /** Symbols to receive ticks for. Omit (or undefined) for ALL ticks. */
  symbols?: string[];
  /** Client id, so POST /api/stream/visible can update this subscription. */
  cid?: string;
}

export function subscribe(send: Send, opts?: SubscribeOptions): () => void {
  const visible: Set<string> | null = Array.isArray(opts?.symbols)
    ? new Set(opts.symbols.slice(0, LIVE.MAX_VISIBLE_SYMBOLS_PER_CLIENT))
    : null;
  subscribers.set(send, visible);
  if (opts?.cid) byCid.set(opts.cid, send);
  ensureFlushTimer();
  return () => {
    dropVisibleSet(send);
    if (opts?.cid) byCid.delete(opts.cid);
    if (totalSubscribers() === 0 && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  };
}

/**
 * Subscribe with a raw frame sink — the SSE route's path.
 *
 * The whole flush arrives as one string, so the route performs exactly one
 * `res.write` per flush however many symbols moved. Non-tick messages still go
 * through `send()` as discrete frames; they are low frequency and individually
 * interesting, and batching them would change nothing measurable.
 */
export function subscribeRaw(send: SendRaw, opts?: SubscribeOptions): () => void {
  const visible: Set<string> | null = Array.isArray(opts?.symbols)
    ? new Set(opts.symbols.slice(0, LIVE.MAX_VISIBLE_SYMBOLS_PER_CLIENT))
    : null;
  rawSubscribers.set(send, visible);
  if (opts?.cid) byCid.set(opts.cid, send);
  ensureFlushTimer();
  return () => {
    dropVisibleSet(send);
    if (opts?.cid) byCid.delete(opts.cid);
    if (totalSubscribers() === 0 && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  };
}

/**
 * Narrow an open subscription's tick set. Returns false when the cid is not
 * an open connection (or is already gone), so the route can 404 honestly.
 */
export function setVisibleForCid(cid: string, symbols: string[]): boolean {
  const send = byCid.get(cid);
  if (!send) return false;
  const visible: Set<string> | null = Array.isArray(symbols)
    ? new Set(symbols.slice(0, LIVE.MAX_VISIBLE_SYMBOLS_PER_CLIENT))
    : null;
  if (subscribers.has(send as Send)) subscribers.set(send as Send, visible);
  else if (rawSubscribers.has(send as SendRaw)) rawSubscribers.set(send as SendRaw, visible);
  else return false;
  return true;
}

export function send(msg: StreamMsg): void {
  broadcast(msg);
}

/**
 * Record the newest price for a symbol; the flush timer delivers it.
 *
 * The guard is deliberately narrow. A repeat of the price already sitting in
 * the pending map is dropped, because it would replace an identical value. A
 * repeat of the price last *flushed* is still staged: the 24h change or the
 * exchange timestamp may have moved even when the price did not, and both are
 * shown.
 */
export function stageTick(symbol: string, price: number, changePct: number, E = 0): void {
  lastIngestAt = Date.now();
  const cur = pendingTicks.get(symbol);
  // Drop only when both price AND changePct are identical — a day-roll can
  // change changePct without moving the last trade price.
  if (cur && cur.price === price && cur.changePct === changePct) return;
  pendingTicks.set(symbol, { price, changePct, E });
}

/**
 * Tick and kline-close hooks are set by the boot sequence via
 * `setIngestHandlers`; only the broadcast-only hooks are built here.
 */
let ingestHooks: {
  onTick?: (symbol: string, price: number, changePct: number, exchangeTs?: number) => void;
  onKlineClose?: (symbol: string, closed: boolean) => void;
} = {};

export function setIngestHandlers(h: {
  onTick?: (symbol: string, price: number, changePct: number, exchangeTs?: number) => void;
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
  onTick: (symbol: string, price: number, changePct: number, exchangeTs?: number) => void;
  onKlineClose: (symbol: string, closed: boolean) => void;
  onLiq: (e: LiqEvent) => void;
  onStatus: (s: ConnectionStatus) => void;
} {
  return {
    onTick: (s, p, c, e) => ingestHooks.onTick?.(s, p, c, e),
    onKlineClose: (s, c) => ingestHooks.onKlineClose?.(s, c),
    onLiq: (e) => broadcast({ type: 'liq', event: e, ts: Date.now() }),
    onStatus: (s) => broadcast({ type: 'status', connection: { [s.name]: s }, ts: Date.now() }),
  };
}

export const streamStats = () => ({
  subscribers: totalSubscribers(),
  /** Connections that receive one batched write per flush. */
  rawSubscribers: rawSubscribers.size,
  /** How many open connections have narrowed their tick set (budget in use). */
  filteredClients:
    [...subscribers.values(), ...rawSubscribers.values()].filter((v) => v !== null).length,
  pendingTicks: pendingTicks.size,
  lastFlushAt,
  lastIngestAt,
  ticksFlushed,
  flushIntervalMs: LIVE_TICK_FLUSH_MS,
  maxVisibleSymbols: LIVE.MAX_VISIBLE_SYMBOLS_PER_CLIENT,
});

/** Exposed for tests: perform one flush pass immediately. */
export const flushNowForTest = flushNow;

/** Exposed for tests: forget delivered prices so a repeated price is re-sent. */
export function __resetStreamHub(): void {
  pendingTicks.clear();
  lastSent.clear();
  lastFlushAt = 0;
  lastIngestAt = 0;
  ticksFlushed = 0;
}