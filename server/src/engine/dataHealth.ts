/**
 * The data-integrity gate.
 *
 * Spec rule 2: "Never generate a signal from incomplete, delayed, stale, mocked,
 * or unverified data. If data freshness fails, output NO TRADE with the reason."
 *
 * This module exists because the requirement was previously satisfied only in
 * prose. The audit that produced this file found the failure mode that prose
 * hides: `fetchAllNews().catch(() => [])` turned a news-feed outage into an
 * empty headline list, and `newsScore()` awards 5/10 for an empty list — the
 * same score a genuinely quiet asset earns. An outage was therefore scoring
 * indistinguishable from a real reading, and the board could print an A-grade
 * pick with the news feed dead.
 *
 * The distinction this file enforces, which the old code had no way to express:
 *
 *   BLOCK   the engine refuses to call a setup tradable. The reason is reported.
 *   DEGRADE the setup stays visible but the affected evidence is left
 *           UNMEASURED (`null`). Never scored as a mid-range number.
 *
 * `unknown != clear`. A veto derived from data we do not have is not a passed
 * veto; that is the single most important line in this file.
 *
 * Pure by construction: every input arrives as a parameter, there is no clock
 * read, no I/O and no import of the config's mutable state. The `asOf` a caller
 * passes IS the "now" for the whole computation, which is what makes the
 * no-lookahead property testable.
 */

import { HEALTH } from '../config.js';
import type { DataHealth, HealthBlock, StreamState } from '../../../shared/types.js';

export type { DataHealth, HealthBlock, StreamState };

/** What the caller observed. `null` means "I could not obtain it at all". */
export interface StreamObservation {
  /** Age of the newest datum in ms. `null` when there is no datum. */
  ageMs?: number | null;
  /** Set when the fetch itself failed. Distinguishes outage from silence. */
  unavailable?: string | null;
  /** Set when the stream is serving fixtures. */
  mock?: boolean;
}

/**
 * Grade one stream.
 *
 * Order matters and is not arbitrary: `unavailable` and `mock` are checked
 * before age, because "the feed is down" and "the feed is serving fixtures" are
 * facts about the feed, whereas age is only interpretable once it is alive.
 *
 * Both boundaries are per-stream. A single shared pair of thresholds is wrong
 * in both directions: an 8-second limit makes a healthy cached calendar look
 * dead, and a 3-second delay tolerance makes a normal 6-hour-old published
 * release schedule look "delayed", which the spec then disqualifies.
 */
export function classifyStream(
  obs: StreamObservation,
  maxAgeMs: number,
  delayedAfterMs: number,
): StreamState {
  if (obs.mock) return 'mock';
  if (obs.unavailable) return 'unavailable';
  const age = obs.ageMs;
  // No datum at all is not a fresh datum. `null` must never fall through to
  // 'live', which is precisely how a dead feed gets reported as healthy.
  if (age === null || age === undefined || !Number.isFinite(age) || age < 0) {
    return 'unavailable';
  }
  if (age > maxAgeMs) return 'stale';
  if (age > delayedAfterMs) return 'delayed';
  return 'live';
}

export interface HealthInput {
  asOf: number;
  price: StreamObservation;
  derivatives: StreamObservation;
  news: StreamObservation;
  calendar: StreamObservation;
  /** True when the process is serving fixtures. [V] */
  mock: boolean;
}

export function assessDataHealth(input: HealthInput): DataHealth {
  // Per-stream limits. Price is seconds-scale; news and the macro calendar are
  // cached for minutes and hours by design. Using one bound for all four made a
  // healthy calendar look stale purely because a scan took a few seconds.
  const price_stream = classifyStream(
    input.price, HEALTH.MAX_PRICE_AGE_MS, HEALTH.DELAYED_PRICE_AFTER_MS,
  );
  const derivatives = classifyStream(
    input.derivatives, HEALTH.MAX_DERIVATIVES_AGE_MS, HEALTH.DELAYED_DERIVATIVES_AFTER_MS,
  );
  const news = classifyStream(
    input.news, HEALTH.MAX_NEWS_AGE_MS, HEALTH.DELAYED_NEWS_AFTER_MS,
  );
  const macro_blackout = classifyStream(
    input.calendar, HEALTH.MAX_CALENDAR_AGE_MS, HEALTH.DELAYED_CALENDAR_AFTER_MS,
  );

  const blocking: HealthBlock[] = [];
  const degraded: HealthBlock[] = [];

  // ── Price: without a live price there is no structure, so nothing exists. ──
  if (price_stream !== 'live') {
    blocking.push({
      stream: 'price_stream',
      severity: 'block',
      reason:
        price_stream === 'stale'
          ? `price stream is ${Math.round((input.price.ageMs ?? 0) / 1000)}s old (limit ${HEALTH.MAX_PRICE_AGE_MS / 1000}s) — no structural decision on a stale price`
          : `price stream is ${price_stream} — no structural decision without a live price`,
    });
  }

  // ── Calendar: an outage must not disarm the blackout. ──────────────────────
  // This is the under-veto the audit found. With `BLOCK_ON_CALENDAR_UNAVAILABLE`
  // off, the failure mode is silent and severe: an empty calendar looks exactly
  // like "no events today", so the engine prints picks straight through CPI.
  if (macro_blackout !== 'live') {
    const block: HealthBlock = {
      stream: 'macro_blackout',
      severity: 'block',
      reason:
        macro_blackout === 'mock'
          ? 'macro calendar is mocked — a real release could be ignored'
          : `macro calendar is ${macro_blackout} — an unavailable calendar cannot clear a blackout (unknown != clear)`,
    };
    if (HEALTH.BLOCK_ON_CALENDAR_UNAVAILABLE) blocking.push(block);
    else degraded.push({ ...block, severity: 'degrade' });
  }

  // ── News: outage must not become a mid-range score. ───────────────────────
  if (news !== 'live') {
    const block: HealthBlock = {
      stream: 'news',
      severity: 'block',
      reason:
        news === 'mock'
          ? 'news feed is mocked — catalyst and veto context is not real'
          : news === 'unavailable'
            ? 'news feed unavailable — the catalyst context is unverified, and an empty feed is not "no news"'
            : `news feed is ${news} — catalyst context is behind the decision`,
    };
    if (HEALTH.BLOCK_ON_NEWS_UNAVAILABLE) blocking.push(block);
    else degraded.push({ ...block, severity: 'degrade' });
  }

  // ── Derivatives: degrade, do not block. ───────────────────────────────────
  // One of twelve gates. Losing it leaves the other eleven intact, so the setup
  // stays on the board as grade C / monitor with `derivatives: null` instead of
  // vanishing. Withholding the trade is the correct severity; withholding the
  // observation would throw away real structure evidence for nothing.
  if (derivatives !== 'live' && HEALTH.DEGRADE_ON_DERIVATIVES_UNAVAILABLE) {
    degraded.push({
      stream: 'derivatives',
      severity: 'degrade',
      reason:
        derivatives === 'unavailable'
          ? 'derivatives unavailable — funding, OI and liquidation checks are UNMEASURED, not passing'
          : `derivatives are ${derivatives} — positioning checks are UNMEASURED, not passing`,
    });
  }

  // ── Mock: demonstrable, never tradable. ───────────────────────────────────
  if (input.mock && !HEALTH.MOCK_IS_TRADABLE) {
    blocking.push({
      stream: 'mock',
      severity: 'block',
      reason: 'MOCK DATA — fixtures, not the market. Signals here prove the code path, not an edge.',
    });
  }

  const tradable = blocking.length === 0;

  return {
    price_stream,
    derivatives,
    news,
    macro_blackout,
    blocking,
    degraded,
    tradable,
    reason: tradable
      ? null
      : blocking.map((b) => b.reason).join('; '),
  };
}

/**
 * Fold a health verdict into a conviction grade.
 *
 * Spec: `NO TRADE` on any veto, stale data or unresolved risk. A blocked stream
 * is exactly that. The existing grade ladder is preserved otherwise — this only
 * ever moves a grade DOWN, never up, so it cannot manufacture an A.
 */
export function gradeWithHealth(
  grade: 'A' | 'B' | 'C',
  health: DataHealth,
): 'A' | 'B' | 'C' | 'NO TRADE' {
  if (!health.tradable) return 'NO TRADE';
  // A degraded stream caps at C. The reasoning survives as shadow evidence so
  // the ledger can later show whether the missing input would have mattered.
  if (health.degraded.length > 0 && grade !== 'C') return 'C';
  return grade;
}

/**
 * The exact sentence to attach to a `NO TRADE`. Kept here so the route, the
 * signal card and the report cannot drift apart.
 */
export function healthSentence(health: DataHealth): string {
  if (health.tradable && health.degraded.length === 0) return 'data health nominal';
  const parts: string[] = [];
  if (health.blocking.length > 0) parts.push(health.reason ?? 'blocked');
  if (health.degraded.length > 0) {
    parts.push(health.degraded.map((d) => d.reason).join('; '));
  }
  return parts.join(' | ');
}