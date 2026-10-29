import { describe, it, expect } from 'vitest';
import { isRateLimitedStatus, coolOffMs, HttpError } from '../src/lib/http.js';
import { edgeLabel, HALF_BUCKETS } from '../src/engine/butterfly.js';

/**
 * Rate-limit handling.
 *
 * Found in production, not theorised: repeated server launches pushed the
 * request rate over Binance's weight quota and every scan started returning
 * HTTP 418. These tests pin the two decisions that came out of it — 418 counts
 * as a rate limit rather than an ordinary client error, and the cool-off
 * escalates so a client that keeps getting limited eventually stops trying.
 */

describe('isRateLimitedStatus', () => {
  it('treats 418 as a rate limit', () => {
    // Binance's 418 is a "teapot" that in practice means "slow down", not
    // "your request was malformed". Treating it as an ordinary 4xx made us
    // fail instantly with no backoff at all.
    expect(isRateLimitedStatus(418)).toBe(true);
  });

  it('treats 429 as a rate limit', () => {
    expect(isRateLimitedStatus(429)).toBe(true);
  });

  it('does not treat ordinary client errors as rate limits', () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isRateLimitedStatus(s)).toBe(false);
    }
  });

  it('does not treat server errors as rate limits', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isRateLimitedStatus(s)).toBe(false);
    }
  });
});

describe('coolOffMs', () => {
  it('is deterministic with zero jitter, so tests can assert it', () => {
    // The old ladder was 5s / 20s / 60s. That is what let a self-inflicted 429
    // escalate into a 418, so it was replaced by the ladder Binance documents:
    // "IP bans are tracked and scale in duration for repeat offenders, from 2
    // minutes to 3 days."
    expect(coolOffMs(1, 0)).toBe(120_000);
    expect(coolOffMs(2, 0)).toBe(300_000);
    expect(coolOffMs(3, 0)).toBe(900_000);
  });

  it('escalates monotonically with repeated offences', () => {
    const a = coolOffMs(1, 0);
    const b = coolOffMs(2, 0);
    const c = coolOffMs(3, 0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('caps at the documented 3-day maximum rather than growing without limit', () => {
    expect(coolOffMs(50, 0)).toBe(72 * 3600_000);
  });

  it('treats a nonsensical strike count as a first offence', () => {
    expect(coolOffMs(0, 0)).toBe(120_000);
    expect(coolOffMs(-1, 0)).toBe(120_000);
  });

  it('keeps jitter inside the requested window', () => {
    for (let i = 0; i < 200; i++) {
      const v = coolOffMs(1, 1_500);
      expect(v).toBeGreaterThanOrEqual(120_000);
      expect(v).toBeLessThan(121_500);
    }
  });
});

describe('HttpError', () => {
  it('carries the status so callers can branch on it', () => {
    const e = new HttpError('klines -> HTTP 418', 418, 'https://x');
    expect(e.status).toBe(418);
    expect(e.name).toBe('HttpError');
    expect(e.message).toContain('418');
  });
});

describe('edgeLabel contract', () => {
  it('never renders Infinity into the UI', () => {
    // Re-exported from the chart module; the assertion lives here so a
    // regression is caught even if the chart stops using it.
    expect(edgeLabel(Infinity)).not.toMatch(/Infinity/);
    expect(edgeLabel(-Infinity)).not.toMatch(/Infinity/);
  });

  it('keeps the open bucket readable on both sides', () => {
    expect(edgeLabel(Infinity)).toBe(edgeLabel(-Infinity));
  });
});

describe('butterfly half-width', () => {
  it('is positive, so the bucket array is non-degenerate', () => {
    expect(HALF_BUCKETS).toBeGreaterThan(0);
  });
});