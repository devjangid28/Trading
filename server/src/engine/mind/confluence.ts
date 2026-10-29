/**
 * Confluence scorer — the thinking core.
 *
 * ## The one design decision everything else follows from
 *
 * **The intercept is the ledger's observed base rate, not 50%.**
 *
 * `logit(p) = logit(baseRate) + (feature push) / temperature`
 *
 * This is what makes the layer honest while its weights are untuned. A logistic
 * model whose weights are all zero predicts a constant; the best constant is the
 * base rate, so a zero-weight model anchored here is **calibrated by
 * construction**. Any deviation from the base rate has to be earned by a feature
 * that actually carries information, and `npm run mind:report` prints the live
 * Brier against that bar so the claim is checkable rather than asserted.
 *
 * The alternative — anchoring at 50% — is what produces the "our model is 87%
 * confident" screens this project is trying to get away from. Anchoring at 50%
 * with untuned weights means the average signal is a coin flip dressed as a
 * forecast.
 *
 * ## What the hard vetoes are for
 *
 * A veto is not a penalty. It forces `probability = 0` and NO TRADE, and it is
 * recorded as a `MindVeto` with a rule name so the UI can explain the refusal.
 * Penalties let a strong-looking setup talk its way past a blacked-out calendar;
 * a veto does not.
 *
 * ## Why weights are `[TUNED]`
 *
 * `CONVICTION.WEIGHTS` is reused as the base model exactly as specified, and it
 * is hand-tuned. Nothing here is fitted. `calibrate.ts` measures whether the
 * result beats the base rate and reports it either way.
 */

import { CONVICTION, MIND } from '../../config.js';
import type {
  Driver,
  FeatureVector,
  Measured,
  MindRegime,
  MindVeto,
  Side,
  TradePlan,
} from '../../../../shared/types.js';
import { num } from './features.js';

// ─────────────────────────────────────────────────────────────────────────────
// Probability
// ─────────────────────────────────────────────────────────────────────────────

/** Numerically safe logistic. `Math.exp` overflows past ~709. */
export function logistic(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Inverse logistic. Clamped so a 0% or 100% base rate cannot produce Infinity. */
export function logit(p: number): number {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

export interface BaseRate {
  /** Observed win frequency of resolved signals. */
  rate: number;
  /** How many resolved signals it came from. */
  samples: number;
  source: 'ledger' | 'prior';
}

/**
 * Blend the ledger's observed win rate with a neutral prior.
 *
 * Below `BASE_RATE_MIN_SAMPLES` the observed rate is treated as unreliable and
 * the model leans on the prior instead. It does not silently fall back to 50% —
 * it blends, and it reports which it used, because "we don't know yet" and
 * "we know it's a coin flip" are different statements.
 */
export function resolveBaseRate(observed: number | null, samples: number): BaseRate {
  const PRIOR = 0.5;
  const clamped =
    observed === null || !Number.isFinite(observed)
      ? null
      : Math.min(Math.max(observed, 1e-6), 1 - 1e-6);
  const reliable = clamped !== null && samples >= MIND.BASE_RATE_MIN_SAMPLES;
  if (reliable) return { rate: clamped, samples, source: 'ledger' };
  if (clamped === null) {
    return { rate: PRIOR, samples: 0, source: 'prior' };
  }
  const blend = MIND.BASE_RATE_PRIOR_BLEND;
  return { rate: clamped * (1 - blend) + PRIOR * blend, samples, source: 'prior' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group scores
// ─────────────────────────────────────────────────────────────────────────────

/** One group's signed push on the log-odds, and the drivers behind it. */
export interface GroupScore {
  /** In [-1, 1]. 0 is neutral. */
  score: number;
  drivers: Driver[];
}

function driver(
  feature: string,
  contribution: number,
  reason: string,
  disclosure = false,
): Driver {
  return { feature, contribution: Number(contribution.toFixed(4)), reason, ...(disclosure ? { disclosure: true } : {}) };
}

/** Signed value of a measurement, or null when unmeasured. */
function v(m: Measured): number | null {
  return num(m);
}

/**
 * Structure (weight 25): does the tape support the zone?
 *
 * Deliberately rewards *measured agreement*, not the presence of a setup. A coin
 * with an order block and nothing else is worth the same as no coin.
 */
function scoreStructure(f: FeatureVector, side: Side): GroupScore {
  const drivers: Driver[] = [];
  let total = 0;
  let counted = 0;
  const wantUp = side === 'bullish';
  const sign = wantUp ? 1 : -1;

  // HTF agreement across the three frames.
  for (const [label, m] of [
    ['structure.htf15m', f.structure.htf15m],
    ['structure.htf1h', f.structure.htf1h],
    ['structure.htf4h', f.structure.htf4h],
  ] as const) {
    const val = v(m);
    if (val === null) continue;
    counted += 1;
    // htfAgreement returns +1 aligned / -1 opposed, in absolute terms.
    total += val;
    drivers.push(
      driver(
        label,
        val * 0.5,
        val > 0
          ? `${label.replace('structure.htf', '')} agrees with a ${side} setup`
          : val < 0
            ? `${label.replace('structure.htf', '')} argues against a ${side} setup`
            : 'neutral on this frame',
      ),
    );
  }

  // Session VWAP side.
  const vwap = v(f.structure.vwapDistFrac);
  if (vwap !== null) {
    counted += 1;
    // For a long, price above VWAP is supportive; for a short, below.
    const agree = vwap * sign > 0 ? 1 : vwap * sign < 0 ? -1 : 0;
    total += agree * 1.2;
    drivers.push(
      driver(
        'structure.vwapDistFrac',
        agree * 0.6,
        `${Math.abs(vwap * 100).toFixed(2)}% ${vwap >= 0 ? 'above' : 'below'} session VWAP`,
      ),
    );
  }

  // Retest state, straight from the engine's state machine.
  const retest = f.structure.retest;
  if (retest && retest !== 'none') {
    counted += 1;
    const good =
      retest === 'retested-held' ? 1.2 : retest === 'fresh' ? 1 : retest === 'in-zone' ? 0.8 : retest === 'approaching' ? 0.5 : -1;
    total += good;
    drivers.push(
      driver(
        'structure.retest',
        good * 0.5,
        good < 0 ? `zone ${retest} — the setup is failing its own retest` : `zone ${retest}`,
      ),
    );
  }

  // Displacement: a zone that was actually respected.
  const disp = v(f.structure.displacementX);
  if (disp !== null) {
    counted += 1;
    // Saturating: 2x the local range is plenty of respect.
    const strength = Math.max(-1, Math.min(1, (disp - 0.5) / 1.5));
    total += strength;
    drivers.push(
      driver(
        'structure.displacementX',
        strength * 0.5,
        `displaced ${disp.toFixed(2)}x the local range away from the zone`,
      ),
    );
  }

  // Choppiness is a brake, not a score: chop makes every structural read weaker.
  const chop = v(f.structure.choppiness);
  if (chop !== null) {
    counted += 1;
    const penalty = chop >= 1 ? -1 : Math.max(-1, (chop - 0.55) / 0.45);
    total += penalty;
    if (penalty < 0) {
      drivers.push(
        driver('structure.choppiness', penalty * 0.5, `choppiness ${chop.toFixed(2)} — structure reads are unreliable`),
      );
    }
  }

  const normalised = counted > 0 ? total / (counted * 1.2) : 0;
  return { score: Math.max(-1, Math.min(1, normalised)), drivers };
}

/** Order flow (weight 20): CVD slope and where the liquidations sit. */
function scoreOrderFlow(f: FeatureVector): GroupScore {
  const drivers: Driver[] = [];
  let total = 0;
  let counted = 0;

  const slope = v(f.positioning.cvdSlope);
  if (slope !== null) {
    counted += 1;
    const norm = Math.tanh(slope);
    total += norm;
    drivers.push(
      driver(
        'positioning.cvdSlope',
        norm * 0.6,
        norm > 0 ? 'aggressive flow leaning to the buy side' : norm < 0 ? 'aggressive flow leaning to the sell side' : 'no directional flow imbalance',
      ),
    );
  }

  const liqDist = v(f.positioning.liqClusterDistFrac);
  if (liqDist !== null) {
    counted += 1;
    // Closer to a liquidation cluster means a more defined stop-run magnet.
    const norm = Math.max(-1, Math.min(1, (0.05 - liqDist) / 0.05));
    total += norm * 0.5;
    drivers.push(
      driver('positioning.liqClusterDistFrac', norm * 0.3, `${(liqDist * 100).toFixed(2)}% from the nearest liquidation cluster`),
    );
  }

  const normalised = counted > 0 ? total / (counted * 1.0) : 0;
  return { score: Math.max(-1, Math.min(1, normalised)), drivers };
}

/** Positioning (weight 15): is the crowd already on our side? */
function scorePositioning(f: FeatureVector, side: Side): GroupScore {
  const drivers: Driver[] = [];
  let total = 0;
  let counted = 0;
  const sign = side === 'bullish' ? 1 : -1;

  const crowded = v(f.positioning.crowdedAgainst);
  if (crowded !== null) {
    counted += 1;
    const push = crowded > 0 ? -1 : 0.2;
    total += push;
    if (crowded > 0) {
      drivers.push(
        driver('positioning.crowdedAgainst', -0.6, 'funding and open interest are crowded against this side'),
      );
    }
  }

  const fundingZ = v(f.positioning.fundingZ);
  if (fundingZ !== null) {
    counted += 1;
    const norm = Math.tanh(fundingZ / 2);
    const agree = norm * sign > 0 ? norm : -norm;
    total += agree;
    drivers.push(
      driver(
        'positioning.fundingZ',
        agree * 0.5,
        `funding z-score ${fundingZ.toFixed(2)} (8h-normalised)`,
      ),
    );
  }

  // OI moving with price is participation; against it is a short cover or a trap.
  const oi1h = v(f.positioning.oiChange1h);
  if (oi1h !== null) {
    counted += 1;
    const norm = Math.tanh(oi1h / MIND.REGIME_OI_THRUST);
    total += norm * 0.5;
    drivers.push(
      driver('positioning.oiChange1h', norm * 0.3, `open interest ${(oi1h * 100).toFixed(2)}% in 1h`),
    );
  }

  const normalised = counted > 0 ? total / (counted * 1.0) : 0;
  return { score: Math.max(-1, Math.min(1, normalised)), drivers };
}

/** Catalyst (weight 10): is there a reason, and is it real? */
function scoreCatalyst(f: FeatureVector, side: Side): GroupScore {
  const drivers: Driver[] = [];
  let total = 0;
  let counted = 0;
  const sign = side === 'bullish' ? 1 : -1;

  const dir = f.catalyst.newsDirection;
  if (dir !== null) {
    counted += 1;
    const agree = dir * sign > 0 ? 1 : dir === 0 ? 0 : -1;
    total += agree;
    drivers.push(
      driver(
        'catalyst.newsDirection',
        agree * 0.5,
        agree > 0 ? 'the strongest catalyst points this way' : agree < 0 ? 'the strongest catalyst points the other way' : 'catalysts are neutral',
      ),
    );
  }

  const nis = v(f.catalyst.maxNis4h);
  if (nis !== null) {
    counted += 1;
    const mag = Math.min(1, nis / 100);
    total += mag;
    drivers.push(driver('catalyst.maxNis4h', mag * 0.4, `highest news impact in the last 4h is ${nis.toFixed(0)}`));
  }

  const routine = v(f.catalyst.routineDominates);
  if (routine !== null) {
    counted += 1;
    const push = routine > 0 ? -1 : 0.3;
    total += push;
    if (routine > 0) {
      drivers.push(
        driver('catalyst.routineDominates', -0.6, 'attribution is dominated by routine price commentary'),
      );
    }
  }

  const reversal = v(f.catalyst.reversalRisk);
  if (reversal !== null) {
    counted += 1;
    const push = -Math.max(-1, Math.min(1, reversal));
    total += push;
    if (push < 0) {
      drivers.push(driver('catalyst.reversalRisk', push * 0.4, `reversal risk flagged at ${reversal.toFixed(2)}`));
    }
  }

  const normalised = counted > 0 ? total / (counted * 1.2) : 0;
  return { score: Math.max(-1, Math.min(1, normalised)), drivers };
}

/** Macro regime (weight 10): does the environment permit this trade? */
function scoreMacroRegime(f: FeatureVector, regime: MindRegime): GroupScore {
  const drivers: Driver[] = [];
  let total = 0;
  let counted = 1;

  const base: Record<MindRegime, number> = {
    'trending-bull': 0.6,
    'trending-bear': -0.4,
    range: 0.1,
    'high-vol-cascade': -0.8,
    'macro-blackout': -1,
    quiet: 0,
  };
  total += base[regime];
  if (regime !== 'quiet') {
    drivers.push(driver('regime', base[regime] * 0.5, `regime is ${regime}`));
  }

  const breadth = v(f.regime.breadthRatio);
  if (breadth !== null) {
    total += (breadth - 0.5) * 0.8;
    if (Math.abs(breadth - 0.5) > 0.2) {
      drivers.push(
        driver('regime.breadthRatio', (breadth - 0.5) * 0.4, `${(breadth * 100).toFixed(0)}% of the board is bullish`),
      );
    }
  }

  const sector = v(f.regime.sectorRelativeStrength);
  if (sector !== null) {
    total += Math.tanh(sector * 20) * 0.3;
  }

  const norm = total / counted;
  return { score: Math.max(-1, Math.min(1, norm)), drivers };
}

/**
 * Tradability (weight 5): can this actually be traded, and do we have the data?
 *
 * On the India path there is no funding, no OI and no CVD, so this group is
 * mostly unmeasured. It is scored as neutral rather than assumed fine — the
 * penalty for missing data lands here, which is what makes the India path
 * automatically lower-confidence instead of needing a special case.
 */
function scoreTradability(f: FeatureVector): GroupScore {
  const drivers: Driver[] = [];
  const missing = v(f.context.convictionMissingFrac) ?? 0;
  const score = -missing;

  if (missing > 0.34) {
    drivers.push(
      driver(
        'context.convictionMissingFrac',
        -missing,
        `${Math.round(missing * 100)}% of the conviction components could not be measured`,
        true,
      ),
    );
  }

  const liqMeasured = v(f.positioning.fundingZ) !== null;
  if (!liqMeasured) {
    // Always flagged, and always a disclosure: on the India path there is no
    // derivatives feed at all, and that is the single most important thing a
    // reader can know about the number in front of them.
    drivers.push(
      driver(
        'tradability.coverage',
        -0.2,
        'no derivatives feed on this path — fewer independent inputs',
        true,
      ),
    );
    return { score: Math.max(-1, score - 0.2), drivers };
  }

  return { score: Math.max(-1, Math.min(1, score)), drivers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hard vetoes
// ─────────────────────────────────────────────────────────────────────────────

export interface VetoContext {
  features: FeatureVector;
  regime: MindRegime;
}

/**
 * The hard vetoes. Any one of these forces NO TRADE.
 *
 * Each is a *mechanical* condition, not a judgement about how the setup feels.
 * That is the discipline: a Wyckoff spring is a liquidity sweep with a reclaim,
 * detectable in the candles; "it looks like a spring" is not a veto.
 */
export function hardVetoes(ctx: VetoContext): MindVeto[] {
  const { features: f, regime } = ctx;
  const out: MindVeto[] = [];

  // 1. Extreme funding against the side, with OI rising.
  const crowded = v(f.positioning.crowdedAgainst);
  const fundingZ = v(f.positioning.fundingZ);
  if (crowded !== null && crowded > 0) {
    out.push({
      code: 'funding-crowded-against',
      rule: 'positioning',
      reason:
        fundingZ !== null
          ? `funding is at z=${fundingZ.toFixed(2)} and crowded against this side while open interest rises`
          : 'funding is crowded against this side while open interest rises',
    });
  }

  // 2. Macro blackout.
  //
  //    The negative branch is the one the Part XV audit found missing: an event
  //    that has ALREADY fired but whose window has not closed is the most
  //    dangerous moment to open a new position, and it was being ignored.
  const blackout = v(f.regime.macroBlackoutMin);
  if (blackout !== null && blackout <= MIND.VETO_BLACKOUT_MIN) {
    out.push({
      code: 'macro-blackout',
      rule: 'macro',
      reason:
        blackout < 0
          ? `a tier-1 macro release fired ${Math.abs(Math.round(blackout))} minutes ago — the window is still open`
          : `a tier-1 macro release is ${Math.round(blackout)} minutes away`,
    });
  }
  if (regime === 'macro-blackout') {
    if (!out.some((x) => x.code === 'macro-blackout')) {
      out.push({ code: 'macro-blackout', rule: 'macro', reason: 'the market is inside a macro blackout' });
    }
  }

  // 3. Routine commentary dominating attribution.
  const routine = v(f.catalyst.routineDominates);
  if (routine !== null && routine > 0) {
    out.push({
      code: 'routine-commentary',
      rule: 'catalyst',
      reason: `routine price commentary accounts for over ${MIND.VETO_ROUTINE_COVERAGE_PCT}% of the attribution`,
    });
  }

  // 4. Efficiency / event risk. The engine's own gates, mirrored so a veto is
  //    impossible to route around by calling the scorer directly.
  const strength = v(f.structure.strength);
  if (strength !== null && strength <= 0) {
    out.push({
      code: 'no-strength',
      rule: 'structure',
      reason: 'the engine scored zero strength — chop, or no tradable structure',
    });
  }
  const eventRisk = v(f.context.eventRisk);
  if (eventRisk !== null && eventRisk >= MIND.VETO_EVENT_RISK) {
    out.push({
      code: 'event-risk',
      rule: 'structure',
      reason: `already moved ${(eventRisk * 100).toFixed(1)}% — above the ${(MIND.VETO_EVENT_RISK * 100).toFixed(0)}% event-risk line`,
    });
  }

  // 5. Regime that contradicts a trend setup.
  //    `retest` is an enum, not a Measured, so it is tested directly.
  if (regime === 'high-vol-cascade' || regime === 'quiet') {
    const needsTrend = f.structure.retest === 'fresh' || f.structure.retest === 'approaching';
    if (needsTrend) {
      out.push({
        code: 'regime-requires-trend',
        rule: 'regime',
        reason:
          regime === 'high-vol-cascade'
            ? 'the market is in a liquidation cascade and this setup needs a trend'
            : 'the market is quiet and this fresh setup needs a trend to develop',
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expected R
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectedR {
  grossR: number;
  netR: number;
  /** True when the plan publishes no target, so there is no R to quote. */
  noRoom: boolean;
}

/**
 * Gross and net expected R from the engine's own plan.
 *
 * Costs are converted from the plan's `totalBps` against a one-unit position:
 * `costR = (entryMid × bps / 10_000) / riskPerUnit`. That is exact for a
 * one-unit position and needs no account sizing, which keeps this a pure
 * function of the plan.
 *
 * A plan with no liquidity target yields `grossR = 0` and `noRoom = true` —
 * never an invented multiple (house rule 2, and bug #4).
 */
export function expectedR(plan: TradePlan | null | undefined): ExpectedR {
  if (!plan || plan.noRoom || !(plan.rr > 0) || !(plan.riskPerUnit > 0)) {
    return { grossR: 0, netR: 0, noRoom: true };
  }
  const grossR = plan.rr;
  const bps = plan.costs?.totalBps;
  let costR: number;
  if (typeof bps === 'number' && Number.isFinite(bps) && plan.entryMid > 0) {
    costR = (plan.entryMid * (bps / 10_000)) / plan.riskPerUnit;
  } else {
    costR = grossR * MIND.DEFAULT_COST_R;
  }
  return { grossR, netR: Number((grossR - costR).toFixed(4)), noRoom: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// The scorer
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreInput {
  features: FeatureVector;
  regime: MindRegime;
  plan: TradePlan | null;
  base: BaseRate;
  /** Stable id for the output. */
  id: string;
}

export interface ScoreOutput {
  probability: number;
  expectedR: number;
  netExpectedR: number;
  regime: MindRegime;
  drivers: Driver[];
  vetoes: MindVeto[];
  confidenceBand: 'high' | 'medium' | 'low';
  actionable: boolean;
  rank: number;
  /** The group scores, kept for the calibration report. */
  groupScores: Record<string, number>;
}

/**
 * Score one candidate into a calibrated probability and a net expected R.
 *
 * Pure. The output is a `MindSignal` minus the fields that only the caller can
 * supply (`symbol`, `side`, `asOf`).
 */
export function scoreCandidate(i: ScoreInput): ScoreOutput {
  const { features: f, regime } = i;
  const side = f.side;

  const groups: Array<[string, number, GroupScore]> = [
    ['structure', CONVICTION.WEIGHTS.structure, scoreStructure(f, side)],
    ['orderFlow', CONVICTION.WEIGHTS.orderFlow, scoreOrderFlow(f)],
    ['positioning', CONVICTION.WEIGHTS.positioning, scorePositioning(f, side)],
    ['newsEvents', CONVICTION.WEIGHTS.newsEvents, scoreCatalyst(f, side)],
    ['macroRegime', CONVICTION.WEIGHTS.macroRegime, scoreMacroRegime(f, regime)],
    ['tradability', CONVICTION.WEIGHTS.tradability, scoreTradability(f)],
  ];

  // Weighted feature push, scaled so full alignment is ALIGNED_LOG_ODDS.
  let push = 0;
  const drivers: Driver[] = [];
  const groupScores: Record<string, number> = {};
  for (const [name, weight, g] of groups) {
    groupScores[name] = Number(g.score.toFixed(4));
    push += (weight / 100) * g.score * MIND.ALIGNED_LOG_ODDS;
    for (const d of g.drivers) {
      // Scale each driver the same way so the "top drivers" list is comparable.
      drivers.push({ ...d, contribution: Number((d.contribution * (weight / 100) * MIND.ALIGNED_LOG_ODDS).toFixed(4)) });
    }
  }

  // THE ANCHOR. Everything above is a deviation from the base rate.
  const logOdds = logit(i.base.rate) + push / MIND.LOGISTIC_TEMPERATURE;
  const vetoes = hardVetoes({ features: f, regime });

  const er = expectedR(i.plan);

  let probability: number;
  if (vetoes.length > 0) {
    // A veto is not a penalty. The probability is zero and stays zero.
    probability = 0;
  } else {
    probability = Number(logistic(logOdds).toFixed(4));
  }

  const netExpectedR = vetoes.length > 0 ? 0 : er.netR;

  const confidenceBand: 'high' | 'medium' | 'low' =
    probability >= MIND.BAND_HIGH ? 'high' : probability >= MIND.BAND_LOW ? 'medium' : 'low';

  const actionable =
    vetoes.length === 0 &&
    probability >= MIND.ACTIONABLE_MIN_PROBABILITY &&
    netExpectedR > MIND.ACTIONABLE_MIN_NET_R &&
    !er.noRoom;

  return {
    probability,
    expectedR: er.grossR,
    netExpectedR,
    regime,
    drivers: selectDrivers(drivers, 3),
    vetoes,
    confidenceBand,
    actionable,
    rank: kellyRank(probability, netExpectedR),
    groupScores,
  };
}

/**
 * Ranking score: the Kelly fraction for a bet paying `netR` net, scaled by
 * `MIND.KELLY_FRACTION`.
 *
 * For payoff ratio `m` and win probability `p` the optimal fraction is the
 * linear Kelly form:
 *
 *   f* = (p·m − (1 − p)) / m  =  p − (1 − p)/m
 *
 * which reduces to `2p − 1` when `m = 1` (a fair binary) and stays **finite for
 * every `m > 0`**.
 *
 * The textbook logarithmic form, `ln(b/(1−b))` with `b = p·m`, was the first
 * draft and it is unusable here for a concrete reason: whenever `p·m > 1` — which
 * is most of this board, since a 2R plan at p=0.54 gives 1.08 — then `1 − b` goes
 * negative and the log returns NaN. Clamping `b` instead of leaving it NaN made
 * every good signal tie at the ceiling, so four different setups all ranked
 * `3.4539` and the ordering was gone. The linear form has no such cliff.
 *
 * Clamped at zero, never negative: a board sorted worst-edge-first is not a board.
 *
 * Not full Kelly either. Full Kelly on unfitted weights produces large sizing on
 * noise, which is the failure this layer exists to avoid.
 */
export function kellyRank(probability: number, netR: number): number {
  if (!Number.isFinite(probability) || !Number.isFinite(netR)) return 0;
  if (probability <= 0 || netR <= 0) return 0;
  const f = probability - (1 - probability) / netR;
  if (!Number.isFinite(f)) return 0;
  const scaled = f * MIND.KELLY_FRACTION;
  return Number.isFinite(scaled) ? Number(Math.max(0, scaled).toFixed(4)) : 0;
}

/**
 * Choose which drivers the UI shows.
 *
 * The top `n` by absolute contribution, **plus every disclosure driver**.
 *
 * Disclosure drivers are exempt from the cut. A "you are reading a thin number"
 * notice competes against a well-measured feature and loses, which means the
 * reader sees a confident-looking panel for a sparse vector — precisely the
 * failure mode house rule 3 exists to prevent. If the disclosures do not fit, a
 * measured feature is dropped rather than a warning.
 */
export function selectDrivers(drivers: Driver[], n = 3): Driver[] {
  const disclosures = drivers.filter((d) => d.disclosure);
  const ranked = drivers
    .filter((d) => !d.disclosure)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const room = Math.max(0, n - disclosures.length);
  return [...ranked.slice(0, room), ...disclosures].slice(0, Math.max(n, disclosures.length));
}

/** Reassemble a `MindSignal` from a score plus the identity fields. */
export function toMindSignal(
  score: ScoreOutput,
  identity: { id: string; symbol: string; side: Side; asOf: number },
) {
  return {
    id: identity.id,
    symbol: identity.symbol,
    side: identity.side,
    probability: score.probability,
    expectedR: score.expectedR,
    netExpectedR: score.netExpectedR,
    regime: score.regime,
    drivers: score.drivers,
    vetoes: score.vetoes,
    confidenceBand: score.confidenceBand,
    actionable: score.actionable,
    rank: score.rank,
    asOf: identity.asOf,
  };
}