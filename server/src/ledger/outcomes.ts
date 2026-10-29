/**
 * The outcome store — Phase XVI step 2.
 *
 * Two problems this file exists to solve.
 *
 * ── 1. EXPIRED had no consistent treatment ──
 *
 * `EXPIRED` is a **censored observation**, not a loss and not a win. The trade
 * did not fail; it ran out of time. Treating it as a loss understates the
 * strategy, and silently dropping it inflates every rate that depends on it.
 *
 * The literature's answer is survival analysis: censored rows belong in
 * time-to-event metrics and out of binary metrics. So:
 *
 * | metric family | EXPIRED treatment | why |
 * |---|---|---|
 * | net expectancy, drawdown, profit factor | **included** | the money was spent; the cost is real |
 * | win rate | **excluded from the denominator, count reported** | it is not a decided outcome |
 * | Brier / calibration | **excluded** | those need a binary label we do not have |
 * | time-to-resolution | **included** | censored at the expiry time |
 *
 * The whole table is ONE exported constant. Every metric reads it. Nothing is
 * allowed to decide inclusion for itself — that is precisely how Phase XV found
 * the anchor and the bar drawn from different populations.
 *
 * ── 2. R was reported gross ──
 *
 * `rMultiple` credits the gross move. Phase XVI rule 6: costs are never
 * optional. So every outcome now carries gross AND net, where net subtracts fees,
 * slippage, and funding actually charged across the holding period.
 *
 * Funding is charged per 8-hour UTC boundary crossed while the trade was open,
 * at the funding rate that was live at that boundary. `FUNDING_TIMES_UTC` is the
 * exchange's own schedule, so the count is exact rather than `hours / 8`.
 */

import { FUNDING_TIMES_UTC, LEDGER, RISK } from '../config.js';
import type { Outcome } from '../../../shared/types.js';

// ─── Outcome classification: ONE definition, used everywhere ─────────────────

export type OutcomeClass = 'win' | 'loss' | 'censored';

export const OUTCOME_POLICY = {
  /** A target was reached. */
  win: ['TP1', 'TP2', 'TP3'] as const,
  /** The invalidation was hit. A real, decided loss. */
  loss: ['STOP'] as const,
  /** Neither happened in time. NOT a loss — the observation is censored. */
  censored: ['EXPIRED', 'DATA_GAP'] as const,

  /**
   * Which metric families include each class. Read this; do not re-derive it.
   *
   * `expectancy` includes everything because the cost was paid. `winRate` and
   * `brier` need a binary decision, so they exclude censored — and the report
   * prints the censored count beside them, so the reader is never left wondering
   * where rows went.
   */
  families: {
    expectancy: ['win', 'loss', 'censored'],
    profitFactor: ['win', 'loss', 'censored'],
    drawdown: ['win', 'loss', 'censored'],
    timeToResolve: ['win', 'loss', 'censored'],
    winRate: ['win', 'loss'],
    brier: ['win', 'loss'],
    reliability: ['win', 'loss'],
  },
} as const;

export function classifyOutcome(outcome: Outcome | string): OutcomeClass {
  if ((OUTCOME_POLICY.win as readonly string[]).includes(outcome)) return 'win';
  if ((OUTCOME_POLICY.loss as readonly string[]).includes(outcome)) return 'loss';
  if ((OUTCOME_POLICY.censored as readonly string[]).includes(outcome)) return 'censored';
  return 'censored';
}

export function isDecided(outcome: Outcome | string): boolean {
  return classifyOutcome(outcome) !== 'censored';
}

/** Does this family include this class? The single gate every metric goes through. */
export function includes(
  family: keyof typeof OUTCOME_POLICY.families,
  outcome: Outcome | string,
): boolean {
  const classes = OUTCOME_POLICY.families[family] as readonly OutcomeClass[];
  return classes.includes(classifyOutcome(outcome));
}

/**
 * Human sentence for the EXPIRED policy, printed by every report that excludes
 * censored rows. A population that shrank must say so in words.
 */
export function excludedNote(total: number, included: number): string | null {
  const dropped = total - included;
  if (dropped <= 0) return null;
  return `${dropped} censored outcome${dropped === 1 ? '' : 's'} (expired or unresolved) excluded from this metric and included in expectancy and drawdown`;
}

// ─── Ambiguity policy ────────────────────────────────────────────────────────

/**
 * The ambiguity policy, stated explicitly.
 *
 * Same-candle stop/target is resolved STOP_FIRST — the worst case — so the
 * ledger never flatters itself with a coin flip. That is a policy, not a
 * measurement, so it is recorded ON THE OUTCOME rather than being invisible.
 *
 * `AMBIGUITY_NOTE` exists so a reader can tell "the stop was genuinely hit first"
 * from "one candle covered both levels and we chose the pessimistic reading".
 */
export const AMBIGUITY_POLICY = {
  mode: LEDGER.AMBIGUITY,
  description:
    'When one candle spans both the stop and a target, the order inside it is unknowable, so the STOP is taken. This is the worst case, chosen deliberately.',
} as const;

// ─── Costs ───────────────────────────────────────────────────────────────────

export interface CostInputs {
  /** Gross R realised. */
  grossR: number;
  /** Entry price, used to convert bps into R. */
  entry: number;
  /** Absolute per-unit risk. */
  riskPerUnit: number;
  /** Milliseconds the position was open. */
  heldMs: number;
  /** Funding rate per 8h while open. Positive = longs pay shorts. */
  funding8h: number | null;
  /** Direction, to sign the funding. */
  side: 'bullish' | 'bearish';
  /** Measured spread, when depth data exists. Falls back to the config default. */
  spreadBps?: number | null;
}

export interface CostBreakdown {
  /** Round-trip taker fee, in R. */
  feeR: number;
  /** Expected slippage + spread crossing, in R. */
  slippageR: number;
  /** Funding actually charged over the held period, in R. Positive = a cost. */
  fundingR: number;
  totalCostR: number;
  /** `grossR - totalCostR`. Null when per-unit risk is unusable. */
  netR: number | null;
  /** Funding boundaries actually crossed. Zero when held under 8h. */
  fundingEvents: number;
  /** False when no derivatives feed meant no funding rate. Then `fundingR` is 0, not an estimate. */
  fundingMeasured: boolean;
}

/**
 * Number of 8-hour funding boundaries crossed in `[fromMs, toMs)`.
 *
 * Counted from the exchange's own UTC schedule rather than `hours / 8`, because
 * those disagree whenever a trade straddles a boundary and the difference is one
 * whole funding payment.
 */
export function fundingEventsCrossed(fromMs: number, toMs: number): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return 0;
  let count = 0;
  const dayMs = 24 * 3600_000;
  for (let day = Math.floor(fromMs / dayMs) - 1; day <= Math.floor(toMs / dayMs) + 1; day++) {
    for (const h of FUNDING_TIMES_UTC) {
      const t = day * dayMs + h * 3600_000;
      if (t > fromMs && t <= toMs) count++;
    }
  }
  return count;
}

/**
 * Cost-honest net R.
 *
 * When funding was never measured the result is `fundingMeasured: false` and
 * `fundingR: 0` — a zero COST, not a zero RATE. The distinction is carried to the
 * report, because "we did not measure funding" and "funding cost nothing" are
 * different claims and only one of them is usually true.
 */
export function computeCosts(i: CostInputs): CostBreakdown {
  const { grossR, entry, riskPerUnit, heldMs, funding8h, side } = i;
  const perUnitR = (bps: number): number => {
    if (!Number.isFinite(riskPerUnit) || riskPerUnit <= 0 || !Number.isFinite(entry)) return 0;
    return ((bps / 10_000) * entry) / riskPerUnit;
  };

  const feeR = perUnitR(RISK.TAKER_FEE_BPS * 2);
  const slipBps = i.spreadBps != null && i.spreadBps > 0
    ? Math.max(RISK.DEFAULT_SLIPPAGE_BPS, i.spreadBps)
    : RISK.DEFAULT_SLIPPAGE_BPS;
  const slippageR = perUnitR(slipBps);

  const events = fundingEventsCrossed(0, heldMs);
  const fundingMeasured = funding8h !== null && Number.isFinite(funding8h);
  // Longs pay when funding is positive; shorts receive. Direction flips the sign.
  const rateR = fundingMeasured ? funding8h : 0;
  const perEventR = rateR !== 0 ? ((rateR * entry) / riskPerUnit) * (side === 'bullish' ? 1 : -1) : 0;
  const fundingR = perEventR * events;

  const totalCostR = feeR + slippageR + fundingR;
  return {
    feeR: r4(feeR),
    slippageR: r4(slippageR),
    fundingR: r4(fundingR),
    totalCostR: r4(totalCostR),
    netR: Number.isFinite(riskPerUnit) && riskPerUnit > 0 ? r4(grossR - totalCostR) : null,
    fundingEvents: events,
    fundingMeasured,
  };
}

// ─── The stored record ───────────────────────────────────────────────────────

export interface OutcomeRecord {
  signalId: string;
  outcome: Outcome;
  /** Which population family this outcome belongs to. */
  outcomeClass: OutcomeClass;
  resolvedAt: number;
  /** Candles from creation to resolution. */
  barsToResolve: number;
  timeToResolveMin: number;
  priceAtResolve: number | null;

  grossR: number;
  netR: number | null;
  feeR: number;
  slippageR: number;
  fundingR: number;
  totalCostR: number;
  fundingMeasured: boolean;

  mfeR: number;
  maeR: number;

  /** True when one candle covered both the stop and a target. */
  ambiguous: boolean;
  /** The policy that resolved it, stored on the row. */
  ambiguityPolicy: string;
  /** Why, in words, whenever something about the resolution was not obvious. */
  resolutionNote: string | null;
  /** The EXPIRED policy in force, so a historical row stays interpretable. */
  expiredPolicy: string | null;

  engineVersion: string;
  featureSchemaVersion: string;
}

export interface BuildOutcomeInput {
  signalId: string;
  outcome: Outcome;
  createdAt: number;
  resolvedAt: number;
  entry: number;
  stop: number;
  riskPerUnit: number;
  side: 'bullish' | 'bearish';
  /** Candles from creation onward. */
  bars: { t: number }[];
  priceAtResolve: number | null;
  grossR: number;
  mfeR: number;
  maeR: number;
  funding8h: number | null;
  spreadBps: number | null;
  /** True when the resolving candle also touched a target. */
  ambiguous: boolean;
  /** Set when the outcome is DATA_GAP rather than a market event. */
  dataGap?: string | null;
  engineVersion: string;
  featureSchemaVersion: string;
}

export function buildOutcomeRecord(i: BuildOutcomeInput): OutcomeRecord {
  const heldMs = Math.max(0, i.resolvedAt - i.createdAt);
  const costs = computeCosts({
    grossR: i.grossR,
    entry: i.entry,
    riskPerUnit: i.riskPerUnit,
    heldMs,
    funding8h: i.funding8h,
    side: i.side,
    spreadBps: i.spreadBps,
  });

  const notes: string[] = [];
  if (i.ambiguous) {
    notes.push(`ambiguous candle: ${AMBIGUITY_POLICY.description}`);
  }
  if (!costs.fundingMeasured) {
    notes.push('funding never measured — recorded as a zero COST, not a zero rate');
  }
  if (i.dataGap) notes.push(`data gap prevented resolution: ${i.dataGap}`);

  return {
    signalId: i.signalId,
    outcome: i.outcome,
    outcomeClass: classifyOutcome(i.outcome),
    resolvedAt: i.resolvedAt,
    barsToResolve: i.bars.length,
    timeToResolveMin: r2(heldMs / 60_000),
    priceAtResolve: i.priceAtResolve,
    grossR: r4(i.grossR),
    netR: costs.netR,
    feeR: costs.feeR,
    slippageR: costs.slippageR,
    fundingR: costs.fundingR,
    totalCostR: costs.totalCostR,
    fundingMeasured: costs.fundingMeasured,
    mfeR: r4(i.mfeR),
    maeR: r4(i.maeR),
    ambiguous: i.ambiguous,
    ambiguityPolicy: AMBIGUITY_POLICY.mode,
    resolutionNote: notes.length ? notes.join('; ') : null,
    expiredPolicy:
      i.outcome === 'EXPIRED'
        ? 'censored: included in expectancy and drawdown, excluded from win rate and Brier, count reported'
        : null,
    engineVersion: i.engineVersion,
    featureSchemaVersion: i.featureSchemaVersion,
  };
}

function r2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}
function r4(v: number): number {
  const r = Math.round(v * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}