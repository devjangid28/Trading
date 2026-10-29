import { useSyncExternalStore } from 'react';

/**
 * Freshness thresholds shared by the stream badge and every panel.
 *
 * These are duplicated from `server/src/config.ts` (LIVE.DELAYED_AFTER_MS /
 * LIVE.STALE_AFTER_MS) rather than imported, because the server config is a
 * Node module and pulling it into the browser bundle drags in `node:sqlite`
 * and the whole server graph with it.
 *
 * Keep the two in step. `server/test/freshness.test.ts` asserts the values
 * match, so drift is a test failure rather than a silent inconsistency.
 *
 * These used to be 90s / 240s. That was correct for a 60s board scan and
 * catastrophic for a price: an 85-second-old price rendered a green LIVE badge.
 * A price feed is judged on seconds, not on minutes — see the reasoning at the
 * `LIVE` definition in `server/src/config.ts`.
 */
export const LIVE = {
  /** Panel shows LIVE below this age. */
  DELAYED_AFTER_MS: 3_000,
  /** Panel shows STALE beyond this. */
  STALE_AFTER_MS: 6_000,
} as const;

export type Freshness = 'LIVE' | 'DELAYED' | 'STALE' | 'UNKNOWN';

/**
 * Classify a data age.
 *
 * `UNKNOWN` is distinct from `LIVE` on purpose: "we have never received
 * anything" and "we just received something" are opposite claims, and showing
 * an empty panel as LIVE is the failure mode this guards against.
 */
export function freshnessOf(ageMs: number | null | undefined): Freshness {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return 'UNKNOWN';
  // `>=` not `>`: at exactly the threshold the data has aged out, so it should
  // already read as degraded. Using `>` left the boundary millisecond in the
  // better bucket, which is the kind of off-by-one that makes a panel look
  // fresh for exactly one tick after it stopped being fresh.
  if (ageMs >= LIVE.STALE_AFTER_MS) return 'STALE';
  if (ageMs >= LIVE.DELAYED_AFTER_MS) return 'DELAYED';
  return 'LIVE';
}

/** Compact human form: "just now", "42s ago", "6m ago", "2h ago". */
export function ageLabel(ageMs: number | null | undefined): string {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs)) return 'no data';
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 3) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared age clock
//
// `FreshnessBadge` and `ValueAge` both need to age a number without calling
// `Date.now()` during render. Each one used to own a private 1s interval, and
// `ValueAge` is rendered once per board row — so a 200-row board ran 200 timers
// and forced 200 component re-renders every second, forever, whether or not
// the stream was alive. That was tolerable at a 1Hz data rate and is pure
// overhead at 5Hz.
//
// One interval, one subscription set. It only runs while something is mounted,
// and it stops entirely when the last subscriber leaves.
// ─────────────────────────────────────────────────────────────────────────────

const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function tickClock(): void {
  now = Date.now();
  for (const cb of [...clockListeners]) cb();
}

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb);
  if (!clockTimer) {
    clockTimer = setInterval(tickClock, CLOCK_MS);
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

/**
 * The clock period.
 *
 * [TUNED] 500ms. The freshness bands are seconds wide, so second-level
 * granularity is enough to place a value in the right band, and halving the
 * period from the previous 1000ms keeps the label from visibly skipping a
 * threshold boundary on the way past.
 */
export const CLOCK_MS = 500;

/**
 * A reactive "now" that ticks for as long as the component is mounted.
 *
 * Returns the current wall clock immediately so the first render already shows
 * a real age rather than a placeholder that corrects itself a frame later.
 */
export function useAgeClock(): number {
  return useSyncExternalStore(subscribeClock, () => now, () => now);
}
