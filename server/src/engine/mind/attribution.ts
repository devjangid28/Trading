/**
 * Attribution-derived features, in their own module.
 *
 * Split out so `features.ts` depends on shapes rather than on the news engine.
 * A feature extractor that imports the scorer is a feature extractor whose
 * output changes when the scorer changes, and the tests for point-in-time
 * correctness stop being about time.
 *
 * Everything here is a reduction over `NewsItem[]` that the caller has already
 * sliced to `asOf`. The wall is enforced upstream in `newsAsOf`; re-slicing here
 * would be belt-and-braces at the cost of hiding where the guarantee lives.
 */

import { MIND } from '../../config.js';
import type { Measured, NewsItem } from '../../../../shared/types.js';
import { absent } from './features.js';

/**
 * What the caller can supply about attribution. Deliberately narrow: a coverage
 * number and the shares that produced it.
 *
 * When it is absent the coverage features stay `absent()` — which is what makes
 * an asset with no news story *look* unattributed rather than falsely covered.
 */
export interface AttributionFeatureSource {
  /** 0-100. Null when the move was not significant enough to attribute. */
  coveragePct: number | null;
  /** Per-driver shares summing to ~100 when coverage is non-null. */
  entries: Array<{ share: number; routine: boolean; reversalRisk: number | null }>;
  /** 0-1. Null when unmeasured. */
  reversalRisk: number | null;
}

export interface DerivedAttributionFeatures {
  coveragePct: Measured;
  routineDominates: Measured;
  reversalRisk: Measured;
  direction: -1 | 0 | 1 | null;
}

/**
 * Derive the catalyst features.
 *
 * `routineDominates` is the one that earns its keep: a routine price recap
 * carrying a high attribution share is the failure mode that produced bugs #6
 * and #7, and a Mind layer that ignores it would happily trade on the word
 * "holds".
 */
export function deriveAttributionFeatures(
  src: AttributionFeatureSource | null | undefined,
  news: NewsItem[],
  asOf: number,
): DerivedAttributionFeatures {
  // ── Direction: the strongest *aligned, non-routine* headline. ────────────
  let direction: -1 | 0 | 1 | null = null;
  let best = 0;
  for (const n of news) {
    if (n.routine) continue;
    const weight = Math.abs(n.direction) * n.nis;
    if (weight > best) {
      best = weight;
      direction = n.direction === 0 ? null : n.direction;
    }
  }

  // ── Reversal risk: take the maximum over the window. ─────────────────────
  let maxReversal: number | null = null;
  for (const n of news) {
    if (typeof n.reversalRisk !== 'number' || !Number.isFinite(n.reversalRisk)) continue;
    maxReversal = maxReversal === null ? n.reversalRisk : Math.max(maxReversal, n.reversalRisk);
  }

  // ── Attribution shares. ──────────────────────────────────────────────────
  if (!src || src.coveragePct === null || !Number.isFinite(src.coveragePct)) {
    return {
      coveragePct: absent(),
      // Without attribution we cannot claim commentary is dominating, and we
      // equally cannot claim it is not. This is `absent()`, not `false`.
      routineDominates: absent(),
      reversalRisk:
        maxReversal === null
          ? absent()
          : { value: maxReversal, at: asOf },
      direction,
    };
  }

  const entries = src.entries ?? [];
  let routineShare = 0;
  for (const e of entries) {
    if (e.routine && Number.isFinite(e.share)) routineShare += e.share;
  }

  const reversal: Measured =
    src.reversalRisk !== null && Number.isFinite(src.reversalRisk)
      ? { value: src.reversalRisk, at: asOf }
      : maxReversal === null
        ? absent()
        : { value: maxReversal, at: asOf };

  return {
    coveragePct: { value: src.coveragePct, at: asOf },
    routineDominates: {
      value: routineShare >= MIND.VETO_ROUTINE_COVERAGE_PCT ? 1 : 0,
      at: asOf,
    },
    reversalRisk: reversal,
    direction,
  };
}