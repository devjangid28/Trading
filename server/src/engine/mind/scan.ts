/**
 * Scan-level glue: board rows in, a Mind board out.
 *
 * Deliberately its own module so the engine stays testable without booting a
 * scan. Everything here is a *composition* of the pure modules — it decides
 * which regime to publish, resolves the anchor once for the whole board, and
 * attaches the result to rows. It contains no scoring logic of its own, because
 * a second copy of the scoring rules is how two versions of the truth end up in
 * one codebase.
 *
 * ## The base rate comes from the ledger, and it is read once
 *
 * Every row on a board is scored against the same anchor. If each row resolved
 * its own, two rows on the same screen could be calibrated to different
 * populations and the ordering between them would be meaningless.
 */

import { MIND } from '../../config.js';
import type {
  AssetRow,
  Candle,
  FeatureVector,
  LedgerSignal,
  MarketPicture,
  MindHealth,
  MindRegime,
  MindSignal,
  SectorFlow,
  Side,
  TradePlan,
} from '../../../../shared/types.js';
import { buildFeatureVector, type FeatureInputs } from './features.js';
import { classifyRegime, type RegimeInputs, type RegimeVerdict } from './regime.js';
import { rankCandidates, idFor, type Candidate } from './rank.js';
import { resolveBaseRate } from './confluence.js';
import { buildCalibrationReport } from './calibrate.js';

/** Market-wide readings the classifier needs that no single row carries. */
export interface MarketContext {
  btcChangePct: number | null;
  btcCandles: Candle[] | null;
  /** Liquidation notional over 5m as a fraction of total volume. */
  liqVelocityFrac: number | null;
  btcDominanceShiftPp: number | null;
  oiChange1h: number | null;
  macroBlackoutMin: number | null;
  fearGreed: number | null;
  fearGreedHistory: number[];
  stablecoinFloatUsd: number | null;
  ethBtcChangePct: number | null;
  /**
   * Median ATR percentile across the scanned universe, or null when nothing
   * measured one. Supplied by the caller rather than read off the board rows:
   * `AssetRow` does not carry the engine's `VolatilityContext`, and adding it
   * there would put a volatility field on every row for the benefit of one
   * aggregate read.
   */
  atrPercentile: number | null;
}

/** Everything the Mind pass needs that is not on the rows themselves. */
export interface MindScanInput {
  rows: AssetRow[];
  candlesBySymbol: Map<string, Candle[]>;
  market: MarketContext;
  asOf: number;
  marketPicture: MarketPicture | null;
  sectors: SectorFlow[];
  /** The ledger's observed win rate and how many resolved signals it rests on. */
  baseRate: { observedWinRate: number | null; resolvedSamples: number };
}

export interface MindScanResult {
  regime: MindRegime;
  regimeVerdict: RegimeVerdict;
  byId: Map<string, MindSignal>;
  featuresById: Map<string, FeatureVector>;
  base: ReturnType<typeof resolveBaseRate>;
}

/**
 * Which regime to publish for a given row.
 *
 * Macro blackout and cascade are market-wide, so the board shows one verdict
 * rather than one per row — a board where two rows disagree about the regime is
 * a bug report waiting to happen.
 */
export function boardRegime(input: MindScanInput): RegimeVerdict {
  const board = boardLevelRegimeInputs(input);
  return classifyRegime(board);
}

/** Build the regime inputs from the market-wide readings. */
export function boardLevelRegimeInputs(input: MindScanInput): RegimeInputs {
  const mp = input.marketPicture;
  const breadthRatio =
    mp && mp.total >= MIND.REGIME_MIN_BOARD ? mp.bullishCount / mp.total : null;

  // The typical move across the board, as a fraction. Median rather than mean so
  // one 40% alt does not define the market's energy level.
  const medianAbs =
    mp && mp.dots.length > 0
      ? (() => {
          const xs = mp.dots.map((d) => Math.abs(d.changePct) / 100).sort((a, b) => a - b);
          return xs[Math.floor(xs.length / 2)];
        })()
      : null;

  const atrPercentile = input.market.atrPercentile;

  return {
    breadthRatio,
    btcChangePct: input.market.btcChangePct,
    medianAbsChangePct: medianAbs,
    liqVelocityFrac: input.market.liqVelocityFrac,
    btcDominanceShiftPp: input.market.btcDominanceShiftPp,
    atrPercentile,
    oiChange1h: input.market.oiChange1h,
    macroBlackoutMin: input.market.macroBlackoutMin,
    assetChangePct: null,
  };
}

/**
 * Run the whole Mind pass over a set of board rows.
 *
 * The row's own plan and setup are used, so the expected R is the plan the board
 * is actually showing — not a recomputation that could drift from it.
 */
export function runMindPass(input: MindScanInput): MindScanResult {
  const regimeVerdict = boardRegime(input);
  const regime = regimeVerdict.regime;
  const sectorByName = new Map(input.sectors.map((s) => [s.sector, s]));
  const base = resolveBaseRate(input.baseRate.observedWinRate, input.baseRate.resolvedSamples);

  const candidates: Candidate[] = [];
  const featuresById = new Map<string, FeatureVector>();

  for (const row of input.rows) {
    const key = idFor(row.base, row.side);
    const candles = input.candlesBySymbol.get(row.pair) ?? [];
    const sector = sectorByName.get(row.sector) ?? null;

    const fi: FeatureInputs = {
      symbol: row.pair,
      side: row.side,
      asOf: input.asOf,
      candles,
      setup: row.setup ?? null,
      htf: row.setup?.htf ?? null,
      deriv: row.derivatives ?? null,
      sector,
      market: input.marketPicture,
      news: [],
      components: row.conviction?.components ?? null,
      strength: row.strength,
      macro: {
        btcDominanceTrendPp: input.market.btcDominanceShiftPp,
        ethBtcChangePct: input.market.ethBtcChangePct,
        stablecoinFloatUsd: input.market.stablecoinFloatUsd,
        fearGreed: input.market.fearGreed,
        fearGreedHistory: input.market.fearGreedHistory,
      },
      macroBlackoutMin: input.market.macroBlackoutMin,
    };

    const features = buildFeatureVector(fi);
    // The classifier's verdict is frozen onto the vector, so a stored vector
    // always carries the regime it was read under.
    features.regimeLabel = regime;
    featuresById.set(key, features);

    candidates.push({
      base: row.base,
      symbol: row.pair,
      side: row.side,
      features,
      regime,
      plan: (row.plan as TradePlan | null) ?? null,
    });
  }

  const ranked = rankCandidates(candidates, input.baseRate, input.asOf);

  const byId = new Map<string, MindSignal>();
  for (const s of ranked.signals) byId.set(s.id, s);

  return { regime, regimeVerdict, byId, featuresById, base };
}

export { idFor };

/**
 * Build the `/api/mind/health` payload.
 *
 * Assembled from the current scan plus the ledger's calibration report, so the
 * one screen answers: what is the regime, why, is the model better than the base
 * rate, and how many signals are actionable right now.
 */
export function buildMindHealth(
  pass: MindScanResult,
  ledgerSignals: LedgerSignal[],
  now: number,
  lastRefitAt: number | null = null,
): MindHealth {
  const signals = [...pass.byId.values()];
  const calibration = buildCalibrationReport(ledgerSignals, now, lastRefitAt);

  const vetoCounts = new Map<string, number>();
  for (const s of signals) {
    for (const v of s.vetoes) vetoCounts.set(v.code, (vetoCounts.get(v.code) ?? 0) + 1);
  }

  return {
    ok: true,
    updatedAt: now,
    regime: pass.regime,
    regimeEvidence: pass.regimeVerdict.evidence,
    calibration,
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
    model: {
      // Changes whenever the scoring maths changes, so a reader can tell two
      // reports apart instead of assuming continuity.
      id: 'mind-1',
      usingShippedWeights: true,
      baseRateSamples: pass.base.samples,
      baseRateSource: pass.base.source,
    },
  };
}

/** Convenience: the rows a scan produced, with their Mind signals attached. */
export function attachMindToRows<T extends { base: string; side: Side }>(
  rows: T[],
  pass: MindScanResult,
): Array<T & { mind: MindSignal | null }> {
  return rows.map((r) => ({ ...r, mind: pass.byId.get(idFor(r.base, r.side)) ?? null }));
}