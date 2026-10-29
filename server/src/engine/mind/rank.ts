/**
 * Signal generation and ranking.
 *
 * Ranking is by **Kelly-inspired edge at a fraction**, not by raw strength. Raw
 * strength is a price-action measure; it knows nothing about what the crowd is
 * already positioned for, what the macro calendar says, or what the last target
 * is actually worth after costs. Ranking a board by strength is how a terminal
 * puts its most crowded trade at the top.
 *
 * Sorting is stable and total: ties break on probability, then on symbol, so the
 * board order does not shuffle between two identical scans.
 */

import type {
  FeatureVector,
  MindRegime,
  MindSignal,
  TradePlan,
  Side,
} from '../../../../shared/types.js';
import { resolveBaseRate, scoreCandidate, toMindSignal, type BaseRate } from './confluence.js';

export interface Candidate {
  /** Base ticker, e.g. `APT`. Used as the stable lookup key. */
  base: string;
  /** Tradeable pair, e.g. `APTUSDT`. What the signal reports. */
  symbol: string;
  side: Side;
  features: FeatureVector;
  regime: MindRegime;
  plan: TradePlan | null;
}

/**
 * The stable lookup key for one row's verdict.
 *
 * Keyed by **base**, not by pair. The board addresses rows by base (`APT`) while
 * the signal reports the tradeable pair (`APTUSDT`); using the pair here made
 * every scanner lookup miss and every row came back `mind: null`.
 *
 * Defined here rather than in `scan.ts` because `scan.ts` imports this module,
 * and a key function that both sides need cannot live downstream of one of them.
 */
export function idFor(base: string, side: Side): string {
  return `${base}:${side}`;
}

export interface RankedBoard {
  signals: MindSignal[];
  /** Actionable ones first, already in rank order. */
  actionable: MindSignal[];
  bands: { high: number; medium: number; low: number; actionable: number; vetoed: number };
  vetoCounts: Array<{ code: string; n: number }>;
  base: BaseRate;
  asOf: number;
}

/**
 * Score and rank a set of candidates.
 *
 * The base rate is resolved once for the whole board, not per candidate, so every
 * row on the same screen is scored against the same anchor and the board is
 * internally comparable.
 */
export function rankCandidates(
  candidates: Candidate[],
  base: { observedWinRate: number | null; resolvedSamples: number },
  asOf: number,
): RankedBoard {
  const resolved = resolveBaseRate(base.observedWinRate, base.resolvedSamples);

  const signals: MindSignal[] = candidates.map((c) => {
    const score = scoreCandidate({
      features: c.features,
      regime: c.regime,
      plan: c.plan,
      base: resolved,
      // Keyed by BASE, not by pair. The board addresses rows by base (`APT`) and
      // the signal reports the pair (`APTUSDT`); mixing the two made every
      // lookup miss and every row come back with `mind: null`.
      id: idFor(c.base, c.side),
    });
    return toMindSignal(score, {
      id: idFor(c.base, c.side),
      symbol: c.symbol,
      side: c.side,
      asOf,
    });
  });

  const sorted = signals.slice().sort((a, b) => {
    // Actionable always outranks everything, including a higher raw rank.
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (b.probability !== a.probability) return b.probability - a.probability;
    return a.symbol.localeCompare(b.symbol);
  });

  const vetoCounts = new Map<string, number>();
  for (const s of signals) {
    for (const v of s.vetoes) {
      vetoCounts.set(v.code, (vetoCounts.get(v.code) ?? 0) + 1);
    }
  }

  return {
    signals: sorted,
    actionable: sorted.filter((s) => s.actionable),
    bands: {
      high: signals.filter((s) => s.confidenceBand === 'high').length,
      medium: signals.filter((s) => s.confidenceBand === 'medium').length,
      low: signals.filter((s) => s.confidenceBand === 'low').length,
      actionable: signals.filter((s) => s.actionable).length,
      vetoed: signals.filter((s) => s.vetoes.length > 0).length,
    },
    vetoCounts: [...vetoCounts.entries()]
      .map(([code, n]) => ({ code, n }))
      .sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)),
    base: resolved,
    asOf,
  };
}