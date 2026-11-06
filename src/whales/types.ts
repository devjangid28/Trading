import type { Candle, TerminalInterval, TerminalTrade } from '../../shared/types';

export type WhaleFeedState = 'connecting' | 'live' | 'reconnecting' | 'stale' | 'offline' | 'mock';

export interface WhaleBubble {
  id: string;
  t: number;
  price: number;
  buyUsd: number;
  sellUsd: number;
  notional: number;
  /** Raw trade count summed over the aggregated prints. */
  count: number;
  /** Number of same-side clusters (whale prints) in this candle. */
  prints: number;
  tradeIds: number[];
  avg: number;
}

export type WhaleLevelKind = 'user' | 'ref' | 'liq-short' | 'liq-long' | 'gamma-call' | 'gamma-put' | 'plan-buy' | 'plan-sell' | 'plan-stop' | 'plan-target';

export interface WhaleLevel {
  id: string;
  kind: WhaleLevelKind;
  price: number;
  label: string;
  /** dashed / dotted / dashdot / solid */
  style: 'dashed' | 'dotted' | 'dashdot' | 'solid';
  color: string;
}

export interface WhaleAverages {
  buyAvg: number | null;
  sellAvg: number | null;
  avg: number | null;
  buyUsd: number;
  sellUsd: number;
  buyCount: number;
  sellCount: number;
}

export interface CandleTradeStat {
  buyUsd: number;
  sellUsd: number;
}

export interface PriceRow {
  low: number;
  high: number;
  buyUsd: number;
  sellUsd: number;
}

export interface BubbleNetPoint {
  t: number;
  whale: number;
  everyone: number;
}

export interface WhaleView {
  start: number;
  end: number;
  priceMin: number;
  priceMax: number;
}

export type WhaleBubbleMode = 'sweep' | 'aggressive' | 'level' | 'print';
export type WhaleAggressor = 'bidask' | 'tick' | 'combined';
export type WhaleSizeBy = 'total' | 'aggressive';
export type WhaleLabelPos = 'above' | 'inside' | 'below';
export type WhalePlaceAt = 'vwap' | 'first' | 'last';

export interface WhaleSettings {
  showBubbles: boolean;
  /** Whale avg lines + buy/sell average chips. */
  showAvg: boolean;
  /** Top-2-per-side dollar zones bands. */
  showZones: boolean;
  /** Volume-by-price strip at the right (with POC / 70% value area). */
  showVolProfile: boolean;
  showLiq: boolean;
  showLevels: boolean;
  showMa: boolean;
  showBubbleNet: boolean;
  showPlan: boolean;
  showGamma: boolean;
  showRef: boolean;
  showInsight: boolean;
  showVolume: boolean;
  /** Bubble detection mode (Sweep / Aggressive / Level / Print). */
  mode: WhaleBubbleMode;
  aggressor: WhaleAggressor;
  sizeBy: WhaleSizeBy;
  labelPos: WhaleLabelPos;
  placeAt: WhalePlaceAt;
  /**
   * Whale print floor. `'auto'` = top ~0.5% of print sizes on this symbol,
   * capped at $5K (the site's `keepUsd = min(p99, 5000)`).
   */
  threshold: 'auto' | number;
  /** Cluster window in ms for sweep grouping (same-side, near same price). */
  clusterWindowMs: number;
  sideFilter: 'both' | 'buys' | 'sells';
  /** Shared-timeframe link (persisted; other views may subscribe later). */
  linkedTf: boolean;
}

export interface WhaleTapeStats {
  median: number;
  p99: number;
  p999: number;
  sampled: number;
}

export interface WhaleFeedSnapshot {
  bars: Candle[];
  trades: TerminalTrade[];
  t0: number | null;
  last: number | null;
  bid: number | null;
  ask: number | null;
  state: WhaleFeedState;
  latencyMs: number | null;
  resyncs: number;
  reconnects: number;
  tradeCountSinceT0: number;
  startedAt: number;
  /** Percentile tape stats (median/p99/p999) used by Auto sizing. */
  stats: WhaleTapeStats | null;
  /** Effective whale floor when Auto: min(p99, WHALE_AUTO_SIZE_CAP). */
  keepUsd: number;
  /** Earliest kept whale-print timestamp (the reading line's "since"). */
  fromTs: number | null;
  backfillError: string | null;
}

export type { Candle, TerminalInterval, TerminalTrade };
