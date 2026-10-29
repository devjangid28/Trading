/**
 * The random-entry baseline.
 *
 * ## The question it answers
 *
 * "Is the engine's edge a property of the MARKET, or a property of the
 * ENGINE?" A stop/target geometry says nothing on its own about where the
 * entry was. If you take the SAME stop and the SAME target and enter at a
 * RANDOM time with the same distances, how much do you make?
 *
 * If the answer is "about as much as the engine makes", then the engine has
 * found nothing, and no amount of feature engineering will change that. If the
 * answer is "the engine makes much more", the edge is real and worth
 * measuring further. If the answer is "a random entry makes MORE", the
 * geometry itself is the finding and the engine is a worse version of it.
 *
 * ## What makes the comparison fair
 *
 * Four things are held identical between the engine's trade and the random
 * trade:
 *
 * 1. **The geometry.** The same per-unit risk and the same target distances
 *    from the entry, re-anchored at the new entry price.
 * 2. **The candles.** The random entry is drawn from the SAME window of
 *    candles the engine's signal was resolved over. A different window would
 *    be a different market.
 * 3. **The resolution rules.** The same `resolveOutcome()` — stop-first on
 *    ambiguity, gap-aware fills, expiry at the end of the trade's life.
 * 4. **The costs.** The same `computeCosts()` from `RISK.*`, charged over the
 *    same kind of holding period.
 *
 * The ONE thing that differs is the entry time, which is the entire point.
 *
 * ## The fill
 *
 * A random entry fills at the OPEN of the chosen candle — the next candle's
 * open, at the market, with slippage charged. It is not filled at the
 * original entry price, because that would make the baseline a fantasy: the
 * whole reason the engine's ledger looks profitable is that it assumes a fill
 * at the mid of the zone, and the baseline has to pay the same assumption the
 * engine gets for free.
 */

import { LEDGER } from '../../config.js';
import { computeCosts } from '../../ledger/outcomes.js';
import { makeRandom, reanchor, resolveGeometry, type Bar, type Geometry } from './geometry.js';

export interface BaselineOptions {
  /** How many random entries per signal. */
  trials: number;
  /** The trade's life, from the config. */
  lifeMs: number;
  /**
   * The window of candles the entry may be chosen from.
   *
   * Always the signal's own session, for every control. The controls differ
   * in the time BUDGET they are given afterwards, not in where they may
   * enter.
   */
  candidateWindowMs: number;
  /** Seed, so the baseline is reproducible. */
  seed: number;
}

export interface RandomEntry {
  /** The candle the entry was taken at. */
  entryTs: number;
  /** The price it filled at: that candle's open. */
  entryPrice: number;
  /** The outcome the resolver produced. */
  outcome: string;
  /** Gross R. Null when the resolver could not measure it. */
  grossR: number | null;
  /**
   * Net R, after the same modelled costs the engine's arm pays.
   *
   * Carried PER TRIAL so a comparison against the engine's arm is on the same
   * footing. Comparing the engine's NET R against a random arm's GROSS R would
   * hand the engine a free round trip of costs.
   */
  netR: number | null;
  /** How long the trade was held, in ms. */
  heldMs: number;
}

export interface BaselineResult {
  /** Every trial. */
  trials: RandomEntry[];
  /** The mean gross R over the trials with a measurable R. */
  meanGrossR: number | null;
  /** The win rate over the trials with a DECIDED outcome. */
  winRate: number | null;
  /** The mean NET R over the trials with a measurable R. */
  meanNetR: number | null;
  /** The mean cost in R. */
  meanCostR: number | null;
  /** How many trials were unmeasurable. */
  unmeasurable: number;
  /** How many trials the signal's own candles could not support. */
  noCandles: number;
}

/**
 * Random entries over one signal's window, with the signal's geometry.
 *
 * `candles` must be the window the signal was resolved over. An entry is only
 * considered at a candle that has a candle AFTER it in the window, because a
 * trade needs somewhere to go.
 */
export function randomEntryBaseline(
  geometry: Geometry,
  candles: Bar[],
  fromTs: number,
  funding8h: number | null,
  spreadBps: number | null,
  opts: BaselineOptions,
): BaselineResult {
  const rand = makeRandom(opts.seed);
  // The candidate entry times are the SAME for every control: the candles of
  // the signal's own session. What differs between the controls is the TIME
  // BUDGET, which is the one asymmetry that could otherwise manufacture an
  // edge for the engine.
  const candidates = candles.filter((c) => c.t >= fromTs && c.t < fromTs + opts.candidateWindowMs);
  const out: RandomEntry[] = [];

  if (candidates.length < 2) {
    return { trials: [], meanGrossR: null, winRate: null, meanNetR: null, meanCostR: null, unmeasurable: 0, noCandles: candidates.length };
  }

  for (let t = 0; t < opts.trials; t++) {
    // The last candidate is excluded: a trade entered there has no future to
    // resolve against inside the candidate window.
    const pick = candidates[Math.floor(rand() * (candidates.length - 1))];
    const fill = pick.o;
    if (!Number.isFinite(fill) || fill <= 0) continue;

    const g = reanchor(geometry, fill);
    const res = resolveGeometry(g, candles, pick.t, opts.lifeMs);
    const heldMs = res.index >= 0 ? candles[res.index].t + 5 * 60_000 - pick.t : opts.lifeMs;

    let grossR: number | null = null;
    if (res.rMultiple !== null) {
      grossR = res.rMultiple;
    }

    // The cost is charged PER TRIAL, so the trial carries the same net R the
    // engine's arm would have carried at the same entry.
    let netR: number | null = null;
    if (grossR !== null) {
      const g = reanchor(geometry, fill);
      const c = computeCosts({
        grossR,
        entry: fill,
        riskPerUnit: g.riskPerUnit,
        heldMs,
        funding8h,
        side: g.side,
        spreadBps,
      });
      netR = c.netR;
    }

    out.push({
      entryTs: pick.t,
      entryPrice: fill,
      outcome: res.outcome,
      grossR,
      netR,
      heldMs,
    });
  }

  const measurable = out.filter((x) => x.grossR !== null);
  const decided = measurable.filter((x) => x.outcome === 'TP1' || x.outcome === 'TP2' || x.outcome === 'TP3' || x.outcome === 'STOP');

  const costRs: number[] = [];
  const netRs: number[] = [];
  for (const x of measurable) {
    const g = reanchor(geometry, x.entryPrice);
    const c = computeCosts({
      grossR: x.grossR as number,
      entry: x.entryPrice,
      riskPerUnit: g.riskPerUnit,
      heldMs: x.heldMs,
      funding8h,
      side: g.side,
      spreadBps,
    });
    costRs.push(c.totalCostR);
    if (c.netR !== null) netRs.push(c.netR);
  }

  return {
    trials: out,
    meanGrossR: measurable.length ? measurable.reduce((a, b) => a + (b.grossR as number), 0) / measurable.length : null,
    winRate: decided.length ? (decided.filter((x) => x.outcome !== 'STOP').length / decided.length) * 100 : null,
    meanNetR: netRs.length ? netRs.reduce((a, b) => a + b, 0) / netRs.length : null,
    meanCostR: costRs.length ? costRs.reduce((a, b) => a + b, 0) / costRs.length : null,
    unmeasurable: out.length - measurable.length,
    noCandles: candidates.length,
  };
}

/**
 * The engine's own trade over the same window, with the same costs.
 *
 * This is the "treatment" arm. It fills at the entry mid — which is what the
 * ledger has always assumed — so the comparison is explicitly FAVOURABLE to
 * the engine, and the gap between the arms is a lower bound on any real edge.
 */
export function engineArm(
  geometry: Geometry,
  candles: Bar[],
  fromTs: number,
  funding8h: number | null,
  spreadBps: number | null,
): { grossR: number | null; netR: number | null; costR: number | null; outcome: string; heldMs: number } {
  const res = resolveGeometry(geometry, candles, fromTs, LEDGER.EXPIRY_HOURS * 3600_000);
  if (res.rMultiple === null) {
    return { grossR: null, netR: null, costR: null, outcome: res.outcome, heldMs: LEDGER.EXPIRY_HOURS * 3600_000 };
  }
  const heldMs = res.index >= 0 ? candles[res.index].t + 5 * 60_000 - fromTs : LEDGER.EXPIRY_HOURS * 3600_000;
  const c = computeCosts({
    grossR: res.rMultiple,
    entry: geometry.entry,
    riskPerUnit: geometry.riskPerUnit,
    heldMs,
    funding8h,
    side: geometry.side,
    spreadBps,
  });
  return {
    grossR: res.rMultiple,
    netR: c.netR,
    costR: c.totalCostR,
    outcome: res.outcome,
    heldMs,
  };
}
