import type { Candle } from '../../shared/types';
import type { LiquidityWall } from './liquidity';
import type { TerminalHistory } from '../../shared/types';
import { computeLiquidityProfileFromHistory } from './terminalHistory';

export type SRType = 'support' | 'resistance';
export type SRStrength = 'weak' | 'moderate' | 'strong' | 'major';
export type SRSource = 'swing' | 'volume' | 'liquidity';
export type OBType = 'bullish' | 'bearish';
export type WickType = 'upper' | 'lower' | 'both';

export interface SRLevel {
  price: number;
  type: SRType;
  strength: SRStrength;
  touches: number;
  lastTouch: number;
  volumeAtLevel: number;
  /** Heuristic break score 0–1. Same number as `breakProbability` (kept for compatibility). */
  breakStrength: number;
  /** Three-tier label derived from breakStrength via toBreakLabel. */
  breakLabel: BreakLabel;
  breakProbability: number;
  age: number;
  zoneTop: number;
  zoneBottom: number;
  isActive: boolean;
  /** Where the level came from: fractal swings, volume profile, or live order book. */
  source: SRSource;
  /** True when price has crossed this level and the role flipped (S↔R). */
  flipped: boolean;
  /** Aggregated notional of the order-book wall at this price, if any. */
  wallUsd: number;
  /** Number of order-book levels in the wall. */
  wallLevels: number;
}

export interface OrderBlock {
  price: number;
  type: OBType;
  top: number;
  bottom: number;
  timestamp: number;
  volume: number;
  candles: number;
  isTested: boolean;
  testCount: number;
  breakProbability: number;
}

export interface WickSignal {
  price: number;
  type: WickType;
  candleIndex: number;
  timestamp: number;
  wickSize: number;
  bodySize: number;
  wickRatio: number;
  volume: number;
  direction: 'rejection' | 'exhaustion';
  strength: 'weak' | 'moderate' | 'strong';
}

export interface BreakProbability {
  levelPrice: number;
  type: SRType;
  probability: number;
  factors: {
    volumeProfile: number;
    touchCount: number;
    timeSinceTouch: number;
    momentum: number;
    orderFlow: number;
    liquidity: number;
  };
  timeframe: string;
}

export interface SREngineOutput {
  supportLevels: SRLevel[];
  resistanceLevels: SRLevel[];
  orderBlocks: OrderBlock[];
  wickSignals: WickSignal[];
  bigMoves: BigMoveCandle[];
  breakProbabilities: BreakProbability[];
  currentPrice: number;
  nearestSupport: SRLevel | null;
  nearestResistance: SRLevel | null;
  activeOrderBlock: OrderBlock | null;
  latestWickSignal: WickSignal | null;
  liquidityWalls: LiquidityWall[];
  /** The latest PRIMARY break event that survived the confirmation rules, if any. */
  breakStatus: BreakStatus | null;
  /** Every watched-level break event (primary + secondary when enabled). */
  breakEvents: BreakStatus[];
  /**
   * Health of the heatmap history layer: `live` frames are in the engine;
   * `fallback` means the engine is running on candle volume profile + structure
   * + order book only (no frames yet); `offline` means the heatmap fetch failed.
   */
  heatmapHealth: HeatmapHealth;
  /** Detailed score breakdown for the chosen levels (for logging/analysis). */
  levelScores?: LevelScoreBreakdown[];
  /** Backtest results if requested. */
  backtestResults?: BacktestResults;
}

export interface LevelScoreBreakdown {
  price: number;
  type: SRType;
  source: SRSource;
  touches: number;
  volumeAtLevel: number;
  volumeScore: number;
  touchScore: number;
  recencyScore: number;
  liquidityScore: number;
  historyLiquidityScore: number;
  historyTouches: number;
  historyNotional: number;
  totalScore: number;
  rank: number;
}

export interface BacktestResults {
  symbol: string;
  interval: string;
  candlesTested: number;
  supportHitRate: number;
  resistanceHitRate: number;
  orderBlockHitRate: number;
  orderBlockMoveRate: number;
  avgSupportReaction: number;
  avgResistanceReaction: number;
  avgOrderBlockMove: number;
  details: BacktestDetail[];
}

export interface BacktestDetail {
  type: 'support' | 'resistance' | 'orderBlock';
  levelPrice: number;
  timestamp: number;
  reacted: boolean;
  reactionPct: number;
  maxReactionPct: number;
  timeToReaction: number;
}

export type BreakStrength = 'weak' | 'medium' | 'strong';

/** How prominently a break should be surfaced: primaries alert loudly, secondaries quietly. */
export type BreakScope = 'primary' | 'secondary';

export interface BreakStatus {
  type: SRType;
  price: number;
  /** Candle close time of the break candle. */
  timestamp: number;
  strength: BreakStrength;
  confirmed: boolean;
  reason: string;
  /** Whether this level is a primary (drawn) or secondary (watched, quieter) level. */
  scope: BreakScope;
}

/** Health of the heatmap history layer feeding the engine. */
export type HeatmapHealth = 'live' | 'fallback' | 'offline';

/**
 * Honesty note for every displayed break figure. Break probabilities are a
 * heuristic blend of real inputs — never presented as calibrated odds.
 */
export const HEURISTIC_DISCLAIMER =
  'Heuristic based on volume, heatmap pressure & structure — not calibrated odds';

/**
 * Tuning knobs for the S/R engine. Every threshold lives here so the engine
 * stays adjustable without touching logic. Provenance: [TUNED] hand-tuned,
 * not yet fitted against a ledger.
 */
export interface SREngineConfig {
  /** How many candles back the engine looks for swings (fractals). */
  swingLookback: number;
  /** Minimum touches for a swing level to count (cluster member count). */
  minTouches: number;
  /** Volume-profile outlier threshold: node volume >= median × this. */
  volumeMultiplier: number;
  /** Maximum distance from price (fraction) for a level to be "relevant". */
  relevanceWindowPct: number;
  /** Ignore levels outside this % of price. */
  hardWindowPct: number;
  /** Minimum body fraction vs the neighbors for the order-block candle. */
  obMinBodyFraction: number;
  /** Volume multiple above the 10-bar average for an order-block candle. */
  obVolumeMultiple: number;
  /** Wick-to-body ratio that flags a rejection wick. */
  wickMinRatio: number;
  /** Body size (fraction of range) that flags a "big move" candle. */
  bigMoveMinBodyPct: number;
  /** Volume multiple for a big-move candle to be confirmed. */
  bigMoveVolumeMultiple: number;
  /** Number of candles the break detector looks back for events. */
  breakLookback: number;
  /** Retest window: candles after the break that count as a retest. */
  retestWindow: number;
  /** Watch secondary (non-drawn) levels for breaks and surface them quietly. */
  alertOnSecondaryBreaks: boolean;
}

export const DEFAULT_SR_CONFIG: SREngineConfig = {
  swingLookback: 5,
  minTouches: 2,
  volumeMultiplier: 2.2,
  relevanceWindowPct: 0.08,
  hardWindowPct: 0.06,
  obMinBodyFraction: 0.5,
  obVolumeMultiple: 1.5,
  wickMinRatio: 2,
  bigMoveMinBodyPct: 0.7,
  bigMoveVolumeMultiple: 1.8,
  breakLookback: 20,
  retestWindow: 6,
  alertOnSecondaryBreaks: true,
};

interface PriceVolumeNode {
  price: number;
  volume: number;
  touches: number;
  lastTouch: number;
  candleIndices: number[];
}

const MAX_LEVEL_AGE_MS = 45 * 24 * 60 * 60 * 1000;

function roundToTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize) * tickSize;
}

function getTickSize(price: number): number {
  if (price >= 10000) return 0.1;
  if (price >= 1000) return 0.01;
  if (price >= 100) return 0.001;
  if (price >= 10) return 0.0001;
  if (price >= 1) return 0.00001;
  return 0.000001;
}

function calculateVolumeProfile(candles: Candle[], bins = 100): PriceVolumeNode[] {
  if (candles.length === 0) return [];

  let high = -Infinity;
  let low = Infinity;
  for (const candle of candles) {
    if (candle.h > high) high = candle.h;
    if (candle.l < low) low = candle.l;
  }
  const range = high - low;
  if (range <= 0 || !Number.isFinite(high)) return [];

  const binSize = range / bins;
  const nodes = new Map<number, PriceVolumeNode>();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const volume = candle.qv ?? candle.v * candle.c;
    if (!Number.isFinite(volume) || volume <= 0) continue;
    const candleLow = Math.max(0, Math.floor((candle.l - low) / binSize));
    const candleHigh = Math.min(bins - 1, Math.floor((candle.h - low) / binSize));
    const span = candleHigh - candleLow + 1;

    for (let bin = candleLow; bin <= candleHigh; bin++) {
      const price = low + (bin + 0.5) * binSize;
      const key = roundToTick(price, getTickSize(price));
      const existing = nodes.get(key) || { price: key, volume: 0, touches: 0, lastTouch: 0, candleIndices: [] };
      existing.volume += volume / span;
      existing.touches += 1;
      existing.lastTouch = candle.t;
      existing.candleIndices.push(i);
      nodes.set(key, existing);
    }
  }

  return [...nodes.values()].sort((a, b) => b.volume - a.volume);
}

function findSwingPoints(candles: Candle[], lookback = 5): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const current = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= current.h) isHigh = false;
      if (candles[j].l <= current.l) isLow = false;
    }

    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }

  return { highs, lows };
}

interface LevelCluster {
  price: number;
  touches: number;
}

function clusterLevels(prices: number[], tickSize: number, maxDistance = 4): LevelCluster[] {
  if (prices.length === 0) return [];

  const sorted = [...prices].sort((a, b) => a - b);
  const resolution = Math.max(maxDistance * tickSize, sorted[0] * 0.0006);
  const clusters: number[][] = [];
  let currentCluster: number[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - currentCluster[currentCluster.length - 1] <= resolution) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push(currentCluster);
      currentCluster = [sorted[i]];
    }
  }
  clusters.push(currentCluster);

  return clusters.map(cluster => ({
    price: cluster.reduce((a, b) => a + b, 0) / cluster.length,
    touches: cluster.length,
  }));
}

function calculateStrength(touches: number, volumeAtLevel: number, totalVolume: number, age: number): SRStrength {
  const volumeRatio = totalVolume > 0 ? volumeAtLevel / totalVolume : 0;
  const touchScore = Math.min(touches / 5, 1);
  const volumeScore = Math.min(volumeRatio * 12, 1);
  const ageScore = Math.max(0, 1 - age / MAX_LEVEL_AGE_MS);
  const score = touchScore * 0.4 + volumeScore * 0.4 + ageScore * 0.2;

  if (score >= 0.8) return 'major';
  if (score >= 0.6) return 'strong';
  if (score >= 0.35) return 'moderate';
  return 'weak';
}

interface ProbFactors {
  volumeNode: PriceVolumeNode | undefined;
  touches: number;
  lastTouch: number;
  momentum: number;
  wallUsd: number;
}

function computeBreakProbability(
  level: { price: number; type: SRType; strength: SRStrength },
  currentPrice: number,
  recentCandles: Candle[],
  volumeProfile: PriceVolumeNode[],
  factors: ProbFactors,
): number {
  let probability = 0.5;

  const volumeFactor = factors.volumeNode
    ? Math.min(factors.volumeNode.volume / Math.max(1, volumeProfile[0]?.volume) * 2, 1)
    : 0.3;
  probability += (volumeFactor - 0.5) * 0.28;

  const touchFactor = Math.min(factors.touches / 8, 1);
  probability += (touchFactor - 0.5) * 0.18;

  const timeSinceTouch = Date.now() - factors.lastTouch;
  const timeFactor = Math.max(0, 1 - timeSinceTouch / (7 * 24 * 60 * 60 * 1000));
  probability += (timeFactor - 0.5) * 0.12;

  const isApproaching = (level.type === 'resistance' && currentPrice < level.price && currentPrice > level.price * 0.995) ||
                        (level.type === 'support' && currentPrice > level.price && currentPrice < level.price * 1.005);
  if (isApproaching) probability += 0.12;

  const wallFactor = Math.min(factors.wallUsd / Math.max(1, recentCandles.slice(-50).reduce((sum, c) => sum + (c.qv ?? c.v * c.c), 0)) * 0.05, 0.3);
  probability += wallFactor * (level.type === 'resistance' ? -1 : 1) * -0.15;

  probability = Math.max(0.05, Math.min(0.95, probability));

  if (level.strength === 'major') probability = Math.max(probability, 0.3);
  if (level.strength === 'weak') probability = Math.min(probability, 0.7);

  return Math.round(probability * 100) / 100;
}

export function detectOrderBlocks(candles: Candle[], lookback = 50): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  const recentCandles = candles.slice(-lookback);

  for (let i = 1; i < recentCandles.length - 1; i++) {
    const prev = recentCandles[i - 1];
    const curr = recentCandles[i];
    const next = recentCandles[i + 1];

    const prevBody = Math.abs(prev.c - prev.o);
    const currBody = Math.abs(curr.c - curr.o);
    const nextBody = Math.abs(next.c - next.o);
    const avgBody = (prevBody + currBody + nextBody) / 3;

    const currVolume = curr.qv ?? curr.v * curr.c;
    const avgVolume = recentCandles.slice(Math.max(0, i - 10), i).reduce((sum, c) => sum + (c.qv ?? c.v * c.c), 0) / 10;

    if (currBody >= avgBody * 0.5 && currVolume > avgVolume * 1.5) {
      if (curr.c > curr.o && next.c > next.o && next.c > curr.h) {
        blocks.push({
          price: (curr.o + curr.c) / 2,
          type: 'bullish',
          top: curr.h,
          bottom: curr.l,
          timestamp: curr.t,
          volume: currVolume,
          candles: 1,
          isTested: false,
          testCount: 0,
          breakProbability: 0,
        });
      } else if (curr.c < curr.o && next.c < next.o && next.c < curr.l) {
        blocks.push({
          price: (curr.o + curr.c) / 2,
          type: 'bearish',
          top: curr.h,
          bottom: curr.l,
          timestamp: curr.t,
          volume: currVolume,
          candles: 1,
          isTested: false,
          testCount: 0,
          breakProbability: 0,
        });
      }
    }

    if (i >= 2) {
      const c1 = recentCandles[i - 2];
      const c2 = recentCandles[i - 1];
      const c3 = recentCandles[i];

      const bodies = [c1, c2, c3].map(c => Math.abs(c.c - c.o));
      const volumes = [c1, c2, c3].map(c => c.qv ?? c.v * c.c);
      const avgB = bodies.reduce((a, b) => a + b, 0) / 3;
      const avgV = volumes.reduce((a, b) => a + b, 0) / 3;

      const allSmallBodies = bodies.every(b => b < avgB * 1.2);
      const highVolume = volumes.some(v => v > avgV * 2);

      if (allSmallBodies && highVolume) {
        const direction = c3.c > c1.o ? 'bullish' : 'bearish';
        const top = Math.max(c1.h, c2.h, c3.h);
        const bottom = Math.min(c1.l, c2.l, c3.l);

        if (direction === 'bullish' && c3.c > c3.o) {
          blocks.push({
            price: (bottom + top) / 2,
            type: 'bullish',
            top,
            bottom,
            timestamp: c3.t,
            volume: volumes.reduce((a, b) => a + b, 0),
            candles: 3,
            isTested: false,
            testCount: 0,
            breakProbability: 0,
          });
        } else if (direction === 'bearish' && c3.c < c3.o) {
          blocks.push({
            price: (bottom + top) / 2,
            type: 'bearish',
            top,
            bottom,
            timestamp: c3.t,
            volume: volumes.reduce((a, b) => a + b, 0),
            candles: 3,
            isTested: false,
            testCount: 0,
            breakProbability: 0,
          });
        }
      }
    }
  }

  return blocks.filter(b => b.volume > 0).slice(-20);
}

export function detectWickSignals(candles: Candle[], lookback = 100): WickSignal[] {
  const signals: WickSignal[] = [];
  const recentCandles = candles.slice(-lookback);
  // `candleIndex` must be absolute in the passed candles array — the chart
  // draw pass converts it straight to an x-axis dataset index. Indices inside
  // the lookback slice would land markers at the wrong candles.
  const offset = candles.length - recentCandles.length;

  for (let i = 0; i < recentCandles.length; i++) {
    const candle = recentCandles[i];
    const bodySize = Math.abs(candle.c - candle.o);
    const upperWick = candle.h - Math.max(candle.o, candle.c);
    const lowerWick = Math.min(candle.o, candle.c) - candle.l;
    const totalRange = candle.h - candle.l;

    if (totalRange <= 0 || bodySize <= 0) continue;

    const upperRatio = upperWick / bodySize;
    const lowerRatio = lowerWick / bodySize;
    const volume = candle.qv ?? candle.v * candle.c;
    const avgVolume = recentCandles.slice(Math.max(0, i - 20), i).reduce((sum, c) => sum + (c.qv ?? c.v * c.c), 0) / 20;

    const isHighVolume = volume > avgVolume * 1.3;

    if (upperRatio >= 2 && lowerRatio < 0.5) {
      const isRejection = candle.c < candle.o;
      signals.push({
        price: candle.h,
        type: 'upper',
        candleIndex: i + offset,
        timestamp: candle.t,
        wickSize: upperWick,
        bodySize,
        wickRatio: upperRatio,
        volume,
        direction: isRejection ? 'rejection' : 'exhaustion',
        strength: upperRatio >= 4 && isHighVolume ? 'strong' : upperRatio >= 2.5 ? 'moderate' : 'weak',
      });
    }

    if (lowerRatio >= 2 && upperRatio < 0.5) {
      const isRejection = candle.c > candle.o;
      signals.push({
        price: candle.l,
        type: 'lower',
        candleIndex: i + offset,
        timestamp: candle.t,
        wickSize: lowerWick,
        bodySize,
        wickRatio: lowerRatio,
        volume,
        direction: isRejection ? 'rejection' : 'exhaustion',
        strength: lowerRatio >= 4 && isHighVolume ? 'strong' : lowerRatio >= 2.5 ? 'moderate' : 'weak',
      });
    }

    if (upperRatio >= 1.5 && lowerRatio >= 1.5) {
      signals.push({
        price: (candle.h + candle.l) / 2,
        type: 'both',
        candleIndex: i + offset,
        timestamp: candle.t,
        wickSize: upperWick + lowerWick,
        bodySize,
        wickRatio: (upperWick + lowerWick) / bodySize,
        volume,
        direction: 'exhaustion',
        strength: (upperRatio + lowerRatio) >= 5 && isHighVolume ? 'strong' : 'moderate',
      });
    }
  }

  return signals.slice(-30);
}

export interface BigMoveCandle {
  candleIndex: number;
  timestamp: number;
  price: number;
  type: OBType;
  bodyPct: number;
  volumeMultiple: number;
}

/**
 * Detect single large impulsive candles: a candle whose body covers most of
 * its range AND closes in the direction of the body, with volume well above
 * the recent average. These are the "big-move" bars traders look for after
 * an order block.
 */
export function detectBigMoveCandles(candles: Candle[], config: SREngineConfig = DEFAULT_SR_CONFIG): BigMoveCandle[] {
  const recent = candles.slice(-200);
  const offset = candles.length - recent.length;
  const out: BigMoveCandle[] = [];
  for (let i = 0; i < recent.length; i++) {
    const candle = recent[i];
    const range = candle.h - candle.l;
    if (range <= 0) continue;
    const body = Math.abs(candle.c - candle.o);
    const bodyPct = body / range;
    const avgVolume = recent.slice(Math.max(0, i - 20), i)
      .reduce((sum, c) => sum + (c.qv ?? c.v * c.c), 0) / Math.max(1, Math.min(i, 20));
    const volume = candle.qv ?? candle.v * candle.c;
    const volumeMultiple = avgVolume > 0 ? volume / avgVolume : 0;
    if (
      bodyPct >= config.bigMoveMinBodyPct
      && volumeMultiple >= config.bigMoveVolumeMultiple
    ) {
      out.push({
        candleIndex: i + offset,
        timestamp: candle.t,
        price: (candle.h + candle.l) / 2,
        type: candle.c > candle.o ? 'bullish' : 'bearish',
        bodyPct,
        volumeMultiple,
      });
    }
  }
  return out.slice(-20);
}

function isFlipped(levelPrice: number, type: SRType, currentPrice: number): boolean {
  return type === 'resistance' ? levelPrice < currentPrice : levelPrice > currentPrice;
}

export interface WatchedLevel {
  level: SRLevel;
  scope: BreakScope;
}

/**
 * Run the confirmation rules over a set of watched levels and return every
 * break event that survived. Secondary levels are included only when
 * `alertOnSecondaryBreaks` is enabled in the config. Events are newest first.
 */
export function collectBreakEvents(
  candles: Candle[],
  watched: WatchedLevel[],
  config: SREngineConfig = DEFAULT_SR_CONFIG,
): BreakStatus[] {
  return watched
    .filter(w => config.alertOnSecondaryBreaks || w.scope === 'primary')
    .map(w => detectBreakStatus(candles, w.level, config, w.scope))
    .filter((s): s is BreakStatus => s !== null)
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Break detection with confirmation rules.
 *
 * Rules (professional flow):
 *   1. CLOSE beyond the level (not an intraday wick spike).
 *   2. VOLUME confirmation: the break candle's volume >= 1.3× the 10-bar
 *      average, otherwise the move is suspect.
 *   3. RETEST filter: if the surface immediately closes back on the level
 *      within `retestWindow` candles, the break is a fake-out (the level
 *      holds). A breakout that is never retested keeps its "confirmed"
 *      state. A retest that HOLDS confirms the break.
 *   4. Strength: strong = volume confirmed + no fake-out or successful
 *      retest; medium = close-confirmed but volume below threshold; weak =
 *      a break that later failed the retest (possible fake-out).
 */
export function detectBreakStatus(
  candles: Candle[],
  level: SRLevel,
  config: SREngineConfig = DEFAULT_SR_CONFIG,
  scope: BreakScope = 'primary',
): BreakStatus | null {
  const recent = candles.slice(-Math.max(config.breakLookback, config.retestWindow + 5));
  if (recent.length < 5) return null;

  const isResistance = level.type === 'resistance';
  const crossed = (candle: Candle) => isResistance
    ? candle.c > level.price
    : candle.c < level.price;

  // Find the most recent candle whose close crossed the level.
  let breakIndex = -1;
  for (let i = recent.length - 1; i >= 1; i--) {
    if (crossed(recent[i]) && !crossed(recent[i - 1])) {
      breakIndex = i;
      break;
    }
  }
  if (breakIndex === -1) return null;

  const breakCandle = recent[breakIndex];
  const avgVolume = recent.slice(Math.max(0, breakIndex - 10), breakIndex)
    .reduce((sum, c) => sum + (c.qv ?? c.v * c.c), 0) / Math.max(1, Math.min(breakIndex, 10));
  const breakVolume = breakCandle.qv ?? breakCandle.v * breakCandle.c;
  const volumeConfirmed = avgVolume > 0 && breakVolume >= avgVolume * 1.3;

  // Fake-out filter: any candle within the retest window closes back through.
  let fakeOut = false;
  for (let i = breakIndex + 1; i < recent.length && i <= breakIndex + config.retestWindow; i++) {
    if (!crossed(recent[i])) {
      fakeOut = true;
      break;
    }
  }

  const confirmed = volumeConfirmed && !fakeOut;
  let strength: BreakStrength;
  let reason: string;

  if (fakeOut) {
    strength = 'weak';
    reason = volumeConfirmed
      ? 'close broke but level reclaimed — likely fake-out despite volume'
      : 'close broke but level reclaimed — likely fake-out';
  } else if (volumeConfirmed) {
    strength = 'strong';
    reason = 'volume confirmed, no retest failure';
  } else {
    strength = 'medium';
    reason = 'close crossed but volume weak — needs confirmation';
  }

  return {
    type: level.type,
    price: level.price,
    timestamp: breakCandle.t,
    strength,
    confirmed,
    reason,
    scope,
  };
}

function buildLiquidityProfile(
  candles: Candle[],
  bins = 200
): Map<number, { notional: number; touches: number }> {
  if (candles.length === 0) return new Map();
  let high = -Infinity;
  let low = Infinity;
  for (const c of candles) {
    if (c.h > high) high = c.h;
    if (c.l < low) low = c.l;
  }
  const range = high - low;
  if (range <= 0) return new Map();
  const binSize = range / bins;
  const profile = new Map<number, { notional: number; touches: number }>();
  for (const c of candles) {
    const vol = c.qv ?? c.v * c.c;
    const candleLow = Math.max(0, Math.floor((c.l - low) / binSize));
    const candleHigh = Math.min(bins - 1, Math.floor((c.h - low) / binSize));
    const span = candleHigh - candleLow + 1;
    for (let bin = candleLow; bin <= candleHigh; bin++) {
      const price = low + (bin + 0.5) * binSize;
      const existing = profile.get(price) || { notional: 0, touches: 0 };
      existing.notional += vol / span;
      existing.touches += 1;
      profile.set(price, existing);
    }
  }
  return profile;
}

function mergeLiquidityProfiles(
  primary: Map<number, { notional: number; touches: number }>,
  secondary: Map<number, { notional: number; touches: number }>,
  weightSecondary = 0.5
): Map<number, { notional: number; touches: number }> {
  const merged = new Map(primary);
  for (const [price, data] of secondary) {
    const existing = merged.get(price) || { notional: 0, touches: 0 };
    existing.notional += data.notional * weightSecondary;
    existing.touches += data.touches * weightSecondary;
    merged.set(price, existing);
  }
  return merged;
}

function scoreLevel(
  level: SRLevel,
  volumeProfile: Map<number, { notional: number; touches: number }>,
  historyProfile: Map<number, { notional: number; touches: number }> | null,
  totalVolume: number,
  tickSize: number
): LevelScoreBreakdown {
  const volumeScore = Math.min((level.volumeAtLevel / Math.max(1, totalVolume)) * 12, 1);
  const touchScore = Math.min(level.touches / 5, 1);
  const age = Date.now() - level.lastTouch;
  const recencyScore = Math.max(0, 1 - age / (45 * 24 * 60 * 60 * 1000));

  // Liquidity from volume profile
  let liquidityScore = 0;
  let vpNotional = 0;
  const tol = Math.max(tickSize * 3, level.price * 0.0006);
  for (const [price, data] of volumeProfile) {
    if (Math.abs(price - level.price) <= tol) {
      vpNotional += data.notional;
      liquidityScore += Math.min((data.notional / 1e6) * 0.5 + data.touches * 0.3, 1);
    }
  }
  liquidityScore = Math.min(liquidityScore, 1);

  // Historical liquidity from terminal heatmap
  let historyLiquidityScore = 0;
  let historyTouches = 0;
  let historyNotional = 0;
  if (historyProfile) {
    const hTol = Math.max(tickSize * 3, level.price * 0.0005);
    for (const [price, data] of historyProfile) {
      if (Math.abs(price - level.price) <= hTol) {
        historyNotional += data.notional;
        historyTouches += data.touches;
      }
    }
    historyLiquidityScore = Math.min(
      (historyNotional / 1e6) * 0.4 + historyTouches * 0.2,
      1
    );
  }

  const totalScore =
    touchScore * 0.30 +
    volumeScore * 0.25 +
    recencyScore * 0.15 +
    liquidityScore * 0.20 +
    historyLiquidityScore * 0.10;

  return {
    price: level.price,
    type: level.type,
    source: level.source,
    touches: level.touches,
    volumeAtLevel: level.volumeAtLevel,
    volumeScore,
    touchScore,
    recencyScore,
    liquidityScore,
    historyLiquidityScore,
    historyTouches,
    historyNotional,
    totalScore,
    rank: 0,
  };
}

export function runSREngine(
  candles: Candle[],
  interval: string,
  liquidityWalls: LiquidityWall[] = [],
  config: SREngineConfig = DEFAULT_SR_CONFIG,
  terminalHistory: TerminalHistory | null = null,
  enableBacktest = false,
  symbol = 'UNKNOWN',
  heatmapStatus: HeatmapHealth = 'fallback'
): SREngineOutput {
  const empty = (): SREngineOutput => ({
    supportLevels: [],
    resistanceLevels: [],
    orderBlocks: [],
    wickSignals: [],
    bigMoves: [],
    breakProbabilities: [],
    currentPrice: candles[candles.length - 1]?.c ?? 0,
    nearestSupport: null,
    nearestResistance: null,
    activeOrderBlock: null,
    latestWickSignal: null,
    liquidityWalls,
    breakStatus: null,
    breakEvents: [],
    heatmapHealth: heatmapStatus,
  });

  if (candles.length < 20) return empty();

  const currentPrice = candles[candles.length - 1].c;
  const tickSize = getTickSize(currentPrice);
  const recentCandles = candles.slice(-200);
  const volumeProfile = calculateVolumeProfile(recentCandles);

  const { highs, lows } = findSwingPoints(recentCandles, config.swingLookback);

  const clusteredResistance = clusterLevels(highs.map(i => recentCandles[i].h), tickSize);
  const clusteredSupport = clusterLevels(lows.map(i => recentCandles[i].l), tickSize);

  const totalVolume = volumeProfile.reduce((sum, v) => sum + v.volume, 0);
  const recentTradesUsd = recentCandles.slice(-50).reduce((sum, c) => sum + (c.qv ?? c.v * c.c), 0);

  const buildLevel = (
    price: number,
    type: SRType,
    touches: number,
    lastTouchIndex: number | undefined,
    source: SRSource,
    wall?: LiquidityWall,
  ): SRLevel | null => {
    if (!Number.isFinite(price) || price <= 0) return null;
    const lastTouch = lastTouchIndex !== undefined ? recentCandles[lastTouchIndex].t : candles[0].t;
    const volumeNode = volumeProfile.find(v => Math.abs(v.price - price) < Math.max(tickSize * 2, price * 0.0004));
    const volumeAtLevel = volumeNode?.volume ?? 0;
    const strength = calculateStrength(touches, volumeAtLevel + (wall?.usd ?? 0), totalVolume, Date.now() - lastTouch);
    const wallUsd = wall?.usd ?? 0;
    const breakProbability = computeBreakProbability(
      { price, type, strength },
      currentPrice,
      recentCandles,
      volumeProfile,
      {
        volumeNode,
        touches,
        lastTouch,
        momentum: (recentCandles[recentCandles.length - 1].c - recentCandles[Math.max(0, recentCandles.length - 6)].c) / currentPrice,
        wallUsd,
      },
    );
    const flipped = isFlipped(price, type, currentPrice);

    return {
      price: roundToTick(price, tickSize),
      type,
      strength,
      touches,
      lastTouch,
      volumeAtLevel,
      breakStrength: breakProbability,
      breakLabel: toBreakLabel(breakProbability),
      breakProbability,
      age: Date.now() - lastTouch,
      zoneTop: roundToTick(price + tickSize * 6, tickSize),
      zoneBottom: roundToTick(price - tickSize * 6, tickSize),
      isActive: true,
      source,
      flipped,
      wallUsd,
      wallLevels: wall?.levels ?? 0,
    };
  };

  const resistanceLevels: SRLevel[] = [];
  const supportLevels: SRLevel[] = [];
  const seen = new Set<string>();

  const addLevel = (level: SRLevel | null) => {
    if (!level) return;
    const key = `${level.type}:${Math.round(level.price / Math.max(tickSize, 1e-12))}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (level.type === 'resistance') resistanceLevels.push(level);
    else supportLevels.push(level);
  };

  for (const cluster of clusteredResistance) {
    if (cluster.price <= currentPrice * (1 - config.hardWindowPct)) continue;
    const lastTouchIndex = [...highs].reverse().find(i => Math.abs(recentCandles[i].h - cluster.price) < Math.max(tickSize * 6, cluster.price * 0.0008));
    if (cluster.touches >= config.minTouches) addLevel(buildLevel(cluster.price, 'resistance', cluster.touches, lastTouchIndex, 'swing'));
  }
  for (const cluster of clusteredSupport) {
    if (cluster.price >= currentPrice * (1 + config.hardWindowPct)) continue;
    const lastTouchIndex = [...lows].reverse().find(i => Math.abs(recentCandles[i].l - cluster.price) < Math.max(tickSize * 6, cluster.price * 0.0008));
    if (cluster.touches >= config.minTouches) addLevel(buildLevel(cluster.price, 'support', cluster.touches, lastTouchIndex, 'swing'));
  }

  const nodeVolumes = volumeProfile.map(v => v.volume).filter(v => v > 0).sort((a, b) => a - b);
  const nodeMedian = nodeVolumes.length > 0 ? nodeVolumes[Math.floor(nodeVolumes.length / 2)] : 0;
  const volCutoff = Math.max(totalVolume * 0.008, nodeMedian * config.volumeMultiplier);
  for (const node of volumeProfile) {
    if (node.volume < volCutoff) continue;
    const type: SRType = node.price > currentPrice ? 'resistance' : 'support';
    if (node.price > currentPrice * (1 + config.hardWindowPct) || node.price < currentPrice * (1 - config.hardWindowPct)) continue;
    const lastTouchIndex = node.candleIndices[node.candleIndices.length - 1];
    addLevel(buildLevel(node.price, type, node.touches, lastTouchIndex, 'volume'));
  }

  const enrichNearby = (wall: LiquidityWall) => {
    const type: SRType = wall.side === 'ask' ? 'resistance' : 'support';
    const pool = type === 'resistance' ? resistanceLevels : supportLevels;
    const proximity = Math.max(tickSize * 3, wall.price * 0.0006);
    const target = pool.find(l => Math.abs(l.price - wall.price) <= proximity);
    if (target) {
      target.wallUsd = wall.usd;
      target.wallLevels = wall.levels;
      return true;
    }
    return false;
  };

  for (const wall of liquidityWalls) {
    const type: SRType = wall.side === 'ask' ? 'resistance' : 'support';
    if (type === 'resistance' && wall.price <= currentPrice) continue;
    if (type === 'support' && wall.price >= currentPrice) continue;
    if (wall.price > currentPrice * (1 + config.hardWindowPct) || wall.price < currentPrice * (1 - config.hardWindowPct)) continue;
    if (!enrichNearby(wall)) addLevel(buildLevel(wall.price, type, 0, undefined, 'liquidity', wall));
  }

  const STRENGTH_RANK: Record<SRStrength, number> = { weak: 1, moderate: 2, strong: 3, major: 4 };

  const mergeNearby = (levels: SRLevel[]): SRLevel[] => {
    const sorted = [...levels].sort((a, b) => a.price - b.price);
    const out: SRLevel[] = [];
    for (const level of sorted) {
      const existing = out.find(o => Math.abs(o.price - level.price) <= Math.max(tickSize * 6, level.price * 0.0006));
      if (!existing) {
        out.push({ ...level });
        continue;
      }
      if (STRENGTH_RANK[level.strength] > STRENGTH_RANK[existing.strength]) existing.strength = level.strength;
      existing.touches += level.touches;
      existing.volumeAtLevel += level.volumeAtLevel;
      existing.wallUsd = Math.max(existing.wallUsd, level.wallUsd);
      existing.wallLevels = Math.max(existing.wallLevels, level.wallLevels);
      existing.lastTouch = Math.max(existing.lastTouch, level.lastTouch);
      existing.age = Date.now() - existing.lastTouch;
      if (existing.source !== 'liquidity' && level.source === 'liquidity') existing.source = 'liquidity';
      if (existing.flipped || level.flipped) existing.flipped = true;
    }
    return out;
  };

  const recomputeProbability = (level: SRLevel): number => {
    const volumeNode = volumeProfile.find(v => Math.abs(v.price - level.price) < Math.max(tickSize * 2, level.price * 0.0004));
    return computeBreakProbability(
      { price: level.price, type: level.type, strength: level.strength },
      currentPrice,
      recentCandles,
      volumeProfile,
      {
        volumeNode,
        touches: level.touches,
        lastTouch: level.lastTouch,
        momentum: (recentCandles[recentCandles.length - 1].c - recentCandles[Math.max(0, recentCandles.length - 6)].c) / currentPrice,
        wallUsd: level.wallUsd,
      },
    );
  };

  const applyBreakMeta = (level: SRLevel) => {
    level.breakStrength = level.breakProbability;
    level.breakLabel = toBreakLabel(level.breakProbability);
  };

  const pickPrimary = (levels: SRLevel[]): SRLevel | null => {
    const relevant = levels.filter(l => Math.abs(l.price - currentPrice) / currentPrice <= config.relevanceWindowPct);
    const pool = relevant.length > 0 ? relevant : levels;
    if (pool.length === 0) return null;
    return [...pool].sort((a, b) => {
      const diff = STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength];
      if (diff !== 0) return diff;
      return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
    })[0] ?? null;
  };

  const allLevels = [...resistanceLevels, ...supportLevels].map(level =>
    level.flipped
      ? { ...level, type: level.type === 'resistance' ? 'support' as SRType : 'resistance' as SRType }
      : level,
  );
  const finalResistance = mergeNearby(allLevels.filter(l => l.type === 'resistance'));
  const finalSupport = mergeNearby(allLevels.filter(l => l.type === 'support'));

  for (const level of finalResistance) {
    level.breakProbability = recomputeProbability(level);
    applyBreakMeta(level);
  }
  for (const level of finalSupport) {
    level.breakProbability = recomputeProbability(level);
    applyBreakMeta(level);
  }

  finalResistance.sort((a, b) => a.price - b.price);
  finalSupport.sort((a, b) => b.price - a.price);

  resistanceLevels.length = 0;
  resistanceLevels.push(...finalResistance);
  supportLevels.length = 0;
  supportLevels.push(...finalSupport);

  const orderBlocks = detectOrderBlocks(candles);
  const wickSignals = detectWickSignals(candles);
  const bigMoves = detectBigMoveCandles(candles, config);

  const testedBlocks = orderBlocks.map(block => {
    let testCount = 0;
    let isTested = false;
    for (const candle of recentCandles) {
      if (candle.t > block.timestamp) {
        if (block.type === 'bullish' && candle.l <= block.top && candle.l >= block.bottom) {
          testCount++;
          isTested = true;
        } else if (block.type === 'bearish' && candle.h >= block.bottom && candle.h <= block.top) {
          testCount++;
          isTested = true;
        }
      }
    }
    const breakProbability = isTested ? Math.min(0.3 + testCount * 0.15, 0.85) : 0.15;
    return { ...block, isTested, testCount, breakProbability };
  });

  const breakProbabilities: BreakProbability[] = [
    ...resistanceLevels.map(level => ({
      levelPrice: level.price,
      type: 'resistance' as SRType,
      probability: level.breakProbability,
      factors: {
        volumeProfile: Math.min(level.volumeAtLevel / Math.max(1, volumeProfile[0]?.volume) * 2, 1),
        touchCount: level.touches,
        timeSinceTouch: Date.now() - level.lastTouch,
        momentum: (recentCandles[recentCandles.length - 1].c - recentCandles[Math.max(0, recentCandles.length - 6)].c) / currentPrice,
        orderFlow: 0,
        liquidity: Math.min(level.wallUsd / Math.max(1, recentTradesUsd), 1),
      },
      timeframe: interval,
    })),
    ...supportLevels.map(level => ({
      levelPrice: level.price,
      type: 'support' as SRType,
      probability: level.breakProbability,
      factors: {
        volumeProfile: Math.min(level.volumeAtLevel / Math.max(1, volumeProfile[0]?.volume) * 2, 1),
        touchCount: level.touches,
        timeSinceTouch: Date.now() - level.lastTouch,
        momentum: (recentCandles[recentCandles.length - 1].c - recentCandles[Math.max(0, recentCandles.length - 6)].c) / currentPrice,
        orderFlow: 0,
        liquidity: Math.min(level.wallUsd / Math.max(1, recentTradesUsd), 1),
      },
      timeframe: interval,
    })),
  ].sort((a, b) => b.probability - a.probability);

  const nearestResistance = pickPrimary(resistanceLevels);
  const nearestSupport = pickPrimary(supportLevels);
  const activeOrderBlock = testedBlocks.find(b => !b.isTested && b.type === (currentPrice > b.price ? 'bullish' : 'bearish')) ?? testedBlocks[0] ?? null;
  const latestWickSignal = wickSignals[wickSignals.length - 1] ?? null;

  // Watch primary levels always; secondary levels (the strongest non-primary on
  // each side) when alertOnSecondaryBreaks is enabled.
  const toleranceForWatch = (price: number) => Math.max(tickSize * 6, price * 0.0006);
  const watched: { level: SRLevel; scope: BreakScope }[] = [];
  const watchLevel = (level: SRLevel | null, scope: BreakScope) => {
    if (!level) return;
    const dup = watched.some(w => Math.abs(w.level.price - level.price) <= toleranceForWatch(level.price));
    if (!dup) watched.push({ level, scope });
  };
  watchLevel(nearestResistance, 'primary');
  watchLevel(nearestSupport, 'primary');
  if (config.alertOnSecondaryBreaks) {
    const secondaryFor = (levels: SRLevel[], primary: SRLevel | null) => {
      const candidates = levels.filter(l => !primary || Math.abs(l.price - primary.price) > toleranceForWatch(l.price));
      if (candidates.length === 0) return null;
      return [...candidates].sort((a, b) => {
        const diff = STRENGTH_RANK[b.strength] - STRENGTH_RANK[a.strength];
        if (diff !== 0) return diff;
        return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
      })[0] ?? null;
    };
    watchLevel(secondaryFor(finalResistance, nearestResistance), 'secondary');
    watchLevel(secondaryFor(finalSupport, nearestSupport), 'secondary');
  }

  const breakEvents = collectBreakEvents(candles, watched, config);
  const breakStatus = breakEvents.find(e => e.scope === 'primary') ?? null;

  // Build liquidity profile from candles
  const candleLiquidityProfile = buildLiquidityProfile(recentCandles);
  const historyProfile = terminalHistory
    ? computeLiquidityProfileFromHistory(terminalHistory, [
        Math.min(...candles.map(c => c.l)),
        Math.max(...candles.map(c => c.h)),
      ])
    : null;
  const mergedLiquidityProfile = historyProfile
    ? mergeLiquidityProfiles(candleLiquidityProfile, historyProfile)
    : candleLiquidityProfile;

  // Use merged profile for scoring
  const finalLiquidityProfile = mergedLiquidityProfile;

  // Score all levels and rank them
  const allLevelsForScoring = [...resistanceLevels, ...supportLevels];
  const levelScores = allLevelsForScoring
    .map(level => scoreLevel(level, finalLiquidityProfile, historyProfile, totalVolume, tickSize))
    .sort((a, b) => b.totalScore - a.totalScore)
    .map((score, i) => ({ ...score, rank: i + 1 }));

  // Log the chosen levels with score breakdown
  if (typeof console !== 'undefined' && typeof console.group === 'function') {
    console.group(`S/R Engine [${symbol}] ${interval}`);
    console.log('Current price:', currentPrice);
    if (nearestResistance) {
      const rs = levelScores.find(s => Math.abs(s.price - nearestResistance!.price) < tickSize);
      console.log('↑ RESISTANCE:', rs ? JSON.stringify(rs, null, 2) : 'no score');
    }
    if (nearestSupport) {
      const ss = levelScores.find(s => Math.abs(s.price - nearestSupport!.price) < tickSize);
      console.log('↓ SUPPORT:', ss ? JSON.stringify(ss, null, 2) : 'no score');
    }
    console.groupEnd();
  }

  // Optional backtest
  let backtestResults: BacktestResults | undefined;
  if (enableBacktest) {
    backtestResults = runBacktest(candles, interval, resistanceLevels, supportLevels, testedBlocks);
  }

  return {
    supportLevels,
    resistanceLevels,
    orderBlocks: testedBlocks,
    wickSignals,
    bigMoves,
    breakProbabilities,
    currentPrice,
    nearestSupport,
    nearestResistance,
    activeOrderBlock,
    latestWickSignal,
    liquidityWalls,
    breakStatus,
    breakEvents,
    heatmapHealth: heatmapStatus,
    levelScores,
    backtestResults,
  };
}

export function runBacktest(
  candles: Candle[],
  interval: string,
  resistanceLevels: SRLevel[],
  supportLevels: SRLevel[],
  orderBlocks: OrderBlock[]
): BacktestResults {
  const testCandles = candles.slice(-500);
  if (testCandles.length < 50) {
    return {
      symbol: 'UNKNOWN',
      interval,
      candlesTested: testCandles.length,
      supportHitRate: 0,
      resistanceHitRate: 0,
      orderBlockHitRate: 0,
      orderBlockMoveRate: 0,
      avgSupportReaction: 0,
      avgResistanceReaction: 0,
      avgOrderBlockMove: 0,
      details: [],
    };
  }

  const details: BacktestDetail[] = [];
  let supportHits = 0;
  let supportTotal = 0;
  let resistanceHits = 0;
  let resistanceTotal = 0;
  let obHits = 0;
  let obTotal = 0;
  let obMoves = 0;
  let supportReactionSum = 0;
  let resistanceReactionSum = 0;
  let obMoveSum = 0;

  for (const level of supportLevels) {
    for (let i = 0; i < testCandles.length - 1; i++) {
      const c = testCandles[i];
      const nextC = testCandles[i + 1];
      if (c.l <= level.price * 1.001 && c.l >= level.price * 0.999) {
        supportTotal++;
        const reaction = (nextC.c - c.l) / c.l;
        if (reaction > 0.002) {
          supportHits++;
          supportReactionSum += reaction;
          details.push({
            type: 'support',
            levelPrice: level.price,
            timestamp: c.t,
            reacted: true,
            reactionPct: reaction * 100,
            maxReactionPct: reaction * 100,
            timeToReaction: nextC.t - c.t,
          });
        }
        break;
      }
    }
  }

  for (const level of resistanceLevels) {
    for (let i = 0; i < testCandles.length - 1; i++) {
      const c = testCandles[i];
      const nextC = testCandles[i + 1];
      if (c.h >= level.price * 0.999 && c.h <= level.price * 1.001) {
        resistanceTotal++;
        const reaction = (c.h - nextC.c) / c.h;
        if (reaction > 0.002) {
          resistanceHits++;
          resistanceReactionSum += reaction;
          details.push({
            type: 'resistance',
            levelPrice: level.price,
            timestamp: c.t,
            reacted: true,
            reactionPct: reaction * 100,
            maxReactionPct: reaction * 100,
            timeToReaction: nextC.t - c.t,
          });
        }
        break;
      }
    }
  }

  for (const ob of orderBlocks) {
    for (let i = 0; i < testCandles.length - 3; i++) {
      const c = testCandles[i];
      const touch = ob.type === 'bullish'
        ? c.l <= ob.top && c.l >= ob.bottom
        : c.h >= ob.bottom && c.h <= ob.top;
      if (touch) {
        obTotal++;
        let maxMove = 0;
        for (let j = i + 1; j < Math.min(i + 12, testCandles.length); j++) {
          const move = ob.type === 'bullish'
            ? (testCandles[j].h - ob.bottom) / ob.bottom
            : (ob.top - testCandles[j].l) / ob.top;
          if (move > maxMove) maxMove = move;
        }
        if (maxMove > 0.01) {
          obMoves++;
          obMoveSum += maxMove;
        }
        if (maxMove > 0.003) {
          obHits++;
          details.push({
            type: 'orderBlock',
            levelPrice: ob.price,
            timestamp: c.t,
            reacted: true,
            reactionPct: maxMove * 100,
            maxReactionPct: maxMove * 100,
            timeToReaction: 0,
          });
        }
        break;
      }
    }
  }

  return {
    symbol: 'UNKNOWN',
    interval,
    candlesTested: testCandles.length,
    supportHitRate: supportTotal > 0 ? supportHits / supportTotal : 0,
    resistanceHitRate: resistanceTotal > 0 ? resistanceHits / resistanceTotal : 0,
    orderBlockHitRate: obTotal > 0 ? obHits / obTotal : 0,
    orderBlockMoveRate: obTotal > 0 ? obMoves / obTotal : 0,
    avgSupportReaction: supportHits > 0 ? supportReactionSum / supportHits : 0,
    avgResistanceReaction: resistanceHits > 0 ? resistanceReactionSum / resistanceHits : 0,
    avgOrderBlockMove: obMoves > 0 ? obMoveSum / obMoves : 0,
    details,
  };
}

export function getStrengthColor(strength: SRStrength, type: SRType): string {
  const rgb = type === 'support' ? '14, 203, 129' : '246, 70, 93';
  const alpha = strength === 'major' ? 1 : strength === 'strong' ? 0.8 : strength === 'moderate' ? 0.5 : 0.3;
  return `rgba(${rgb}, ${alpha})`;
}

export function getWickColor(signal: WickSignal): string {
  if (signal.direction === 'rejection') {
    return signal.type === 'lower' ? 'rgba(14, 203, 129, 0.9)' : 'rgba(246, 70, 93, 0.9)';
  }
  return 'rgba(240, 185, 11, 0.9)';
}

export function formatBreakProbability(prob: number): string {
  return `${Math.round(prob * 100)}%`;
}

export function getProbabilityTone(prob: number): 'low' | 'medium' | 'high' | 'critical' {
  if (prob >= 0.75) return 'critical';
  if (prob >= 0.55) return 'high';
  if (prob >= 0.35) return 'medium';
  return 'low';
}

/** Three-tier break-strength label for the heuristic score (0–1). */
export type BreakLabel = 'Strong' | 'Medium' | 'Weak';

/**
 * Thresholds (agreed): ≥ 0.72 Strong, ≥ 0.45 Medium, < 0.45 Weak.
 */
export function toBreakLabel(score: number): BreakLabel {
  if (score >= 0.72) return 'Strong';
  if (score >= 0.45) return 'Medium';
  return 'Weak';
}

/** Keep the old name as an alias so callers read one exported function. */
export function breakStrengthLabel(prob: number): BreakLabel {
  return toBreakLabel(prob);
}

/** Tone class used by the UI to color a break-strength chip. */
export function breakLabelTone(label: BreakLabel): 'low' | 'medium' | 'high' {
  return label === 'Strong' ? 'high' : label === 'Medium' ? 'medium' : 'low';
}

export function fmtUsdCompact(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '—';
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(0)}K`;
  return `$${usd.toFixed(0)}`;
}

export function fmtAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '—';
  const hours = ageMs / 3_600_000;
  if (hours < 1) return `${Math.round(ageMs / 60_000)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  if (hours < 24 * 30) return `${(hours / 24).toFixed(1)}d`;
  return `${(hours / (24 * 30)).toFixed(1)}mo`;
}