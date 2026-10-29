/**
 * Spec test requirement 7:
 *
 *   "Data-integrity tests: stale feed, missing candle, duplicate tick, WebSocket
 *    disconnect, and API failure must produce NO TRADE, not a fake signal."
 *
 * Every case here is a way the engine used to keep trading while blind. Each one
 * now has to fail closed, and the failure has to CARRY A REASON — a silent
 * `NO TRADE` is indistinguishable from a quiet market, which is how the original
 * bugs stayed hidden.
 *
 * `assessDataHealth` is pure, so these are exact rather than timing-dependent.
 * The clock is injected as `asOf` precisely so a test cannot accidentally pass
 * because the wall clock happened to line up.
 */

import { describe, it, expect } from 'vitest';
import {
  assessDataHealth,
  classifyStream,
  gradeWithHealth,
  healthSentence,
  type DataHealth,
  type StreamObservation,
} from '../src/engine/dataHealth.js';
import { HEALTH } from '../src/config.js';

const NOW = 1_700_000_000_000;

/** A fully healthy context; individual tests break exactly one thing. */
function ok(over: Partial<Parameters<typeof assessDataHealth>[0]> = {}) {
  return assessDataHealth({
    asOf: NOW,
    price: { ageMs: 200 },
    derivatives: { ageMs: 200 },
    news: { ageMs: 200 },
    calendar: { ageMs: 200 },
    mock: false,
    ...over,
  });
}

describe('classifyStream', () => {
  // Both boundaries are per-stream, so the tests pass them explicitly. The
  // price numbers are the realistic ones; the calendar's are deliberately huge.
  const price = { max: HEALTH.MAX_PRICE_AGE_MS, delayed: HEALTH.DELAYED_PRICE_AFTER_MS };

  it('reports live only for a genuinely recent, available datum', () => {
    expect(classifyStream({ ageMs: 0 }, price.max, price.delayed)).toBe('live');
    expect(classifyStream({ ageMs: price.delayed - 1 }, price.max, price.delayed)).toBe('live');
  });

  it('separates delayed from stale', () => {
    expect(classifyStream({ ageMs: price.delayed + 1 }, price.max, price.delayed)).toBe('delayed');
    expect(classifyStream({ ageMs: price.max }, price.max, price.delayed)).toBe('delayed');
    expect(classifyStream({ ageMs: price.max + 1 }, price.max, price.delayed)).toBe('stale');
  });

  it('never reports LIVE for missing data', () => {
    // The specific bug class this whole gate exists for: a null age falling
    // through to the fresh branch.
    expect(classifyStream({ ageMs: null }, price.max, price.delayed)).toBe('unavailable');
    expect(classifyStream({ ageMs: undefined }, price.max, price.delayed)).toBe('unavailable');
    expect(classifyStream({}, price.max, price.delayed)).toBe('unavailable');
    expect(classifyStream({ ageMs: Number.NaN }, price.max, price.delayed)).toBe('unavailable');
    expect(classifyStream({ ageMs: Number.POSITIVE_INFINITY }, price.max, price.delayed)).toBe('unavailable');
    expect(classifyStream({ ageMs: -1 }, price.max, price.delayed)).toBe('unavailable');
  });

  it('prefers unavailable and mock over age', () => {
    // "The feed is down" and "the feed is fixtures" are facts about the feed.
    // Age is only interpretable once the feed is alive.
    expect(classifyStream({ ageMs: 1, unavailable: 'HTTP 503' }, price.max, price.delayed)).toBe('unavailable');
    expect(classifyStream({ ageMs: 1, mock: true }, price.max, price.delayed)).toBe('mock');
    expect(classifyStream({ ageMs: 999_999, mock: true }, price.max, price.delayed)).toBe('mock');
  });

  it('treats an observation with nothing in it as unavailable', () => {
    expect(classifyStream({}, price.max, price.delayed)).toBe('unavailable');
  });
});

describe('a healthy stack trades', () => {
  it('is tradable with no blocks and no degraded streams', () => {
    const h = ok();
    expect(h.tradable).toBe(true);
    expect(h.blocking).toEqual([]);
    expect(h.degraded).toEqual([]);
    expect(h.reason).toBeNull();
    expect(h.price_stream).toBe('live');
    expect(healthSentence(h)).toBe('data health nominal');
  });
});

describe('spec rule 2 — every failure closes the gate', () => {
  it('a stale price stream blocks, with the age in the reason', () => {
    const h = ok({ price: { ageMs: HEALTH.MAX_PRICE_AGE_MS + 5_000 } });
    expect(h.tradable).toBe(false);
    expect(h.price_stream).toBe('stale');
    expect(h.reason).toMatch(/price stream is \d+s old/);
    expect(healthSentence(h)).toMatch(/price stream/);
  });

  it('a dead price stream blocks even with no age recorded', () => {
    const h = ok({ price: { ageMs: null } });
    expect(h.tradable).toBe(false);
    expect(h.price_stream).toBe('unavailable');
  });

  it('an UNAVAILABLE CALENDAR blocks — unknown is not clear', () => {
    // The single most consequential case. With an empty calendar the old code
    // found no blackout, printed nothing wrong, and emitted A-grade picks
    // straight through CPI.
    const h = ok({ calendar: { ageMs: 10, unavailable: 'HTTP 502 from bea.gov' } });
    expect(h.tradable).toBe(false);
    expect(h.macro_blackout).toBe('unavailable');
    expect(h.reason).toMatch(/macro calendar is unavailable/);
    expect(h.reason).toMatch(/unknown != clear/);
    expect(h.blocking.some((b) => b.stream === 'macro_blackout')).toBe(true);
  });

  it('an UNAVAILABLE NEWS FEED blocks — an empty feed is not "no news"', () => {
    // The old path: `fetchAllNews().catch(() => [])` then a 5/10 score for the
    // empty list, identical to the score a genuinely quiet asset earned.
    const h = ok({ news: { ageMs: 10, unavailable: 'RSS timeout' } });
    expect(h.tradable).toBe(false);
    expect(h.news).toBe('unavailable');
    expect(h.reason).toMatch(/news feed unavailable/);
  });

  it('a stale news feed blocks', () => {
    const h = ok({ news: { ageMs: HEALTH.MAX_NEWS_AGE_MS + 1 } });
    expect(h.tradable).toBe(false);
    expect(h.news).toBe('stale');
  });

  it('a merely DELAYED news feed also blocks - the spec disqualifies delayed', () => {
    // Spec rule 2 lists "delayed" as a disqualifier alongside stale. This is the
    // line between "current enough to trade" and "behind", and it sits well
    // below the stale bound, so the two must not be conflated.
    expect(ok({ news: { ageMs: HEALTH.DELAYED_NEWS_AFTER_MS + 1 } }).tradable).toBe(false);
    expect(ok({ news: { ageMs: HEALTH.DELAYED_NEWS_AFTER_MS - 1 } }).tradable).toBe(true);
  });

  it('uses a per-stream threshold, not the price one', () => {
    // A 6-hour-old published release schedule is normal, not "delayed". Judging
    // it against the seconds-scale price threshold closed the gate on every scan.
    expect(ok({ calendar: { ageMs: 3 * 3600_000 } }).macro_blackout).toBe('live');
    expect(ok({ calendar: { ageMs: 3 * 3600_000 } }).tradable).toBe(true);
    expect(ok({ calendar: { ageMs: HEALTH.MAX_CALENDAR_AGE_MS + 1 } }).tradable).toBe(false);
    // Derivatives are rebuilt per scan, so 10 s is comfortably live; 30 s is
    // deliberately `delayed` under this threshold.
    expect(ok({ derivatives: { ageMs: 10_000 } }).derivatives).toBe('live');
    expect(ok({ derivatives: { ageMs: 30_000 } }).derivatives).toBe('delayed');
  });

  it('MOCK blocks, and says so in words', () => {
    const h = ok({ mock: true });
    expect(h.tradable).toBe(false);
    expect(h.reason).toMatch(/MOCK DATA/);
    expect(h.blocking.some((b) => b.stream === 'mock')).toBe(true);
  });

  it('reports EVERY blocked stream, not just the first', () => {
    const h = ok({
      price: { ageMs: null },
      news: { ageMs: 10, unavailable: 'down' },
      calendar: { ageMs: 10, unavailable: 'down' },
    });
    const streams = h.blocking.map((b) => b.stream);
    expect(streams).toContain('price_stream');
    expect(streams).toContain('news');
    expect(streams).toContain('macro_blackout');
    expect(h.blocking.length).toBe(3);
  });
});

describe('derivatives degrade rather than block', () => {
  it('downgrades but does not close the board', () => {
    // One of twelve gates. Throwing away a real structural setup because the
    // derivatives feed blipped would be throwing away real evidence for nothing.
    const h = ok({ derivatives: { ageMs: 10, unavailable: 'binance 418' } });
    expect(h.tradable).toBe(true);
    expect(h.derivatives).toBe('unavailable');
    expect(h.degraded).toHaveLength(1);
    expect(h.degraded[0].severity).toBe('degrade');
    expect(h.degraded[0].reason).toMatch(/UNMEASURED, not passing/);
  });

  it('stale derivatives also only degrade', () => {
    const h = ok({ derivatives: { ageMs: HEALTH.MAX_DERIVATIVES_AGE_MS + 1 } });
    expect(h.tradable).toBe(true);
    expect(h.degraded).toHaveLength(1);
  });
});

describe('gradeWithHealth', () => {
  const blocked: DataHealth = ok({ news: { ageMs: 1, unavailable: 'down' } });
  const degraded: DataHealth = ok({ derivatives: { ageMs: 1, unavailable: 'down' } });
  const healthy: DataHealth = ok();

  it('forces NO TRADE on a blocked stream, from any grade', () => {
    expect(gradeWithHealth('A', blocked)).toBe('NO TRADE');
    expect(gradeWithHealth('B', blocked)).toBe('NO TRADE');
    expect(gradeWithHealth('C', blocked)).toBe('NO TRADE');
  });

  it('caps at C on a degraded stream', () => {
    expect(gradeWithHealth('A', degraded)).toBe('C');
    expect(gradeWithHealth('B', degraded)).toBe('C');
    // Already C stays C — the gate only ever moves a grade down.
    expect(gradeWithHealth('C', degraded)).toBe('C');
  });

  it('leaves a healthy grade untouched', () => {
    expect(gradeWithHealth('A', healthy)).toBe('A');
    expect(gradeWithHealth('B', healthy)).toBe('B');
    expect(gradeWithHealth('C', healthy)).toBe('C');
  });

  it('can never promote a grade', () => {
    // Exhaustively: no input combination may produce a higher grade than it
    // started with. This is the invariant that stops a "safety" feature from
    // quietly becoming a bias.
    const inputs: DataHealth[] = [blocked, degraded, healthy];
    for (const h of inputs) {
      for (const g of ['A', 'B', 'C'] as const) {
        const out = gradeWithHealth(g, h);
        if (out === 'NO TRADE') continue;
        const rank = { A: 3, B: 2, C: 1 } as const;
        expect(rank[out]).toBeLessThanOrEqual(rank[g]);
      }
    }
  });
});

describe('the gate is a pure function of its inputs', () => {
  it('produces an identical verdict for identical input', () => {
    const input: Parameters<typeof assessDataHealth>[0] = {
      asOf: NOW,
      price: { ageMs: 100 },
      derivatives: { ageMs: 100 },
      news: { ageMs: 100, unavailable: 'x' },
      calendar: { ageMs: 100 },
      mock: false,
    };
    const a = assessDataHealth(input);
    const b = assessDataHealth(input);
    expect(a).toEqual(b);
    // `asOf` is passed, not read, which is what makes the no-lookahead property
    // of the gate itself testable.
    expect(assessDataHealth({ ...input, asOf: NOW + 10_000 }).news).toBe('unavailable');
  });

  it('an observation object with nothing in it is unavailable', () => {
    const empty: StreamObservation = {};
    expect(classifyStream(empty, HEALTH.MAX_PRICE_AGE_MS, HEALTH.DELAYED_PRICE_AFTER_MS)).toBe('unavailable');
  });
});