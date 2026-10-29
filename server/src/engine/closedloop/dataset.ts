/**
 * The training dataset for the Closed-Loop Engine.
 *
 * ## Where the features come from - and why that matters
 *
 * The obvious worry with training a model on a ledger is that the features
 * have to be RECONSTRUCTED from historical data, and a reconstruction is not a
 * measurement. That worry is real for the 36-field Mind vector: only **7** of
 * the ledger's signals carry a frozen feature record.
 *
 * It is NOT real for the ledger's own `SignalSnapshot`, which stores what the
 * engine knew AT THE DECISION: the conviction components, the plan and its
 * costs, the order-block setup, the derivatives row, the news dot, the VWAP,
 * the regime and the breadth. Every one of those was written once, at
 * decision time, and never touched again.
 *
 * So the feature set here is **MEASURED**, not reconstructed: it is read out
 * of a frozen snapshot. The features that are NOT in the snapshot - the five
 * microstructure and cross-venue readings added in Part XIX - are **absent for
 * every historical row**, and a model that used them would be reading a
 * column that exists only for today. They are therefore excluded from the
 * fitted feature set, and the exclusion is stated in the report rather than
 * papered over.
 *
 * ## The population
 *
 * The brief's rule: shadow AND real rows, EXCLUDING the rows the
 * data-integrity gate blocked, because those rows were decided on stale or
 * missing inputs. `wasReal` and the veto kind are used to SLICE the results
 * and are never features. The vetoes stay hard rules applied AFTER the model
 * has spoken.
 *
 * ## The labels
 *
 * `y = 1` for a take-profit, `y = 0` for a stop, and **null for an expiry** -
 * a censored observation, which has no binary label to give. Expires are
 * excluded from the win rate and the Brier score, and INCLUDED in the
 * expectancy, which is the single population rule `ledger/outcomes.ts` already
 * states.
 */

import { LEDGER } from '../../config.js';
import { vetoKindOf } from '../vetoKind.js';
import { computeCosts } from '../../ledger/outcomes.js';
import { resolveOutcome, type ResolveInput } from '../../ledger/resolve.js';
import type { Bar } from './geometry.js';
import type { Grade, LedgerSignal, Side } from '../../../../shared/types.js';

export type Population = 'MEASURED' | 'RECONSTRUCTED';

export interface LabelledRow {
  id: string;
  symbol: string;
  side: Side;
  createdAt: number;
  resolvedAt: number;
  grade: Grade;
  /** True for a grade A/B signal. A SLICE, never a feature. */
  wasReal: boolean;
  /** The veto kind. A SLICE, never a feature. */
  vetoKind: string;
  /** The features, all read from the frozen snapshot. */
  features: Record<string, number>;
  /** Which features had to be imputed, and why. */
  imputed: string[];
  /** 1 = take-profit, 0 = stop, null = censored (expired). */
  y: 0 | 1 | null;
  outcome: string;
  /** Gross R, as the resolver measured it. */
  grossR: number | null;
  /** Net R, with MODELLED costs. */
  netR: number | null;
  /** The modelled cost in R. */
  costR: number | null;
  /** How long the trade was held. */
  heldMs: number;
  population: Population;
}

/** The feature names, in a fixed order, so a model artefact is reproducible. */
export const FEATURE_NAMES: readonly string[] = [
  'score',
  'comp_structure', 'comp_orderFlow', 'comp_momentum', 'comp_positioning',
  'comp_newsEvents', 'comp_macroRegime', 'comp_tradability',
  'plan_rr', 'plan_netR', 'plan_riskPctOfPrice', 'plan_costBps', 'plan_target1DistPct',
  'setup_rr', 'setup_displacement', 'setup_fvg', 'setup_violated', 'setup_ageMin',
  'setup_distanceAtr', 'setup_htfAligned', 'setup_htfConflict',
  'deriv_funding8h', 'deriv_oiH1', 'deriv_oiH4', 'deriv_oiD1', 'deriv_cvd',
  'deriv_cvdSlope', 'deriv_takerRatio', 'deriv_basisPct', 'deriv_lsDivergence',
  'news_nis', 'news_direction',
  'price_vs_vwap',
  'regime_bull', 'regime_bear', 'regime_range', 'regime_expansion', 'regime_riskoff',
  'breadth_bull', 'breadth_bear', 'breadth_twoway',
];

/**
 * The features, read from the frozen snapshot.
 *
 * Every value here was written at decision time. A missing one is recorded in
 * `imputed` and left out of the feature map - it is never quietly replaced
 * with a zero, because a zero funding rate and an unmeasured funding rate are
 * different claims.
 */
export function featuresOf(s: LedgerSignal): { features: Record<string, number>; imputed: string[] } {
  const out: Record<string, number> = {};
  const imputed: string[] = [];
  const put = (name: string, value: number | null | undefined): void => {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      imputed.push(name);
      return;
    }
    out[name] = value;
  };

  const snap = s.snapshot;
  const c = snap.components as unknown as Record<string, number>;
  put('score', s.score);
  for (const k of ['structure', 'orderFlow', 'momentum', 'positioning', 'newsEvents', 'macroRegime', 'tradability']) {
    put(`comp_${k}`, c?.[k]);
  }

  const plan = snap.plan ?? null;
  const entry = plan?.entryMid ?? (s.entryZoneLow + s.entryZoneHigh) / 2;
  put('plan_rr', plan?.rr);
  put('plan_netR', plan?.netR);
  put('plan_riskPctOfPrice', entry > 0 && s.riskPerUnit > 0 ? (s.riskPerUnit / entry) * 100 : null);
  put('plan_costBps', plan?.costs?.totalBps);
  put('plan_target1DistPct', plan?.targets?.[0] && entry > 0
    ? (Math.abs(plan.targets[0].price - entry) / entry) * 100 : null);

  const setup = snap.setup ?? null;
  put('setup_rr', setup?.rr);
  put('setup_displacement', setup?.displacement);
  put('setup_fvg', setup ? (setup.fvg ? 1 : 0) : null);
  put('setup_violated', setup ? (setup.violated ? 1 : 0) : null);
  put('setup_ageMin', setup?.ageMinutes);
  put('setup_distanceAtr', setup?.distanceAtr);
  put('setup_htfAligned', setup?.htf ? (setup.htf.aligned ? 1 : 0) : null);
  put('setup_htfConflict', setup?.htf ? (setup.htf.conflict ? 1 : 0) : null);

  const d = snap.deriv ?? null;
  put('deriv_funding8h', d?.funding8h);
  put('deriv_oiH1', d?.oiChange?.h1);
  put('deriv_oiH4', d?.oiChange?.h4);
  put('deriv_oiD1', d?.oiChange?.d1);
  put('deriv_cvd', d?.cvd);
  put('deriv_cvdSlope', d?.cvdSlope);
  put('deriv_takerRatio', d?.takerRatio);
  put('deriv_basisPct', d?.basisPct);
  put('deriv_lsDivergence', d?.lsDivergence);

  // The snapshot stores the news read as a NIS and a direction; the richer
  // `newsDot` (with the item count) lives on the board row, not in the
  // frozen snapshot, so the count is not available here.
  put('news_nis', snap.newsNis);
  put('news_direction', snap.newsDirection);

  put('price_vs_vwap', snap.vwap && snap.vwap > 0 && entry > 0 ? ((entry - snap.vwap) / snap.vwap) * 100 : null);

  const regime = snap.regime;
  put('regime_bull', regime === 'trend-up' ? 1 : 0);
  put('regime_bear', regime === 'trend-down' ? 1 : 0);
  put('regime_range', regime === 'range' ? 1 : 0);
  put('regime_expansion', regime === 'high-vol-expansion' ? 1 : 0);
  put('regime_riskoff', regime === 'risk-off' ? 1 : 0);

  const breadth = snap.breadth;
  put('breadth_bull', breadth === 'bullish' ? 1 : 0);
  put('breadth_bear', breadth === 'bearish' ? 1 : 0);
  put('breadth_twoway', breadth === 'two-way' ? 1 : 0);

  return { features: out, imputed };
}

/**
 * The population policy, in one place.
 *
 * `DATA_HEALTH` rows are EXCLUDED: the data-integrity gate blocked them
 * because their inputs were stale or missing, so the features they carry are
 * not the features a live decision would have had. The brief set this rule,
 * and the live data independently supports it - those rows are the BEST
 * performers in the ledger (+3.75 R, n=83), which is exactly what a
 * stale-feature artefact looks like.
 */
export function isExcludedByPolicy(vetoKind: string): boolean {
  return vetoKind === 'DATA_HEALTH';
}

/**
 * Re-resolve one signal and build its label.
 *
 * The label comes from the RESOLVER, on real candles, with the corrected
 * rules. The net R uses the modelled costs.
 */
export function labelOf(
  s: LedgerSignal,
  candles: Bar[],
): Pick<LabelledRow, 'y' | 'outcome' | 'grossR' | 'netR' | 'costR' | 'heldMs' | 'population'> {
  const plan = s.snapshot.plan ?? null;
  const entry = plan?.entryMid ?? (s.entryZoneLow + s.entryZoneHigh) / 2;
  const risk = s.riskPerUnit > 0 ? s.riskPerUnit : Math.abs(entry - s.stop);
  const lifeMs = LEDGER.EXPIRY_HOURS * 3600_000;

  const input: ResolveInput = {
    side: s.side,
    entry,
    stop: s.stop,
    targets: s.targets ?? [],
    riskPerUnit: risk,
    candles: candles.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
    createdAt: s.createdAt,
    now: s.createdAt + lifeMs,
  };
  const res = resolveOutcome(input);

  const heldMs = res.index >= 0
    ? Math.max(0, candles[res.index].t + 5 * 60_000 - s.createdAt)
    : lifeMs;

  const d = s.snapshot.deriv ?? null;
  const funding8h = d && Number.isFinite(d.funding8h) ? d.funding8h : null;
  const spreadBps = d?.depth?.spreadBps ?? null;

  let grossR: number | null = null;
  let netR: number | null = null;
  let costR: number | null = null;
  if (res.rMultiple !== null && risk > 0) {
    grossR = res.rMultiple;
    const costs = computeCosts({
      grossR, entry, riskPerUnit: risk, heldMs, funding8h, side: s.side, spreadBps,
    });
    netR = costs.netR;
    costR = costs.totalCostR;
  }

  const outcome = res.outcome;
  const y: 0 | 1 | null =
    outcome === 'TP1' || outcome === 'TP2' || outcome === 'TP3' ? 1
    : outcome === 'STOP' ? 0
    : null;

  return { y, outcome, grossR, netR, costR, heldMs, population: 'MEASURED' };
}

/** Assemble the full row. */
export function buildRow(s: LedgerSignal, candles: Bar[]): LabelledRow {
  const { features, imputed } = featuresOf(s);
  const label = labelOf(s, candles);
  const vetoKind = s.shadow ? vetoKindOf(s.vetoReason) : 'real';
  return {
    id: s.id,
    symbol: s.symbol,
    side: s.side,
    createdAt: s.createdAt,
    resolvedAt: s.resolvedAt ?? s.createdAt,
    grade: s.grade,
    wasReal: !s.shadow,
    vetoKind,
    features,
    imputed,
    ...label,
  };
}
