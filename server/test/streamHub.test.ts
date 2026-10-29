import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  subscribe, subscribeRaw, stageTick, setVisibleForCid, send, streamStats,
  flushNowForTest, subscriberCount, lastTickAt, __resetStreamHub,
} from '../src/live/streamHub';
import { LIVE } from '../src/config';
import type { StreamMsg } from '../../shared/types';

/**
 * Per-client symbol visibility — the subscription budget.
 *
 * A client tells the hub which symbols it renders and the hub must push ticks
 * for ONLY those symbols to that client. This is bandwidth, so the test has to
 * prove less is sent, not just that a filter exists.
 */

const tick = (symbol: string): StreamMsg => ({ type: 'tick', symbol, price: 1, changePct: 0, ts: 0 });

describe('streamHub per-client tick budget', () => {
  let clients: { msgs: StreamMsg[]; unsubscribe: () => void }[] = [];

  beforeEach(() => {
    clients = [];
    // The hub suppresses a re-send of a price it has already delivered, and it
    // keeps that memory at module scope. Without this reset, a symbol staged in
    // one test is "already delivered" in the next and the assertion below fails
    // for a reason that has nothing to do with what it is testing.
    __resetStreamHub();
  });

  afterEach(() => {
    for (const c of clients) c.unsubscribe();
  });

  function open(symbols?: string[], cid?: string) {
    const msgs: StreamMsg[] = [];
    const unsubscribe = subscribe((m) => { msgs.push(m); }, { symbols, cid });
    const client = { msgs, unsubscribe };
    clients.push(client);
    return client;
  }

  it('sends a tick only to clients that declared that symbol', () => {
    const btcOnly = open(['BTCUSDT'], 'cid-btc');
    const ethSol = open(['ETHUSDT', 'SOLUSDT'], 'cid-eth');

    stageTick('BTCUSDT', 1, 0.1);
    stageTick('ETHUSDT', 2, -0.2);
    stageTick('SOLUSDT', 3, 0);
    stageTick('DOGEUSDT', 4, 1); // nobody asked for this one

    flushNowForTest();
    send({ type: 'heartbeat', ts: 0 });

    expect(btcOnly.msgs.filter((m) => m.type === 'tick').map((m) => (m as { symbol: string }).symbol))
      .toEqual(['BTCUSDT']);
    expect(ethSol.msgs.filter((m) => m.type === 'tick').map((m) => (m as { symbol: string }).symbol).sort())
      .toEqual(['ETHUSDT', 'SOLUSDT']);
  });

  it('still sends every non-tick message to everyone', () => {
    const narrow = open(['BTCUSDT'], 'cid-x');
    const all = open(undefined, 'cid-y');

    send(tick('DOGEUSDT'));
    send({ type: 'heartbeat', ts: 1 });
    send({ type: 'status', connection: {}, ts: 1 });

    expect(narrow.msgs.filter((m) => m.type !== 'tick').map((m) => m.type))
      .toEqual(['heartbeat', 'status']);
    expect(all.msgs.map((m) => m.type).sort()).toEqual(['heartbeat', 'status', 'tick']);
  });

  it('a client with no subscription receives ALL ticks (legacy behaviour)', () => {
    const all = open(undefined, 'cid-all');
    stageTick('BTCUSDT', 1, 0);
    stageTick('DOGEUSDT', 2, 0);
    flushNowForTest();
    expect(all.msgs.filter((m) => m.type === 'tick')).toHaveLength(2);
  });

  it('POST /visible narrows an existing connection and 404s an unknown one', () => {
    const client = open(['BTCUSDT'], 'cid-live');

    expect(setVisibleForCid('cid-live', ['XRPUSDT'])).toBe(true);
    stageTick('BTCUSDT', 1, 0);
    stageTick('XRPUSDT', 2, 0);
    flushNowForTest();
    expect(client.msgs.filter((m) => m.type === 'tick').map((m) => (m as { symbol: string }).symbol))
      .toEqual(['XRPUSDT']);

    expect(setVisibleForCid('no-such-cid', ['BTCUSDT'])).toBe(false);
  });

  it('clamps an over-large request to the per-client budget', () => {
    const big = Array.from({ length: LIVE.MAX_VISIBLE_SYMBOLS_PER_CLIENT + 50 }, (_, i) => `S${i}USDT`);
    open(big, 'cid-big');
    expect(streamStats().filteredClients).toBeGreaterThanOrEqual(1);
    // The cap is exported so the route and the UI can agree on it.
    expect(streamStats().maxVisibleSymbols).toBe(LIVE.MAX_VISIBLE_SYMBOLS_PER_CLIENT);
  });
});

/**
 * The real-time path.
 *
 * Two properties matter and neither was true when the socket carried only the
 * 1 Hz miniTicker array:
 *
 *  1. A burst of ticks inside one flush window collapses to ONE update per
 *     symbol carrying the NEWEST price — never an arbitrary earlier one.
 *  2. A raw subscriber receives the entire flush as a single write, so the
 *     route performs one `res.write` per flush regardless of symbol count.
 *
 * Plus the dedupe: an unchanged price must not cost a frame.
 */
describe('streamHub real-time flush', () => {
  beforeEach(() => { __resetStreamHub(); });

  it('reports a tick as ingested even when no client is subscribed', () => {
    // The boot scan asks "is the price stream live?" before a browser exists.
    // Freshness must come from ingestion, not from the flush timer, which only
    // runs for connected clients.
    expect(lastTickAt()).toBe(0);
    stageTick('BTCUSDT', 100, 0);
    expect(lastTickAt()).toBeGreaterThan(0);
    expect(streamStats().lastFlushAt).toBe(0);
  });

  it('collapses a burst to one update per symbol, newest price winning', () => {
    const msgs: StreamMsg[] = [];
    const unsubscribe = subscribe((m) => { msgs.push(m); });
    try {
      stageTick('BTCUSDT', 100, 0);
      stageTick('BTCUSDT', 101, 0);
      stageTick('BTCUSDT', 102, 0);
      stageTick('ETHUSDT', 50, 0);
      flushNowForTest();

      const ticks = msgs.filter((m): m is Extract<StreamMsg, { type: 'tick' }> => m.type === 'tick');
      expect(ticks).toHaveLength(2);
      const btc = ticks.find((t) => t.symbol === 'BTCUSDT');
      expect(btc?.price).toBe(102);
    } finally {
      unsubscribe();
    }
  });

  it('delivers a whole flush to a raw subscriber as ONE write', () => {
    const frames: string[] = [];
    const unsubscribe = subscribeRaw((f) => { frames.push(f); });
    try {
      stageTick('BTCUSDT', 100, 0);
      stageTick('ETHUSDT', 50, 0);
      stageTick('SOLUSDT', 10, 0);
      flushNowForTest();

      expect(frames).toHaveLength(1);
      // One string, three SSE data frames inside it.
      const dataFrames = frames[0].split('data: ').length - 1;
      expect(dataFrames).toBe(3);
    } finally {
      unsubscribe();
    }
  });

  it('does not resend a price that did not move', () => {
    const frames: string[] = [];
    const unsubscribe = subscribeRaw((f) => { frames.push(f); });
    try {
      stageTick('BTCUSDT', 100, 0);
      flushNowForTest();
      stageTick('BTCUSDT', 100, 0); // same price, next window
      flushNowForTest();

      expect(frames).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('still reaches raw subscribers with non-tick broadcasts', () => {
    // A raw subscriber that only got flushes would go deaf to scan/agg/status
    // — the low-frequency messages the connection exists for.
    const frames: string[] = [];
    const unsubscribe = subscribeRaw((f) => { frames.push(f); });
    try {
      send({ type: 'status', connection: {}, ts: 1 });
      send({ type: 'heartbeat', ts: 2 });
      expect(frames).toHaveLength(2);
      expect(frames[0]).toContain('"type":"status"');
      expect(frames[1]).toContain('"type":"heartbeat"');
    } finally {
      unsubscribe();
    }
  });

  it('honours the visible set for raw subscribers too', () => {
    const frames: string[] = [];
    const unsubscribe = subscribeRaw((f) => { frames.push(f); }, { symbols: ['BTCUSDT'] });
    try {
      stageTick('BTCUSDT', 100, 0);
      stageTick('DOGEUSDT', 1, 0);
      flushNowForTest();
      expect(frames[0]).toContain('BTCUSDT');
      expect(frames[0]).not.toContain('DOGEUSDT');
    } finally {
      unsubscribe();
    }
  });

  it('flushing an empty window writes nothing', () => {
    const frames: string[] = [];
    const unsubscribe = subscribeRaw((f) => { frames.push(f); });
    try {
      flushNowForTest();
      expect(frames).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('subscriberCount includes raw subscribers', () => {
    // This gates the 1s aggregate push. When it read 0 for a raw-only client the
    // `agg` event silently stopped reaching every real browser, so it is
    // asserted rather than left to inspection.
    const before = subscriberCount();
    const unsubscribe = subscribeRaw(() => {});
    try {
      expect(subscriberCount()).toBe(before + 1);
    } finally {
      unsubscribe();
    }
    expect(subscriberCount()).toBe(before);
  });
});