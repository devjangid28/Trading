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
 */
export const LIVE = {
  /** Panel shows LIVE below this age. */
  DELAYED_AFTER_MS: 90_000,
  /** Panel shows STALE beyond this. */
  STALE_AFTER_MS: 240_000,
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