import { api } from '../lib/api';
import type { TerminalHistory, TerminalHistoryFrame } from '../../shared/types';

export interface LiquidityScore {
  frame: TerminalHistoryFrame;
  bidNotional: number;
  askNotional: number;
  totalNotional: number;
  mid: number;
}

/**
 * Convert terminal history frames into liquidity scores at each price level.
 * Returns a map of price -> total liquidity (bid + ask notional) aggregated over all frames.
 */
export function computeLiquidityProfileFromHistory(
  history: TerminalHistory,
  priceRange: [number, number],
  bins: number = 200
): Map<number, { notional: number; touches: number }> {
  const profile = new Map<number, { notional: number; touches: number }>();
  const binSize = (priceRange[1] - priceRange[0]) / bins;

  for (const frame of history.frames) {
    if (frame.bids.length !== frame.asks.length) continue;
    const step = frame.binBps / 10000;
    const mid = frame.mid;

    // Aggregate bid notional
    for (let i = 0; i < frame.bids.length; i++) {
      const price = mid * (1 - (i + 1) * step);
      if (price < priceRange[0] || price > priceRange[1]) continue;
      const key = Math.round(price / binSize) * binSize;
      const existing = profile.get(key) || { notional: 0, touches: 0 };
      existing.notional += frame.bids[i];
      existing.touches += 1;
      profile.set(key, existing);
    }

    // Aggregate ask notional
    for (let i = 0; i < frame.asks.length; i++) {
      const price = mid * (1 + (i + 1) * step);
      if (price < priceRange[0] || price > priceRange[1]) continue;
      const key = Math.round(price / binSize) * binSize;
      const existing = profile.get(key) || { notional: 0, touches: 0 };
      existing.notional += frame.asks[i];
      existing.touches += 1;
      profile.set(key, existing);
    }
  }

  return profile;
}

/**
 * Score a level using the historical liquidity profile.
 */
export function scoreLevelWithHistory(
  levelPrice: number,
  _type: 'support' | 'resistance',
  historyProfile: Map<number, { notional: number; touches: number }>,
  tickSize: number
): { liquidityScore: number; historyTouches: number; totalNotional: number } {
  const tolerance = Math.max(tickSize * 3, levelPrice * 0.0005);
  let totalNotional = 0;
  let totalTouches = 0;

  for (const [price, data] of historyProfile) {
    if (Math.abs(price - levelPrice) <= tolerance) {
      totalNotional += data.notional;
      totalTouches += data.touches;
    }
  }

  // Normalize: more notional = higher score, more touches = higher score
  const liquidityScore = Math.min((totalNotional / 1e6) * 0.5 + totalTouches * 0.3, 1.0);

  return { liquidityScore, historyTouches: totalTouches, totalNotional };
}

/**
 * Fetch terminal history for a symbol and span.
 */
export async function fetchTerminalHistoryForCharts(
  symbol: string,
  interval: string,
  signal?: AbortSignal
): Promise<TerminalHistory | null> {
  // Map chart intervals to terminal spans
  const intervalToSpan: Record<string, string> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1h',
    '4h': '4h',
    '1d': '1d',
  };

  const span = intervalToSpan[interval] || '15m';
  try {
    const history = await api.terminalHistory(symbol, span as any, 900, signal);
    return history;
  } catch {
    return null;
  }
}