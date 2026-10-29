/**
 * Regime classifier.
 *
 * Six states, one verdict per scan, and — the part that matters — an **evidence
 * list** alongside it. A regime badge that cannot be argued with is a vibe with
 * extra steps, so `classifyRegime` returns the readings that produced it. When
 * the UI shows "Range", the evidence says which inputs said so and how strongly.
 *
 * Precedence is deliberate and ordered by how much the state should suppress
 * trading:
 *
 *   1. `macro-blackout`  — a scheduled event, not a market condition. Nothing
 *                          about the tape overrides "CPI prints in 20 minutes".
 *   2. `high-vol-cascade`— liquidation velocity dominates; structure is noise.
 *   3. `trending-bull` / `trending-bear` — direction + participation agree.
 *   4. `range`           — real, but a trend setup has no edge in it.
 *   5. `quiet`           — the default when nothing measured. **Not** a bullish
 *                          claim; it is the absence of a claim.
 *
 * `quiet` is last and is the fallback. A classifier that defaults to a
 * directional state would invent direction from missing data.
 */

import { MIND } from '../../config.js';
import type { Measured, MindRegime } from '../../../../shared/types.js';
import { num } from './features.js';

/** The market-wide readings the classifier is allowed to use. */
export interface RegimeInputs {
  /** Bullish share of the board, 0-1. */
  breadthRatio: number | null;
  /** BTC's move over the scan window, fraction. */
  btcChangePct: number | null;
  /** Median absolute move across the board, fraction. Typical size right now. */
  medianAbsChangePct: number | null;
  /** 5-minute liquidation notional as a fraction of total volume. */
  liqVelocityFrac: number | null;
  /** BTC dominance move over the window, percentage points. */
  btcDominanceShiftPp: number | null;
  /** ATR percentile from the engine's volatility context. */
  atrPercentile: number | null;
  /** 1h open-interest change, fraction. */
  oiChange1h: number | null;
  /** Minutes until the next tier-1 release; negative once inside the window. */
  macroBlackoutMin: number | null;
  /** Directional thrust on the asset being scored, fraction. Signed. */
  assetChangePct: number | null;
}

export interface RegimeEvidence {
  input: string;
  value: number | string | null;
  reading: string;
}

export interface RegimeVerdict {
  regime: MindRegime;
  evidence: RegimeEvidence[];
  /** True when a direction is asserted. `quiet` and `range` are not directional. */
  directional: boolean;
}

/** Human-readable reading for one input. Never a bare number with no meaning. */
function reading(name: string, value: number | null, verdict: string): RegimeEvidence {
  return {
    input: name,
    value: value === null ? null : Number(value.toFixed(4)),
    reading: value === null ? `${verdict} — not measured` : verdict,
  };
}

/**
 * Classify the market regime.
 *
 * Pure. Every input nullable, and a null input narrows the claim rather than
 * defaulting toward a direction.
 */
export function classifyRegime(i: RegimeInputs): RegimeVerdict {
  const evidence: RegimeEvidence[] = [];

  // ── 1. Macro blackout. Highest precedence by design. ──────────────────────
  const blackout = i.macroBlackoutMin;
  if (blackout !== null && Number.isFinite(blackout) && blackout <= MIND.VETO_BLACKOUT_MIN) {
    evidence.push(
      reading(
        'macroBlackoutMin',
        blackout,
        blackout < 0
          ? 'inside the blackout window — tier-1 event in progress or imminent'
          : `tier-1 release in ${Math.round(blackout)} min`,
      ),
    );
    return { regime: 'macro-blackout', evidence, directional: false };
  }
  evidence.push(
    reading(
      'macroBlackoutMin',
      blackout,
      blackout === null
        ? 'no calendar reading — blackout cannot be ruled out'
        : `next tier-1 in ${Math.round(blackout)} min`,
    ),
  );

  // ── 2. Liquidation cascade. ───────────────────────────────────────────────
  const liq = i.liqVelocityFrac;
  const cascade = liq !== null && liq >= MIND.REGIME_LIQ_CASCADE_USD;
  evidence.push(
    reading(
      'liqVelocityFrac',
      liq,
      liq === null
        ? 'no liquidation feed on this path'
        : cascade
          ? `liquidation velocity ${(liq * 100).toFixed(2)}% of volume — cascade`
          : `liquidation velocity ${(liq * 100).toFixed(2)}% of volume`,
    ),
  );
  if (cascade) {
    return { regime: 'high-vol-cascade', evidence, directional: false };
  }

  // ── 3. Direction. Needs participation, not just a price move. ─────────────
  const breadth = i.breadthRatio;
  const breadthOneSided = breadth !== null && Math.abs(breadth - 0.5) >= MIND.REGIME_BREADTH_STRONG - 0.5;
  evidence.push(
    reading(
      'breadthRatio',
      breadth,
      breadth === null
        ? 'board too small to read breadth'
        : breadthOneSided
          ? `breadth one-sided at ${(breadth * 100).toFixed(0)}% bullish`
          : `breadth mixed at ${(breadth * 100).toFixed(0)}% bullish`,
    ),
  );

  const btc = i.btcChangePct;
  evidence.push(
    reading(
      'btcChangePct',
      btc,
      btc === null
        ? 'BTC move not measured'
        : `BTC ${btc >= 0 ? '+' : ''}${(btc * 100).toFixed(2)}% over the window`,
    ),
  );

  // A trend needs BTC to be moving AND breadth to agree. Either alone is a
  // single-asset move, which is the single most common way a regime label
  // becomes wrong.
  const btcMoving = btc !== null && Math.abs(btc) >= MIND.REGIME_PRICE_THRUST;
  const atrHigh = i.atrPercentile !== null && i.atrPercentile >= MIND.REGIME_ATR_PCTL_HIGH;
  evidence.push(
    reading(
      'atrPercentile',
      i.atrPercentile,
      i.atrPercentile === null
        ? 'ATR percentile not measured'
        : atrHigh
          ? `volatility expansion — ATR at p${Math.round(i.atrPercentile)}`
          : `ATR at p${Math.round(i.atrPercentile)}`,
    ),
  );

  const oi = i.oiChange1h;
  evidence.push(
    reading(
      'oiChange1h',
      oi,
      oi === null
        ? 'no open interest on this path'
        : Math.abs(oi) >= MIND.REGIME_OI_THRUST
          ? `OI thrust ${(oi * 100).toFixed(2)}% in 1h — positioning moving`
          : `OI ${(oi * 100).toFixed(2)}% in 1h`,
    ),
  );

  if (btcMoving && breadthOneSided) {
    const up = (btc ?? 0) > 0;
    // Breadth and BTC must agree. If BTC is up but 20% of the board is bullish,
    // the board is not confirming and "trending-bull" would be a lie.
    const agree = up ? (breadth ?? 0) > 0.5 : (breadth ?? 0) < 0.5;
    // Recorded either way. The contradiction case is precisely the one where a
    // reader most wants to see why no trend was asserted, so it must not be the
    // branch that falls through silently.
    evidence.push(
      reading(
        'breadth vs BTC',
        breadth,
        `breadth ${agree ? 'confirms' : 'contradicts'} the ${up ? 'bullish' : 'bearish'} BTC move`,
      ),
    );
    if (agree) {
      return {
        regime: up ? 'trending-bull' : 'trending-bear',
        evidence,
        directional: true,
      };
    }
  }

  // ── 4. Range: a real, measurable state with no directional claim. ─────────
  const medianAbs = i.medianAbsChangePct;
  const lowEnergy = medianAbs !== null && medianAbs < MIND.REGIME_PRICE_THRUST;
  evidence.push(
    reading(
      'medianAbsChangePct',
      medianAbs,
      medianAbs === null
        ? 'no board to measure typical move'
        : lowEnergy
          ? `typical move ${(medianAbs * 100).toFixed(2)}% — low energy`
          : `typical move ${(medianAbs * 100).toFixed(2)}%`,
    ),
  );
  if (lowEnergy && !btcMoving) {
    return { regime: 'range', evidence, directional: false };
  }

  // ── 5. Quiet. The honest default: nothing was asserted. ──────────────────
  const dom = i.btcDominanceShiftPp;
  evidence.push(
    reading(
      'btcDominanceShiftPp',
      dom,
      dom === null
        ? 'dominance not measured'
        : Math.abs(dom) >= MIND.REGIME_DOMINANCE_SHIFT_PP
          ? `dominance rotated ${dom >= 0 ? '+' : ''}${dom.toFixed(2)}pp — rotation regime`
          : `dominance ${dom >= 0 ? '+' : ''}${dom.toFixed(2)}pp`,
    ),
  );

  return { regime: 'quiet', evidence, directional: false };
}

/**
 * Build regime inputs from a feature vector plus the market-wide readings the
 * vector does not carry (it carries breadth, but not BTC's own move or the
 * liquidation velocity, because those are properties of the market rather than
 * of one asset).
 */
export function regimeInputsFrom(
  features: { regime: { breadthRatio: Measured }; context: { atrPercentile: Measured } },
  market: {
    btcChangePct: number | null;
    medianAbsChangePct: number | null;
    liqVelocityFrac: number | null;
    btcDominanceShiftPp: number | null;
    oiChange1h: number | null;
    macroBlackoutMin: number | null;
    assetChangePct: number | null;
  },
): RegimeInputs {
  return {
    breadthRatio: num(features.regime.breadthRatio),
    atrPercentile: num(features.context.atrPercentile),
    ...market,
  };
}