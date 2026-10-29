import { describe, it, expect } from 'vitest';
import { freshnessOf, ageLabel, LIVE } from '../../src/lib/freshness.js';
import { LIVE as SERVER_LIVE } from '../src/config.js';

/**
 * Freshness classification.
 *
 * The subtle case is UNKNOWN. A panel that has never received data must not
 * claim to be LIVE: that is the difference between "no data yet" and "data
 * arriving now", and conflating them is how a dead feed ends up showing a
 * green badge over frozen prices.
 */

describe('freshness thresholds', () => {
  it('client and server agree on the DELAYED threshold', () => {
    // These are duplicated because the server config cannot be imported into
    // the browser bundle. This test is the guard on that duplication.
    expect(LIVE.DELAYED_AFTER_MS).toBe(SERVER_LIVE.DELAYED_AFTER_MS);
    expect(LIVE.STALE_AFTER_MS).toBe(SERVER_LIVE.STALE_AFTER_MS);
  });

  it('STALE is further out than DELAYED', () => {
    expect(LIVE.STALE_AFTER_MS).toBeGreaterThan(LIVE.DELAYED_AFTER_MS);
  });

  it('the LIVE window is seconds wide, not minutes', () => {
    // This is a regression guard with teeth.
    //
    // The thresholds were 90_000 / 240_000, which were correct for a 60s board
    // scan and wrong for a price: an 85-second-old price rendered a green LIVE
    // badge. The house rule is "STALE is never rendered as LIVE", and an
    // over-generous constant breaks it exactly as effectively as a wrong one.
    //
    // The window must also be several flush intervals wide, or a single dropped
    // frame would flicker the badge off LIVE.
    expect(LIVE.DELAYED_AFTER_MS).toBeGreaterThanOrEqual(SERVER_LIVE.TICK_PUSH_MS * 5);
    expect(LIVE.DELAYED_AFTER_MS).toBeLessThanOrEqual(10_000);
    expect(LIVE.STALE_AFTER_MS).toBeLessThanOrEqual(30_000);
  });
});

describe('freshnessOf', () => {
  it('treats a reading inside the push cadence as LIVE', () => {
    expect(freshnessOf(0)).toBe('LIVE');
    expect(freshnessOf(SERVER_LIVE.TICK_PUSH_MS)).toBe('LIVE');
    expect(freshnessOf(SERVER_LIVE.TICK_PUSH_MS * 4)).toBe('LIVE');
  });

  it('does not call a multi-second-old price LIVE', () => {
    // The bug, stated as an assertion. Under the old thresholds every one of
    // these returned 'LIVE' for a price up to 85 seconds out of date.
    expect(freshnessOf(5_000)).toBe('DELAYED');
    expect(freshnessOf(30_000)).toBe('STALE');
    expect(freshnessOf(85_000)).toBe('STALE');
  });

  it('treats the exact DELAYED boundary as DELAYED, not LIVE', () => {
    expect(freshnessOf(LIVE.DELAYED_AFTER_MS)).toBe('DELAYED');
  });

  it('treats one millisecond inside the boundary as LIVE', () => {
    expect(freshnessOf(LIVE.DELAYED_AFTER_MS - 1)).toBe('LIVE');
  });

  it('treats one millisecond past STALE as STALE, not DELAYED', () => {
    expect(freshnessOf(LIVE.STALE_AFTER_MS + 1)).toBe('STALE');
    expect(freshnessOf(LIVE.STALE_AFTER_MS - 1)).toBe('DELAYED');
  });

  it('treats the exact STALE boundary as STALE', () => {
    expect(freshnessOf(LIVE.STALE_AFTER_MS)).toBe('STALE');
  });

  it('returns UNKNOWN for null rather than defaulting to LIVE', () => {
    expect(freshnessOf(null)).toBe('UNKNOWN');
    expect(freshnessOf(undefined)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for non-finite input', () => {
    expect(freshnessOf(NaN)).toBe('UNKNOWN');
    expect(freshnessOf(Infinity)).toBe('UNKNOWN');
  });

  it('never reports LIVE for missing data, whatever the input', () => {
    for (const v of [null, undefined, NaN]) {
      expect(freshnessOf(v)).not.toBe('LIVE');
    }
  });
});

describe('ageLabel', () => {
  it('says "just now" for the first few seconds', () => {
    expect(ageLabel(0)).toBe('just now');
    expect(ageLabel(2_000)).toBe('just now');
  });

  it('reports seconds under a minute', () => {
    expect(ageLabel(42_000)).toBe('42s ago');
  });

  it('reports minutes under an hour', () => {
    expect(ageLabel(6 * 60_000)).toBe('6m ago');
  });

  it('reports hours under a day', () => {
    expect(ageLabel(2 * 3600_000)).toBe('2h ago');
  });

  it('reports days beyond a day', () => {
    expect(ageLabel(50 * 3600_000)).toBe('2d ago');
  });

  it('says "no data" rather than a misleading zero', () => {
    expect(ageLabel(null)).toBe('no data');
  });

  it('clamps a negative age instead of printing a negative time', () => {
    // Happens when the client clock is behind the server's asOf.
    expect(ageLabel(-5_000)).toBe('just now');
  });
});