import type { Candle, TerminalInterval } from '../../shared/types';
import { TERMINAL_INTERVALS } from '../../shared/types';

export const CHART_INTERVALS = TERMINAL_INTERVALS;
export type ChartInterval = TerminalInterval;

export const INTERVAL_LABEL: Record<ChartInterval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1D',
};

export type ChartType = 'candles' | 'heikin' | 'line' | 'area';
export type ScaleType = 'linear' | 'log' | 'percent';

export const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'candles', label: 'Candles' },
  { id: 'heikin', label: 'Heikin Ashi' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
];

export const SCALE_TYPES: { id: ScaleType; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'log', label: 'Log' },
  { id: 'percent', label: 'Percent' },
];

export type IndicatorKind = 'EMA' | 'SMA' | 'RSI' | 'MACD' | 'BOLL' | 'VOL' | 'VWAP';
export type IndicatorPane = 'main' | 'rsi' | 'macd' | 'vol';

export interface IndicatorCatalogEntry {
  kind: IndicatorKind;
  label: string;
  pane: IndicatorPane;
  defaults: number[];
  color: string;
  description: string;
}

export const INDICATOR_CATALOG: IndicatorCatalogEntry[] = [
  {
    kind: 'EMA',
    label: 'EMA',
    pane: 'main',
    defaults: [21, 50],
    color: '#f0b90b',
    description: 'Exponential moving averages on the price pane',
  },
  {
    kind: 'SMA',
    label: 'SMA',
    pane: 'main',
    defaults: [20],
    color: '#55c8ee',
    description: 'Simple moving averages on the price pane',
  },
  {
    kind: 'RSI',
    label: 'RSI',
    pane: 'rsi',
    defaults: [14],
    color: '#b493ff',
    description: 'Relative strength index in its own pane',
  },
  {
    kind: 'MACD',
    label: 'MACD',
    pane: 'macd',
    defaults: [12, 26, 9],
    color: '#55c8ee',
    description: 'Moving average convergence divergence',
  },
  {
    kind: 'BOLL',
    label: 'BOLL',
    pane: 'main',
    defaults: [20, 2],
    color: '#91a2b4',
    description: 'Bollinger bands on the price pane',
  },
  {
    kind: 'VOL',
    label: 'VOL',
    pane: 'vol',
    defaults: [5, 10, 20],
    color: '#f4b860',
    description: 'Volume moving averages in their own pane',
  },
  {
    kind: 'VWAP',
    label: 'VWAP',
    pane: 'main',
    defaults: [],
    color: '#f0b90b',
    description: 'Session VWAP computed from the loaded candles',
  },
];

export interface IndicatorConfig {
  id: string;
  kind: IndicatorKind;
  params: number[];
  visible: boolean;
}

export type SessionId = 'london' | 'newyork';

export const SESSION_LABEL: Record<SessionId, string> = {
  london: 'London',
  newyork: 'New York',
};

export interface ChartSettings {
  symbol: string;
  interval: ChartInterval;
  chartType: ChartType;
  scale: ScaleType;
  indicators: IndicatorConfig[];
  sessions: Record<SessionId, boolean>;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
}

export type SidebarTab = 'whales' | 'futures' | 'sentiment' | 'news' | 'guide';

export const SIDEBAR_TABS: { id: SidebarTab; label: string }[] = [
  { id: 'whales', label: 'Whales' },
  { id: 'futures', label: 'Futures' },
  { id: 'sentiment', label: 'Sentiment' },
  { id: 'news', label: 'News' },
  { id: 'guide', label: 'Guide' },
];

export type DrawingTool =
  | 'cursor'
  | 'trend'
  | 'ray'
  | 'hline'
  | 'rect'
  | 'fib'
  | 'long'
  | 'short'
  | 'text';

export const DRAWING_TOOLS: { id: DrawingTool; label: string; hint: string }[] = [
  { id: 'cursor', label: 'Cursor', hint: 'Pan and inspect (Esc)' },
  { id: 'trend', label: 'Trend line', hint: 'Two clicks: start and end' },
  { id: 'ray', label: 'Horizontal ray', hint: 'One click: anchor the ray' },
  { id: 'hline', label: 'Horizontal line', hint: 'One click: pin a level' },
  { id: 'rect', label: 'Rectangle', hint: 'Two clicks: opposite corners' },
  { id: 'fib', label: 'Fib retracement', hint: 'Two clicks: swing low and high' },
  { id: 'long', label: 'Long position', hint: 'Three clicks: entry, target, stop' },
  { id: 'short', label: 'Short position', hint: 'Three clicks: entry, target, stop' },
  { id: 'text', label: 'Text note', hint: 'One click: place a note' },
];

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'error';

export interface TickerSnapshot {
  price: number | null;
  prevPrice: number | null;
  direction: 'up' | 'down' | 'flat';
  bid: number | null;
  ask: number | null;
  changePct: number | null;
  at: number | null;
}

export interface MarketState {
  symbol: string;
  interval: ChartInterval;
  bars: Candle[];
  loading: boolean;
  error: string | null;
  status: StreamStatus;
  ticker: TickerSnapshot;
  latencyMs: number | null;
  lastRestAt: number | null;
  lastMessageAt: number | null;
}

export interface VisibleStats {
  volumeQty: number;
  deltaQty: number | null;
  cvdUsd: number | null;
  poc: number | null;
  bars: number;
}

export interface CrosshairState {
  candle: Candle | null;
  index: number | null;
}

export interface VisibleRangeState {
  from: number;
  to: number;
}
